//! Task-local transport counters. Never retains URLs, queries, keys or paths.
use serde::{Deserialize, Serialize};
use std::{collections::{VecDeque,BTreeMap}, sync::Mutex, time::Duration};
use tokio::time::Instant;

pub fn millis(value: Duration) -> u64 { value.as_millis().min(9_007_199_254_740_991) as u64 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionDiagnostic {
    pub version: u8,
    pub scheduler: Option<SchedulerDiagnostic>,
    pub overpass: Option<OverpassDiagnostic>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchedulerDiagnostic {
    pub provider: String,
    pub requests: u64, pub responses: u64, pub http_404: u64,
    pub http_429: u64, pub http_503: u64, pub timeouts: u64, pub network_errors: u64,
    /// Sum across request workers; may exceed wall time when workers wait together.
    pub gate_wait_ms: u64, pub retry_wait_ms: u64,
    pub last_backoff_ms: u64, pub max_backoff_ms: u64,
    pub observed_ms: u64, pub peak_qps: u64, pub max_in_flight: u64, pub waiting_requests: u64,
    /// Latest observed provider gate values, including a rejection's reduction.
    pub target_qps: Option<u32>, pub target_concurrency: Option<u32>,
    pub user_rate: u32, pub user_batch_size: u32, pub user_batch_pause_ms: u32,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverpassDiagnostic {
    pub queue_wait_ms: Option<u64>, pub fallback_count: u32, pub wait_ms: u64,
    pub attempts: Vec<OverpassAttempt>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OverpassAttempt {
    pub endpoint: String, pub outcome: String, pub http_status: Option<u16>,
    pub elapsed_ms: u64, pub backoff_ms: u64,
}
struct State { diagnostic: SchedulerDiagnostic, first: Option<Instant>, starts: VecDeque<Instant>, active: u64, waits:BTreeMap<u64,Instant>, next_wait:u64 }
impl Default for State { fn default() -> Self { Self { diagnostic: SchedulerDiagnostic {provider:"tianditu".into(),..Default::default()}, first: None, starts: VecDeque::new(), active: 0,waits:BTreeMap::new(),next_wait:0 } } }
#[derive(Default)]
pub struct Tracker(Mutex<State>);
pub struct Request<'a>(&'a Tracker);
impl Drop for Request<'_> { fn drop(&mut self) { self.0.0.lock().unwrap().active -= 1; } }
pub struct Wait<'a>(&'a Tracker,u64);
impl Drop for Wait<'_> {fn drop(&mut self){let mut s=self.0.0.lock().unwrap();if let Some(start)=s.waits.remove(&self.1){s.diagnostic.gate_wait_ms=s.diagnostic.gate_wait_ms.saturating_add(millis(start.elapsed())).min(9_007_199_254_740_991);}}}
impl Tracker {
    pub fn waiting(&self)->Wait<'_>{let mut s=self.0.lock().unwrap();let now=Instant::now();s.first.get_or_insert(now);let id=s.next_wait;s.next_wait=s.next_wait.wrapping_add(1);s.waits.insert(id,now);Wait(self,id)}
    pub(crate) fn gate_wait(&self, elapsed: Duration, caps: Option<(u32, usize)>, user: crate::download_scheduling::UserPolicy) {
        let mut s=self.0.lock().unwrap(); let d=&mut s.diagnostic;
        d.gate_wait_ms=d.gate_wait_ms.saturating_add(millis(elapsed)).min(9_007_199_254_740_991);
        if let Some((q,c))=caps {d.target_qps=(q>0).then_some(q);d.target_concurrency=u32::try_from(c).ok();}
        d.user_rate=user.rate; d.user_batch_size=user.batch_size; d.user_batch_pause_ms=user.batch_pause_ms;
    }
    pub fn request(&self) -> Request<'_> {
        let mut s=self.0.lock().unwrap(); let now=Instant::now();
        s.first.get_or_insert(now);
        while s.starts.front().is_some_and(|t| now.duration_since(*t)>=Duration::from_secs(1)) { s.starts.pop_front(); }
        s.starts.push_back(now); s.active+=1;
        s.diagnostic.requests+=1; s.diagnostic.peak_qps=s.diagnostic.peak_qps.max(s.starts.len() as u64);
        s.diagnostic.max_in_flight=s.diagnostic.max_in_flight.max(s.active);
        Request(self)
    }
    pub fn response(&self, status: u16) {
        let mut s=self.0.lock().unwrap(); let d=&mut s.diagnostic; d.responses+=1;
        match status {404=>d.http_404+=1,429=>d.http_429+=1,503=>d.http_503+=1,_=>{}}
    }
    pub fn error(&self, timeout: bool) { let mut s=self.0.lock().unwrap(); if timeout {s.diagnostic.timeouts+=1;}else{s.diagnostic.network_errors+=1;} }
    pub fn backoff(&self, delay: Duration, caps: Option<(u32,usize)>) { let mut s=self.0.lock().unwrap(); s.diagnostic.last_backoff_ms=millis(delay); s.diagnostic.max_backoff_ms=s.diagnostic.max_backoff_ms.max(millis(delay)); if let Some((q,c))=caps {s.diagnostic.target_qps=(q>0).then_some(q);s.diagnostic.target_concurrency=u32::try_from(c).ok();} }
    pub fn retry_wait(&self, delay: Duration) { let mut s=self.0.lock().unwrap(); s.diagnostic.retry_wait_ms=s.diagnostic.retry_wait_ms.saturating_add(millis(delay)).min(9_007_199_254_740_991); }
    pub fn snapshot(&self) -> Option<ExecutionDiagnostic> {
        let s=self.0.lock().unwrap(); let first=s.first?; let mut d=s.diagnostic.clone(); d.observed_ms=millis(first.elapsed());
        d.waiting_requests=s.waits.len() as u64;
        for start in s.waits.values(){d.gate_wait_ms=d.gate_wait_ms.saturating_add(millis(start.elapsed())).min(9_007_199_254_740_991);}
        Some(ExecutionDiagnostic {version:1,scheduler:Some(d),overpass:None})
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test]
    async fn requests_responses_limits_waits_and_tasks_are_separate() {
        let a=Tracker::default();let b=Tracker::default();assert!(a.snapshot().is_none());
        a.gate_wait(Duration::from_millis(30),Some((8,2)),crate::download_scheduling::UserPolicy{rate:4,batch_size:10,batch_pause_ms:1000});
        let x=a.request();let y=a.request();a.response(429);a.response(404);a.error(true);a.backoff(Duration::from_secs(7),Some((4,1)));a.retry_wait(Duration::from_millis(300));drop((x,y));
        let d=a.snapshot().unwrap().scheduler.unwrap();assert_eq!((d.requests,d.responses,d.http_429,d.http_404),(2,2,1,1));
        assert_eq!((d.peak_qps,d.max_in_flight,d.gate_wait_ms,d.retry_wait_ms,d.max_backoff_ms),(2,2,30,300,7000));
        assert_eq!(d.target_qps,Some(4));assert_eq!(d.user_rate,4);assert!(b.snapshot().is_none());
        let serialized=serde_json::to_string(&a.snapshot()).unwrap();for secret in ["http://","token","query","path"] {assert!(!serialized.contains(secret));}
        if let Ok(dir)=std::env::var("GEOD_EXECUTION_DIAGNOSTIC_FIXTURES") {std::fs::create_dir_all(&dir).unwrap();std::fs::write(std::path::Path::new(&dir).join("scheduler.json"),serialized).unwrap();}
    }
    #[tokio::test]
    async fn pending_and_cancelled_admission_wait_is_visible_without_a_fake_request() {
        let tracker=Tracker::default();let wait=tracker.waiting();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let d=tracker.snapshot().unwrap().scheduler.unwrap();assert_eq!((d.requests,d.waiting_requests),(0,1));assert!(d.gate_wait_ms>=20);
        drop(wait);
        let d=tracker.snapshot().unwrap().scheduler.unwrap();assert_eq!((d.requests,d.waiting_requests),(0,0));assert!(d.gate_wait_ms>=20);
    }
}
