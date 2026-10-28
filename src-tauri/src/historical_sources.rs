//! Public historical imagery verified against the provider's Web Mercator service.
use crate::config::TileSource;
use std::collections::HashMap;

const WELD_PATH: &str = "/wmts/epsg3857/best/Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual/default/";
pub const WELD_MAX_ZOOM: u8 = 12;
pub const EOX_MAX_ZOOM: u8 = 21;

pub fn sources() -> HashMap<String, TileSource> {
    let mut sources: HashMap<String, TileSource> = [(1990, "1989-12-01", "1990-11-30"), (2000, "1999-12-01", "2000-11-30")]
        .into_iter()
        .map(|(year, start, end)| {
            let id = format!("nasa_weld_{year}");
            let source = TileSource {
                headers: Default::default(),
                id: id.clone(),
                name: format!("NASA Landsat {year}（30米年度合成）"),
                url: format!("https://gibs.earthdata.nasa.gov{WELD_PATH}{start}/GoogleMapsCompatible_Level12/{{z}}/{{y}}/{{x}}.jpeg"),
                subdomains: vec![],
                max_zoom: WELD_MAX_ZOOM,
                attribution: format!("NASA EOSDIS GIBS / USGS Landsat GWELD; {start} – {end} annual composite; RGB visualization, nominal 30 m"),
            };
            (id, source)
        })
        .collect();
    for year in [2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] {
        let layer = if year == 2016 { "s2cloudless_3857".to_string() }
            else { format!("s2cloudless-{year}_3857") };
        let years = match year { 2016 => "2016 & 2017".into(), 2018 => "2017 & 2018".into(), _ => year.to_string() };
        let id = format!("eox_sentinel_{year}");
        sources.insert(id.clone(), TileSource {
            headers: Default::default(),
            id,
            name: format!("EOX Sentinel-2 {year}（年度合成）"),
            url: format!("https://tiles.maps.eox.at/wmts/1.0.0/{layer}/default/g/{{z}}/{{y}}/{{x}}.jpg"),
            subdomains: vec![],
            max_zoom: EOX_MAX_ZOOM,
            attribution: format!("EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data {years})"),
        });
    }
    sources
}

pub fn is_gibs_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https" && url.host_str() == Some("gibs.earthdata.nasa.gov")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty() && url.password().is_none()
    })
}

pub fn is_weld_url(raw: &str) -> bool {
    is_gibs_url(raw) && reqwest::Url::parse(raw).is_ok_and(|url| url.path().starts_with(WELD_PATH))
}

pub fn is_eox_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https" && url.host_str() == Some("tiles.maps.eox.at")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty() && url.password().is_none()
            && url.path().starts_with("/wmts/1.0.0/s2cloudless")
    })
}

pub fn validate_zoom(raw: &str, zoom: u8) -> Result<(), String> {
    if is_weld_url(raw) && zoom > WELD_MAX_ZOOM {
        return Err("SOURCE_ZOOM_UNSUPPORTED: NASA WELD supports z0–z12 (约30米年度合成，请选择 z12 或更低级别)".into());
    }
    if is_eox_url(raw) && zoom > EOX_MAX_ZOOM {
        return Err("SOURCE_ZOOM_UNSUPPORTED: EOX Sentinel-2 supports z0–z21".into());
    }
    Ok(())
}

/// GIBS WELD's observed missing-coverage response is a 256×256 all-black JPEG.
/// Do not apply this rule to other sources, clouds, or arbitrary uniform colours.
pub fn is_no_data_tile(raw: &str, bytes: &[u8]) -> bool {
    if !is_weld_url(raw) { return false; }
    let Ok(image) = image::load_from_memory(bytes) else { return false; };
    if image.width() != 256 || image.height() != 256 { return false; }
    image.to_rgb8().pixels().all(|pixel| pixel.0 == [0, 0, 0])
}

pub fn usable_cached_tile(raw: &str, bytes: &[u8]) -> bool {
    crate::tile_payload::validate(bytes, None).is_ok() && !is_no_data_tile(raw, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(colour: [u8; 3]) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(256, 256, image::Rgb(colour));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn missing_coverage_is_distinct_from_valid_uniform_images_and_other_providers() {
        let source = sources().remove("nasa_weld_1990").unwrap();
        let black = png([0, 0, 0]);
        assert!(is_no_data_tile(&source.url, &black));
        assert!(!usable_cached_tile(&source.url, &black));
        assert!(!is_no_data_tile("https://example.com/tiles/1/0/0.png", &black));
        assert!(usable_cached_tile(&source.url, &png([255, 255, 255])));
        assert!(usable_cached_tile(&source.url, &png([22, 65, 90])));
        assert!(!usable_cached_tile(&source.url, b"<html>error</html>"));
    }

    #[test]
    fn only_the_verified_annual_sources_are_registered_with_service_limits() {
        let sources = crate::config::get_tile_sources(None);
        for id in ["nasa_weld_1990", "nasa_weld_2000"] {
            let source = &sources[id];
            assert!(validate_zoom(&source.url, 12).is_ok());
            assert!(validate_zoom(&source.url, 13).is_err());
            assert!(source.url.contains("GoogleMapsCompatible_Level12/{z}/{y}/{x}.jpeg"));
            assert!(source.attribution.contains("annual composite"));
        }
        assert!(!sources.contains_key("nasa_weld_1985"));
        for year in [2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] {
            let source = &sources[&format!("eox_sentinel_{year}")];
            assert!(is_eox_url(&source.url));
            assert!(validate_zoom(&source.url, 21).is_ok());
            assert!(validate_zoom(&source.url, 22).is_err());
            assert!(source.attribution.contains("Copernicus Sentinel data"));
        }
        assert!(!sources.contains_key("eox_sentinel_2017"));
        assert!(!is_weld_url("https://gibs.earthdata.nasa.gov.evil.test/anything"));
    }
}
