//! Ordered, task-scoped credential failover. Tokens never appear in task logs.
use crate::settings::{AppSettings, SettingsManager};
use std::collections::HashSet;
use serde::{Serialize, Deserialize};
use std::sync::{Arc, Mutex, OnceLock, Weak};

type Logger = Arc<dyn Fn(&str) + Send + Sync>;
static LIVE_POOLS: OnceLock<Mutex<Vec<Weak<TiandituTokens>>>> = OnceLock::new();

pub fn normalize_tokens(primary: Option<&str>, backups: &[String]) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in primary
        .into_iter()
        .chain(backups.iter().map(String::as_str))
    {
        let token = token.trim();
        if !token.is_empty() && !tokens.iter().any(|value| value == token) {
            tokens.push(token.to_owned());
        }
    }
    tokens
}

fn configured_tokens(settings: &AppSettings, fallback: Option<&str>) -> Vec<String> {
    let tokens = normalize_tokens(
        settings.tianditu_token.as_deref(),
        &settings.tianditu_backup_tokens,
    );
    if tokens.is_empty() {
        // Explicit request credentials remain supported for CLI callers. Desktop
        // resume supplies the freshly saved primary, including an explicit clear.
        let fallback = fallback.map(str::trim).filter(|token| !token.is_empty());
        normalize_tokens(
            Some(fallback.unwrap_or(crate::config::TIANDITU_DEFAULT_TOKEN)),
            &[],
        )
    } else {
        tokens
    }
}

pub fn is_tianditu_url(template: &str) -> bool {
    reqwest::Url::parse(&template.replace("{s}", "0"))
        .ok()
        .and_then(|url| {
            url.host_str().map(|host| {
                let host = host.trim_end_matches('.').to_ascii_lowercase();
                host == "tianditu.gov.cn" || host.ends_with(".tianditu.gov.cn")
            })
        })
        .unwrap_or(false)
}

// Keep fixed URL parameters and replace only tk. Never send credentials to a
// host merely containing the provider's name in its path or query string.
pub fn token_url(url: &str, token: &str) -> String {
    let mut parsed = reqwest::Url::parse(url).expect("validated tile URL");
    let pairs: Vec<_> = parsed
        .query_pairs()
        .filter(|(key, _)| key != "tk")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    parsed
        .query_pairs_mut()
        .clear()
        .extend_pairs(pairs)
        .append_pair("tk", token);
    parsed.to_string()
}

/// Only bounded counters and fixed categories cross the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenDiagnostics {
    pub diagnostic_version: u8,
    pub provider: String,
    pub phase: String,
    pub token_source: String,
    pub configured_tokens: u32,
    pub used_tokens: u32,
    pub token_switches: u32,
    pub recovered_switches: u32,
    pub settings_updates: u32,
    pub last_rejection_status: u16,
    pub tokens_exhausted: bool,
    #[serde(default)]
    pub acquisition: crate::acquisition_diagnostic::AcquisitionDiagnostic,
}

struct State {
    tokens: Vec<String>,
    active: usize,
    generation: u64,
    used_tokens: HashSet<String>,
    switches: u32,
    recovered: u32,
    updates: u32,
    last_status: u16,
    awaiting_recovery: bool,
    phase: String,
    provider: String,
    acquisition:crate::acquisition_diagnostic::AcquisitionDiagnostic,
    active_source:Option<usize>,
}

// Do not derive Debug: this value contains a credential.
#[derive(Clone)]
pub struct Selection {
    pub token: String,
    index: usize,
    generation: u64,
}

pub struct TiandituTokens {
    state: Mutex<State>,
    logger: Logger,
}

impl TiandituTokens {
    pub fn new(tokens: Vec<String>, logger: Logger) -> Self {
        Self {
            state: Mutex::new(State {
                tokens,
                active: 0,
                generation: 0,
                used_tokens: HashSet::new(), switches: 0, recovered: 0,
                updates: 0, last_status: 0, awaiting_recovery: false,
                phase: "prepare".into(), provider: "unknown".into(),
                acquisition:Default::default(),active_source:None,
            }),
            logger,
        }
    }

    /// One pool for all zooms and annotation layers of a task; setting saves
    /// update live pools. Completed files are unaffected by credential changes.
    pub fn for_task(fallback: Option<&str>, logger: Logger) -> Arc<Self> {
        let mut registry = LIVE_POOLS.get_or_init(Default::default).lock().unwrap();
        let settings = SettingsManager::new()
            .and_then(|manager| manager.get())
            .unwrap_or_default();
        let pool = Arc::new(Self::new(configured_tokens(&settings, fallback), logger));
        registry.retain(|pool| pool.strong_count() > 0);
        registry.push(Arc::downgrade(&pool));
        pool
    }

    pub fn current(&self) -> Result<Selection, String> {
        let state = self.state.lock().unwrap();
        state
            .tokens
            .get(state.active)
            .map(|token| Selection {
                token: token.clone(),
                index: state.active,
                generation: state.generation,
            })
            .ok_or_else(|| Self::exhausted(state.tokens.len()))
    }

    pub fn set_stage(&self, phase: &str, tianditu: bool) {
        let mut state = self.state.lock().unwrap();
        state.phase = phase.to_owned();
        state.provider = if tianditu { "tianditu" } else { "other" }.into();
        state.acquisition.phase=phase.into();
    }

    pub fn configure_diagnostic_sources(&self,sources:&[crate::config::TileSource]){
        let mut state=self.state.lock().unwrap();state.acquisition.sources.clear();
        for(i,source)in sources.iter().enumerate(){
            if i<8{state.acquisition.sources.push(crate::acquisition_diagnostic::describe_source(if i==0{"base"}else{"overlay"},&source.url,!source.headers.is_empty()||is_tianditu_url(&source.url)));}
            else{state.acquisition.additional_sources=state.acquisition.additional_sources.saturating_add(1);}
        }
        state.active_source=(!state.acquisition.sources.is_empty()).then_some(0);
    }
    pub fn select_diagnostic_source(&self,index:usize){let mut state=self.state.lock().unwrap();state.active_source=(index<state.acquisition.sources.len()).then_some(index);}
    pub fn observe_http(&self,host:&str,status:u16){let mut state=self.state.lock().unwrap();if let Some(i)=state.active_source{state.acquisition.response(i,host,status);}}
    pub fn set_storage_diagnostics(&self,storage:Vec<crate::acquisition_diagnostic::StorageDiagnostic>){let mut state=self.state.lock().unwrap();state.acquisition.storage=storage;state.acquisition.storage_checked_at=Some(chrono::Utc::now().to_rfc3339());}
    pub fn record_failure(&self,message:&str){
        let mut state=self.state.lock().unwrap();
        let code=["TILE_ACCESS_DENIED","TILE_TOKENS_EXHAUSTED","TILE_RATE_LIMITED","TILE_STORAGE_FAILED","TILE_REDIRECT_DENIED","INVALID_TILE","TILE_TOO_LARGE","OSM_OFFLINE_FORBIDDEN","CARTO_OFFLINE_FORBIDDEN"].into_iter().find(|code|message.contains(code)).unwrap_or(if message.contains("空间不足"){"DISK_INSUFFICIENT"}else{"UNKNOWN"});
        let index=if ["base_download","overlay_download"].contains(&state.acquisition.phase.as_str())&&code!="TILE_STORAGE_FAILED"{state.active_source}else{None};
        let status=crate::acquisition_diagnostic::http_status(message).or_else(||if code=="TILE_TOKENS_EXHAUSTED"&&state.last_status>0{Some(state.last_status)}else{None});
        state.acquisition.fail(code,index,status);if code=="TILE_STORAGE_FAILED"{state.acquisition.phase="cache".into();}
    }
    pub fn record_completed(&self){let mut state=self.state.lock().unwrap();state.acquisition.phase="completed".into();state.acquisition.error_code=None;state.acquisition.error_http_status=None;state.acquisition.failed_source=None;}

    pub fn record_request(&self, used: &Selection) {
        let mut state = self.state.lock().unwrap();
        state.used_tokens.insert(used.token.clone());
    }

    pub fn record_success(&self, used: &Selection) {
        let mut state = self.state.lock().unwrap();
        if used.generation == state.generation && used.index == state.active && state.awaiting_recovery {
            state.recovered = state.recovered.saturating_add(1);
            state.awaiting_recovery = false;
        }
    }

    pub fn diagnostics(&self) -> TokenDiagnostics {
        let state = self.state.lock().unwrap();
        let relevant=state.acquisition.sources.is_empty()||state.provider=="tianditu"||!state.used_tokens.is_empty()||state.acquisition.sources.iter().any(|s|s.provider=="tianditu");
        TokenDiagnostics {
            diagnostic_version: 1, provider: state.provider.clone(), phase: state.phase.clone(),
            token_source: if state.tokens.len() == 1 && state.tokens[0] == crate::config::TIANDITU_DEFAULT_TOKEN { "builtin" } else { "user" }.into(),
            configured_tokens: if relevant{state.tokens.len().min(65535) as u32}else{0},
            used_tokens: if relevant{state.used_tokens.len().min(65535) as u32}else{0},
            token_switches: if relevant{state.switches.min(65535)}else{0}, recovered_switches: if relevant{state.recovered.min(65535)}else{0},
            settings_updates: if relevant{state.updates.min(65535)}else{0}, last_rejection_status: if relevant{state.last_status}else{0},
            tokens_exhausted: relevant&&state.active >= state.tokens.len(),
            acquisition:state.acquisition.clone(),
        }
    }

    fn exhausted(count: usize) -> String {
        format!("TILE_TOKENS_EXHAUSTED: 天地图的 {} 个 Token 均不可用或额度不足；任务数据已保留。请修改并保存 Token 后继续任务，或稍后重试。", count)
    }

    pub fn reject(&self, used: &Selection, reason: &str) -> Result<(), String> {
        let message = {
            let mut state = self.state.lock().unwrap();
            // Late errors from concurrent requests must not exhaust the next
            // token, or reject a newly saved credential configuration.
            if used.generation != state.generation || used.index != state.active {
                return Ok(());
            }
            state.last_status = match reason { "HTTP 401" => 401, "HTTP 403" => 403, "HTTP 429" => 429, _ => 0 };
            state.active += 1;
            if state.active >= state.tokens.len() {
                let error = Self::exhausted(state.tokens.len());
                drop(state);
                (self.logger)(&error);
                return Err(error);
            }
            state.switches = state.switches.saturating_add(1);
            state.awaiting_recovery = true;
            format!(
                "天地图 {}，自动切换至第 {}/{} 个 Token，继续下载",
                reason,
                state.active + 1,
                state.tokens.len()
            )
        };
        (self.logger)(&message);
        Ok(())
    }

    fn replace(&self, tokens: Vec<String>) {
        let count = tokens.len();
        {
            let mut state = self.state.lock().unwrap();
            // Saving unrelated settings must not reactivate exhausted tokens.
            if state.tokens == tokens {
                return;
            }
            state.updates = state.updates.saturating_add(1);
            state.awaiting_recovery = false;
            state.tokens = tokens;
            state.active = 0;
            state.generation = state.generation.wrapping_add(1);
        }
        (self.logger)(&format!(
            "天地图 Token 设置已更新，后续请求使用最新配置（{} 个 Token）",
            count
        ));
    }
}

/// Call only after settings have been successfully persisted.
pub fn settings_saved(settings: &AppSettings) {
    let pools = {
        let mut registry = LIVE_POOLS.get_or_init(Default::default).lock().unwrap();
        registry.retain(|pool| pool.strong_count() > 0);
        registry
            .iter()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>()
    };
    let tokens = configured_tokens(settings, None);
    for pool in pools {
        pool.replace(tokens.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_unique_tokens_and_legacy_settings() {
        let settings: AppSettings = serde_json::from_str(r#"{"tianditu_token":" old "}"#).unwrap();
        assert_eq!(configured_tokens(&settings, Some("stale")), vec!["old"]);
        assert_eq!(
            normalize_tokens(
                Some(" first "),
                &["second".into(), "first".into(), " ".into()]
            ),
            vec!["first", "second"]
        );
        assert_eq!(configured_tokens(&AppSettings::default(), None).len(), 1);
        assert_eq!(
            configured_tokens(&AppSettings::default(), Some(" ")),
            vec![crate::config::TIANDITU_DEFAULT_TOKEN]
        );
    }

    #[test]
    fn successfully_saved_settings_update_registered_live_tasks_and_clear_old_tokens() {
        let pool = Arc::new(TiandituTokens::new(
            vec!["stale-request".into()],
            Arc::new(|_| {}),
        ));
        LIVE_POOLS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .push(Arc::downgrade(&pool));
        let stale = pool.current().unwrap();
        let mut settings = AppSettings::default();
        settings.tianditu_token = Some("fresh-primary".into());
        settings.tianditu_backup_tokens = vec!["fresh-backup".into()];
        settings_saved(&settings);
        pool.reject(&stale, "HTTP 429").unwrap();
        assert_eq!(pool.current().unwrap().token, "fresh-primary");
        let fresh = pool.current().unwrap();
        pool.reject(&fresh, "HTTP 429").unwrap();
        settings_saved(&settings); // unrelated setting save retains the active backup
        assert_eq!(pool.current().unwrap().token, "fresh-backup");
        settings_saved(&AppSettings::default());
        assert_eq!(
            pool.current().unwrap().token,
            crate::config::TIANDITU_DEFAULT_TOKEN
        );
    }

    #[test]
    fn concurrent_failures_only_advance_once_and_saved_tokens_supersede_in_flight_errors() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let output = logs.clone();
        let pool = Arc::new(TiandituTokens::new(
            vec!["secret-a".into(), "secret-b".into(), "secret-c".into()],
            Arc::new(move |line| output.lock().unwrap().push(line.to_owned())),
        ));
        let used = pool.current().unwrap();
        let handles: Vec<_> = (0..30)
            .map(|_| {
                let used = used.clone();
                let pool = pool.clone();
                std::thread::spawn(move || pool.reject(&used, "HTTP 429").unwrap())
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(pool.current().unwrap().token, "secret-b");
        assert_eq!(logs.lock().unwrap().len(), 1);
        pool.replace(vec!["new-a".into(), "new-b".into()]);
        let used = pool.current().unwrap();
        pool.reject(&used, "HTTP 401").unwrap();
        for _ in 0..30 {
            pool.reject(&used, "HTTP 429").unwrap();
        }
        assert_eq!(pool.current().unwrap().token, "new-b");
        pool.replace(vec!["saved".into()]);
        pool.reject(&used, "HTTP 429").unwrap();
        assert_eq!(pool.current().unwrap().token, "saved");
        let used = pool.current().unwrap();
        assert!(pool
            .reject(&used, "HTTP 429")
            .unwrap_err()
            .starts_with("TILE_TOKENS_EXHAUSTED:"));
        pool.replace(vec!["saved".into()]);
        assert!(pool.current().is_err());
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .all(|line| !line.contains("secret-")
                && !line.contains("new-a")
                && !line.contains("saved")));
    }

    #[test]
    fn diagnostics_count_actual_unique_credentials_and_ignore_stale_concurrency() {
        let pool = TiandituTokens::new(vec!["private-a".into(), "private-b".into()], Arc::new(|_| {}));
        pool.set_stage("overlay_download", true);
        let a = pool.current().unwrap();
        assert_eq!(pool.diagnostics().used_tokens, 0); // selecting isn't a request
        pool.record_request(&a); pool.record_request(&a);
        pool.reject(&a, "HTTP 401").unwrap();
        pool.reject(&a, "HTTP 403").unwrap(); // late failure must not advance again
        pool.record_success(&a); // nor count as successful recovery
        assert_eq!(pool.diagnostics().recovered_switches, 0);
        let b = pool.current().unwrap();
        pool.record_request(&b); pool.record_success(&b); pool.record_success(&b);
        assert_eq!(pool.diagnostics().recovered_switches, 1);
        pool.replace(vec!["private-b".into(), "private-c".into()]);
        pool.record_request(&pool.current().unwrap());
        pool.reject(&a, "HTTP 429").unwrap();
        let d = pool.diagnostics();
        assert_eq!((d.configured_tokens, d.used_tokens, d.token_switches, d.settings_updates), (2,2,1,1));
        assert_eq!(d.last_rejection_status, 401);
        assert_eq!(d.provider, "tianditu"); assert_eq!(d.phase, "overlay_download");
        let json = serde_json::to_string(&d).unwrap();
        assert!(!json.contains("private-"));
    }

    #[test]
    fn only_provider_hosts_and_tk_are_changed() {
        assert!(is_tianditu_url(
            "https://t{s}.tianditu.gov.cn/img_w/wmts?tk=old"
        ));
        for url in [
            "https://evil.test/tianditu.gov.cn",
            "https://tianditu.gov.cn.evil.test/a",
            "https://tianditu.gov.cn@evil.test/a",
        ] {
            assert!(!is_tianditu_url(url));
        }
        let url = token_url(
            "https://t0.tianditu.gov.cn/wmts?x=2&tk=old&hl=en&tk=duplicate",
            "new",
        );
        let parsed = reqwest::Url::parse(&url).unwrap();
        let pairs: Vec<_> = parsed.query_pairs().collect();
        assert_eq!(
            pairs,
            vec![
                ("x".into(), "2".into()),
                ("hl".into(), "en".into()),
                ("tk".into(), "new".into())
            ]
        );
    }
}
