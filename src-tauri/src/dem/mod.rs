//! DEM（数字高程模型）下载模块
//!
//! 当前支持：
//! - AWS Terrain Tiles (Terrarium 编码) - 全球免费，无需 API Key
//!
//! 计划：
//! - Mapbox Terrain-RGB
//! - Copernicus GLO-30 (COG Range)

pub mod terrarium;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DemSource {
    /// AWS Terrain Tiles - Terrarium 编码 PNG 瓦片，全球，最大 z15
    Terrarium,
}

impl DemSource {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "terrarium" | "dem_terrarium" | "aws_terrarium" => Some(Self::Terrarium),
            _ => None,
        }
    }

    pub fn url_template(&self) -> &'static str {
        match self {
            Self::Terrarium => "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        }
    }

    pub fn max_zoom(&self) -> u8 {
        match self {
            Self::Terrarium => 15,
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Terrarium => "AWS Terrain (Terrarium)",
        }
    }
}

/// 判断给定 source id 是否为 DEM 数据源
pub fn is_dem_source(source: &str) -> bool {
    DemSource::from_str(source).is_some()
}
