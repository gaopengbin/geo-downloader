use std::{collections::HashSet, sync::OnceLock, time::Duration};

use dashmap::DashMap;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

use crate::settings::SettingsManager;

const KEYRING_SERVICE: &str = "GeoD";
const KEYRING_ACCOUNT: &str = "deepseek-api-key";
const KNOWLEDGE_JSON: &str = include_str!("../../services/ai-gateway/knowledge/articles.json");
const AGENT_POLICY: &str = r#"You are the built-in assistant for GeoD (technical application name: GeoDownloader).
Answer in Chinese unless the user explicitly asks for another language.
Prefer short, concrete steps that match the current GeoD interface.
Treat the retrieved GeoD knowledge as the product source of truth and state uncertainty when it is insufficient.
Never claim to inspect local files, logs, tasks or settings unless explicit diagnostic context is attached.
Never request provider API keys or help bypass authorization, access controls, usage terms or copyright restrictions.
GeoD navigation links are user-invoked actions, not ordinary web links. Only reproduce exact geod:// links supplied by retrieved knowledge.
Do not claim an action already happened. Explain what the link will open and let the user click it."#;

#[derive(Default)]
pub struct AssistantRuntime {
    requests: DashMap<String, CancellationToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantChatRequest {
    request_id: String,
    messages: Vec<AssistantMessage>,
    diagnostic_context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeAction {
    label: String,
    href: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    id: String,
    title: String,
    summary: String,
    actions: Vec<KnowledgeAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantStreamEvent {
    Sources { sources: Vec<KnowledgeSource> },
    Delta { content: String },
    Done,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatus {
    status: &'static str,
    mode: &'static str,
    configured: bool,
    model: String,
    knowledge: KnowledgeStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeStatus {
    version: String,
    article_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSecretStatus {
    configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeBase {
    content_version: String,
    articles: Vec<KnowledgeArticle>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeArticle {
    id: String,
    title: String,
    summary: String,
    keywords: Vec<String>,
    body: String,
    actions: Vec<KnowledgeAction>,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Option<Vec<StreamChoice>>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: Option<StreamDelta>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("无法访问系统凭据库: {error}"))
}

pub fn set_api_key(api_key: &str) -> Result<(), String> {
    let value = api_key.trim();
    if value.is_empty() {
        return Err("DeepSeek API Key 不能为空".to_string());
    }
    keyring_entry()?
        .set_password(value)
        .map_err(|error| format!("无法将 DeepSeek API Key 保存到系统凭据库: {error}"))
}

pub fn get_api_key() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法从系统凭据库读取 DeepSeek API Key: {error}")),
    }
}

fn delete_api_key() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统凭据库删除 DeepSeek API Key: {error}")),
    }
}

#[tauri::command]
pub async fn assistant_secret_status() -> Result<AssistantSecretStatus, String> {
    let configured = tokio::task::spawn_blocking(get_api_key)
        .await
        .map_err(|error| format!("读取系统凭据库失败: {error}"))??
        .is_some();
    Ok(AssistantSecretStatus { configured })
}

#[tauri::command]
pub async fn assistant_set_api_key(api_key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || set_api_key(&api_key))
        .await
        .map_err(|error| format!("写入系统凭据库失败: {error}"))?
}

#[tauri::command]
pub async fn assistant_delete_api_key() -> Result<(), String> {
    tokio::task::spawn_blocking(delete_api_key)
        .await
        .map_err(|error| format!("访问系统凭据库失败: {error}"))?
}

#[tauri::command]
pub async fn assistant_status() -> Result<AssistantStatus, String> {
    let settings = SettingsManager::new()?.get()?;
    let configured = tokio::task::spawn_blocking(get_api_key)
        .await
        .map_err(|error| format!("读取系统凭据库失败: {error}"))??
        .is_some();
    let knowledge = knowledge_base();
    Ok(AssistantStatus {
        status: "ok",
        mode: "desktop",
        configured,
        model: settings.ai_model,
        knowledge: KnowledgeStatus {
            version: knowledge.content_version.clone(),
            article_count: knowledge.articles.len(),
        },
    })
}

#[tauri::command]
pub fn assistant_cancel(request_id: String, runtime: State<'_, AssistantRuntime>) -> bool {
    if let Some(token) = runtime.requests.get(&request_id) {
        token.cancel();
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn assistant_chat(
    request: AssistantChatRequest,
    on_event: Channel<AssistantStreamEvent>,
    runtime: State<'_, AssistantRuntime>,
) -> Result<(), String> {
    validate_request(&request)?;
    let settings = SettingsManager::new()?.get()?;
    if !settings.ai_assistant_enabled {
        return Err("GeoD AI 助手尚未启用".to_string());
    }

    let api_key = tokio::task::spawn_blocking(get_api_key)
        .await
        .map_err(|error| format!("读取系统凭据库失败: {error}"))??
        .ok_or_else(|| "请先在设置的开发者选项中配置 DeepSeek API Key".to_string())?;

    let cancel = CancellationToken::new();
    if let Some(previous) = runtime
        .requests
        .insert(request.request_id.clone(), cancel.clone())
    {
        previous.cancel();
    }

    let result = run_chat(&settings, &api_key, &request, &on_event, &cancel).await;
    runtime.requests.remove(&request.request_id);
    result
}

async fn run_chat(
    settings: &crate::settings::AppSettings,
    api_key: &str,
    request: &AssistantChatRequest,
    on_event: &Channel<AssistantStreamEvent>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let latest_question = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.trim())
        .unwrap_or_default();
    let matches = search_knowledge(latest_question, 3);
    let sources = matches.iter().map(public_source).collect::<Vec<_>>();
    on_event
        .send(AssistantStreamEvent::Sources { sources })
        .map_err(|error| format!("无法发送知识库信息: {error}"))?;

    let system_content = build_system_content(
        &matches,
        request.diagnostic_context.as_deref().unwrap_or_default(),
    );
    let mut messages = vec![json!({ "role": "system", "content": system_content })];
    messages.extend(
        request
            .messages
            .iter()
            .rev()
            .take(16)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|message| {
                json!({
                    "role": message.role,
                    "content": message.content,
                })
            }),
    );

    let mut client_builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120));
    if settings.proxy_enabled && !settings.proxy_url.trim().is_empty() {
        client_builder = client_builder.proxy(
            reqwest::Proxy::all(settings.proxy_url.trim())
                .map_err(|error| format!("AI 请求代理地址无效: {error}"))?,
        );
    }
    let client = client_builder
        .build()
        .map_err(|error| format!("创建 AI 请求客户端失败: {error}"))?;
    let endpoint = format!(
        "{}/chat/completions",
        settings.ai_base_url.trim().trim_end_matches('/')
    );
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&json!({
            "model": settings.ai_model,
            "messages": messages,
            "stream": true,
            "temperature": 0.25,
            "max_tokens": 1200,
        }))
        .send()
        .await
        .map_err(|error| format!("连接 DeepSeek 失败: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| body.chars().take(300).collect());
        return Err(format!("DeepSeek 请求失败 ({status}): {message}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            item = stream.next() => {
                let Some(item) = item else { break };
                let bytes = item.map_err(|error| format!("读取 DeepSeek 响应失败: {error}"))?;
                buffer.extend_from_slice(&bytes);
                while let Some((end, delimiter_len)) = find_event_boundary(&buffer) {
                    let event = buffer.drain(..end).collect::<Vec<_>>();
                    buffer.drain(..delimiter_len);
                    if process_sse_event(&event, on_event)? {
                        on_event.send(AssistantStreamEvent::Done)
                            .map_err(|error| format!("无法发送完成状态: {error}"))?;
                        return Ok(());
                    }
                }
            }
        }
    }

    on_event
        .send(AssistantStreamEvent::Done)
        .map_err(|error| format!("无法发送完成状态: {error}"))
}

fn process_sse_event(
    event: &[u8],
    on_event: &Channel<AssistantStreamEvent>,
) -> Result<bool, String> {
    let text = std::str::from_utf8(event)
        .map_err(|error| format!("DeepSeek 返回了无效 UTF-8: {error}"))?;
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            return Ok(true);
        }
        if data.is_empty() {
            continue;
        }
        let chunk: StreamChunk = serde_json::from_str(data)
            .map_err(|error| format!("无法解析 DeepSeek 流式响应: {error}"))?;
        let content = chunk
            .choices
            .and_then(|choices| choices.into_iter().next())
            .and_then(|choice| choice.delta)
            .and_then(|delta| delta.content);
        if let Some(content) = content.filter(|content| !content.is_empty()) {
            on_event
                .send(AssistantStreamEvent::Delta { content })
                .map_err(|error| format!("无法发送 AI 响应: {error}"))?;
        }
    }
    Ok(false)
}

fn find_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| (index, 2))
        })
}

fn validate_request(request: &AssistantChatRequest) -> Result<(), String> {
    if request.request_id.trim().is_empty() {
        return Err("请求 ID 不能为空".to_string());
    }
    if request.messages.is_empty() || request.messages.len() > 30 {
        return Err("消息数量必须在 1 到 30 条之间".to_string());
    }
    let mut total_chars = 0usize;
    let mut has_user = false;
    for message in &request.messages {
        if !matches!(message.role.as_str(), "user" | "assistant") {
            return Err("助手只接受 user 和 assistant 文本消息".to_string());
        }
        has_user |= message.role == "user";
        total_chars = total_chars.saturating_add(message.content.chars().count());
    }
    if !has_user {
        return Err("消息中必须包含用户问题".to_string());
    }
    if total_chars > 30_000 {
        return Err("对话内容超过 30000 个字符".to_string());
    }
    if request
        .diagnostic_context
        .as_ref()
        .is_some_and(|context| context.chars().count() > 12_000)
    {
        return Err("诊断信息超过 12000 个字符".to_string());
    }
    Ok(())
}

fn knowledge_base() -> &'static KnowledgeBase {
    static KNOWLEDGE: OnceLock<KnowledgeBase> = OnceLock::new();
    KNOWLEDGE.get_or_init(|| {
        serde_json::from_str(KNOWLEDGE_JSON)
            .expect("embedded GeoD knowledge base must be valid JSON")
    })
}

fn search_knowledge(query: &str, limit: usize) -> Vec<KnowledgeArticle> {
    let normalized_query = normalize(query);
    if normalized_query.is_empty() {
        return Vec::new();
    }
    let tokens = tokenize(&normalized_query);
    let mut ranked = knowledge_base()
        .articles
        .iter()
        .filter_map(|article| {
            let title = normalize(&article.title);
            let summary = normalize(&article.summary);
            let body = normalize(&article.body);
            let keywords = article
                .keywords
                .iter()
                .map(|keyword| normalize(keyword))
                .collect::<Vec<_>>();
            let mut score = 0f64;
            if title.contains(&normalized_query) {
                score += 18.0;
            }
            if keywords.iter().any(|keyword| {
                keyword.contains(&normalized_query) || normalized_query.contains(keyword)
            }) {
                score += 12.0;
            }
            if summary.contains(&normalized_query) {
                score += 8.0;
            }
            if body.contains(&normalized_query) {
                score += 4.0;
            }
            for token in tokens.iter().filter(|token| token.chars().count() >= 2) {
                if title.contains(token) {
                    score += 6.0;
                }
                if keywords.iter().any(|keyword| keyword.contains(token)) {
                    score += 5.0;
                }
                if summary.contains(token) {
                    score += 2.0;
                }
                if body.contains(token) {
                    score += 1.0;
                }
            }
            (score > 0.0).then(|| (score, article.clone()))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| left.1.id.cmp(&right.1.id))
    });
    let minimum = (ranked.first().map(|item| item.0).unwrap_or_default() * 0.45).max(5.0);
    ranked
        .into_iter()
        .filter(|(score, _)| *score >= minimum)
        .take(limit.clamp(1, 8))
        .map(|(_, article)| article)
        .collect()
}

fn normalize(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase()
}

fn tokenize(value: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let mut latin = String::new();
    let mut chinese = String::new();

    let flush_latin = |value: &mut String, tokens: &mut HashSet<String>| {
        if !value.is_empty() {
            tokens.insert(std::mem::take(value));
        }
    };
    let flush_chinese = |value: &mut String, tokens: &mut HashSet<String>| {
        if value.is_empty() {
            return;
        }
        let chars = value.chars().collect::<Vec<_>>();
        tokens.insert(std::mem::take(value));
        for pair in chars.windows(2) {
            tokens.insert(pair.iter().collect());
        }
    };

    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '/' | '-') {
            flush_chinese(&mut chinese, &mut tokens);
            latin.push(character);
        } else if ('\u{4e00}'..='\u{9fff}').contains(&character) {
            flush_latin(&mut latin, &mut tokens);
            chinese.push(character);
        } else {
            flush_latin(&mut latin, &mut tokens);
            flush_chinese(&mut chinese, &mut tokens);
        }
    }
    flush_latin(&mut latin, &mut tokens);
    flush_chinese(&mut chinese, &mut tokens);
    tokens
}

fn public_source(article: &KnowledgeArticle) -> KnowledgeSource {
    KnowledgeSource {
        id: article.id.clone(),
        title: article.title.clone(),
        summary: article.summary.clone(),
        actions: article.actions.clone(),
    }
}

fn build_system_content(matches: &[KnowledgeArticle], diagnostic_context: &str) -> String {
    let knowledge_context = if matches.is_empty() {
        "No GeoD knowledge article matched this question.\nDo not invent product behavior. Ask for the exact module, operation and error when needed.".to_string()
    } else {
        let articles = matches
            .iter()
            .map(|article| {
                let actions = if article.actions.is_empty() {
                    "- None".to_string()
                } else {
                    article
                        .actions
                        .iter()
                        .map(|action| format!("- [{}]({})", action.label, action.href))
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                format!(
                    "SOURCE {}: {}\nSummary: {}\nContent: {}\nAllowed navigation links:\n{}",
                    article.id, article.title, article.summary, article.body, actions
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!(
            "GeoD knowledge base version: {}\n\n{}",
            knowledge_base().content_version,
            articles
        )
    };

    let mut parts = vec![
        "You are the GeoD assistant. Reply in Chinese unless the user asks otherwise. Be concise, factual, and clear about uncertainty.".to_string(),
        AGENT_POLICY.to_string(),
        knowledge_context,
    ];
    if !diagnostic_context.trim().is_empty() {
        parts.push(format!(
            "The desktop client explicitly attached this diagnostic context:\n{}",
            diagnostic_context.trim()
        ));
    }
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_proxy_configuration() {
        let results = search_knowledge("怎么配置代理", 3);
        assert_eq!(
            results.first().map(|article| article.id.as_str()),
            Some("proxy-configuration")
        );
    }

    #[test]
    fn matches_cache_migration() {
        let results = search_knowledge("C盘缓存占满了，怎么迁移", 3);
        assert!(results
            .iter()
            .any(|article| article.id == "cache-migration"));
    }

    #[test]
    fn finds_crlf_and_lf_sse_boundaries() {
        assert_eq!(find_event_boundary(b"data: a\r\n\r\nnext"), Some((7, 4)));
        assert_eq!(find_event_boundary(b"data: a\n\nnext"), Some((7, 2)));
    }
}
