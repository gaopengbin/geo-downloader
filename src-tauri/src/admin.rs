//! 行政区划数据模块

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f64::consts::PI;
use std::time::Duration;

// GCJ-02 到 WGS-84 坐标转换常量
const A: f64 = 6378245.0; // 半轴
const EE: f64 = 0.00669342162296594323; // 偏心率平方

/// 判断坐标是否在中国境内
fn out_of_china(lng: f64, lat: f64) -> bool {
    !(73.66 < lng && lng < 135.05 && 3.86 < lat && lat < 53.55)
}

/// 纬度偏移计算
fn transform_lat(x: f64, y: f64) -> f64 {
    let mut ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * x.abs().sqrt();
    ret += (20.0 * (6.0 * x * PI).sin() + 20.0 * (2.0 * x * PI).sin()) * 2.0 / 3.0;
    ret += (20.0 * (y * PI).sin() + 40.0 * (y / 3.0 * PI).sin()) * 2.0 / 3.0;
    ret += (160.0 * (y / 12.0 * PI).sin() + 320.0 * (y * PI / 30.0).sin()) * 2.0 / 3.0;
    ret
}

/// 经度偏移计算
fn transform_lng(x: f64, y: f64) -> f64 {
    let mut ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * x.abs().sqrt();
    ret += (20.0 * (6.0 * x * PI).sin() + 20.0 * (2.0 * x * PI).sin()) * 2.0 / 3.0;
    ret += (20.0 * (x * PI).sin() + 40.0 * (x / 3.0 * PI).sin()) * 2.0 / 3.0;
    ret += (150.0 * (x / 12.0 * PI).sin() + 300.0 * (x / 30.0 * PI).sin()) * 2.0 / 3.0;
    ret
}

/// GCJ-02 转 WGS-84
fn gcj02_to_wgs84(gcj_lng: f64, gcj_lat: f64) -> (f64, f64) {
    if out_of_china(gcj_lng, gcj_lat) {
        return (gcj_lng, gcj_lat);
    }
    
    let x = gcj_lng - 105.0;
    let y = gcj_lat - 35.0;
    
    let mut dlat = transform_lat(x, y);
    let mut dlng = transform_lng(x, y);
    
    let radlat = gcj_lat / 180.0 * PI;
    let mut magic = radlat.sin();
    magic = 1.0 - EE * magic * magic;
    let sqrtmagic = magic.sqrt();
    
    dlat = (dlat * 180.0) / ((A * (1.0 - EE)) / (magic * sqrtmagic) * PI);
    dlng = (dlng * 180.0) / (A / sqrtmagic * radlat.cos() * PI);
    
    let mg_lat = gcj_lat + dlat;
    let mg_lng = gcj_lng + dlng;
    
    (gcj_lng * 2.0 - mg_lng, gcj_lat * 2.0 - mg_lat)
}

/// 转换 GeoJSON 中的所有坐标从 GCJ-02 到 WGS-84
fn transform_geojson_coords(geojson: &mut Value) {
    match geojson {
        Value::Object(map) => {
            // 处理 coordinates 字段
            if let Some(coords) = map.get_mut("coordinates") {
                transform_coords(coords);
            }
            // 递归处理其他字段
            for (key, value) in map.iter_mut() {
                if key != "coordinates" {
                    transform_geojson_coords(value);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                transform_geojson_coords(item);
            }
        }
        _ => {}
    }
}

/// 转换坐标数组
fn transform_coords(coords: &mut Value) {
    if let Value::Array(arr) = coords {
        if arr.is_empty() {
            return;
        }
        
        // 检查第一个元素是否是数字（浮点数或整数）
        if arr[0].is_number() {
            // 这是一个坐标对 [lng, lat]
            if arr.len() >= 2 {
                // 使用 as_f64() 可以同时处理整数和浮点数
                if let (Some(lng), Some(lat)) = (arr[0].as_f64(), arr[1].as_f64()) {
                    let (new_lng, new_lat) = gcj02_to_wgs84(lng, lat);
                    arr[0] = Value::from(new_lng);
                    arr[1] = Value::from(new_lat);
                }
            }
        } else {
            // 这是嵌套数组，递归处理
            for item in arr.iter_mut() {
                transform_coords(item);
            }
        }
    }
}

/// 行政区划项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminRegion {
    pub code: String,
    pub name: String,
}

/// 中国省级行政区划
const PROVINCES: &[(&str, &str)] = &[
    ("110000", "北京市"),
    ("120000", "天津市"),
    ("130000", "河北省"),
    ("140000", "山西省"),
    ("150000", "内蒙古自治区"),
    ("210000", "辽宁省"),
    ("220000", "吉林省"),
    ("230000", "黑龙江省"),
    ("310000", "上海市"),
    ("320000", "江苏省"),
    ("330000", "浙江省"),
    ("340000", "安徽省"),
    ("350000", "福建省"),
    ("360000", "江西省"),
    ("370000", "山东省"),
    ("410000", "河南省"),
    ("420000", "湖北省"),
    ("430000", "湖南省"),
    ("440000", "广东省"),
    ("450000", "广西壮族自治区"),
    ("460000", "海南省"),
    ("500000", "重庆市"),
    ("510000", "四川省"),
    ("520000", "贵州省"),
    ("530000", "云南省"),
    ("540000", "西藏自治区"),
    ("610000", "陕西省"),
    ("620000", "甘肃省"),
    ("630000", "青海省"),
    ("640000", "宁夏回族自治区"),
    ("650000", "新疆维吾尔自治区"),
    ("710000", "台湾省"),
    ("810000", "香港特别行政区"),
    ("820000", "澳门特别行政区"),
];

/// 获取省份列表
pub fn get_provinces() -> Vec<AdminRegion> {
    PROVINCES
        .iter()
        .map(|(code, name)| AdminRegion {
            code: code.to_string(),
            name: name.to_string(),
        })
        .collect()
}

/// DataV API 响应结构
#[derive(Debug, Deserialize)]
struct DataVResponse {
    features: Vec<DataVFeature>,
}

#[derive(Debug, Deserialize)]
struct DataVFeature {
    properties: DataVProperties,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DataVProperties {
    adcode: Option<i64>,
    name: Option<String>,
    #[serde(default, rename = "childrenNum")]
    children_num: i32,
}

/// 从 DataV API 获取子区域
async fn fetch_children(code: &str) -> Result<Vec<AdminRegion>, String> {
    let url = format!(
        "https://geo.datav.aliyun.com/areas_v3/bound/{}_full.json",
        code
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let data: DataVResponse = response
        .json()
        .await
        .map_err(|e| format!("解析失败: {}", e))?;

    let regions: Vec<AdminRegion> = data
        .features
        .iter()
        .filter_map(|f| {
            let code = f.properties.adcode?;
            let name = f.properties.name.clone()?;
            Some(AdminRegion {
                code: code.to_string(),
                name,
            })
        })
        .collect();

    Ok(regions)
}

/// 获取城市列表
pub async fn get_cities(province_code: &str) -> Result<Vec<AdminRegion>, String> {
    fetch_children(province_code).await
}

/// 获取区县列表
pub async fn get_districts(city_code: &str) -> Result<Vec<AdminRegion>, String> {
    fetch_children(city_code).await
}

/// 获取行政区边界 GeoJSON
/// 参数 to_wgs84: 是否将 GCJ-02 转换为 WGS-84（默认 true）
pub async fn get_admin_boundary(code: &str, to_wgs84: bool) -> Result<serde_json::Value, String> {
    let url = format!(
        "https://geo.datav.aliyun.com/areas_v3/bound/{}.json",
        code
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let mut geojson: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析失败: {}", e))?;

    // 根据参数决定是否转换坐标
    if to_wgs84 {
        transform_geojson_coords(&mut geojson);
    }

    Ok(geojson)
}

/// 地名搜索结果
#[derive(Debug, Clone, Serialize)]
pub struct GeocodeResult {
    pub name: String,
    pub display_name: String,
    pub lat: f64,
    pub lng: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<GeoBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GeoBounds {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}

/// 下载 OSM 要素
/// feature_type: building, highway, waterway, landuse, natural, amenity 等
/// polygon: 可选的多边形坐标 (lat, lng) 列表，用于精确过滤
pub async fn download_osm_features(
    south: f64,
    west: f64,
    north: f64,
    east: f64,
    feature_type: &str,
    proxy: Option<&str>,
    polygon: Option<&[(f64, f64)]>,
) -> Result<serde_json::Value, String> {
    // 生成区域过滤字符串：优先使用多边形，否则使用边界框
    let area_filter = if let Some(poly) = polygon {
        if poly.len() >= 3 {
            // 使用 Overpass poly: 语法
            // 格式: poly:"lat1 lng1 lat2 lng2 ..."
            let poly_str: String = poly.iter()
                .map(|(lat, lng)| format!("{} {}", lat, lng))
                .collect::<Vec<_>>()
                .join(" ");
            println!("[OSM] 下载 {} 数据, 使用多边形过滤 ({} 个顶点)", feature_type, poly.len());
            format!("(poly:\"{}\")", poly_str)
        } else {
            println!("[OSM] 下载 {} 数据, 边界框: ({}, {}, {}, {})", feature_type, south, west, north, east);
            format!("({},{},{},{})", south, west, north, east)
        }
    } else {
        println!("[OSM] 下载 {} 数据, 边界框: ({}, {}, {}, {})", feature_type, south, west, north, east);
        format!("({},{},{},{})", south, west, north, east)
    };
    
    // 根据要素类型生成 Overpass 查询
    let query = match feature_type {
        "building" | "buildings" => format!(
            r#"[out:json][timeout:120];
            (
              way["building"]{af};
              relation["building"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            af = area_filter
        ),
        "highway" | "roads" => format!(
            r#"[out:json][timeout:120];
            (
              way["highway"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            af = area_filter
        ),
        "waterway" | "waterways" => format!(
            r#"[out:json][timeout:120];
            (
              way["waterway"]{af};
              relation["waterway"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            af = area_filter
        ),
        "landuse" => format!(
            r#"[out:json][timeout:120];
            (
              way["landuse"]{af};
              relation["landuse"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            af = area_filter
        ),
        "natural" => format!(
            r#"[out:json][timeout:120];
            (
              way["natural"]{af};
              relation["natural"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            af = area_filter
        ),
        "amenity" | "pois" => format!(
            r#"[out:json][timeout:120];
            (
              node["amenity"]{af};
              way["amenity"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            af = area_filter
        ),
        "railway" | "railways" => format!(
            r#"[out:json][timeout:120];
            (
              way["railway"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            af = area_filter
        ),
        _ => format!(
            r#"[out:json][timeout:120];
            (
              way["{ft}"]{af};
            );
            out body;
            >;
            out skel qt;"#,
            ft = feature_type,
            af = area_filter
        ),
    };

    // 使用 Overpass API
    let overpass_url = "https://overpass-api.de/api/interpreter";
    
    let client_builder = Client::builder()
        .timeout(Duration::from_secs(120));
    
    let client = if let Some(proxy_url) = proxy {
        if !proxy_url.is_empty() {
            client_builder
                .proxy(reqwest::Proxy::all(proxy_url).map_err(|e| format!("代理设置失败: {}", e))?)
                .build()
                .map_err(|e| e.to_string())?
        } else {
            client_builder.build().map_err(|e| e.to_string())?
        }
    } else {
        client_builder.build().map_err(|e| e.to_string())?
    };

    let response = client
        .post(overpass_url)
        .header("User-Agent", "TIF-Downloader/1.0")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("data={}", urlencoding::encode(&query)))
        .send()
        .await
        .map_err(|e| format!("Overpass API 请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Overpass API 返回 HTTP {}", response.status()));
    }

    let osm_data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("OSM 数据解析失败: {}", e))?;
    
    // 输出元素数量用于调试
    if let Some(elements) = osm_data.get("elements").and_then(|e| e.as_array()) {
        println!("[OSM] Overpass 返回 {} 个元素", elements.len());
    } else {
        println!("[OSM] Overpass 返回数据无 elements 字段");
    }

    // 转换为 GeoJSON
    let geojson = osm_to_geojson(osm_data)?;
    
    Ok(geojson)
}

/// 将 Overpass API 返回的 OSM 数据转换为 GeoJSON
fn osm_to_geojson(osm_data: serde_json::Value) -> Result<serde_json::Value, String> {
    use std::collections::HashMap;
    
    let elements = osm_data.get("elements")
        .and_then(|e| e.as_array())
        .ok_or("无效的 OSM 数据格式")?;
    
    // 索引所有节点
    let mut nodes: HashMap<i64, (f64, f64)> = HashMap::new();
    for elem in elements {
        if elem.get("type").and_then(|t| t.as_str()) == Some("node") {
            if let (Some(id), Some(lat), Some(lon)) = (
                elem.get("id").and_then(|i| i.as_i64()),
                elem.get("lat").and_then(|l| l.as_f64()),
                elem.get("lon").and_then(|l| l.as_f64()),
            ) {
                nodes.insert(id, (lon, lat));
            }
        }
    }
    
    // 转换 way 和 relation 为 GeoJSON features
    let mut features = Vec::new();
    
    for elem in elements {
        let elem_type = elem.get("type").and_then(|t| t.as_str()).unwrap_or("");
        
        match elem_type {
            "way" => {
                if let Some(node_ids) = elem.get("nodes").and_then(|n| n.as_array()) {
                    let coords: Vec<serde_json::Value> = node_ids
                        .iter()
                        .filter_map(|id| {
                            let node_id = id.as_i64()?;
                            let (lon, lat) = nodes.get(&node_id)?;
                            Some(serde_json::json!([lon, lat]))
                        })
                        .collect();
                    
                    if coords.len() >= 2 {
                        let is_closed = node_ids.first() == node_ids.last() && coords.len() >= 4;
                        let geometry = if is_closed {
                            serde_json::json!({
                                "type": "Polygon",
                                "coordinates": [coords]
                            })
                        } else {
                            serde_json::json!({
                                "type": "LineString",
                                "coordinates": coords
                            })
                        };
                        
                        let properties = elem.get("tags").cloned().unwrap_or(serde_json::json!({}));
                        
                        features.push(serde_json::json!({
                            "type": "Feature",
                            "geometry": geometry,
                            "properties": properties
                        }));
                    }
                }
            }
            "node" => {
                // 只包含有 tags 的节点 (POI)
                if elem.get("tags").is_some() {
                    if let (Some(lat), Some(lon)) = (
                        elem.get("lat").and_then(|l| l.as_f64()),
                        elem.get("lon").and_then(|l| l.as_f64()),
                    ) {
                        let properties = elem.get("tags").cloned().unwrap_or(serde_json::json!({}));
                        
                        features.push(serde_json::json!({
                            "type": "Feature",
                            "geometry": {
                                "type": "Point",
                                "coordinates": [lon, lat]
                            },
                            "properties": properties
                        }));
                    }
                }
            }
            _ => {}
        }
    }
    
    println!("[OSM] 转换为 {} 个 GeoJSON features", features.len());
    
    Ok(serde_json::json!({
        "type": "FeatureCollection",
        "features": features
    }))
}

/// 地名搜索 (Nominatim API)
pub async fn geocode_search(query: &str) -> Result<Vec<GeocodeResult>, String> {
    let url = format!(
        "https://nominatim.openstreetmap.org/search?q={}&format=json&addressdetails=1&limit=5",
        urlencoding::encode(query)
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("User-Agent", "TIF-Downloader/1.0")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let data: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("解析失败: {}", e))?;

    let results: Vec<GeocodeResult> = data
        .iter()
        .filter_map(|item| {
            let lat = item.get("lat")?.as_str()?.parse::<f64>().ok()?;
            let lng = item.get("lon")?.as_str()?.parse::<f64>().ok()?;
            let name = item.get("name")?.as_str().unwrap_or("").to_string();
            let display_name = item.get("display_name")?.as_str()?.to_string();
            
            let bounds = item.get("boundingbox").and_then(|bb| {
                let arr = bb.as_array()?;
                if arr.len() >= 4 {
                    Some(GeoBounds {
                        south: arr[0].as_str()?.parse().ok()?,
                        north: arr[1].as_str()?.parse().ok()?,
                        west: arr[2].as_str()?.parse().ok()?,
                        east: arr[3].as_str()?.parse().ok()?,
                    })
                } else {
                    None
                }
            });
            
            let address = item.get("address").cloned();
            
            Some(GeocodeResult {
                name: if name.is_empty() { display_name.split(',').next()?.to_string() } else { name },
                display_name,
                lat,
                lng,
                bounds,
                address,
            })
        })
        .collect();

    Ok(results)
}
