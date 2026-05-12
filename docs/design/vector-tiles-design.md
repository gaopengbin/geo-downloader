# 矢量切片下载功能 — 技术设计文档

> 创建日期: 2026-04-18
> 状态: 方案设计阶段
> 作者: Geo Downloader 团队
> 关联：v3.3.x 候选特性（核心能力补全）
> 优先级：高（差异化能力 + 市场空白）

## 1. 功能概述

为 Geo Downloader 新增**矢量切片（Vector Tiles, MVT）下载与打包能力**，将工具从「栅格瓦片下载器」升级为「全栈瓦片下载器」，覆盖栅格 + 矢量两大主流瓦片体系。

### 1.1 与现有能力对比

| 能力 | 当前 | 引入后 |
|---|---|---|
| 栅格瓦片（PNG/JPG） | ✅ | ✅ |
| 矢量瓦片（PBF/MVT） | ❌ | ✅ |
| 输出 GeoTIFF | ✅ | ✅ |
| 输出 MBTiles 栅格 | ❌（前置功能） | ✅ |
| 输出 MBTiles 矢量 | ❌ | ✅ |
| 客户端可换样式 | ❌ | ✅（矢量天然支持） |
| 客户端可查询要素 | ❌ | ✅ |

### 1.2 用户价值

| 用户类型 | 价值 |
|---|---|
| GIS 数据工程师 | 一次下载，灵活样式，免去手动从 PostGIS 切片 |
| Web 地图开发 | 离线 MBTiles 直接配 MapLibre/Mapbox GL，零服务器部署 |
| 无人系统 / 自动驾驶 | 程序判断航道/道路/禁区（语义可读，PNG 做不到） |
| 数据分析 | 提取道路/POI/水系矢量数据，省去外部 ETL |

### 1.3 核心差异化

- 国内同类工具（BIGEMAP、水经注、91 卫图助手）**全部不支持矢量切片下载**
- 是当前市场的真空地带

---

## 2. 数据源调研

### 2.1 矢量切片源对比

| 数据源 | 覆盖 | 认证 | 速度 | 推荐度 |
|---|---|---|---|---|
| **OpenMapTiles (公开实例)** | 全球 | 无 | 中（海外） | ⭐⭐⭐⭐ |
| **Maptiler Vector** | 全球 | API Key（免费 10 万次/月） | 中 | ⭐⭐⭐⭐⭐ |
| **Mapbox Streets** | 全球 | API Key（免费 5 万次/月） | 中 | ⭐⭐⭐⭐ |
| **Stadia Maps Vector** | 全球 | API Key（免费 20 万次/月） | 中 | ⭐⭐⭐⭐ |
| **Esri ArcGIS World Vector** | 全球 | 无（公开服务） | 慢（海外） | ⭐⭐⭐ |
| **Tilezen / Nextzen** | 全球 | 无 | 慢（已停服务，仅历史快照） | ⭐⭐ |
| **天地图矢量底图** | 国内 | API Key | 快 | ⚠️ 实为栅格，伪矢量 |
| **高德/百度** | 国内 | — | — | ❌ 无公开矢量切片 API |

### 2.2 推荐：Maptiler Vector（首选）

**URL 模板**：
```
https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key={API_KEY}
```

**特点**：
- OpenMapTiles schema（业界事实标准）
- 免费 10 万次/月（无人船/中小项目完全够用）
- CDN 全球加速，国内可达
- 含 17 个标准图层：water, waterway, landcover, landuse, mountain_peak, transportation, transportation_name, building, place, housenumber, water_name, aerodrome_label, park, boundary, aeroway, poi

### 2.3 备选：自建 OpenMapTiles 实例

```
https://tile.openstreetmap.fr/openmaptiles/{z}/{x}/{y}.pbf
```

无需 API Key，但稳定性不如商业服务。适合临时使用或国内部署。

### 2.4 真矢量 vs 伪矢量识别

国内"矢量地图"常常实为栅格（如天地图 vec_w 是 PNG）。判断方法：
- 真矢量：返回 `application/x-protobuf` 或 `.pbf`
- 伪矢量：返回 `image/png`，仅是"看起来像矢量"的栅格风格

工具实现时需在源配置中**显式标记** `tile_format: "pbf" | "png"`，避免误用。

---

## 3. 技术方案

### 3.1 架构集成

矢量切片与栅格切片共用大部分基础设施：

```
┌──────────────────────────────────────────────────────┐
│ 前端：瓦片类型选择                                   │
│   ○ 栅格瓦片（现有）                                 │
│   ● 矢量瓦片（新增）                                 │
│     └─ 数据源：Maptiler Vector ▼                     │
│         ├─ API Key 输入框                            │
│         └─ 图层选择（可选过滤）                      │
├──────────────────────────────────────────────────────┤
│ 后端：统一任务入口 create_download_task              │
│   新增字段：tile_format: "raster" | "vector"         │
├──────────────────────────────────────────────────────┤
│ 执行分支                                             │
│   raster → 现有流程                                  │
│   vector:                                            │
│     ├─ 复用 fetcher.rs（仅文件扩展名换 .pbf）        │
│     ├─ 跳过拼接阶段（矢量无法"拼"）                  │
│     └─ 走 MBTiles 矢量打包 (vector_mbtiles_writer)   │
├──────────────────────────────────────────────────────┤
│ 输出：MBTiles (format=pbf)                          │
│   + metadata 表（含 vector_layers 描述）             │
│   + tiles 表（zoom/col/row → pbf blob）              │
└──────────────────────────────────────────────────────┘
```

### 3.2 数据流

```
用户选 bbox + zoom 范围 → 瓦片列表计算（复用 tile::bbox_to_tiles）
  ↓
并发下载 PBF 瓦片（复用 downloader.rs，仅扩展名/Content-Type 适配）
  ↓
【新增】MBTiles 矢量写入 (vector_mbtiles.rs)
  - 创建 SQLite 文件
  - 写入 metadata（含 vector_layers JSON）
  - 逐瓦片 INSERT 到 tiles 表
  - 注意 TMS y 翻转：tms_y = (1 << z) - 1 - xyz_y
  ↓
输出：单个 .mbtiles 文件
```

### 3.3 Rust 模块设计

```
src-tauri/src/vector/
  mod.rs                   # 模块入口 + VectorSource 枚举
  mvt_decoder.rs           # PBF 解码（用于元数据提取，可选）
  vector_mbtiles.rs        # MBTiles SQLite 写入
  layer_inspector.rs       # 解析 .pbf 抽取 vector_layers 元数据
```

### 3.4 核心代码示意

#### 3.4.1 矢量切片源配置

```rust
// src-tauri/src/config.rs
pub struct VectorTileSource {
    pub id: String,
    pub name: String,
    pub url_template: String,   // 含 {z}/{x}/{y}/{key}
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub format: TileFormat,     // Pbf | Png
    pub requires_key: bool,
    pub attribution: String,
}

pub enum TileFormat { Png, Jpg, Pbf }
```

#### 3.4.2 MBTiles 矢量写入

```rust
use rusqlite::{Connection, params};

pub struct VectorMBTilesWriter {
    conn: Connection,
}

impl VectorMBTilesWriter {
    pub fn create(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("
            CREATE TABLE metadata (name TEXT, value TEXT);
            CREATE TABLE tiles (
                zoom_level INTEGER, 
                tile_column INTEGER, 
                tile_row INTEGER, 
                tile_data BLOB,
                PRIMARY KEY (zoom_level, tile_column, tile_row)
            );
            CREATE INDEX idx_tiles ON tiles(zoom_level, tile_column, tile_row);
        ")?;
        Ok(Self { conn })
    }
    
    pub fn write_metadata(&self, meta: &MBTilesMetadata) -> Result<()> {
        let stmt = "INSERT INTO metadata (name, value) VALUES (?, ?)";
        self.conn.execute(stmt, params!["name", meta.name])?;
        self.conn.execute(stmt, params!["format", "pbf"])?;
        self.conn.execute(stmt, params!["bounds", meta.bounds_str()])?;
        self.conn.execute(stmt, params!["minzoom", meta.min_zoom])?;
        self.conn.execute(stmt, params!["maxzoom", meta.max_zoom])?;
        self.conn.execute(stmt, params!["type", "overlay"])?;
        self.conn.execute(stmt, params!["version", "1.0"])?;
        // 矢量切片必须含 vector_layers JSON
        self.conn.execute(stmt, params!["json", meta.vector_layers_json()])?;
        Ok(())
    }
    
    pub fn write_tile(&self, z: u8, x: u32, y: u32, data: &[u8]) -> Result<()> {
        // XYZ → TMS 翻转
        let tms_y = (1u32 << z) - 1 - y;
        self.conn.execute(
            "INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)",
            params![z as i64, x as i64, tms_y as i64, data]
        )?;
        Ok(())
    }
}
```

#### 3.4.3 vector_layers 元数据提取

MBTiles 矢量规范要求 metadata 表含 `json` 字段，描述每个图层。从首个下载成功的 .pbf 解析：

```rust
// 用 mvt 或 protobuf-codegen 解析
pub fn extract_vector_layers(pbf: &[u8]) -> Result<Vec<VectorLayerMeta>> {
    let tile = mvt::Tile::decode(pbf)?;
    let mut layers = Vec::new();
    for layer in tile.layers {
        let mut fields = HashMap::new();
        for feature in &layer.features {
            for (key, value) in feature.properties() {
                fields.entry(key.clone())
                    .or_insert_with(|| infer_type(value));
            }
        }
        layers.push(VectorLayerMeta {
            id: layer.name,
            description: String::new(),
            minzoom: 0,
            maxzoom: 14,
            fields,
        });
    }
    Ok(layers)
}
```

### 3.5 依赖项新增

```toml
# Cargo.toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
# 可选（用于 vector_layers 元数据提取）
prost = "0.12"  # 或 mvt = "0.10"
```

`rusqlite` 启用 `bundled` 特性，免除用户系统装 SQLite，与 Tauri 单文件分发理念一致。

### 3.6 前端 UI 改动

#### 3.6.1 数据类型切换

主界面顶部新增切换：

```
┌──────────────────────────────────────────────┐
│ 瓦片类型：[● 栅格] [○ 矢量]                 │
└──────────────────────────────────────────────┘
```

切换到"矢量"后联动：
- 瓦片源下拉替换为矢量源（Maptiler / OpenMapTiles / 自定义）
- 输出格式锁定为 **MBTiles**（不允许选 GeoTIFF/PNG）
- 显示 API Key 输入框（如果源需要）
- 显示图层信息提示

#### 3.6.2 输出格式联动

| 瓦片类型 | 可选输出 |
|---|---|
| 栅格 | GeoTIFF / BigTIFF / PNG / JPG / **MBTiles 栅格**（v3.3.1 新增） |
| 矢量 | **MBTiles 矢量** |

---

## 4. 实施计划

### 4.1 前置依赖

矢量切片功能依赖 **MBTiles 写入能力**，因此推荐拆为两个里程碑：

| 里程碑 | 内容 | 工期 |
|---|---|---|
| **M1: MBTiles 栅格导出** | rusqlite 集成 + 栅格 MBTiles writer | 1.5 天 |
| **M2: 矢量切片下载** | 配置 + .pbf 下载 + 矢量 MBTiles writer | 2 天 |
| **M3: 元数据增强** | vector_layers 提取 + UI 联动 | 1 天 |
| **M4: 测试 + 文档** | E2E 测试 + 用户文档 | 0.5 天 |
| **总计** | | **5 天** |

### 4.2 阶段拆解

#### 阶段 1：MBTiles 栅格 writer（铺垫）
- 引入 rusqlite + bundled
- 实现 `MBTilesWriter` 通用结构（栅格/矢量复用）
- 在现有栅格输出菜单加 MBTiles 选项
- E2E 测试：下载小区域 → 输出 .mbtiles → QGIS 验证

#### 阶段 2：矢量切片配置 + 下载
- 新增 `VectorTileSource` 配置
- 内置 Maptiler / OpenMapTiles 公开源
- 适配 downloader：识别 `tile_format=pbf`，扩展名 .pbf
- 下载流程跳过拼接阶段，直接进打包

#### 阶段 3：矢量 MBTiles 输出
- 实现 `VectorMBTilesWriter`
- 写入完整 metadata（特别是 `vector_layers`）
- 提取首个 .pbf 自动生成 layer schema

#### 阶段 4：UI 与体验
- 瓦片类型 Radio 切换
- API Key 输入与持久化
- 进度显示适配（无拼接阶段）

### 4.3 不在本期范围

- 矢量切片样式预览（v3.4+）
- 自定义图层过滤（仅下载 roads + water）（v3.4+）
- PMTiles 输出（v3.5+）
- 矢量切片到 Shapefile/GeoJSON 转换（v3.5+，外部 GDAL 已能做）

---

## 5. 测试计划

### 5.1 单元测试

```rust
#[test]
fn test_xyz_to_tms_y_flip() {
    assert_eq!(xyz_to_tms(14, 13345, 6789), (14, 13345, 9594));
}

#[test]
fn test_mbtiles_metadata_required_fields() {
    // 验证 name/format/bounds/minzoom/maxzoom/type/version/json 全部写入
}

#[test]
fn test_vector_layers_extraction() {
    let pbf = include_bytes!("../testdata/sample.pbf");
    let layers = extract_vector_layers(pbf).unwrap();
    assert!(layers.iter().any(|l| l.id == "water"));
}
```

### 5.2 端到端测试

| 测试 | 验证点 |
|---|---|
| 小区域 z6-z10 下载 | 文件可被 QGIS 直接打开 |
| 矢量样式渲染 | 在 MapLibre + OpenMapTiles style 下能正确渲染 |
| Python 解码 | mapbox_vector_tile.decode() 不报错 |
| 大区域 z0-z14 | 文件大小合理（< 数百 MB），不 OOM |
| 断点续传 | 中断后重启能跳过已下载瓦片 |

### 5.3 兼容性矩阵

| 客户端 | 验证 |
|---|---|
| QGIS 3.30+ | 直接拖入 .mbtiles |
| MapLibre GL JS | `addSource({type:'vector', url:'mbtiles://...'})` |
| Mapbox GL JS | 同 MapLibre |
| Tippecanoe | `tippecanoe-decode out.mbtiles` |
| Python | `import mapbox_vector_tile` |

---

## 6. 风险与权衡

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| 国内主流地图无矢量切片 | 中 | 内置海外源 + 鼓励用户自配 |
| 海外源访问慢 | 中 | UI 显示推荐 CDN / 国内镜像；保留代理设置 |
| API Key 滥用风险 | 低 | Key 仅本地存储，不上传服务器 |
| 矢量切片 schema 多样 | 低 | 首期只支持 OpenMapTiles schema，其他作"原样下载" |
| 用户认知门槛 | 中 | 文档 + UI 内提示 + 配套样式模板 |
| MBTiles 文件超大 | 低 | SQLite 单库 281 TB 上限，远超实际需求 |
| 瓦片缺失（404） | 低 | 复用现有 404 处理 + no_data 统计 |

---

## 7. 与现有路线图的关系

| 版本 | 现有规划 | 调整建议 |
|---|---|---|
| v3.3.0 | 批量 shp + TIFF 金字塔 | 维持 |
| v3.3.1 | （未占用） | **新增：MBTiles 栅格导出** |
| v3.3.2 | （未占用） | **新增：矢量切片下载** |
| v3.4.0 | Wayback 增量 + DEM | 维持 |

矢量切片插入 v3.3 系列，不影响后续节奏。

---

## 8. 参考资料

- [Mapbox Vector Tile Specification](https://github.com/mapbox/vector-tile-spec)
- [MBTiles 1.3 Specification](https://github.com/mapbox/mbtiles-spec)
- [OpenMapTiles Schema](https://openmaptiles.org/schema/)
- [MapLibre GL JS Style Spec](https://maplibre.org/maplibre-style-spec/)
- [Maptiler Cloud](https://www.maptiler.com/cloud/)

---

## 9. 决策记录

| 决策 | 选项 | 选定 | 理由 |
|---|---|---|---|
| 默认源 | OpenMapTiles 公开 / Maptiler / 自建 | **Maptiler** | 稳定 + CDN + 免费额度大 |
| 打包格式 | MBTiles / PMTiles / 散文件 | **MBTiles** | 客户端兼容性最好 |
| SQLite 集成 | rusqlite / sqlx | **rusqlite (bundled)** | 单文件分发，无运行时依赖 |
| 矢量解码库 | mvt / prost+自定义 / 不解码 | **首期不解码**（只透传） | 降低实现复杂度 |
| Y 轴约定 | XYZ / TMS | **存储 TMS（mbtiles 规范）+ 下载用 XYZ** | 兼容 MBTiles 标准 |

---

> **下一步**：本文档评审通过后，在 GitHub 提 Issue 跟踪实施进度，按里程碑 M1→M4 顺序开发。
