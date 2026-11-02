//! Process-wide download budgets. These are client defaults, not provider quotas.
//! All subdomains, tasks, layers and retries of a provider share one budget.
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

const MAX_IN_FLIGHT: usize = 4;
const REQUEST_SPACING: Duration = Duration::from_micros(62_500);
const TIANDITU_SPACING: Duration = Duration::from_millis(125);
static AMAP: OnceLock<Arc<Gate>> = OnceLock::new();
static TIANDITU: OnceLock<Arc<Gate>> = OnceLock::new();

pub(crate) fn applies(template: &str) -> bool {
    reqwest::Url::parse(&template.replace("{s}", "1"))
        .ok()
        .is_some_and(|url| {
            let host = url.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
            matches!(url.scheme(), "http" | "https")
                && (host == "autonavi.com" || host.ends_with(".autonavi.com")
                    || host == "amap.com" || host.ends_with(".amap.com"))
                && url.path().eq_ignore_ascii_case("/appmaptile")
        })
}

struct Gate {
    slots: Arc<Semaphore>,
    state: Mutex<State>,
    spacing: Duration,
}

struct State {
    next: Option<Instant>,
    spacing: Duration,
    successes: u8,
}

pub(crate) struct Permit {
    gate: Arc<Gate>,
    _slot: OwnedSemaphorePermit,
}

impl Permit {
    pub(crate) fn limited(&self, delay: Duration) { self.gate.limited(delay); }
    pub(crate) fn succeeded(&self) { self.gate.succeeded(); }
}

impl Gate {
    fn new(slots: usize, spacing: Duration) -> Self {
        Self { slots: Arc::new(Semaphore::new(slots)),
            state: Mutex::new(State { next: None, spacing, successes: 0 }), spacing }
    }

    fn limited(&self, delay: Duration) {
        let mut state = self.state.lock().unwrap();
        state.spacing = (state.spacing * 2).min(Duration::from_secs(1));
        state.successes = 0;
        // Never allow untrusted Retry-After values to overflow Instant.
        let until = Instant::now() + delay.min(Duration::from_secs(86_400));
        state.next = Some(state.next.map_or(until, |next| next.max(until)));
    }

    fn succeeded(&self) {
        let mut state = self.state.lock().unwrap();
        state.successes = state.successes.saturating_add(1);
        if state.successes >= 16 {
            state.spacing = (state.spacing * 3 / 4).max(self.spacing);
            state.successes = 0;
        }
    }

    async fn acquire(&self) -> OwnedSemaphorePermit {
        let permit = self.slots.clone().acquire_owned().await.expect("Amap gate is never closed");
        // Recheck after waking. If a busy runtime wakes several waiters together,
        // only one can claim a start; sleeping past an old deadline cannot burst.
        loop {
            let until = {
                let mut state = self.state.lock().unwrap();
                let now = Instant::now();
                match state.next {
                    Some(until) if until > now => Some(until),
                    _ => { state.next = Some(now + state.spacing); None }
                }
            };
            match until {
                Some(until) => tokio::time::sleep_until(until).await,
                None => return permit,
            }
        }
    }
}

pub(crate) async fn acquire(url: &str) -> Option<Permit> {
    let gate = if applies(url) {
        AMAP.get_or_init(|| Arc::new(Gate::new(MAX_IN_FLIGHT, REQUEST_SPACING)))
    } else if crate::tianditu_tokens::is_tianditu_url(url) {
        TIANDITU.get_or_init(|| Arc::new(Gate::new(MAX_IN_FLIGHT, TIANDITU_SPACING)))
    } else { return None; };
    Some(Permit { gate: gate.clone(), _slot: gate.acquire().await })
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    for gate in [&AMAP, &TIANDITU].into_iter().filter_map(OnceLock::get) {
        *gate.state.lock().unwrap() = State { next: None, spacing: gate.spacing, successes: 0 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_amap_tile_hosts_share_the_budget() {
        for url in [
            "https://webrd0{s}.is.autonavi.com/appmaptile?style=8&x={x}",
            "https://webst04.is.autonavi.com/appmaptile?style=6",
            "https://WEBST01.IS.AUTONAVI.COM.:443/appmaptile",
        ] { assert!(applies(url), "{url}"); }
        for url in [
            "https://example.com/appmaptile?host=autonavi.com",
            "https://autonavi.com.example.com/appmaptile",
            "https://autonavi.com@example.com/appmaptile",
            "https://restapi.amap.com/v3/geocode/geo",
            "https://tile.openstreetmap.org/1/0/0.png",
        ] { assert!(!applies(url), "{url}"); }
    }

    #[tokio::test]
    async fn concurrent_callers_start_at_separate_intervals() {
        let gate = Arc::new(Gate::new(4, Duration::from_millis(15)));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let gate = gate.clone();
            tasks.push(tokio::spawn(async move {
                let _permit = gate.acquire().await;
                Instant::now()
            }));
        }
        let mut starts = Vec::new();
        for task in tasks { starts.push(task.await.unwrap()); }
        starts.sort();
        for pair in starts.windows(2) {
            assert!(pair[1].duration_since(pair[0]) >= Duration::from_millis(12));
        }
    }

    #[tokio::test]
    async fn permits_bound_in_flight_requests_and_cancel_cleanly() {
        let gate = Arc::new(Gate::new(2, Duration::ZERO));
        let first = gate.acquire().await;
        let second = gate.acquire().await;
        let waiting = tokio::spawn({ let gate = gate.clone(); async move { gate.acquire().await } });
        tokio::task::yield_now().await;
        assert_eq!(gate.slots.available_permits(), 0);
        assert!(!waiting.is_finished());
        waiting.abort();
        let _ = waiting.await;
        drop(first); drop(second);
        assert_eq!(gate.slots.available_permits(), 2);
        let _next = tokio::time::timeout(Duration::from_secs(1), gate.acquire()).await.unwrap();
    }

    #[tokio::test]
    async fn cooldown_postpones_already_waiting_requests_without_a_restart_burst() {
        let gate = Arc::new(Gate::new(4, Duration::from_millis(10)));
        let first = gate.acquire().await;
        let waiting = tokio::spawn({ let gate = gate.clone(); async move {
            let _permit = gate.acquire().await; Instant::now()
        }});
        tokio::task::yield_now().await;
        let limited = Instant::now();
        gate.limited(Duration::from_millis(80));
        drop(first);
        let next = waiting.await.unwrap();
        assert!(next.duration_since(limited) >= Duration::from_millis(75));
        let _third = gate.acquire().await;
        assert!(Instant::now().duration_since(next) >= Duration::from_millis(15));
        for _ in 0..32 { gate.succeeded(); }
        assert_eq!(gate.state.lock().unwrap().spacing, Duration::from_millis(11) + Duration::from_micros(250));
    }
}
