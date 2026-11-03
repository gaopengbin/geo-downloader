//! Bounded, sequential Overpass requests. Never accept a partial query as success.
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tokio::{sync::Semaphore, time::Instant};

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
    let _slot = REQUEST_SLOT
        .acquire()
        .await
        .map_err(|_| "OSM_SERVICE_UNAVAILABLE: 请求队列已关闭。")?;
    query_with_client(query, &client, ENDPOINTS, Policy::default(), progress).await
}

async fn query_with_client(
    query: &str,
    client: &Client,
    endpoints: &[&str],
    policy: Policy,
    mut progress: impl FnMut(String),
) -> Result<Value, String> {
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
        let result = tokio::time::timeout_at(
            deadline,
            attempt(
                client,
                endpoint,
                query,
                policy.request.min(remaining),
                policy.rate_limit_wait,
            ),
        )
        .await
        .unwrap_or_else(|_| Err(Failure::unavailable("请求总时限已到")));
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
                    tokio::time::sleep(error.wait).await;
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
) -> Result<Value, Failure> {
    let response = client
        .post(endpoint)
        .timeout(timeout)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("data={}", urlencoding::encode(query)))
        .send()
        .await
        .map_err(transport_failure)?;
    let status = response.status();
    if !status.is_success() {
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
    let bytes = response.bytes().await.map_err(transport_failure)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Failure::unavailable("服务返回的数据不是有效 JSON"))?;
    // Overpass may return HTTP 200 with both partial elements and a runtime remark.
    if let Some(remark) = value
        .get("remark")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
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
        return Err(Failure::unavailable("服务返回的数据缺少 elements 数组"));
    }
    Ok(value)
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
