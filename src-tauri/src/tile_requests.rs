//! Process-local download scheduling. Rates are client policy, not provider quotas.
use rand::Rng;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::time::Instant;

const RECOVERY_WINDOW: Duration = Duration::from_secs(1);
const ISOLATED_OBSERVATION: Duration = Duration::from_secs(8);
const CONGESTION_OBSERVATION: Duration = Duration::from_secs(30);
const MAX_BUDGETS: usize = 128;
static AMAP: OnceLock<Arc<Gate>> = OnceLock::new();
static TIANDITU: OnceLock<Mutex<HashMap<[u8; 32], Arc<Gate>>>> = OnceLock::new();
static OVERFLOW: OnceLock<Arc<Gate>> = OnceLock::new();

pub(crate) fn applies(template: &str) -> bool {
    reqwest::Url::parse(&template.replace("{s}", "1")).ok().is_some_and(|url| {
        let host = url.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
        matches!(url.scheme(), "http" | "https")
            && (host == "autonavi.com" || host.ends_with(".autonavi.com")
                || host == "amap.com" || host.ends_with(".amap.com"))
            && url.path().eq_ignore_ascii_case("/appmaptile")
    })
}

// Coordinates and subdomains do not partition a budget. Only digests, never
// credentials or complete URLs, are retained in this registry.
fn budget_key(url: &str) -> Option<[u8; 32]> {
    if !crate::tianditu_tokens::is_tianditu_url(url) { return None; }
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") { return None; }
    let pairs: Vec<_> = parsed.query_pairs().collect();
    let value = |name: &str| pairs.iter().find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_ref()).unwrap_or("");
    let mut digest = Sha256::new();
    let path = parsed.path().trim_end_matches('/').to_ascii_lowercase();
    let layer = value("layer").to_ascii_lowercase();
    let matrix = value("tilematrixset").to_ascii_lowercase();
    let path_service = path.strip_suffix("/wmts").unwrap_or(&path).trim_start_matches('/');
    // /img_w/wmts and /wmts?LAYER=img&TILEMATRIXSET=w name the same service.
    let service = if matches!(path_service, "img_w" | "img_c" | "cia_w" | "cia_c" | "vec_w" | "vec_c" | "cva_w" | "cva_c" | "ter_w" | "ter_c" | "cta_w" | "cta_c") {
        path_service.to_owned()
    } else if path == "/wmts" && !layer.is_empty() && matches!(matrix.as_str(), "w" | "c") {
        format!("{layer}_{matrix}")
    } else { format!("{path}|{layer}|{matrix}") };
    for part in [value("tk").to_owned(), service] {
        digest.update((part.len() as u64).to_le_bytes()); digest.update(part.as_bytes());
    }
    Some(digest.finalize().into())
}

#[derive(Clone, Copy)]
struct Policy { initial_qps: u32, max_qps: u32, initial_concurrency: usize, max_concurrency: usize, adaptive: bool }
const AMAP_POLICY: Policy = Policy { initial_qps: 16, max_qps: 16, initial_concurrency: 4, max_concurrency: 4, adaptive: false };
const TIANDITU_POLICY: Policy = Policy { initial_qps: 16, max_qps: 64, initial_concurrency: 4, max_concurrency: 16, adaptive: true };

struct Gate { state: Mutex<State>, turn: AsyncMutex<()>, changed: Notify, policy: Policy }
#[derive(Clone, Copy)]
struct Recovery { qps: u32, concurrency: usize, observe_until: Instant, observe_for: Duration }
struct State {
    next: Option<Instant>, cooldown_until: Option<Instant>, qps: u32,
    concurrency: usize, active: usize, successes: u32, epoch: u64,
    limit_streak: u32, wave_rejections: u32, last_limit: Option<Instant>, last_change: Instant,
    proven_qps: u32, proven_concurrency: usize, recovery: Option<Recovery>,
    starts: VecDeque<Instant>,
}

// Compensate a bounded timer oversleep, rather than adding that lateness to
// every following interval. A late runtime never accumulates a send burst.
fn paced_next(now: Instant, scheduled: Option<Instant>, spacing: Duration) -> Instant {
    let scheduled = scheduled.unwrap_or(now);
    if now.saturating_duration_since(scheduled) > spacing * 2 { return now + spacing; }
    (scheduled + spacing).max(now + spacing / 2).min(now + spacing)
}

impl State {
    fn rate_ready(&mut self, now: Instant) -> Instant {
        while self.starts.front().is_some_and(|start| now.duration_since(*start) >= Duration::from_secs(1)) {
            self.starts.pop_front();
        }
        let limit = self.qps as usize;
        if self.starts.len() >= limit { self.starts[self.starts.len() - limit] + Duration::from_secs(1) }
        else { now }
    }
}
pub(crate) struct Permit { gate: Arc<Gate>, epoch: u64 }
impl Drop for Permit {
    fn drop(&mut self) {
        self.gate.state.lock().unwrap().active -= 1;
        self.gate.changed.notify_waiters();
    }
}
impl Permit {
    pub(crate) fn limited(&self, delay: Duration) { self.gate.limited(self.epoch, delay); }
    pub(crate) fn succeeded(&self) { self.gate.succeeded_at(self.epoch, Instant::now()); }
}
impl Gate {
    fn new(policy: Policy) -> Self {
        let now = Instant::now();
        Self { state: Mutex::new(State { next: None, cooldown_until: None,
            qps: policy.initial_qps, concurrency: policy.initial_concurrency,
            active: 0, successes: 0, epoch: 0, limit_streak: 0, wave_rejections: 0,
            last_limit: None, last_change: now, proven_qps: policy.initial_qps,
            proven_concurrency: policy.initial_concurrency, recovery: None, starts: VecDeque::new() }),
            turn: AsyncMutex::new(()), changed: Notify::new(), policy }
    }
    fn limited(&self, epoch: u64, delay: Duration) {
        self.limited_at(epoch, delay, Instant::now());
    }
    fn limited_at(&self, epoch: u64, delay: Duration, now: Instant) {
        let mut state = self.state.lock().unwrap();
        let delay = delay.min(Duration::from_secs(86_400));
        let until = if epoch == state.epoch {
            let recurring = state.last_limit.is_some_and(|last| now.duration_since(last) < CONGESTION_OBSERVATION);
            let prior_qps = state.qps;
            let prior_concurrency = state.concurrency;
            state.qps = (state.qps / 2).max(1);
            state.concurrency = (state.concurrency / 2).max(1);
            state.epoch = state.epoch.wrapping_add(1);
            state.limit_streak = state.limit_streak.saturating_add(1);
            state.wave_rejections = 1;
            state.last_limit = Some(now);
            if self.policy.adaptive {
                // A single rejected tile can recover to previously working
                // capacity. Repeated congestion learns a lower ceiling instead.
                let ceiling = if recurring { (prior_qps * 3 / 4).max(1) } else { prior_qps };
                let observation = if recurring { CONGESTION_OBSERVATION } else { ISOLATED_OBSERVATION };
                state.recovery = Some(Recovery {
                    qps: state.proven_qps.min(ceiling).max(state.qps),
                    concurrency: state.proven_concurrency.min(prior_concurrency).max(state.concurrency),
                    observe_until: now + observation, observe_for: observation,
                });
            }
            // Service-wide exponential backoff does not reset on each new tile.
            let cap_ms = 1000u64 << state.limit_streak.saturating_sub(1).min(5);
            let jitter = Duration::from_millis(rand::thread_rng().gen_range(cap_ms / 2..=cap_ms));
            now + delay.max(jitter)
        } else {
            if epoch.wrapping_add(1) == state.epoch {
                state.wave_rejections = state.wave_rejections.saturating_add(1);
                if state.wave_rejections >= 3 && self.policy.adaptive {
                    // Multiple rejections from one old wave still halve only
                    // once, but they are not treated as an isolated failure.
                    state.recovery = Some(Recovery { qps: state.qps, concurrency: state.concurrency,
                        observe_until: now + CONGESTION_OBSERVATION, observe_for: CONGESTION_OBSERVATION });
                }
            }
            now + delay
        };
        // Old replies honor Retry-After without multiplying one failure wave.
        state.cooldown_until = Some(state.cooldown_until.map_or(until, |prior| prior.max(until)));
        let cooldown_end = state.cooldown_until.unwrap();
        if let Some(recovery) = &mut state.recovery {
            recovery.observe_until = recovery.observe_until.max(cooldown_end + recovery.observe_for);
        }
        state.successes = 0; state.last_change = now;
        state.next = Some(state.next.map_or(state.cooldown_until.unwrap(), |next| next.max(state.cooldown_until.unwrap())));
        drop(state); self.changed.notify_waiters();
    }
    fn succeeded_at(&self, epoch: u64, now: Instant) {
        let mut state = self.state.lock().unwrap();
        if epoch != state.epoch || state.cooldown_until.is_some_and(|until| now < until) { return; }
        state.successes = state.successes.saturating_add(1);
        let window = if self.policy.adaptive { RECOVERY_WINDOW }
            else if state.last_limit.is_some() { Duration::from_secs(5) } else { Duration::from_secs(2) };
        let stable_since = state.last_change.max(state.cooldown_until.unwrap_or(state.last_change));
        if state.successes >= 16 && now.duration_since(stable_since) >= window {
            state.proven_qps = state.qps;
            state.proven_concurrency = state.concurrency;
            if self.policy.adaptive {
                if let Some(recovery) = state.recovery.filter(|recovery| now < recovery.observe_until) {
                    state.qps = (state.qps + (state.qps / 2).max(4)).min(recovery.qps);
                    state.concurrency = (state.concurrency + 2).min(recovery.concurrency);
                } else {
                    state.recovery = None;
                    state.qps = (state.qps + 8).min(self.policy.max_qps);
                    state.concurrency = (state.concurrency + 2).min(self.policy.max_concurrency);
                }
            } else {
                state.qps = (state.qps + 1).min(self.policy.max_qps);
                state.concurrency = (state.concurrency + 1).min(self.policy.max_concurrency);
            }
            state.limit_streak = 0; state.successes = 0; state.last_change = now;
        }
    }
    async fn acquire(self: &Arc<Self>) -> Permit {
        // One FIFO waiter owns the send clock; others wait on the mutex instead
        // of all waking and contending for every single request start.
        let _turn = self.turn.lock().await;
        loop {
            // Register before checking: no lost release between check and await.
            // Cancellation does not reserve a future start or leak capacity.
            let changed = self.changed.notified(); tokio::pin!(changed); changed.as_mut().enable();
            let deadline = {
                let mut state = self.state.lock().unwrap(); let now = Instant::now();
                if state.active >= state.concurrency { None } else {
                    let rate_ready = if self.policy.adaptive { state.rate_ready(now) } else { now };
                    let deadline = state.next.into_iter().chain(state.cooldown_until).chain(Some(rate_ready)).max().unwrap_or(now);
                    if deadline <= now {
                        state.active += 1;
                        let spacing = Duration::from_secs_f64(1.0 / f64::from(state.qps));
                        state.next = Some(if self.policy.adaptive {
                            let next = paced_next(now, state.next, spacing);
                            state.starts.push_back(now);
                            next
                        } else { now + spacing });
                        return Permit { gate: self.clone(), epoch: state.epoch };
                    }
                    Some(deadline)
                }
            };
            if let Some(until) = deadline {
                tokio::select! { _ = changed => {}, _ = tokio::time::sleep_until(until) => {} }
            } else { changed.await; }
        }
    }
}

fn gate_for(url: &str) -> Option<Arc<Gate>> {
    if applies(url) { return Some(AMAP.get_or_init(|| Arc::new(Gate::new(AMAP_POLICY))).clone()); }
    let key = budget_key(url)?;
    let mut registry = TIANDITU.get_or_init(Default::default).lock().unwrap();
    if let Some(gate) = registry.get(&key) { return Some(gate.clone()); }
    if registry.len() >= MAX_BUDGETS {
        // Keep overflow assignment stable for the process lifetime. Evicting an
        // idle/cooling gate could bypass Retry-After or split a live budget.
        return Some(OVERFLOW.get_or_init(|| Arc::new(Gate::new(TIANDITU_POLICY))).clone());
    }
    let gate = Arc::new(Gate::new(TIANDITU_POLICY)); registry.insert(key, gate.clone()); Some(gate)
}
pub(crate) async fn acquire(url: &str) -> Option<Permit> { Some(gate_for(url)?.acquire().await) }
/// Progress text only; no key or URL leaves this module.
pub(crate) fn cooldown_remaining(url: &str) -> Option<Duration> {
    let gate = gate_for(url)?; let until = gate.state.lock().unwrap().cooldown_until?;
    until.checked_duration_since(Instant::now()).filter(|delay| !delay.is_zero())
}
#[cfg(test)]
pub(crate) fn reset_for_tests() {
    if let Some(registry) = TIANDITU.get() { registry.lock().unwrap().clear(); }
    for gate in [&AMAP, &OVERFLOW].into_iter().filter_map(OnceLock::get) {
        assert_eq!(gate.state.lock().unwrap().active, 0);
        *gate.state.lock().unwrap() = Gate::new(gate.policy).state.into_inner().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url(host: &str, layer: &str, key: &str) -> String {
        format!("https://{host}/{layer}_w/wmts?LAYER={layer}&TILEMATRIXSET=w&tk={key}&TILEROW=1")
    }
    #[test]
    fn timer_lateness_is_bounded_and_long_stalls_do_not_accumulate_send_credits() {
        let now = Instant::now(); let spacing = Duration::from_micros(15_625);
        let next = paced_next(now + spacing * 2, Some(now + spacing), spacing);
        assert_eq!(next, now + spacing * 2 + spacing / 2);
        assert_eq!(paced_next(now + spacing * 100, Some(now), spacing), now + spacing * 101);
    }
    #[test]
    fn rolling_budget_enforces_the_target_rate_including_after_a_rate_reduction() {
        let gate = Gate::new(TIANDITU_POLICY); let now = Instant::now();
        let mut state = gate.state.lock().unwrap(); state.qps = 4;
        for millis in [900,700,500,300] { state.starts.push_back(now - Duration::from_millis(millis)); }
        assert_eq!(state.rate_ready(now), now + Duration::from_millis(100));
        state.qps = 2;
        assert_eq!(state.rate_ready(now), now + Duration::from_millis(500));
        assert_eq!(state.rate_ready(now + Duration::from_secs(1)), now + Duration::from_secs(1));
        assert!(state.starts.is_empty());
    }
    #[tokio::test]
    async fn busy_runtime_keeps_a_rolling_rate_bound_without_a_restart_burst() {
        let gate = Arc::new(Gate::new(Policy { initial_qps: 32, max_qps: 32, initial_concurrency: 16, ..TIANDITU_POLICY }));
        let mut tasks = Vec::new();
        for _ in 0..65 {
            let gate = gate.clone();
            tasks.push(tokio::spawn(async move { let permit = gate.acquire().await; let at = Instant::now(); drop(permit); at }));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Simulate one busy-runtime interval; no production code blocks a thread.
        std::thread::sleep(Duration::from_millis(80));
        let mut starts = Vec::new();
        for task in tasks { starts.push(task.await.unwrap()); } starts.sort();
        for (i, at) in starts.iter().enumerate() {
            assert!(starts[i..].iter().take_while(|next| next.duration_since(*at) < Duration::from_millis(999)).count() <= 32);
        }
        for pair in starts.windows(2) { assert!(pair[1].duration_since(pair[0]) >= Duration::from_millis(12)); }
    }
    #[test]
    fn only_amap_tile_hosts_share_the_budget() {
        for url in ["https://webrd0{s}.is.autonavi.com/appmaptile?style=8&x={x}",
            "https://WEBST01.IS.AUTONAVI.COM.:443/appmaptile"] { assert!(applies(url)); }
        for url in ["https://autonavi.com.example.com/appmaptile", "https://autonavi.com@example.com/appmaptile",
            "https://restapi.amap.com/v3/geocode/geo"] { assert!(!applies(url)); }
    }
    #[test]
    fn budgets_share_across_tasks_and_subdomains_but_isolate_keys_and_services() {
        let base = url("t0.tianditu.gov.cn", "img", "test-a");
        assert_eq!(budget_key(&base), budget_key(&url("t7.tianditu.gov.cn", "img", "test-a")));
        assert_eq!(budget_key(&base), budget_key(&base.replace("TILEROW=1", "TILEROW=99")));
        assert_eq!(budget_key(&base), budget_key(&base.replace("/img_w/wmts", "/wmts")));
        assert_ne!(budget_key(&base), budget_key(&url("t0.tianditu.gov.cn", "cia", "test-a")));
        assert_ne!(budget_key(&base), budget_key(&url("t0.tianditu.gov.cn", "img", "test-b")));
        assert!(Arc::ptr_eq(&gate_for(&base).unwrap(), &gate_for(&base).unwrap()));
        assert!(budget_key("https://tianditu.gov.cn.example.com/wmts?tk=a").is_none());
    }
    #[tokio::test]
    async fn startup_is_smooth_and_cancellation_does_not_consume_capacity() {
        let gate = Arc::new(Gate::new(TIANDITU_POLICY)); let first = gate.acquire().await; let started = Instant::now();
        let waiting = tokio::spawn({ let gate = gate.clone(); async move { gate.acquire().await } });
        tokio::task::yield_now().await; waiting.abort(); let _ = waiting.await;
        assert_eq!(gate.state.lock().unwrap().active, 1); drop(first);
        let _second = gate.acquire().await; assert!(started.elapsed() >= Duration::from_millis(60));
    }
    #[tokio::test]
    async fn concurrency_is_bounded_and_drop_wakes_waiters() {
        let gate = Arc::new(Gate::new(Policy { initial_qps: 10000, initial_concurrency: 2, ..TIANDITU_POLICY }));
        let a = gate.acquire().await; let b = gate.acquire().await;
        let waiting = tokio::spawn({ let gate = gate.clone(); async move { gate.acquire().await } });
        tokio::time::sleep(Duration::from_millis(5)).await; assert!(!waiting.is_finished()); drop(a);
        let c = tokio::time::timeout(Duration::from_secs(1), waiting).await.unwrap().unwrap(); drop(b); drop(c);
        assert_eq!(gate.state.lock().unwrap().active, 0);
    }
    #[tokio::test]
    async fn cancelling_the_front_waiter_unblocks_the_next_without_reserving_a_send() {
        let gate = Arc::new(Gate::new(Policy { initial_qps: 1000, initial_concurrency: 1, ..TIANDITU_POLICY }));
        let active = gate.acquire().await;
        let front = tokio::spawn({ let gate = gate.clone(); async move { gate.acquire().await } });
        tokio::task::yield_now().await;
        let next = tokio::spawn({ let gate = gate.clone(); async move { gate.acquire().await } });
        tokio::task::yield_now().await;
        front.abort(); let _ = front.await; drop(active);
        let permit = tokio::time::timeout(Duration::from_secs(1), next).await.unwrap().unwrap();
        assert_eq!(gate.state.lock().unwrap().active, 1); drop(permit);
        assert_eq!(gate.state.lock().unwrap().active, 0);
    }
    #[test]
    fn one_failure_wave_halves_rate_once_and_old_successes_do_not_recover_it() {
        let gate = Gate::new(TIANDITU_POLICY); gate.limited(0, Duration::from_millis(250));
        for _ in 0..29 { gate.limited(0, Duration::from_millis(250)); }
        let state = gate.state.lock().unwrap(); assert_eq!((state.qps, state.concurrency, state.epoch), (8, 2, 1)); drop(state);
        for _ in 0..100 { gate.succeeded_at(0, Instant::now() + Duration::from_secs(10)); }
        assert_eq!(gate.state.lock().unwrap().qps, 8); gate.limited(1, Duration::from_millis(250));
        assert_eq!(gate.state.lock().unwrap().qps, 4);
    }
    #[test]
    fn recovery_requires_time_and_successes_and_preserves_the_deadline() {
        let gate = Gate::new(TIANDITU_POLICY); gate.limited(0, Duration::from_secs(1));
        let origin = Instant::now(); let deadline = gate.state.lock().unwrap().next;
        for _ in 0..100 { gate.succeeded_at(1, origin + Duration::from_millis(500)); }
        assert_eq!(gate.state.lock().unwrap().qps, 8);
        for _ in 0..16 { gate.succeeded_at(1, origin + Duration::from_secs(2)); }
        let state = gate.state.lock().unwrap(); assert_eq!((state.qps, state.concurrency), (12, 4)); assert_eq!(state.next, deadline); drop(state);
        for step in 3..20 { for _ in 0..16 { gate.succeeded_at(1, origin + Duration::from_secs(step)); } }
        assert_eq!(gate.state.lock().unwrap().qps, 64);
    }
    #[test]
    fn isolated_congestion_recovers_proven_capacity_without_permanent_slow_mode() {
        let gate = Gate::new(TIANDITU_POLICY); let origin = Instant::now();
        for step in 1..=6 { for _ in 0..16 { gate.succeeded_at(0, origin + Duration::from_secs(step)); } }
        assert_eq!(gate.state.lock().unwrap().qps, 64);
        gate.limited_at(0, Duration::from_secs(1), origin + Duration::from_secs(8));
        assert_eq!(gate.state.lock().unwrap().qps, 32);
        for step in [10,11,12] { for _ in 0..16 { gate.succeeded_at(1, origin + Duration::from_secs(step)); } }
        assert_eq!(gate.state.lock().unwrap().qps, 56);
        for _ in 0..16 { gate.succeeded_at(1, origin + Duration::from_secs(17)); }
        assert_eq!(gate.state.lock().unwrap().qps, 64);
        assert!(gate.state.lock().unwrap().recovery.is_none());
    }
    #[test]
    fn repeated_or_widespread_limits_hold_a_lower_ceiling_instead_of_fast_oscillation() {
        let gate = Gate::new(TIANDITU_POLICY); let origin = Instant::now();
        for step in 1..=6 { for _ in 0..16 { gate.succeeded_at(0, origin + Duration::from_secs(step)); } }
        gate.limited_at(0, Duration::from_secs(1), origin + Duration::from_secs(8));
        gate.limited_at(1, Duration::from_secs(1), origin + Duration::from_secs(10));
        for step in 12..30 { for _ in 0..16 { gate.succeeded_at(2, origin + Duration::from_secs(step)); } }
        assert_eq!(gate.state.lock().unwrap().qps, 24);
        // Same-wave errors do not cut again, but prevent an early fast recovery.
        gate.limited_at(2, Duration::from_secs(1), origin + Duration::from_secs(31));
        gate.limited_at(2, Duration::from_secs(1), origin + Duration::from_secs(31));
        gate.limited_at(2, Duration::from_secs(1), origin + Duration::from_secs(31));
        for step in 33..60 { for _ in 0..16 { gate.succeeded_at(3, origin + Duration::from_secs(step)); } }
        assert_eq!(gate.state.lock().unwrap().qps, 12);
    }
    #[tokio::test]
    async fn cooldown_postpones_waiters_and_does_not_release_a_restart_burst() {
        let gate = Arc::new(Gate::new(TIANDITU_POLICY)); let first = gate.acquire().await;
        let waiting = tokio::spawn({ let gate = gate.clone(); async move { gate.acquire().await } });
        tokio::task::yield_now().await; first.limited(Duration::from_millis(100)); drop(first);
        let begin = Instant::now(); let second = waiting.await.unwrap(); assert!(begin.elapsed() >= Duration::from_millis(450));
        let begin = Instant::now(); drop(second); let _third = gate.acquire().await;
        assert!(begin.elapsed() >= Duration::from_millis(120));
    }
    #[test]
    fn healthy_rate_is_learned_and_reused_by_the_next_task() {
        let url = url("t3.tianditu.gov.cn", "cva", "learn-test"); let gate = gate_for(&url).unwrap(); let now = Instant::now();
        for step in 1..5 { for _ in 0..16 { gate.succeeded_at(0, now + Duration::from_secs(step * 3)); } }
        assert_eq!(gate_for(&url).unwrap().state.lock().unwrap().qps, 48);
    }
}
