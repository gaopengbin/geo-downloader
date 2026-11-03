//! User pacing, composed with provider backoff at the same request admission point.
use crate::settings::AppSettings;
use rand::Rng;
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::time::Instant;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct UserPolicy {
    pub rate: u32,
    pub batch_size: u32,
    pub batch_pause_ms: u32,
}
impl UserPolicy {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            rate: settings.download_rate_limit,
            batch_size: settings.download_batch_size,
            batch_pause_ms: settings.download_batch_pause_ms,
        }
    }
    pub fn validate(self) -> Result<(), String> {
        if self.rate > 10_000 {
            return Err("每秒请求上限须为 0–10000".into());
        }
        if self.batch_size > 100_000 {
            return Err("每批请求数须为 0–100000".into());
        }
        if self.batch_pause_ms > 600_000 {
            return Err("批次停顿须为 0–600000 毫秒".into());
        }
        Ok(())
    }
    pub fn enabled(self) -> bool {
        self.rate > 0 || self.batch_size > 0
    }
    fn spacing(self) -> Option<Duration> {
        (self.rate > 0).then(|| Duration::from_secs_f64(1.0 / f64::from(self.rate)))
    }
    fn pause(self) -> Duration {
        Duration::from_millis(if self.batch_pause_ms == 0 {
            rand::thread_rng().gen_range(600..=2200)
        } else {
            u64::from(self.batch_pause_ms)
        })
    }
}

static POLICY: OnceLock<Mutex<UserPolicy>> = OnceLock::new();
pub(crate) fn current() -> UserPolicy {
    *POLICY
        .get_or_init(|| {
            let policy = crate::settings::SettingsManager::new()
                .and_then(|m| m.get())
                .map(|s| UserPolicy::from_settings(&s))
                .unwrap_or_default();
            Mutex::new(if policy.validate().is_ok() {
                policy
            } else {
                UserPolicy::default()
            })
        })
        .lock()
        .unwrap()
}
pub(crate) fn configure(settings: &AppSettings) {
    let requested = UserPolicy::from_settings(settings);
    let policy = if requested.validate().is_ok() {
        requested
    } else {
        UserPolicy::default()
    };
    *POLICY.get_or_init(|| Mutex::new(policy)).lock().unwrap() = policy;
}

#[derive(Default)]
pub(crate) struct UserState {
    policy: UserPolicy,
    starts: VecDeque<Instant>,
    next: Option<Instant>,
    batch_started: u32,
    batch_active: usize,
    generation: u64,
    pause_until: Option<Instant>,
}
impl UserState {
    pub fn pause_remaining(&self, now: Instant) -> Option<Duration> {
        self.pause_until
            .and_then(|until| until.checked_duration_since(now))
            .filter(|delay| !delay.is_zero())
    }
    pub fn configure(&mut self, policy: UserPolicy) {
        if self.policy.rate != policy.rate {
            self.next = policy
                .spacing()
                .and_then(|spacing| self.starts.back().map(|last| *last + spacing));
        }
        if self.policy.batch_size != policy.batch_size
            || self.policy.batch_pause_ms != policy.batch_pause_ms
        {
            self.generation = self.generation.wrapping_add(1);
            self.batch_started = 0;
            self.batch_active = 0;
            self.pause_until = None;
        }
        self.policy = policy;
    }
    /// None means the previous batch still has live requests, not a timed pause.
    pub fn ready_at(&mut self, now: Instant) -> Option<Instant> {
        if self.policy.batch_size > 0 && self.batch_started >= self.policy.batch_size {
            if self.batch_active > 0 {
                return None;
            }
            if let Some(until) = self.pause_until.filter(|until| *until > now) {
                return Some(until);
            }
            self.batch_started = 0;
            self.pause_until = None;
        }
        while self
            .starts
            .front()
            .is_some_and(|start| now.duration_since(*start) >= Duration::from_secs(1))
        {
            self.starts.pop_front();
        }
        let rolling = if self.policy.rate > 0 && self.starts.len() >= self.policy.rate as usize {
            self.starts[self.starts.len() - self.policy.rate as usize] + Duration::from_secs(1)
        } else {
            now
        };
        Some(self.next.unwrap_or(now).max(rolling).max(now))
    }
    pub fn started(&mut self, now: Instant) -> Option<u64> {
        if let Some(spacing) = self.policy.spacing() {
            self.starts.push_back(now);
            // No accumulated credits or restart burst after a long wait.
            self.next = Some(now + spacing);
        }
        if self.policy.batch_size == 0 {
            return None;
        }
        self.batch_started += 1;
        self.batch_active += 1;
        Some(self.generation)
    }
    pub fn finished(&mut self, generation: Option<u64>, now: Instant) {
        if generation != Some(self.generation) {
            return;
        }
        debug_assert!(self.batch_active > 0);
        self.batch_active -= 1;
        if self.batch_active == 0 && self.batch_started >= self.policy.batch_size {
            self.pause_until = Some(now + self.policy.pause());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_pause_starts_after_the_last_request_finishes() {
        let mut state = UserState::default();
        let at = Instant::now();
        state.configure(UserPolicy {
            batch_size: 2,
            batch_pause_ms: 100,
            rate: 0,
        });
        let a = state.started(at);
        let b = state.started(at);
        assert!(state.ready_at(at + Duration::from_secs(1)).is_none());
        state.finished(a, at + Duration::from_millis(10));
        assert!(state.ready_at(at + Duration::from_secs(1)).is_none());
        state.finished(b, at + Duration::from_millis(50));
        assert_eq!(
            state.ready_at(at + Duration::from_millis(70)),
            Some(at + Duration::from_millis(150))
        );
        assert_eq!(
            state.ready_at(at + Duration::from_millis(150)),
            Some(at + Duration::from_millis(150))
        );
        assert_eq!(state.batch_started, 0);
    }
    #[test]
    fn rate_reduction_keeps_recent_requests_and_no_restart_credits() {
        let mut state = UserState::default();
        let at = Instant::now();
        state.configure(UserPolicy {
            rate: 10,
            ..UserPolicy::default()
        });
        for i in 0..5 {
            state.started(at + Duration::from_millis(i * 100));
        }
        state.configure(UserPolicy {
            rate: 2,
            ..UserPolicy::default()
        });
        assert_eq!(
            state.ready_at(at + Duration::from_millis(500)),
            Some(at + Duration::from_millis(1300))
        );
        let later = at + Duration::from_secs(5);
        assert_eq!(state.ready_at(later), Some(later));
        state.started(later);
        assert_eq!(
            state.ready_at(later),
            Some(later + Duration::from_millis(500))
        );
    }
    #[test]
    fn changing_batch_parameters_does_not_count_old_completions_in_the_new_batch() {
        let mut state = UserState::default();
        let at = Instant::now();
        state.configure(UserPolicy {
            batch_size: 1,
            batch_pause_ms: 100,
            rate: 0,
        });
        let old = state.started(at);
        state.configure(UserPolicy {
            batch_size: 2,
            batch_pause_ms: 50,
            rate: 0,
        });
        let current = state.started(at);
        state.finished(old, at);
        assert_eq!(state.batch_active, 1);
        state.finished(current, at);
        assert_eq!(state.batch_active, 0);
        assert_eq!(state.ready_at(at), Some(at));
    }
    #[test]
    fn automatic_pause_is_bounded_and_legacy_policy_adds_no_wait() {
        let policy = UserPolicy {
            batch_size: 32,
            ..UserPolicy::default()
        };
        for _ in 0..100 {
            assert!((Duration::from_millis(600)..=Duration::from_millis(2200))
                .contains(&policy.pause()));
        }
        let mut state = UserState::default();
        let at = Instant::now();
        for _ in 0..100 {
            assert_eq!(state.ready_at(at), Some(at));
            assert_eq!(state.started(at), None);
        }
    }
}
