use reqwest::header::{ACCEPT, REFERER, USER_AGENT};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct SourceUrlAnalysis {
    pub url_template: String,
    pub sample_url: String,
    pub suggested_name: String,
    pub suggested_max_zoom: u8,
    pub subdomains: String,
    pub detected_zoom: Option<u8>,
    pub detected_x: Option<u32>,
    pub detected_y: Option<u32>,
    pub test_ok: bool,
    pub status_code: Option<u16>,
    pub content_type: String,
    pub content_length: usize,
    pub tile_format: String,
    pub message: String,
}

#[derive(Debug, Clone)]
struct ParsedTileUrl {
    url_template: String,
    sample_url: String,
    suggested_name: String,
    zoom: Option<u8>,
    x: Option<u32>,
    y: Option<u32>,
}

pub async fn analyze(raw_url: &str, proxy: Option<&str>) -> Result<SourceUrlAnalysis, String> {
    let parsed = parse_tile_url(raw_url)?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(crate::config::allow_invalid_certs());

    if let Some(proxy_url) = proxy.filter(|value| !value.trim().is_empty()) {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy_url)
                .map_err(|error| format!("代理配置无效: {error}"))?,
        );
    }

    let client = builder
        .build()
        .map_err(|error| format!("创建测试请求失败: {error}"))?;
    let referer = referer_for(&parsed.sample_url);
    let response = client
        .get(&parsed.sample_url)
        .header(
            USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) GeoDownloader/SourceAnalyzer",
        )
        .header(ACCEPT, "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        .header(REFERER, referer)
        .send()
        .await;

    let suggested_max_zoom = parsed.zoom.unwrap_or(18).max(18).min(22);
    let base = |message: String| SourceUrlAnalysis {
        url_template: parsed.url_template.clone(),
        sample_url: parsed.sample_url.clone(),
        suggested_name: parsed.suggested_name.clone(),
        suggested_max_zoom,
        subdomains: String::new(),
        detected_zoom: parsed.zoom,
        detected_x: parsed.x,
        detected_y: parsed.y,
        test_ok: false,
        status_code: None,
        content_type: String::new(),
        content_length: 0,
        tile_format: "unknown".to_string(),
        message,
    };

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return Ok(base(format!("模板已解析，但样例瓦片请求失败: {error}")));
        }
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            let mut result = base(format!("服务器已响应，但读取瓦片内容失败: {error}"));
            result.status_code = Some(status.as_u16());
            result.content_type = content_type;
            return Ok(result);
        }
    };

    let tile_format = detect_tile_format(&content_type, &bytes);
    let is_html = content_type.contains("text/html") || tile_format == "html";
    let test_ok = status.is_success() && !bytes.is_empty() && !is_html;
    let message = if !status.is_success() {
        format!("模板已解析，但样例请求返回 HTTP {}", status.as_u16())
    } else if bytes.is_empty() {
        "模板已解析，但样例请求返回空内容".to_string()
    } else if is_html {
        "该地址返回了网页而不是瓦片，请从浏览器开发者工具的网络请求中复制瓦片 URL"
            .to_string()
    } else {
        format!("测试通过，识别为 {} 瓦片", tile_format.to_uppercase())
    };

    Ok(SourceUrlAnalysis {
        url_template: parsed.url_template,
        sample_url: parsed.sample_url,
        suggested_name: parsed.suggested_name,
        suggested_max_zoom,
        subdomains: String::new(),
        detected_zoom: parsed.zoom,
        detected_x: parsed.x,
        detected_y: parsed.y,
        test_ok,
        status_code: Some(status.as_u16()),
        content_type,
        content_length: bytes.len(),
        tile_format,
        message,
    })
}

fn parse_tile_url(raw_url: &str) -> Result<ParsedTileUrl, String> {
    let input = raw_url
        .trim()
        .trim_matches(|character| character == '"' || character == '\'')
        .replace("&amp;", "&")
        .replace("{X}", "{x}")
        .replace("{Y}", "{y}")
        .replace("{Z}", "{z}")
        .replace("{S}", "{s}");
    if input.is_empty() {
        return Err("请先粘贴一条瓦片 URL".to_string());
    }

    if has_xyz_placeholders(&input) {
        let sample_url = input
            .replace("{z}", "1")
            .replace("{x}", "1")
            .replace("{y}", "1")
            .replace("{s}", "a");
        let parsed = reqwest::Url::parse(&sample_url)
            .map_err(|error| format!("URL 格式不正确: {error}"))?;
        ensure_http_url(&parsed)?;
        return Ok(ParsedTileUrl {
            url_template: input,
            sample_url,
            suggested_name: suggest_name(&parsed),
            zoom: None,
            x: None,
            y: None,
        });
    }

    let parsed =
        reqwest::Url::parse(&input).map_err(|error| format!("URL 格式不正确: {error}"))?;
    ensure_http_url(&parsed)?;
    let mut template_url = parsed.clone();
    let mut zoom = None;
    let mut x = None;
    let mut y = None;

    if let Some(query) = parsed.query() {
        let mut replaced = Vec::new();
        for part in query.split('&') {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            let normalized_key = key.to_ascii_lowercase();
            let (next_value, detected) = if is_zoom_key(&normalized_key) {
                replace_coordinate_value(value, "{z}")
            } else if is_x_key(&normalized_key) {
                replace_coordinate_value(value, "{x}")
            } else if is_y_key(&normalized_key) {
                replace_coordinate_value(value, "{y}")
            } else {
                (value.to_string(), None)
            };
            if let Some(value) = detected {
                if is_zoom_key(&normalized_key) {
                    zoom = u8::try_from(value).ok();
                } else if is_x_key(&normalized_key) {
                    x = u32::try_from(value).ok();
                } else if is_y_key(&normalized_key) {
                    y = u32::try_from(value).ok();
                }
            }
            replaced.push(if part.contains('=') {
                format!("{key}={next_value}")
            } else {
                key.to_string()
            });
        }
        template_url.set_query(Some(&replaced.join("&")));
    }

    if zoom.is_none() || x.is_none() || y.is_none() {
        let mut segments: Vec<String> = parsed
            .path()
            .split('/')
            .map(ToString::to_string)
            .collect();
        if let Some((z_index, x_index, y_index)) = find_path_coordinates(&segments) {
            zoom = segment_number(&segments[z_index]).and_then(|value| u8::try_from(value).ok());
            x = segment_number(&segments[x_index]).and_then(|value| u32::try_from(value).ok());
            y = segment_number(&segments[y_index]).and_then(|value| u32::try_from(value).ok());
            segments[z_index] = replace_segment_number(&segments[z_index], "{z}");
            segments[x_index] = replace_segment_number(&segments[x_index], "{x}");
            segments[y_index] = replace_segment_number(&segments[y_index], "{y}");
            template_url.set_path(&segments.join("/"));
        }
    }

    if zoom.is_none() || x.is_none() || y.is_none() {
        return Err(
            "没有识别到完整的瓦片坐标。请粘贴包含层级、行和列的具体瓦片请求 URL"
                .to_string(),
        );
    }

    let template = decode_placeholders(template_url.to_string());
    if !has_xyz_placeholders(&template) {
        return Err("已找到部分坐标，但无法生成完整的 {z}/{x}/{y} 模板".to_string());
    }

    Ok(ParsedTileUrl {
        url_template: template,
        sample_url: input,
        suggested_name: suggest_name(&parsed),
        zoom,
        x,
        y,
    })
}

fn ensure_http_url(url: &reqwest::Url) -> Result<(), String> {
    if matches!(url.scheme(), "http" | "https") {
        Ok(())
    } else {
        Err("仅支持 http:// 或 https:// 瓦片地址".to_string())
    }
}

fn has_xyz_placeholders(value: &str) -> bool {
    value.contains("{x}") && value.contains("{y}") && value.contains("{z}")
}

fn is_zoom_key(key: &str) -> bool {
    matches!(key, "z" | "zoom" | "level" | "l" | "tilematrix")
}

fn is_x_key(key: &str) -> bool {
    matches!(key, "x" | "col" | "tilecol" | "column")
}

fn is_y_key(key: &str) -> bool {
    matches!(key, "y" | "row" | "tilerow")
}

fn replace_coordinate_value(value: &str, placeholder: &str) -> (String, Option<u64>) {
    if let Ok(number) = value.parse::<u64>() {
        return (placeholder.to_string(), Some(number));
    }
    if let Some((prefix, suffix)) = value.rsplit_once(':') {
        if let Ok(number) = suffix.parse::<u64>() {
            return (format!("{prefix}:{placeholder}"), Some(number));
        }
    }
    (value.to_string(), None)
}

fn find_path_coordinates(segments: &[String]) -> Option<(usize, usize, usize)> {
    for (index, segment) in segments.iter().enumerate() {
        if segment.eq_ignore_ascii_case("tile") && index + 3 < segments.len() {
            let z = segment_number(&segments[index + 1])?;
            let y = segment_number(&segments[index + 2])?;
            let x = segment_number(&segments[index + 3])?;
            if valid_xyz(z, x, y) {
                return Some((index + 1, index + 3, index + 2));
            }
        }
    }

    for index in 0..segments.len().saturating_sub(2) {
        let Some(z) = segment_number(&segments[index]) else {
            continue;
        };
        let Some(x) = segment_number(&segments[index + 1]) else {
            continue;
        };
        let Some(y) = segment_number(&segments[index + 2]) else {
            continue;
        };
        if valid_xyz(z, x, y) {
            return Some((index, index + 1, index + 2));
        }
    }
    None
}

fn valid_xyz(z: u64, x: u64, y: u64) -> bool {
    if z > 24 {
        return false;
    }
    let limit = 1_u64 << z;
    x < limit && y < limit
}

fn segment_number(segment: &str) -> Option<u64> {
    let digits: String = segment
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

fn replace_segment_number(segment: &str, placeholder: &str) -> String {
    let digit_count = segment
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    format!("{placeholder}{}", &segment[digit_count..])
}

fn decode_placeholders(value: String) -> String {
    value
        .replace("%7B", "{")
        .replace("%7D", "}")
        .replace("%7b", "{")
        .replace("%7d", "}")
}

fn suggest_name(url: &reqwest::Url) -> String {
    let segments: Vec<_> = url.path_segments().map(|items| items.collect()).unwrap_or_default();
    if let Some(index) = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("MapServer"))
    {
        if index > 0 {
            let service = segments[index - 1].replace(['_', '-'], " ");
            if !service.is_empty() {
                return service;
            }
        }
    }

    url.host_str()
        .unwrap_or("自定义图源")
        .trim_start_matches("www.")
        .to_string()
}

fn referer_for(sample_url: &str) -> String {
    reqwest::Url::parse(sample_url)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?;
            Some(format!("{}://{host}/", url.scheme()))
        })
        .unwrap_or_else(|| "https://www.google.com/maps".to_string())
}

fn detect_tile_format(content_type: &str, bytes: &[u8]) -> String {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png".to_string()
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "jpeg".to_string()
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp".to_string()
    } else if bytes.starts_with(b"GIF8") {
        "gif".to_string()
    } else if content_type.contains("protobuf")
        || content_type.contains("application/vnd.mapbox-vector-tile")
    {
        "pbf".to_string()
    } else if content_type.contains("html")
        || bytes
            .iter()
            .take(64)
            .copied()
            .collect::<Vec<_>>()
            .windows(5)
            .any(|window| window.eq_ignore_ascii_case(b"<html"))
    {
        "html".to_string()
    } else {
        "unknown".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::parse_tile_url;

    #[test]
    fn parses_standard_xyz_path() {
        let result = parse_tile_url("https://tiles.example.com/base/17/105000/52000.png?token=abc")
            .expect("XYZ URL should parse");

        assert_eq!(
            result.url_template,
            "https://tiles.example.com/base/{z}/{x}/{y}.png?token=abc"
        );
        assert_eq!((result.zoom, result.x, result.y), (Some(17), Some(105000), Some(52000)));
    }

    #[test]
    fn parses_arcgis_z_y_x_path() {
        let result = parse_tile_url(
            "https://example.com/arcgis/rest/services/World_Imagery/MapServer/tile/17/52000/105000",
        )
        .expect("ArcGIS URL should parse");

        assert!(result.url_template.ends_with("/tile/{z}/{y}/{x}"));
        assert_eq!((result.zoom, result.x, result.y), (Some(17), Some(105000), Some(52000)));
        assert_eq!(result.suggested_name, "World Imagery");
    }

    #[test]
    fn parses_query_coordinates_without_touching_token() {
        let result = parse_tile_url(
            "https://example.com/gettile?x=105000&y=52000&z=17&token=a%2Bb%3D",
        )
        .expect("query URL should parse");

        assert_eq!(
            result.url_template,
            "https://example.com/gettile?x={x}&y={y}&z={z}&token=a%2Bb%3D"
        );
    }

    #[test]
    fn parses_wmts_coordinate_names() {
        let result = parse_tile_url(
            "https://example.com/wmts?TileMatrix=EPSG:3857:17&TileCol=105000&TileRow=52000",
        )
        .expect("WMTS URL should parse");

        assert!(result.url_template.contains("TileMatrix=EPSG:3857:{z}"));
        assert!(result.url_template.contains("TileCol={x}"));
        assert!(result.url_template.contains("TileRow={y}"));
    }

    #[test]
    fn rejects_page_urls_without_tile_coordinates() {
        let error =
            parse_tile_url("https://example.com/map").expect_err("page URL should not parse");

        assert!(error.contains("没有识别到完整的瓦片坐标"));
    }
}
