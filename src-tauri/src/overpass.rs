//! Bounded, sequential Overpass requests. Never accept a partial query as success.
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tokio::{sync::Semaphore, time::Instant};
use crate::execution_diagnostic::{millis,ExecutionDiagnostic,OverpassDiagnostic,OverpassAttempt};

fn diagnostic(progress:&mut impl FnMut(String), value:&OverpassDiagnostic) {
    let value=ExecutionDiagnostic {version:1,scheduler:None,overpass:Some(value.clone())};
    if let Ok(json)=serde_json::to_string(&value) { progress(format!("OVERPASS_DIAGNOSTIC:{json}")); }
}

const ENDPOINTS: &[&str] = &[
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];
// Concurrent OSM tasks share one request slot, including any server cooldown.
static REQUEST_SLOT: Semaphore = Semaphore::const_new(1);

#[derive(Clone, Copy)]
struct Policy {
    request: Duration,
    total: Duration,
    rate_limit_wait: Duration,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(150),
            total: Duration::from_secs(300),
            rate_limit_wait: Duration::from_secs(30),
        }
    }
}

struct Failure {
    message: String,
    retryable: bool,
    wait: Duration,
    code: &'static str,
}
impl Failure {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            wait: Duration::ZERO,
            code: "OSM_SERVICE_UNAVAILABLE",
        }
    }
}

pub async fn query(
    query: &str,
    proxy: Option<&str>,
    mut progress: impl FnMut(String),
) -> Result<Value, String> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!(
            "GeoD/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/gaopengbin/geo-downloader)"
        ));
    if let Some(proxy) = proxy.filter(|p| !p.trim().is_empty()) {
        // Keep the user's selected route; failover never silently bypasses a proxy.
        builder = builder.proxy(
            reqwest::Proxy::all(proxy)
                .map_err(|_| "OSM_SERVICE_UNAVAILABLE: 代理地址无效，请检查代理设置。")?,
        );
    }
    let client = builder
        .build()
        .map_err(|_| "OSM_SERVICE_UNAVAILABLE: 无法创建网络客户端。")?;
    progress("OVERPASS_QUEUED".into());
    diagnostic(&mut progress,&OverpassDiagnostic::default());
    let queued=Instant::now();
    let _slot = REQUEST_SLOT
        .acquire()
        .await
        .map_err(|_| "OSM_SERVICE_UNAVAILABLE: 请求队列已关闭。")?;
    query_diagnosed(query, &client, ENDPOINTS, Policy::default(), millis(queued.elapsed()), progress).await
}

#[cfg(test)]
async fn query_with_client(
    query: &str,
    client: &Client,
    endpoints: &[&str],
    policy: Policy,
    progress: impl FnMut(String),
) -> Result<Value, String> {
    query_diagnosed(query,client,endpoints,policy,0,progress).await
}

async fn query_diagnosed(query:&str,client:&Client,endpoints:&[&str],policy:Policy,queue_wait_ms:u64,mut progress:impl FnMut(String)) -> Result<Value,String> {
    let mut observed=OverpassDiagnostic {queue_wait_ms:Some(queue_wait_ms),..Default::default()};
    let deadline = Instant::now() + policy.total;
    let mut failures = Vec::new();
    for (index, endpoint) in endpoints.iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let host = reqwest::Url::parse(endpoint)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| "Overpass".into());
        progress(format!(
            "OVERPASS_REQUEST:{}:{}:{host}",
            index + 1,
            endpoints.len()
        ));
        let started=Instant::now();
        let endpoint_id=match reqwest::Url::parse(endpoint).ok().and_then(|u|u.host_str().map(str::to_owned)).as_deref() {
            Some("overpass-api.de")=>"de",Some("maps.mail.ru")=>"mailru",Some("overpass.private.coffee")=>"privatecoffee",_=>"other"};
        let mut observation=OverpassAttempt {endpoint:endpoint_id.into(),outcome:"requesting".into(),http_status:None,elapsed_ms:0,backoff_ms:0};
        observed.attempts.push(observation.clone());
        observed.fallback_count=index as u32;
        diagnostic(&mut progress,&observed);
        let result = tokio::time::timeout_at(
            deadline,
            attempt(
                client,
                endpoint,
                query,
                policy.request.min(remaining),
                policy.rate_limit_wait,
                &mut observation,
            ),
        )
        .await
        .unwrap_or_else(|_| Err(Failure::unavailable("请求总时限已到")));
        observation.elapsed_ms=millis(started.elapsed());
        if observation.outcome=="requesting" {observation.outcome="deadline".into();}
        *observed.attempts.last_mut().unwrap()=observation;
        diagnostic(&mut progress,&observed);
        match result {
            Ok(value) => return Ok(value),
            Err(error) => {
                failures.push(format!("{host}: {}", error.message));
                progress(format!("OVERPASS_ERROR: {}", failures.last().unwrap()));
                if !error.retryable {
                    return Err(format!("{}: {}", error.code, failures.join("；")));
                }
                if index + 1 == endpoints.len() {
                    break;
                }
                if !error.wait.is_zero() {
                    if error.wait >= deadline.saturating_duration_since(Instant::now()) {
                        failures.push("服务要求的冷却时间超过本次等待上限，请稍后重试".into());
                        break;
                    }
                    progress(format!("OVERPASS_WAIT:{}", error.wait.as_secs().max(1)));
                    let waiting=Instant::now();
                    tokio::time::sleep(error.wait).await;
                    observed.wait_ms=observed.wait_ms.saturating_add(millis(waiting.elapsed()));
                    diagnostic(&mut progress,&observed);
                }
                if Instant::now() < deadline {
                    progress(format!(
                        "OVERPASS_FALLBACK:{}:{}",
                        index + 2,
                        endpoints.len()
                    ));
                }
            }
        }
    }
    Err(format!(
        "OSM_SERVICE_UNAVAILABLE: {}。本次未生成输出文件，请检查网络或代理，或稍后重试。",
        failures.join("；")
    ))
}

async fn attempt(
    client: &Client,
    endpoint: &str,
    query: &str,
    timeout: Duration,
    rate_limit_wait: Duration,
    observation: &mut OverpassAttempt,
) -> Result<Value, Failure> {
    let response = client
        .post(endpoint)
        .timeout(timeout)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("data={}", urlencoding::encode(query)))
        .send()
        .await
        .map_err(|error| {observation.outcome=transport_outcome(&error).into();transport_failure(error)})?;
    let status = response.status();
    observation.http_status=Some(status.as_u16());
    if !status.is_success() {
        observation.outcome="http_error".into();
        let retryable = status.is_server_error() || matches!(status.as_u16(), 408 | 429 | 406);
        let wait = if matches!(status.as_u16(), 429 | 406) {
            let specified = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(retry_after)
                .unwrap_or_default();
            rate_limit_wait.max(specified)
        } else {
            Duration::ZERO
        };
        observation.backoff_ms=millis(wait);
        return Err(Failure {
            message: format!("HTTP {status}"),
            retryable,
            wait,
            code: if retryable {
                "OSM_SERVICE_UNAVAILABLE"
            } else {
                "OSM_REQUEST_REJECTED"
            },
        });
    }
    let bytes = response.bytes().await.map_err(|error|{observation.outcome=if error.is_timeout(){"timeout"}else{"body_error"}.into();transport_failure(error)})?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| {observation.outcome="invalid_json".into();Failure::unavailable("服务返回的数据不是有效 JSON")})?;
    // Overpass may return HTTP 200 with both partial elements and a runtime remark.
    if let Some(remark) = value
        .get("remark")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        observation.outcome="incomplete".into();
        return Err(Failure {
            message: format!(
                "服务端未完整执行查询：{}；请缩小范围后重试",
                remark.chars().take(400).collect::<String>()
            ),
            retryable: false,
            wait: Duration::ZERO,
            code: "OSM_QUERY_INCOMPLETE",
        });
    }
    if !value.get("elements").is_some_and(Value::is_array) {
        observation.outcome="invalid_response".into();
        return Err(Failure::unavailable("服务返回的数据缺少 elements 数组"));
    }
    observation.outcome="success".into();
    Ok(value)
}

fn transport_outcome(error:&reqwest::Error)->&'static str {
    if error.is_timeout(){"timeout"}else if error.is_connect(){"connect_error"}else if error.is_body(){"body_error"}else{"request_error"}
}

fn transport_failure(error: reqwest::Error) -> Failure {
    // reqwest's top-level text hides useful causes and can include proxy credentials.
    Failure::unavailable(if error.is_timeout() {
        "连接或读取超时"
    } else if error.is_connect() {
        "无法连接服务（网络、DNS、TLS 或代理连接失败）"
    } else if error.is_body() {
        "响应传输中断"
    } else {
        "请求发送或接收失败"
    })
}

fn retry_after(value: &str) -> Option<Duration> {
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let deadline = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let seconds = deadline
        .signed_duration_since(chrono::Utc::now())
        .num_seconds()
        .max(0);
    Some(Duration::from_secs(seconds as u64))
}

#[cfg(test)]
mod tests;
