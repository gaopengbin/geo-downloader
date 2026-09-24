//! Shared desktop/CLI rules for tile downloads. Interactive preview is separate.

pub const OSM_OFFLINE_ERROR: &str = "OSM_OFFLINE_FORBIDDEN: OpenStreetMap Standard 公共瓦片仅支持在线浏览，不支持离线下载或导出。请切换到自建或明确允许离线使用的图源。";

pub fn is_osm_standard_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "tile.openstreetmap.org" || host.ends_with(".tile.openstreetmap.org")
}

pub fn is_osm_standard_url(template: &str) -> bool {
    reqwest::Url::parse(&template.replace("{s}", "a"))
        .ok()
        .and_then(|url| url.host_str().map(is_osm_standard_host))
        .unwrap_or(false)
}

pub fn ensure_offline_allowed(url: &str) -> Result<(), String> {
    if is_osm_standard_url(url) {
        Err(OSM_OFFLINE_ERROR.into())
    } else {
        Ok(())
    }
}

pub fn offline_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().host_str().is_some_and(is_osm_standard_host) {
            attempt.error(OSM_OFFLINE_ERROR)
        } else if attempt.previous().len() >= 10 {
            attempt.error("Too many tile redirects")
        } else {
            attempt.follow()
        }
    })
}

pub fn is_terminal_download_error(error: &str) -> bool {
    [
        "OSM_OFFLINE_FORBIDDEN:",
        "TILE_ACCESS_DENIED:",
        "TILE_REDIRECT_DENIED:",
        "TILE_RATE_LIMITED:",
        "INVALID_TILE:",
        "TILE_TOO_LARGE:",
    ]
    .iter()
    .any(|prefix| error.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_normalized_host_instead_of_source_id_or_substrings() {
        for url in [
            "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://A.TILE.OPENSTREETMAP.ORG.:443/1/0/0.png",
            "https://%74ile.openstreetmap.org/1/0/0.png",
        ] {
            assert!(ensure_offline_allowed(url).is_err(), "{url}");
        }
        for url in [
            "https://tile.openstreetmap.org.example.com/1/0/0.png",
            "https://example.com/tile.openstreetmap.org/1/0/0.png",
            "https://tile.openstreetmap.org@example.com/1/0/0.png",
            "https://overpass-api.de/api/interpreter",
        ] {
            assert!(ensure_offline_allowed(url).is_ok(), "{url}");
        }
    }
}
