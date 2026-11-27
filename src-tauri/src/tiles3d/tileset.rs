use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================
// 3D Tiles tileset.json 数据结构
// 兼容 1.0 (url) 和 1.1 (uri, contents)
// ============================================================

/// tileset.json 根对象
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tileset {
    pub asset: Asset,
    pub geometric_error: f64,
    pub root: Tile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<serde_json::Value>,
    /// 保留未识别字段，重写时原样输出
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tileset_version: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// 单个瓦片节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    pub bounding_volume: BoundingVolume,
    pub geometric_error: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refine: Option<Refine>,
    /// 1.0: 单个 content
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<TileContent>,
    /// 1.1: 多个 contents
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contents: Option<Vec<TileContent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Tile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Vec<f64>>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// 包围体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingVolume {
    /// [west, south, east, north, minHeight, maxHeight] 弧度
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<Vec<f64>>,
    /// 12 个浮点数: center(3) + x_half_axis(3) + y_half_axis(3) + z_half_axis(3)
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "box")]
    pub box_volume: Option<Vec<f64>>,
    /// [cx, cy, cz, radius]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sphere: Option<Vec<f64>>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// 瓦片内容引用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileContent {
    /// 1.1 标准字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// 1.0 遗留字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounding_volume: Option<BoundingVolume>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl TileContent {
    /// 获取 URI，兼容 1.0 url 和 1.1 uri
    pub fn get_uri(&self) -> Option<&str> {
        self.uri.as_deref().or(self.url.as_deref())
    }

    /// 设置 URI，同时更新 url 和 uri 字段以保持兼容
    pub fn set_uri(&mut self, new_uri: String) {
        if self.url.is_some() {
            self.url = Some(new_uri.clone());
        }
        if self.uri.is_some() {
            self.uri = Some(new_uri.clone());
        }
        // 如果两者皆无（不应发生），设 uri
        if self.url.is_none() && self.uri.is_none() {
            self.uri = Some(new_uri);
        }
    }
}

/// 细化策略
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Refine {
    Add,
    Replace,
}

impl Tile {
    /// 收集该节点的所有内容 URI（兼容 content 和 contents）
    pub fn content_uris(&self) -> Vec<&str> {
        let mut uris = Vec::new();
        if let Some(ref c) = self.content {
            if let Some(uri) = c.get_uri() {
                uris.push(uri);
            }
        }
        if let Some(ref cs) = self.contents {
            for c in cs {
                if let Some(uri) = c.get_uri() {
                    uris.push(uri);
                }
            }
        }
        uris
    }

    /// 判断该节点的内容是否指向外部 tileset（以 .json 结尾，忽略查询参数）
    pub fn is_external_tileset(&self) -> bool {
        self.content_uris()
            .iter()
            .any(|uri| {
                let clean = uri.split('?').next().unwrap_or(uri);
                clean.to_lowercase().ends_with(".json")
            })
    }
}

// ============================================================
// 数据源配置
// ============================================================

/// 3D Tiles 数据源
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Tiles3dSource {
    #[serde(rename = "cesium_ion")]
    CesiumIon {
        asset_id: u64,
        access_token: String,
    },
    #[serde(rename = "url")]
    DirectUrl {
        tileset_url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}

/// 解析后的端点信息
#[derive(Debug, Clone)]
pub struct ResolvedEndpoint {
    pub tileset_url: String,
    pub auth_headers: HashMap<String, String>,
}

/// 3D Tiles 下载请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tiles3dRequest {
    pub source: Tiles3dSource,
    /// 用户选区多边形 [[lng, lat], ...] WGS-84 度；None 表示下载全部
    #[serde(default)]
    pub polygon: Option<crate::selection_areas::SelectionAreas>,
    /// 保存路径
    pub save_path: String,
    /// 并发数
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    /// 代理
    #[serde(default)]
    pub proxy: Option<String>,
}

fn default_concurrency() -> usize {
    50
}

/// 解析结果摘要（用于前端预览）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TilesetSummary {
    /// 资产版本
    pub version: String,
    /// 覆盖范围 [west, south, east, north] 度
    pub extent: Option<[f64; 4]>,
    /// 总节点数
    pub total_tiles: usize,
    /// 有内容的节点数
    pub content_tiles: usize,
    /// 最大树深度
    pub max_depth: usize,
    /// 层级数（max_depth + 1）
    pub levels: usize,
    /// 是否包含外部 tileset 引用（含外部引用时统计仅为根级）
    pub has_external_tilesets: bool,
}

impl Tileset {
    /// 统计 tileset 概要信息
    pub fn summary(&self) -> TilesetSummary {
        let mut total = 0usize;
        let mut with_content = 0usize;
        let mut max_depth = 0usize;
        let mut has_external = false;

        fn walk(tile: &Tile, depth: usize, total: &mut usize, with_content: &mut usize, max_depth: &mut usize, has_external: &mut bool) {
            *total += 1;
            let uris = tile.content_uris();
            if !uris.is_empty() {
                *with_content += 1;
                if uris.iter().any(|u| u.to_lowercase().ends_with(".json")) {
                    *has_external = true;
                }
            }
            if depth > *max_depth {
                *max_depth = depth;
            }
            if let Some(ref children) = tile.children {
                for child in children {
                    walk(child, depth + 1, total, with_content, max_depth, has_external);
                }
            }
        }

        walk(&self.root, 0, &mut total, &mut with_content, &mut max_depth, &mut has_external);

        let extent = self.root.bounding_volume.to_degrees_extent();

        TilesetSummary {
            version: self.asset.version.clone(),
            extent,
            total_tiles: total,
            content_tiles: with_content,
            max_depth,
            levels: max_depth + 1,
            has_external_tilesets: has_external,
        }
    }
}

impl BoundingVolume {
    /// 将 region 包围体转为经纬度范围 [west, south, east, north]（度）
    pub fn to_degrees_extent(&self) -> Option<[f64; 4]> {
        if let Some(ref region) = self.region {
            if region.len() >= 4 {
                return Some([
                    region[0].to_degrees(), // west
                    region[1].to_degrees(), // south
                    region[2].to_degrees(), // east
                    region[3].to_degrees(), // north
                ]);
            }
        }
        // box 和 sphere 类型需要更复杂的转换，暂返回 None
        None
    }
}

// ============================================================
// Cesium Ion API 响应结构
// ============================================================

#[derive(Debug, Deserialize)]
pub struct IonEndpointResponse {
    pub r#type: String,
    pub url: Option<String>,
    #[serde(rename = "accessToken")]
    pub access_token: Option<String>,
    #[serde(rename = "externalType")]
    pub external_type: Option<String>,
    pub options: Option<IonEndpointOptions>,
}

#[derive(Debug, Deserialize)]
pub struct IonEndpointOptions {
    pub url: Option<String>,
}
