//! Shared desktop/CLI rules for tile downloads. Interactive preview is separate.

pub const OSM_OFFLINE_ERROR: &str = "OSM_OFFLINE_FORBIDDEN: OpenStreetMap Standard 公共瓦片仅支持在线浏览，不支持离线下载或导出。请切换到自建或明确允许离线使用的图源。";
pub const CARTO_OFFLINE_ERROR: &str = "CARTO_OFFLINE_FORBIDDEN: CARTO Basemaps now require a user API key and prohibit bulk extraction. Choose a source that explicitly permits downloads.";

pub fn is_osm_standard_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "tile.openstreetmap.org" || host.ends_with(".tile.openstreetmap.org")
}

fn is_carto_basemap_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "basemaps.cartocdn.com" || host.ends_with(".basemaps.cartocdn.com")
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
    } else if reqwest::Url::parse(&url.replace("{s}", "a"))
        .ok().and_then(|parsed| parsed.host_str().map(is_carto_basemap_host)).unwrap_or(false) {
        Err(CARTO_OFFLINE_ERROR.into())
    } else {
        Ok(())
    }
}

pub fn offline_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().host_str().is_some_and(is_osm_standard_host) {
            attempt.error(OSM_OFFLINE_ERROR)
        } else if attempt.url().host_str().is_some_and(is_carto_basemap_host) {
            attempt.error(CARTO_OFFLINE_ERROR)
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
        "CARTO_OFFLINE_FORBIDDEN:",
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
        assert!(ensure_offline_allowed("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png").is_err());
        assert!(ensure_offline_allowed("https://basemaps.cartocdn.com.example.com/1/0/0.png").is_ok());
    }
}
