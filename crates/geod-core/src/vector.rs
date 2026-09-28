//! Bounded, headless GeoJSON acquisition. Coordinates are always RFC 7946 WGS84.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Read;
use std::path::Path;

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_FEATURES: usize = 100_000;
const DEFAULT_ENDPOINT: &str = "https://overpass-api.de/api/interpreter";
const ALLOWED_LAYERS: &[&str] = &[
    "boundary", "roads", "railways", "water", "landuse", "places", "pois", "tourism",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorRequest {
    #[serde(default)]
    pub input: Option<String>,
    /// Download a prepared GeoJSON Feature/FeatureCollection over HTTP(S).
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub layers: Vec<String>,
    /// Provenance supplied by the caller for a GeoJSON file or URL.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub attribution: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerProfile {
    pub id: String,
    pub geometry: String,
    pub feature_count: usize,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorResult {
    pub geojson: Value,
    pub layers: Vec<LayerProfile>,
    pub warnings: Vec<String>,
    pub source: String,
    pub attribution: String,
    pub partial: bool,
}

/// Import a local GeoJSON file, or acquire selected feature types from Overpass.
/// Feature-bbox selection is deliberately not advertised as geometry clipping.
pub async fn acquire(
    request: &VectorRequest,
    bounds: [f64; 4],
    base_dir: &Path,
    client: &reqwest::Client,
) -> Result<VectorResult, String> {
    validate_request(request, bounds)?;
    if let Some(input) = &request.input {
        let path = base_dir.join(input);
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("Cannot open vector input {}: {e}", path.display()))?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("Vector input must be a regular GeoJSON file".into());
        }
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Cannot read vector input: {e}"))?;
        if bytes.len() > MAX_BYTES {
            return Err("Vector input exceeds the 64 MiB limit".into());
        }
        let data = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Vector input is not valid JSON: {e}"))?;
        let mut result = import_geojson(data, &request.layers, bounds, input)?;
        if let Some(source) = &request.source {
            result.source = sanitized_source(source);
        }
        if let Some(attribution) = &request.attribution {
            result.attribution = attribution.clone();
        }
        return Ok(result);
    }

    if let Some(url) = &request.url {
        let response = client
            .get(url)
            .header("User-Agent", "GeoD-CLI/0.1")
            .header("Accept", "application/geo+json, application/json")
            .send()
            .await
            .map_err(|e| format!("GeoJSON download failed: {}", e.without_url()))?;
        let bytes = bounded_response(response, "GeoJSON").await?;
        let data = serde_json::from_slice(&bytes)
            .map_err(|e| format!("GeoJSON URL returned invalid JSON: {e}"))?;
        let source = sanitized_source(request.source.as_deref().unwrap_or(url));
        let mut result = import_geojson(data, &request.layers, bounds, &source)?;
        result.attribution = request.attribution.clone().unwrap_or_else(|| {
            "User-selected GeoJSON URL; retain and verify its source attribution".into()
        });
        return Ok(result);
    }

    let endpoint = request.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
    let url = validate_http_url(endpoint, "Overpass endpoint")?;
    let query = overpass_query(&request.layers, bounds)?;
    let response = client
        .post(url)
        .header("User-Agent", "GeoD-CLI/0.1")
        .header("Accept", "application/json")
        .form(&[("data", query)])
        .send()
        .await
        .map_err(|e| format!("Overpass request failed: {}", e.without_url()))?;
    let bytes = bounded_response(response, "Overpass").await?;
    let data = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Overpass returned invalid JSON: {e}"))?;
    let mut source_url = reqwest::Url::parse(endpoint).map_err(|e| e.to_string())?;
    source_url.set_query(None);
    source_url.set_fragment(None);
    from_overpass(data, &request.layers, bounds, source_url.as_str())
}

async fn bounded_response(mut response: reqwest::Response, label: &str) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("{label} returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(format!(
            "{label} response exceeds the 64 MiB limit; use a smaller dataset"
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| e.without_url().to_string())?
    {
        if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
            return Err(format!(
                "{label} response exceeds the 64 MiB limit; use a smaller dataset"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn validate_http_url(value: &str, label: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|e| format!("Invalid {label}: {e}"))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(format!(
            "{label} must be an HTTP(S) URL without embedded credentials"
        ));
    }
    Ok(url)
}

pub fn validate_request(request: &VectorRequest, bounds: [f64; 4]) -> Result<(), String> {
    if bounds.iter().any(|v| !v.is_finite())
        || bounds[0] < -180.0
        || bounds[2] > 180.0
        || bounds[1] < -90.0
        || bounds[3] > 90.0
        || bounds[0] >= bounds[2]
        || bounds[1] >= bounds[3]
    {
        return Err("Vector bounds must be finite WGS84 [west,south,east,north], with west < east and south < north".into());
    }
    for layer in &request.layers {
        if !ALLOWED_LAYERS.contains(&layer.as_str()) {
            return Err(format!(
                "Unsupported vector layer '{layer}'; expected {}",
                ALLOWED_LAYERS.join(", ")
            ));
        }
    }
    if request
        .input
        .as_deref()
        .is_some_and(|s| s.trim().is_empty())
    {
        return Err("Vector input path must not be empty".into());
    }
    if request.input.is_some() && request.url.is_some() {
        return Err("Specify either a local vector input or a GeoJSON URL, not both".into());
    }
    if (request.input.is_some() || request.url.is_some()) && request.endpoint.is_some() {
        return Err("GeoJSON input/URL cannot be combined with an Overpass endpoint".into());
    }
    if request.input.is_none() && request.url.is_none() && request.layers.is_empty() {
        return Err("Overpass acquisition requires at least one vector layer".into());
    }
    if request.input.is_none()
        && request.url.is_none()
        && (request.source.is_some() || request.attribution.is_some())
    {
        return Err("Source and attribution overrides apply only to supplied GeoJSON input/URL; Overpass provenance is fixed".into());
    }
    for value in [&request.source, &request.attribution]
        .into_iter()
        .flatten()
    {
        if value.trim().is_empty() || value.len() > 4096 {
            return Err("Source and attribution must be nonempty and at most 4096 bytes".into());
        }
    }
    if let Some(url) = &request.url {
        validate_http_url(url, "GeoJSON URL")?;
    }
    if let Some(endpoint) = &request.endpoint {
        validate_http_url(endpoint, "Overpass endpoint")?;
    }
    Ok(())
}

fn sanitized_source(source: &str) -> String {
    if let Ok(mut url) = reqwest::Url::parse(source) {
        if matches!(url.scheme(), "http" | "https") {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            return url.to_string();
        }
    }
    source.to_string()
}

fn overpass_query(layers: &[String], b: [f64; 4]) -> Result<String, String> {
    let bbox = format!("({},{},{},{})", b[1], b[0], b[3], b[2]);
    let mut selectors = BTreeSet::new();
    for layer in layers {
        let choices: &[&str] = match layer.as_str() {
            "boundary" => &[r#"nwr["boundary"="administrative"]"#],
            "roads" => &[r#"way["highway"]"#],
            "railways" => &[r#"way["railway"]"#],
            "water" => &[
                r#"nwr["waterway"]"#,
                r#"nwr["natural"="water"]"#,
                r#"nwr["water"]"#,
            ],
            "landuse" => &[r#"nwr["landuse"]"#, r#"nwr["leisure"="park"]"#],
            "places" => &[r#"nwr["place"]"#],
            "pois" => &[r#"nwr["amenity"]"#],
            "tourism" => &[
                r#"nwr["tourism"]"#,
                r#"nwr["historic"]"#,
                r#"nwr["amenity"~"^(arts_centre|theatre|museum)$"]"#,
            ],
            _ => return Err(format!("Unsupported vector layer '{layer}'")),
        };
        selectors.extend(choices.iter().map(|s| format!("{s}{bbox};")));
    }
    // No user-supplied selector or query fragment can enter this query.
    Ok(format!(
        "[out:json][timeout:120];({});out geom;",
        selectors.into_iter().collect::<Vec<_>>().join("")
    ))
}

fn import_geojson(
    data: Value,
    requested: &[String],
    bounds: [f64; 4],
    source: &str,
) -> Result<VectorResult, String> {
    reject_crs(&data)?;
    let input = match data.get("type").and_then(Value::as_str) {
        Some("FeatureCollection") => data
            .get("features")
            .and_then(Value::as_array)
            .ok_or("GeoJSON FeatureCollection requires an array of features")?
            .clone(),
        Some("Feature") => vec![data],
        _ => return Err("Vector input must be a GeoJSON Feature or FeatureCollection".into()),
    };
    if input.len() > MAX_FEATURES {
        return Err("Vector input exceeds the 100,000 feature limit".into());
    }
    let mut features = Vec::new();
    let mut warnings = Vec::new();
    let mut unclassified = 0usize;
    let mut not_clipped = false;
    for (index, mut feature) in input.into_iter().enumerate() {
        let context = format!("Feature {}", index + 1);
        reject_crs(&feature)?;
        if feature.get("type").and_then(Value::as_str) != Some("Feature") {
            return Err(format!("{context} is not a GeoJSON Feature"));
        }
        let geometry = feature
            .get("geometry")
            .ok_or_else(|| format!("{context} has no geometry"))?;
        let feature_bounds = geometry_bounds(geometry).map_err(|e| format!("{context}: {e}"))?;
        let properties = match feature.get("properties") {
            Some(Value::Object(props)) => props.clone(),
            Some(Value::Null) | None => Map::new(),
            _ => return Err(format!("{context} properties must be an object or null")),
        };
        // Validate every input feature, even those outside the selected region.
        if !intersects(feature_bounds, bounds) {
            continue;
        }
        let mut classification = classify(&properties, geometry);
        let explicit_layer = properties
            .get("layer")
            .or_else(|| properties.get("role"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty());
        if classification.is_none() && requested.len() == 1 && explicit_layer.is_none() {
            classification = Some(classification_for(&requested[0], geometry, &properties));
        }
        if !requested.is_empty() {
            if let Some(ref c) = classification {
                if !requested.iter().any(|r| r == &c.category) {
                    continue;
                }
            }
        }
        let c = classification.unwrap_or_else(|| {
            unclassified += 1;
            Classification {
                category: "unclassified".into(),
                layer: explicit_layer.unwrap_or("unclassified").into(),
                class: "unknown".into(),
            }
        });
        let normalized = normalized_properties(properties, &c);
        // Old source bbox values can be stale: validated coordinates are authoritative.
        feature.as_object_mut().unwrap().remove("bbox");
        feature["properties"] = Value::Object(normalized);
        not_clipped |= !contains(bounds, feature_bounds);
        features.push(feature);
    }
    if unclassified > 0 {
        warnings.push(format!("{unclassified} imported features have no recognized semantic role; inspect their layer before styling"));
    }
    if not_clipped {
        warnings.push("Spatial selection uses feature bounding-box intersection; geometries extending beyond the requested bounds are preserved, not clipped".into());
    }
    if features.is_empty() {
        warnings.push("No vector features matched the requested bounds and layers".into());
    }
    Ok(finish(
        features,
        warnings,
        source.into(),
        "User-supplied GeoJSON; retain and verify its source attribution".into(),
        false,
    ))
}

fn reject_crs(value: &Value) -> Result<(), String> {
    if value.get("crs").is_some_and(|crs| !crs.is_null()) {
        return Err("GeoJSON must use RFC 7946 WGS84 longitude/latitude; remove legacy crs only after reprojecting and verifying the coordinates".into());
    }
    Ok(())
}

#[derive(Debug)]
struct Classification {
    category: String,
    layer: String,
    class: String,
}

fn string_property<'a>(props: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    props
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

fn canonical_layer(category: &str, geometry: &Value) -> String {
    let kind = geometry.get("type").and_then(Value::as_str).unwrap_or("");
    match category {
        "roads" | "railways" | "transportation" => "transportation",
        "water" | "waterway" | "waterways" if kind.contains("Line") => "waterway",
        "water" | "waterway" | "waterways" => "water",
        "places" => "place",
        "pois" | "tourism" => "poi",
        other => other,
    }
    .into()
}

fn classification_for(
    category: &str,
    geometry: &Value,
    props: &Map<String, Value>,
) -> Classification {
    let keys: &[&str] = match category {
        "roads" => &["highway"],
        "railways" => &["railway"],
        "water" => &["waterway", "water", "natural"],
        "tourism" => &["tourism", "historic", "amenity"],
        "pois" => &["amenity"],
        "places" => &["place"],
        "boundary" => &["boundary"],
        "landuse" => &["landuse", "leisure"],
        _ => &[],
    };
    let class = string_property(props, "class")
        .or_else(|| keys.iter().find_map(|key| string_property(props, key)))
        .unwrap_or(category)
        .into();
    Classification {
        category: category.into(),
        layer: canonical_layer(category, geometry),
        class,
    }
}

fn classify(props: &Map<String, Value>, geometry: &Value) -> Option<Classification> {
    let explicit = string_property(props, "layer").or_else(|| string_property(props, "role"));
    let category = if let Some(layer) = explicit {
        match layer {
            "transportation" => {
                if props.contains_key("railway") {
                    "railways"
                } else {
                    "roads"
                }
            }
            "waterway" | "waterways" => "water",
            "place" => "places",
            "poi" => {
                if props.contains_key("tourism") || props.contains_key("historic") {
                    "tourism"
                } else {
                    "pois"
                }
            }
            other => other,
        }
    } else if props.contains_key("tourism")
        || props.contains_key("historic")
        || matches!(
            string_property(props, "amenity"),
            Some("arts_centre" | "theatre" | "museum")
        )
    {
        "tourism"
    } else if props.contains_key("waterway")
        || props.contains_key("water")
        || string_property(props, "natural") == Some("water")
    {
        "water"
    } else if props.contains_key("highway") {
        "roads"
    } else if props.contains_key("railway") {
        "railways"
    } else if props.contains_key("boundary") {
        "boundary"
    } else if props.contains_key("place") {
        "places"
    } else if props.contains_key("amenity") {
        "pois"
    } else if props.contains_key("landuse") || props.contains_key("leisure") {
        "landuse"
    } else {
        return None;
    };
    Some(classification_for(category, geometry, props))
}

fn normalized_properties(mut props: Map<String, Value>, c: &Classification) -> Map<String, Value> {
    let name = string_property(&props, "name")
        .or_else(|| string_property(&props, "name:zh"))
        .unwrap_or("")
        .to_string();
    let replacements = [
        ("layer", Value::String(c.layer.clone())),
        ("class", Value::String(c.class.clone())),
        ("name", Value::String(name)),
    ];
    // Preserve overwritten source values, including custom non-string values.
    let mut originals = Map::new();
    for (key, value) in replacements {
        if let Some(previous) = props.get(key) {
            if previous != &value {
                originals.insert(key.into(), previous.clone());
            }
        }
        props.insert(key.into(), value);
    }
    if !originals.is_empty() {
        let mut key = "geod:originalProperties".to_string();
        while props.contains_key(&key) {
            key.push('_');
        }
        props.insert(key, Value::Object(originals));
    }
    props
}

fn from_overpass(
    data: Value,
    requested: &[String],
    bounds: [f64; 4],
    source: &str,
) -> Result<VectorResult, String> {
    let elements = data
        .get("elements")
        .and_then(Value::as_array)
        .ok_or("Overpass response has no elements array")?;
    if elements.len() > MAX_FEATURES {
        return Err(
            "Overpass result exceeds the 100,000 feature limit; use a smaller region".into(),
        );
    }
    let mut warnings = Vec::new();
    let mut partial = false;
    if let Some(remark) = data.get("remark").and_then(Value::as_str) {
        if !remark.trim().is_empty() {
            warnings.push(format!(
                "Overpass reported a possibly incomplete result: {}",
                remark.chars().take(1000).collect::<String>()
            ));
            partial = true;
        }
    }
    let mut seen = HashSet::new();
    let mut features = Vec::new();
    let mut skipped: BTreeMap<String, usize> = BTreeMap::new();
    let mut not_clipped = false;
    for element in elements {
        let osm_type = element.get("type").and_then(Value::as_str).unwrap_or("");
        let id = element
            .get("id")
            .and_then(Value::as_i64)
            .ok_or("Overpass element has no integer id")?;
        if !seen.insert((osm_type.to_string(), id)) {
            continue;
        }
        let mut props = element
            .get("tags")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let geometry = match osm_geometry(element, &props) {
            Ok(g) => g,
            Err(reason) => {
                *skipped.entry(reason).or_default() += 1;
                continue;
            }
        };
        let feature_bounds = match geometry_bounds(&geometry) {
            Ok(b) => b,
            Err(_) => {
                *skipped
                    .entry("invalid or out-of-range coordinates".into())
                    .or_default() += 1;
                continue;
            }
        };
        if !intersects(feature_bounds, bounds) {
            continue;
        }
        // A feature can satisfy multiple selectors (e.g. a historic road). Pick
        // a requested semantic role instead of dropping it due to tag precedence.
        let mut classification = classify(&props, &geometry);
        if classification
            .as_ref()
            .map_or(true, |c| !requested.contains(&c.category))
        {
            classification = requested
                .iter()
                .find(|r| matches_category(&props, r))
                .map(|r| classification_for(r, &geometry, &props));
        }
        let Some(c) = classification else {
            continue;
        };
        props.insert("osm_type".into(), json!(osm_type));
        props.insert("osm_id".into(), json!(id));
        not_clipped |= !contains(bounds, feature_bounds);
        features.push(json!({"type":"Feature", "id":format!("{osm_type}/{id}"), "properties":normalized_properties(props, &c), "geometry":geometry}));
    }
    for (reason, count) in skipped {
        warnings.push(format!("Skipped {count} OSM elements: {reason}"));
        partial = true;
    }
    if not_clipped {
        warnings.push("Overpass selected intersecting features; complete feature geometries may extend beyond the requested bounds and are not clipped".into());
    }
    if features.is_empty() {
        warnings.push("No vector features matched the requested bounds and layers".into());
    }
    Ok(finish(
        features,
        warnings,
        source.into(),
        "© OpenStreetMap contributors; ODbL 1.0; https://www.openstreetmap.org/copyright".into(),
        partial,
    ))
}

fn matches_category(tags: &Map<String, Value>, category: &str) -> bool {
    match category {
        "boundary" => string_property(tags, "boundary") == Some("administrative"),
        "roads" => tags.contains_key("highway"),
        "railways" => tags.contains_key("railway"),
        "water" => {
            tags.contains_key("waterway")
                || tags.contains_key("water")
                || string_property(tags, "natural") == Some("water")
        }
        "landuse" => {
            tags.contains_key("landuse") || string_property(tags, "leisure") == Some("park")
        }
        "places" => tags.contains_key("place"),
        "pois" => tags.contains_key("amenity"),
        "tourism" => {
            tags.contains_key("tourism")
                || tags.contains_key("historic")
                || matches!(
                    string_property(tags, "amenity"),
                    Some("arts_centre" | "theatre" | "museum")
                )
        }
        _ => false,
    }
}

fn osm_geometry(element: &Value, tags: &Map<String, Value>) -> Result<Value, String> {
    match element.get("type").and_then(Value::as_str) {
        Some("node") => Ok(
            json!({"type":"Point", "coordinates":[element.get("lon").ok_or("node missing longitude")?,element.get("lat").ok_or("node missing latitude")?]}),
        ),
        Some("way") => {
            let mut coordinates = osm_coordinates(element)?;
            if coordinates.len() < 2 {
                return Err("way has fewer than two coordinates".into());
            }
            let closed = coordinates.len() >= 4 && coordinates.first() == coordinates.last();
            let area = string_property(tags, "area");
            let linear = tags.contains_key("highway")
                || tags.contains_key("railway")
                || tags.contains_key("waterway")
                || tags.contains_key("boundary")
                || matches!(
                    string_property(tags, "natural"),
                    Some("coastline" | "tree_row")
                );
            let area_tag = [
                "building", "landuse", "leisure", "amenity", "tourism", "historic", "natural",
                "water", "place",
            ]
            .iter()
            .any(|k| tags.contains_key(*k));
            if area == Some("yes") && !closed {
                return Err("area way is not a closed ring".into());
            }
            if closed && area != Some("no") && (area == Some("yes") || (!linear && area_tag)) {
                orient_ring(&mut coordinates, true);
                Ok(json!({"type":"Polygon", "coordinates":[coordinates]}))
            } else {
                Ok(json!({"type":"LineString", "coordinates":coordinates}))
            }
        }
        Some("relation") => relation_geometry(element, tags),
        _ => Err("unsupported OSM element type".into()),
    }
}

type Position = [f64; 2];
type Ring = Vec<Position>;

fn osm_coordinates(element: &Value) -> Result<Ring, String> {
    element
        .get("geometry")
        .and_then(Value::as_array)
        .ok_or("way/member is missing full out geom coordinates")?
        .iter()
        .map(|point| {
            let lon = point
                .get("lon")
                .and_then(Value::as_f64)
                .ok_or("missing longitude in OSM geometry")?;
            let lat = point
                .get("lat")
                .and_then(Value::as_f64)
                .ok_or("missing latitude in OSM geometry")?;
            validate_position(&[json!(lon), json!(lat)])?;
            Ok([lon, lat])
        })
        .collect()
}

fn relation_geometry(element: &Value, tags: &Map<String, Value>) -> Result<Value, String> {
    if !matches!(
        string_property(tags, "type"),
        Some("multipolygon" | "boundary")
    ) {
        return Err(
            "unsupported relation topology (only multipolygon/boundary relations are assembled)"
                .into(),
        );
    }
    let members = element
        .get("members")
        .and_then(Value::as_array)
        .ok_or("relation has no members")?;
    let mut outer_parts = Vec::new();
    let mut inner_parts = Vec::new();
    for member in members {
        let role = member.get("role").and_then(Value::as_str).unwrap_or("");
        match member.get("type").and_then(Value::as_str) {
            Some("node") if matches!(role, "label" | "admin_centre") => continue,
            Some("way") => {}
            _ => {
                return Err(
                    "unsupported relation topology (nested relations or non-boundary members)"
                        .into(),
                )
            }
        }
        let part = osm_coordinates(member)?;
        if part.len() < 2 {
            return Err("relation member has fewer than two coordinates".into());
        }
        match role {
            "outer" | "" => outer_parts.push(part),
            "inner" => inner_parts.push(part),
            _ => return Err("unsupported relation member role".into()),
        }
    }
    let mut outers = assemble_rings(outer_parts)?;
    let inners = assemble_rings(inner_parts)?;
    if outers.is_empty() {
        return Err("relation has no outer polygon rings".into());
    }
    validate_relation_rings(&outers, &inners)?;
    let mut polygons: Vec<Vec<Ring>> = outers
        .drain(..)
        .map(|mut ring| {
            orient_ring(&mut ring, true);
            vec![ring]
        })
        .collect();
    for mut inner in inners {
        let owners: Vec<usize> = polygons
            .iter()
            .enumerate()
            .filter_map(|(i, polygon)| {
                // An inner ring must be fully contained in exactly one outer ring.
                if inner.iter().all(|p| point_in_ring(*p, &polygon[0])) {
                    Some(i)
                } else {
                    None
                }
            })
            .collect();
        if owners.len() != 1 {
            return Err(
                "unsupported relation topology (hole has no unique enclosing outer ring)".into(),
            );
        }
        orient_ring(&mut inner, false);
        polygons[owners[0]].push(inner);
    }
    if polygons.len() == 1 {
        Ok(json!({"type":"Polygon", "coordinates":polygons.remove(0)}))
    } else {
        Ok(json!({"type":"MultiPolygon", "coordinates":polygons}))
    }
}

/// Conservative topology validation: unsupported intersections are omitted with
/// an explicit partial-result warning rather than exported as misleading areas.
fn validate_relation_rings(outers: &[Ring], inners: &[Ring]) -> Result<(), String> {
    let rings: Vec<&Ring> = outers.iter().chain(inners.iter()).collect();
    let edges: usize = rings.iter().map(|ring| ring.len() - 1).sum();
    if edges.saturating_mul(edges) > 4_000_000 {
        return Err("relation exceeds the bounded topology-validation limit (2,000 edges)".into());
    }
    for ring in &rings {
        let area: f64 = ring
            .windows(2)
            .map(|e| e[0][0] * e[1][1] - e[1][0] * e[0][1])
            .sum();
        if area.abs() < 1e-14 {
            return Err("unsupported relation topology (degenerate polygon ring)".into());
        }
        for (i, a) in ring.windows(2).enumerate() {
            if a[0] == a[1] {
                return Err("unsupported relation topology (duplicate ring position)".into());
            }
            for (j, b) in ring.windows(2).enumerate().skip(i + 1) {
                if j == i + 1 || (i == 0 && j == ring.len() - 2) {
                    continue;
                }
                if segments_intersect(a[0], a[1], b[0], b[1]) {
                    return Err(
                        "unsupported relation topology (self-intersecting polygon ring)".into(),
                    );
                }
            }
        }
    }
    for (i, a) in rings.iter().enumerate() {
        for b in rings.iter().skip(i + 1) {
            if a.windows(2).any(|e| {
                b.windows(2)
                    .any(|f| segments_intersect(e[0], e[1], f[0], f[1]))
            }) {
                return Err(
                    "unsupported relation topology (intersecting or touching polygon rings)".into(),
                );
            }
        }
    }
    for (i, a) in outers.iter().enumerate() {
        for b in outers.iter().skip(i + 1) {
            if point_in_ring(a[0], b) || point_in_ring(b[0], a) {
                return Err("unsupported relation topology (nested outer rings)".into());
            }
        }
    }
    for (i, a) in inners.iter().enumerate() {
        for b in inners.iter().skip(i + 1) {
            if point_in_ring(a[0], b) || point_in_ring(b[0], a) {
                return Err("unsupported relation topology (nested inner rings)".into());
            }
        }
    }
    Ok(())
}

fn segments_intersect(a: Position, b: Position, c: Position, d: Position) -> bool {
    fn cross(a: Position, b: Position, c: Position) -> f64 {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    }
    fn on_segment(a: Position, b: Position, c: Position) -> bool {
        c[0] >= a[0].min(b[0])
            && c[0] <= a[0].max(b[0])
            && c[1] >= a[1].min(b[1])
            && c[1] <= a[1].max(b[1])
    }
    let ab_c = cross(a, b, c);
    let ab_d = cross(a, b, d);
    let cd_a = cross(c, d, a);
    let cd_b = cross(c, d, b);
    (ab_c == 0.0 && on_segment(a, b, c))
        || (ab_d == 0.0 && on_segment(a, b, d))
        || (cd_a == 0.0 && on_segment(c, d, a))
        || (cd_b == 0.0 && on_segment(c, d, b))
        || ((ab_c > 0.0) != (ab_d > 0.0) && (cd_a > 0.0) != (cd_b > 0.0))
}

fn assemble_rings(mut parts: Vec<Ring>) -> Result<Vec<Ring>, String> {
    if parts.len() > 10_000 {
        return Err("relation exceeds the 10,000 member assembly limit".into());
    }
    let mut rings = Vec::new();
    while let Some(mut ring) = parts.pop() {
        while ring.first() != ring.last() {
            let end = *ring.last().unwrap();
            let matches: Vec<(usize, bool)> = parts
                .iter()
                .enumerate()
                .filter_map(|(index, part)| {
                    if part.first() == Some(&end) {
                        Some((index, false))
                    } else if part.last() == Some(&end) {
                        Some((index, true))
                    } else {
                        None
                    }
                })
                .collect();
            if matches.len() != 1 {
                return Err(
                    "unsupported relation topology (open or ambiguous polygon ring)".into(),
                );
            }
            let (index, reverse) = matches[0];
            let mut next = parts.swap_remove(index);
            if reverse {
                next.reverse();
            }
            ring.extend(next.into_iter().skip(1));
        }
        if ring.len() < 4 {
            return Err("relation ring has fewer than four positions".into());
        }
        rings.push(ring);
    }
    Ok(rings)
}

fn point_in_ring(point: Position, ring: &[Position]) -> bool {
    let mut inside = false;
    for edge in ring.windows(2) {
        let a = edge[0];
        let b = edge[1];
        if (a[1] > point[1]) != (b[1] > point[1])
            && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
    }
    inside
}

fn orient_ring(ring: &mut Ring, exterior: bool) {
    let area: f64 = ring
        .windows(2)
        .map(|e| e[0][0] * e[1][1] - e[1][0] * e[0][1])
        .sum();
    if (area > 0.0) != exterior {
        ring.reverse();
    }
}

fn geometry_bounds(geometry: &Value) -> Result<[f64; 4], String> {
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    validate_geometry(geometry, &mut bounds)?;
    if !bounds.iter().all(|n| n.is_finite()) {
        return Err("empty geometries are not supported".into());
    }
    Ok(bounds)
}

fn validate_geometry(g: &Value, bounds: &mut [f64; 4]) -> Result<(), String> {
    reject_crs(g)?;
    let kind = g
        .get("type")
        .and_then(Value::as_str)
        .ok_or("geometry requires a supported type; null geometry is not supported")?;
    if kind == "GeometryCollection" {
        return Err("GeometryCollection is not supported by the GeoStyle bundle bridge; split it into Point, MultiPoint, LineString, MultiLineString, Polygon, or MultiPolygon features before acquisition".into());
    }
    let coordinates = g
        .get("coordinates")
        .ok_or("geometry is missing coordinates")?;
    match kind {
        "Point" => add_position(coordinates, bounds),
        "MultiPoint" => validate_positions(coordinates, bounds, 1, false),
        "LineString" => validate_positions(coordinates, bounds, 2, false),
        "MultiLineString" => {
            for line in nonempty_array(coordinates)? {
                validate_positions(line, bounds, 2, false)?;
            }
            Ok(())
        }
        "Polygon" => validate_polygon(coordinates, bounds),
        "MultiPolygon" => {
            for polygon in nonempty_array(coordinates)? {
                validate_polygon(polygon, bounds)?;
            }
            Ok(())
        }
        _ => Err(format!("unsupported geometry type '{kind}'")),
    }
}

fn nonempty_array(value: &Value) -> Result<&Vec<Value>, String> {
    let array = value
        .as_array()
        .ok_or("coordinates must be nested arrays")?;
    if array.is_empty() {
        return Err("empty geometries are not supported".into());
    }
    Ok(array)
}

fn validate_polygon(value: &Value, bounds: &mut [f64; 4]) -> Result<(), String> {
    for ring in nonempty_array(value)? {
        validate_positions(ring, bounds, 4, true)?;
    }
    Ok(())
}

fn validate_positions(
    value: &Value,
    bounds: &mut [f64; 4],
    minimum: usize,
    closed: bool,
) -> Result<(), String> {
    let positions = nonempty_array(value)?;
    if positions.len() < minimum {
        return Err(format!("geometry requires at least {minimum} positions"));
    }
    for p in positions {
        add_position(p, bounds)?;
    }
    if closed && positions.first() != positions.last() {
        return Err("polygon rings must be closed".into());
    }
    Ok(())
}

fn validate_position(position: &[Value]) -> Result<Position, String> {
    if !(2..=3).contains(&position.len())
        || position
            .iter()
            .any(|v| !v.as_f64().is_some_and(f64::is_finite))
    {
        return Err("positions must contain two or three finite numeric coordinates".into());
    }
    let lon = position[0].as_f64().unwrap();
    let lat = position[1].as_f64().unwrap();
    if !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat) {
        return Err("coordinates are outside WGS84 longitude/latitude limits; reproject the input to EPSG:4326".into());
    }
    Ok([lon, lat])
}

fn add_position(value: &Value, bounds: &mut [f64; 4]) -> Result<(), String> {
    let p = validate_position(value.as_array().ok_or("position must be an array")?)?;
    bounds[0] = bounds[0].min(p[0]);
    bounds[1] = bounds[1].min(p[1]);
    bounds[2] = bounds[2].max(p[0]);
    bounds[3] = bounds[3].max(p[1]);
    Ok(())
}

fn intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

fn contains(outer: [f64; 4], inner: [f64; 4]) -> bool {
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
}

fn finish(
    features: Vec<Value>,
    warnings: Vec<String>,
    source: String,
    attribution: String,
    partial: bool,
) -> VectorResult {
    let mut profiles: BTreeMap<String, (BTreeSet<String>, usize, BTreeSet<String>)> =
        BTreeMap::new();
    for feature in &features {
        let props = feature["properties"].as_object().unwrap();
        let id = props["layer"].as_str().unwrap().to_string();
        let profile = profiles.entry(id).or_default();
        profile.0.insert(
            match feature["geometry"]["type"].as_str().unwrap_or("") {
                "Point" | "MultiPoint" => "point",
                "LineString" | "MultiLineString" => "line",
                "Polygon" | "MultiPolygon" => "polygon",
                _ => "mixed",
            }
            .into(),
        );
        profile.1 += 1;
        profile.2.extend(props.keys().cloned());
    }
    let layers = profiles
        .into_iter()
        .map(|(id, (kinds, feature_count, fields))| LayerProfile {
            id,
            geometry: if kinds.len() == 1 {
                kinds.into_iter().next().unwrap()
            } else {
                "mixed".into()
            },
            feature_count,
            fields: fields.into_iter().collect(),
        })
        .collect();
    VectorResult {
        geojson: json!({"type":"FeatureCollection", "features":features}),
        layers,
        warnings,
        source,
        attribution,
        partial,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const BOUNDS: [f64; 4] = [-10.0, -10.0, 20.0, 20.0];
    fn requested(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }
    fn osm(data: Value, layers: &[&str]) -> VectorResult {
        from_overpass(data, &requested(layers), BOUNDS, "fixture").unwrap()
    }

    #[test]
    fn tourism_nodes_and_historic_nodes_are_not_lost_and_duplicates_are_removed() {
        let node = json!({"type":"node","id":1,"lon":1,"lat":2,"tags":{"tourism":"museum","name":"河南博物院"}});
        let result = osm(
            json!({"elements":[node.clone(),node,{"type":"node","id":2,"lon":2,"lat":3,"tags":{"historic":"monument"}}]}),
            &["tourism"],
        );
        assert_eq!(result.geojson["features"].as_array().unwrap().len(), 2);
        assert_eq!(result.geojson["features"][0]["properties"]["layer"], "poi");
        assert_eq!(
            result.geojson["features"][0]["properties"]["name"],
            "河南博物院"
        );
        assert_eq!(result.layers[0].geometry, "point");
        assert!(!result.partial);
    }

    #[test]
    fn a_closed_road_stays_a_line_and_a_waterway_is_not_a_road() {
        let result = osm(
            json!({"elements":[
                {"type":"way","id":1,"tags":{"highway":"residential"},"geometry":[{"lon":0,"lat":0},{"lon":2,"lat":0},{"lon":2,"lat":2},{"lon":0,"lat":0}]},
                {"type":"way","id":2,"tags":{"waterway":"river"},"geometry":[{"lon":1,"lat":1},{"lon":2,"lat":2}]}
            ]}),
            &["roads", "water"],
        );
        assert_eq!(
            result.geojson["features"][0]["geometry"]["type"],
            "LineString"
        );
        assert_eq!(
            result.geojson["features"][0]["properties"]["layer"],
            "transportation"
        );
        assert_eq!(
            result.geojson["features"][1]["properties"]["layer"],
            "waterway"
        );
    }

    #[test]
    fn multipolygon_assembles_reversed_fragments_and_keeps_its_hole() {
        let result = osm(
            json!({"elements":[{"type":"relation","id":9,"tags":{"type":"multipolygon","natural":"water"},"members":[
                {"type":"way","ref":1,"role":"outer","geometry":[{"lon":0,"lat":0},{"lon":5,"lat":0},{"lon":5,"lat":5}]},
                {"type":"way","ref":2,"role":"outer","geometry":[{"lon":0,"lat":0},{"lon":0,"lat":5},{"lon":5,"lat":5}]},
                {"type":"way","ref":3,"role":"inner","geometry":[{"lon":1,"lat":1},{"lon":2,"lat":1},{"lon":2,"lat":2},{"lon":1,"lat":1}]}
            ]}]}),
            &["water"],
        );
        assert!(!result.partial);
        assert_eq!(result.geojson["features"][0]["geometry"]["type"], "Polygon");
        assert_eq!(
            result.geojson["features"][0]["geometry"]["coordinates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn unsupported_relation_topology_is_reported_as_partial() {
        let result = osm(
            json!({"elements":[{"type":"relation","id":9,"tags":{"type":"multipolygon","natural":"water"},"members":[
                {"type":"way","ref":1,"role":"outer","geometry":[{"lon":0,"lat":0},{"lon":5,"lat":0}]}
            ]}]}),
            &["water"],
        );
        assert!(result.partial);
        assert_eq!(result.geojson["features"].as_array().unwrap().len(), 0);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("open or ambiguous")));
    }

    #[test]
    fn projected_invalid_and_unclosed_local_coordinates_are_rejected() {
        for geometry in [
            json!({"type":"Point","coordinates":[500000,4000000]}),
            json!({"type":"Point","coordinates":[1,null]}),
            json!({"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]}),
            json!({"type":"CircularString","coordinates":[[0,0],[1,1]]}),
        ] {
            let data = json!({"type":"Feature","properties":{},"geometry":geometry});
            assert!(import_geojson(data, &[], BOUNDS, "fixture").is_err());
        }
    }

    #[test]
    fn geometry_collections_are_rejected_before_a_nonportable_bundle_is_created() {
        let data = json!({
            "type":"Feature", "properties":{"layer":"poi"},
            "geometry":{"type":"GeometryCollection","geometries":[
                {"type":"Point","coordinates":[1,2]},
                {"type":"LineString","coordinates":[[1,2],[3,4]]}
            ]}
        });
        let error = import_geojson(data, &[], BOUNDS, "fixture").unwrap_err();
        assert!(error.contains("GeometryCollection is not supported"));
        assert!(error.contains("split it into"));
    }

    #[test]
    fn import_preserves_custom_layers_and_original_fields_without_guessing_roads() {
        let result = import_geojson(json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"layer":"heritage_route","name":"路线","distance":42},"geometry":{"type":"LineString","coordinates":[[1,1],[2,2]]}},
            {"type":"Feature","properties":{"waterway":"river","name":"河流"},"geometry":{"type":"LineString","coordinates":[[1,1],[3,3]]}}
        ]}), &[], BOUNDS, "fixture").unwrap();
        assert_eq!(
            result.geojson["features"][0]["properties"]["layer"],
            "heritage_route"
        );
        assert_eq!(result.geojson["features"][0]["properties"]["distance"], 42);
        assert_eq!(
            result.geojson["features"][1]["properties"]["layer"],
            "waterway"
        );
    }

    #[test]
    fn bbox_selection_does_not_claim_to_clip_crossing_lines() {
        let data = json!({"type":"Feature","properties":{"waterway":"river"},"geometry":{"type":"LineString","coordinates":[[-2,0],[2,0]]}});
        let result = import_geojson(data, &[], [-1.0, -1.0, 1.0, 1.0], "fixture").unwrap();
        assert_eq!(
            result.geojson["features"][0]["geometry"]["coordinates"][0][0],
            -2
        );
        assert!(result.warnings.iter().any(|w| w.contains("not clipped")));
        assert!(!result.partial);
    }

    #[test]
    fn overpass_remarks_are_not_silent_successes_and_queries_are_whitelisted() {
        let result = osm(
            json!({"remark":"runtime error: Query timed out","elements":[]}),
            &["tourism"],
        );
        assert!(result.partial);
        let query = overpass_query(&requested(&["tourism"]), BOUNDS).unwrap();
        assert!(query.contains("nwr[\"tourism\"]"));
        assert!(query.contains("nwr[\"historic\"]"));
        assert!(query.ends_with("out geom;"));
        assert!(overpass_query(&requested(&["highway\"];out;"]), BOUNDS).is_err());
    }

    #[test]
    fn overlapping_tags_do_not_drop_a_requested_road() {
        let result = osm(
            json!({"elements":[{"type":"way","id":3,"tags":{"highway":"pedestrian","historic":"yes"},"geometry":[{"lon":1,"lat":1},{"lon":2,"lat":2}]}]}),
            &["roads"],
        );
        assert_eq!(result.geojson["features"].as_array().unwrap().len(), 1);
        assert_eq!(
            result.geojson["features"][0]["properties"]["layer"],
            "transportation"
        );
        assert_eq!(
            result.geojson["features"][0]["properties"]["historic"],
            "yes"
        );
    }

    #[test]
    fn shared_render_layer_does_not_mix_roads_and_railways_during_import() {
        let result = import_geojson(json!({"type":"FeatureCollection","features":[
            {"type":"Feature","properties":{"layer":"transportation","highway":"residential"},"geometry":{"type":"LineString","coordinates":[[1,1],[2,2]]}},
            {"type":"Feature","properties":{"layer":"transportation","railway":"rail"},"geometry":{"type":"LineString","coordinates":[[1,1],[3,3]]}}
        ]}), &requested(&["roads"]), BOUNDS, "fixture").unwrap();
        assert_eq!(result.geojson["features"].as_array().unwrap().len(), 1);
        assert_eq!(
            result.geojson["features"][0]["properties"]["highway"],
            "residential"
        );
    }

    #[test]
    fn crossing_or_nested_relation_rings_are_rejected_instead_of_filled_incorrectly() {
        let outer = vec![[0.0, 0.0], [5.0, 0.0], [5.0, 5.0], [0.0, 5.0], [0.0, 0.0]];
        let crossing = vec![[4.0, 1.0], [6.0, 1.0], [6.0, 2.0], [4.0, 1.0]];
        assert!(validate_relation_rings(&[outer.clone()], &[crossing]).is_err());
        let nested = vec![[1.0, 1.0], [2.0, 1.0], [2.0, 2.0], [1.0, 1.0]];
        assert!(validate_relation_rings(&[outer, nested], &[]).is_err());
    }

    #[test]
    fn plan_rejects_unknown_fields_and_invalid_endpoints_and_preserves_safe_provenance() {
        assert!(serde_json::from_value::<VectorRequest>(
            json!({"layers":["roads"],"rawQuery":"out;"})
        )
        .is_err());
        for endpoint in [
            "file:///private",
            "https://user:secret@example.com/api",
            "not a URL",
        ] {
            let request: VectorRequest =
                serde_json::from_value(json!({"layers":["roads"],"endpoint":endpoint})).unwrap();
            assert!(validate_request(&request, BOUNDS).is_err());
        }
        assert_eq!(
            sanitized_source("https://user:secret@example.com/data.json?token=secret#key"),
            "https://example.com/data.json"
        );
        let remote_override: VectorRequest =
            serde_json::from_value(json!({"layers":["tourism"],"source":"fake"})).unwrap();
        assert!(validate_request(&remote_override, BOUNDS).is_err());
        for value in [
            json!({"input":"file.json","url":"https://example.com/data.json"}),
            json!({"url":"https://example.com/data.json","endpoint":"https://example.com/api"}),
            json!({"url":"file:///private"}),
        ] {
            let request: VectorRequest = serde_json::from_value(value).unwrap();
            assert!(validate_request(&request, BOUNDS).is_err());
        }
    }

    fn http_fixture(response: String) -> (String, std::thread::JoinHandle<()>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        });
        (format!("http://{address}/data.geojson"), handle)
    }

    #[tokio::test]
    async fn direct_geojson_download_normalizes_data_and_records_attribution() {
        let data = json!({"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"河南","adcode":410000},"geometry":{"type":"Polygon","coordinates":[[[0,0],[2,0],[2,2],[0,0]]]}}]}).to_string();
        let (url, server) = http_fixture(format!("HTTP/1.1 200 OK\r\nContent-Type: application/geo+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()));
        let request: VectorRequest = serde_json::from_value(json!({"url":format!("{url}?token=secret"),"layers":["boundary"],"attribution":"Fixture administrative boundaries"})).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let result = acquire(&request, BOUNDS, Path::new("."), &client)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(result.source, url);
        assert_eq!(result.attribution, "Fixture administrative boundaries");
        assert_eq!(result.layers[0].id, "boundary");
        assert_eq!(result.layers[0].feature_count, 1);
        assert_eq!(
            result.geojson["features"][0]["properties"]["adcode"],
            410000
        );
    }

    #[tokio::test]
    async fn direct_geojson_download_rejects_oversized_response_before_reading_body() {
        let (url, server) = http_fixture(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_BYTES + 1
        ));
        let request: VectorRequest = serde_json::from_value(json!({"url":url})).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let error = acquire(&request, BOUNDS, Path::new("."), &client)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert!(error.contains("64 MiB"));
    }
}
