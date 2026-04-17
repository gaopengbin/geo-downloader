# 数字高程模型（DEM）下载功能 — 技术设计文档

> 创建日期: 2026-04-17
> 状态: 方案设计阶段
> 作者: Geo Downloader 团队
> 关联：v3.4.x 候选特性（DEM 领域独立规划）
> 需求提出者：jojo

## 1. 功能概述

新增**数字高程模型（Digital Elevation Model, DEM）** 下载能力，让用户在同一工具内获取影像 + 高程数据，覆盖科研、地形分析、3D 可视化等场景。

### 用户真实反馈

> jojo：之前下个瓦片、导个影像要开好几个软件，现在一个 GeoD 就搞定了。未来如果能增加批量范围内导入下载，和支持数字高程基本就完美了！

**关键诉求**：高程与影像的"一站式"工作流。

### 核心价值

| 场景 | 当前做法 | 加入 DEM 后 |
|---|---|---|
| 获取卫星影像 | Geo Downloader ✓ | Geo Downloader ✓ |
| 获取配套 DEM | QGIS / ArcGIS / 手动下载 | Geo Downloader ✓ |
| 3D 地形建模 | 多工具拼接 | 单工具链路 |
| 地形分析（坡度/坡向） | 外部 GIS | 可选内置计算 |

---

## 2. 数据源调研

### 2.1 全球免费 DEM 数据源对比

| 数据源 | 分辨率 | 覆盖 | 认证 | 格式 | 推荐度 |
|---|---|---|---|---|---|
| **AWS Terrain Tiles (Terrarium)** | z0-15 (~4.8m) | 全球 | 无 | PNG 瓦片 | ⭐⭐⭐⭐⭐ |
| **Mapbox Terrain-RGB** | z0-15 | 全球 | API Key | PNG 瓦片 | ⭐⭐⭐⭐ |
| **Copernicus GLO-30** | 30m | 全球 | 无（AWS 公开桶） | COG GeoTIFF | ⭐⭐⭐⭐⭐ |
| **NASADEM** | 30m | 60°N-56°S | 无（AWS 公开） | GeoTIFF | ⭐⭐⭐⭐ |
| **SRTM 1-Arc-Second** | 30m | 60°N-56°S | 无 | HGT | ⭐⭐⭐ |
| **ASTER GDEM v3** | 30m | 83°N-83°S | NASA Earthdata | GeoTIFF | ⭐⭐⭐ |
| **ALOS AW3D30** | 30m | 全球 | JAXA 注册 | GeoTIFF | ⭐⭐⭐ |
| **Copernicus GLO-90** | 90m | 全球 | 无 | COG | ⭐⭐⭐ |

### 2.2 推荐：AWS Terrain Tiles（首选）

**URL 模板**：
```
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```

**Terrarium 编码格式**：
```
height (m) = (R * 256 + G + B / 256) - 32768
```
- R/G/B 为 PNG 像素的 3 通道值 (0-255)
- 精度 1/256 m (~3.9 mm 理论)
- 范围 -32768 到 +32767.996 m

**优点**：
- 完全免费、无限额、无认证
- 与现有瓦片下载器完美契合（复用 fetcher / merger 架构）
- Web Mercator 投影，与现有 bbox 选择一致
- 数据来源：NASADEM + SRTM + 其他公开数据融合

**限制**：
- 最高 z15（赤道 ~4.8m/pixel，高纬度更低）
- PNG 压缩有轻微损失（可接受）

### 2.3 次选：Copernicus GLO-30（高精度大区域）

**数据位置**：
```
s3://copernicus-dem-30m/Copernicus_DSM_COG_10_{NS}{lat}_00_{EW}{lon}_00_DEM/
```

**格式**：Cloud Optimized GeoTIFF，30m 分辨率

**访问方式**：
- HTTP Range Request 从 AWS S3 公开桶读取
- 按 1° × 1° 瓦片组织
- 每个 tile ~14 MB

**优点**：
- 原生 Float32 精度（无 PNG 损失）
- 最新 2022 全球更新
- 适合大区域一次性获取

**缺点**：
- 不是 Web Mercator 瓦片化，需裁剪 + 重采样
- 大区域带宽需求高

### 2.4 选择策略

| 场景 | 选用数据源 |
|---|---|
| 小区域 + 快速预览 | AWS Terrain Tiles |
| 小区域 + 需要高精度 | Copernicus GLO-30 |
| 大区域（>100 km²） | Copernicus GLO-30 |
| 极高纬度（>60°） | Copernicus GLO-30（Terrain Tiles 精度下降） |
| 默认推荐 | **AWS Terrain Tiles** |

**v3.4 首期实现 AWS Terrain Tiles，Copernicus 放 v3.5+**。

---

## 3. 技术方案

### 3.1 架构集成

DEM 下载与现有影像下载共用大部分架构：

```
┌───────────────────────────────────────────────────────┐
│ 前端：数据类型选择                                    │
│   ○ 卫星影像（现有）                                  │
│   ● 数字高程（新增）                                  │
│     └─ 数据源：AWS Terrain ▼ / Copernicus GLO-30 ▼    │
├───────────────────────────────────────────────────────┤
│ 后端：统一任务入口 create_download_task               │
│   新增字段：data_type: "imagery" | "dem"              │
│   新增字段：dem_source: Option<DemSource>             │
├───────────────────────────────────────────────────────┤
│ 执行分支                                              │
│   imagery → 现有流程                                  │
│   dem:                                                │
│     ├─ TerrainTiles: 走现有瓦片下载（PNG 瓦片）       │
│     │  ├─ 下载后 RGB 解码为 Float32 矩阵             │
│     │  └─ 写入单波段 Float32 GeoTIFF                 │
│     └─ Copernicus: 走 COG Range 下载                  │
│         ├─ 按 bbox 计算涉及的 1°×1° tile              │
│         ├─ 并发下载各 tile 的 Range bytes             │
│         └─ 重采样 + 裁剪 + 合并输出                   │
├───────────────────────────────────────────────────────┤
│ 输出：GeoTIFF Float32 单波段                          │
│   + 元数据（垂直基准、投影、NODATA）                  │
│   + 可选：等高线 / 山体阴影 / 坡度（v3.5+）          │
└───────────────────────────────────────────────────────┘
```

### 3.2 数据流（AWS Terrain Tiles 路径）

```
用户选 bbox + zoom → 瓦片列表计算（复用现有 tile::bbox_to_tiles）
  ↓
并发下载 PNG 瓦片（复用 fetcher.rs）
  ↓
【新增】DEM 解码阶段 (dem/terrarium_decoder.rs)
  - 对每个 PNG tile：
    * image::load_from_memory() → RgbaImage
    * 逐像素：height = (R*256 + G + B/256) - 32768
    * 输出 Float32Array（单波段）
  ↓
【新增】Float32 合并 (dem/mosaic.rs)
  - 按瓦片坐标拼接
  - 处理边界重叠
  ↓
【新增】Float32 GeoTIFF 写入 (dem/exporter.rs)
  - 单波段 Float32 sample
  - NODATA = -32768（或 NaN）
  - 垂直基准 VerticalDatum = EGM96
  - GeoKeys: VerticalCSTypeGeoKey = 5030 (EGM96)
  ↓
可选：生成金字塔（复用 pyramid.rs）
```

### 3.3 Rust 模块设计

```
src-tauri/src/dem/
  mod.rs                   # 模块入口 + DemSource 枚举
  terrarium_decoder.rs     # AWS Terrain RGB → Float32 解码
  mapbox_decoder.rs        # Mapbox Terrain-RGB 解码（可选）
  copernicus_fetcher.rs    # COG Range 下载（v3.5）
  mosaic.rs                # Float32 瓦片拼接
  exporter.rs              # Float32 GeoTIFF 写入
  analysis.rs              # 可选：坡度 / 山体阴影 / 等高线
```

### 3.4 核心代码示意

#### 3.4.1 Terrarium 解码

```rust
/// 从 PNG 瓦片字节数据解码 Terrarium 编码高程
pub fn decode_terrarium(png_bytes: &[u8]) -> Result<Vec<f32>, DemError> {
    let img = image::load_from_memory(png_bytes)?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut heights = Vec::with_capacity((w * h) as usize);
    
    for pixel in rgba.pixels() {
        let r = pixel[0] as f32;
        let g = pixel[1] as f32;
        let b = pixel[2] as f32;
        let height = (r * 256.0 + g + b / 256.0) - 32768.0;
        heights.push(height);
    }
    Ok(heights)
}
```

#### 3.4.2 Float32 GeoTIFF 写入

```rust
pub fn write_float32_geotiff(
    path: &Path,
    width: u32,
    height: u32,
    heights: &[f32],
    bbox: BoundingBox,
    nodata: f32,
) -> Result<()> {
    let mut encoder = TiffEncoder::new(File::create(path)?)?;
    let mut img = encoder.new_image::<colortype::Gray32Float>(width, height)?;
    
    // GeoTIFF keys
    img.encoder().write_tag(Tag::ModelPixelScaleTag, ...)?;
    img.encoder().write_tag(Tag::ModelTiepointTag, ...)?;
    img.encoder().write_tag(Tag::GeoKeyDirectoryTag, &[
        1, 1, 0, 7,  // Version, Revision, MinorRev, NumberOfKeys
        1024, 0, 1, 2,  // GTModelType = ProjectedCoordinateSystem
        1025, 0, 1, 1,  // GTRasterType = PixelIsArea
        3072, 0, 1, 3857,  // ProjectedCSType = EPSG:3857
        4096, 0, 1, 5030,  // VerticalCSType = EGM96
    ])?;
    img.encoder().write_tag(Tag::GdalNodata, nodata.to_string())?;
    
    img.write_data(heights)?;
    Ok(())
}
```

### 3.5 前端 UI 改动

#### 3.5.1 数据类型选择器

在主界面顶部新增 Tab 或 Radio：

```
┌───────────────────────────────────────┐
│ 下载类型：                            │
│ ● 卫星影像  ○ 数字高程                │
└───────────────────────────────────────┘
```

切换到"数字高程"后，其他 UI 元素联动调整：

- 瓦片源下拉替换为 **DEM 数据源**：
  - AWS Terrain Tiles（推荐 · 免费 · 全球）
  - Mapbox Terrain-RGB（需 API Key）
  - Copernicus GLO-30（高精度 · v3.5）
- Zoom 级别说明：
  - 影像：z18 ≈ 0.6m/pixel
  - DEM：z14 ≈ 10m/pixel（已达 NASADEM 源分辨率，更高无意义）
- 输出格式固定为 GeoTIFF Float32（不提供 JPEG/PNG）

#### 3.5.2 预览图

地图上叠加彩色地形渲染（hillshade + 色阶），用户可直观看到地形起伏。

实现：
- 下载缩略瓦片 → 前端 Canvas 解码 → 色阶渲染
- 使用 `chroma.js` 或内置色阶（Terrain, Viridis, etc.）

### 3.6 Zoom 与分辨率参考表

| Zoom | 赤道分辨率 | 推荐用途 |
|---|---|---|
| z10 | ~150 m | 省级 / 大区域概览 |
| z12 | ~38 m | 市级地形 |
| z13 | ~19 m | 县级精细地形 |
| **z14** | **~10 m** | **已达源数据精度，默认推荐** |
| z15 | ~4.8 m | 最大（Terrain Tiles 上限）|

UI 中显示"精度已达源极限"提示，避免用户误选过高 zoom。

---

## 4. UI 设计

### 4.1 主界面切换

```
┌────────────────────────────────────────────────┐
│ [卫星影像] [数字高程] [3D Tiles（v3.x）]       │ ← Tab 切换
├────────────────────────────────────────────────┤
│ DEM 数据源：  AWS Terrain Tiles ▼              │
│   ℹ️ 全球免费，无需 API Key，精度约 10m         │
│                                                │
│ Zoom 级别：   14 ▼                             │
│   ℹ️ 已达源数据精度，更高无意义                 │
│                                                │
│ 范围选择：    [地图绘制/shp导入]（现有）        │
│                                                │
│ 输出格式：    Float32 GeoTIFF                  │
│ 压缩：        Deflate ▼                        │
│ 构建金字塔：  ☑ 是                             │
│                                                │
│ 地形分析（可选）：                             │
│   ☐ 生成山体阴影图                             │
│   ☐ 生成坡度图                                 │
│   ☐ 生成等高线（间距 10 m）                    │
│                                                │
│            [开始下载]                          │
└────────────────────────────────────────────────┘
```

### 4.2 预览模式

- 完成下载后在地图上以色阶渲染
- 支持 3D 视图（可选 v3.5+，使用 deck.gl TerrainLayer）

---

## 5. 模块划分

### 5.1 新增文件

```
src-tauri/src/dem/
  mod.rs                   # ~50 行
  terrarium_decoder.rs     # ~120 行
  mosaic.rs                # ~200 行
  exporter.rs              # ~250 行
  analysis.rs              # ~300 行（可选，v3.5）
```

### 5.2 修改文件

| 文件 | 改动 |
|---|---|
| `commands.rs` | `DownloadRequest` 增 `data_type`, `dem_source` 字段 |
| `config.rs` | DEM 源配置（AWS URL、Mapbox token） |
| `fetcher.rs` | 复用现有（仅头部 User-Agent 可能需调整） |
| 前端 `app.js` | Tab 切换 + DEM 参数 UI |
| 前端 `api.js` | 类型扩展 |

### 5.3 代码量估算

- Rust：~700 行（首期）+ 300 行（analysis）
- 前端：~200 行（首期）
- **首期总计：~900 行**

---

## 6. 实施计划

### 6.1 里程碑（首期 - AWS Terrain Tiles）

| 阶段 | 内容 | 工期 |
|---|---|---|
| **M1** | 调研 + AWS Terrain Tiles POC（下载单瓦片 → 解码 → 肉眼验证） | 0.5 天 |
| **M2** | `terrarium_decoder.rs` + 单元测试（已知高程点验证） | 0.5 天 |
| **M3** | `mosaic.rs` Float32 合并 + 边界处理 | 0.5 天 |
| **M4** | `exporter.rs` Float32 GeoTIFF + GeoKeys | 0.75 天 |
| **M5** | 前端 UI（数据类型 Tab + DEM 源选择） | 0.5 天 |
| **M6** | QGIS 验证（打开 DEM、剖面线、等高线） | 0.25 天 |
| **首期** | | **~3 天** |

### 6.2 里程碑（二期 - 分析功能）

| 阶段 | 内容 | 工期 |
|---|---|---|
| **M7** | 山体阴影算法 | 0.5 天 |
| **M8** | 坡度 / 坡向 | 0.5 天 |
| **M9** | 等高线（Marching Squares） | 1 天 |
| **二期** | | **~2 天** |

### 6.3 里程碑（三期 - Copernicus）

| 阶段 | 内容 | 工期 |
|---|---|---|
| **M10** | AWS S3 公开桶 HTTP Range 下载 | 1 天 |
| **M11** | COG 解析 + 部分读取 | 1 天 |
| **M12** | 重采样 / 裁剪 / 写出 | 1 天 |
| **M13** | UI 增加 Copernicus 数据源 | 0.25 天 |
| **三期** | | **~3.25 天** |

### 6.4 总计

| 阶段 | 工期 |
|---|---|
| 首期（基础 DEM 下载） | 3 天 |
| 二期（地形分析） | 2 天 |
| 三期（Copernicus 高精度） | 3.25 天 |
| **DEM 领域全功能** | **~8.25 天** |

**v3.4 首期发布 3 天版本**，二三期作独立版本演进。

---

## 7. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| AWS Terrain Tiles 未来收费或下线 | 低 | 高 | 架构解耦，易切换到 Copernicus |
| Float32 GeoTIFF 写入精度问题 | 中 | 中 | 单元测试 + QGIS 数值比对 |
| 垂直基准混淆（EGM96 vs WGS84 椭球） | 中 | 中 | 文档明确 + 元数据正确写入 + 提示用户 |
| 大范围 z14 瓦片数多导致慢 | 中 | 低 | 与影像下载共用并发/重试机制 |
| NODATA 处理不当（海洋为负数） | 中 | 中 | 明确约定 -32768 为 NODATA，测试海岸线 |
| PNG 解码 CPU 瓶颈 | 中 | 低 | 并发解码（rayon） |

---

## 8. 非目标

- ❌ 不实现 LiDAR 点云下载（完全不同数据领域）
- ❌ 不做 3D 建模 / 打印导出（工具链分离）
- ❌ 不支持需要付费的高精度 DEM（商业模式分歧）
- ❌ 不实现自有 DEM 数据托管

---

## 9. 后续演进

### 9.1 分析衍生产品（v3.5）

基于已下载的 Float32 DEM：

- **山体阴影（Hillshade）**：GDAL 算法，光源方位角+俯仰角可调
- **坡度（Slope）**：单位度/百分比
- **坡向（Aspect）**：0-360° 方向
- **等高线（Contours）**：Vector 输出 Shapefile 或 GeoJSON

这些都可在 Rust 中原生实现，不依赖 GDAL。

### 9.2 Copernicus GLO-30 集成（v3.5+）

高精度大区域场景。HTTP Range 读取 COG，避免下载整个 14MB tile 仅用一小块。

### 9.3 实时 3D 预览（v3.6+）

WebGL + deck.gl TerrainLayer：
- 加载下载的 DEM + 配套影像（做纹理）
- 浏览器内 3D 旋转浏览
- 导出为 .glTF（可选）

### 9.4 与 3D Tiles 模块联动（v3.7+）

参见 `docs/3dtiles-design.md`：
- 用户下载 DEM + 影像
- 一键生成 3D Tiles 格式
- 支持 CesiumJS / 三维 GIS 发布

**Geo Downloader 终极形态：影像 → DEM → 3D Tiles 全链路一站式**。

---

## 10. 附录

### 10.1 数据源 URL 汇总

```
AWS Terrain Tiles:
  https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png

Mapbox Terrain-RGB:
  https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}.pngraw
  ?access_token={TOKEN}

Copernicus GLO-30 S3:
  https://copernicus-dem-30m.s3.amazonaws.com/
  Copernicus_DSM_COG_10_{NS}{lat}_00_{EW}{lon}_00_DEM/
  Copernicus_DSM_COG_10_{NS}{lat}_00_{EW}{lon}_00_DEM.tif

NASADEM S3:
  https://nasadem.s3.amazonaws.com/...

OpenTopoMap DEM:
  https://opentopodata.org/ (API, 限额)
```

### 10.2 GeoTIFF GeoKeys 参考

DEM 输出应包含：

```
GTModelTypeGeoKey (1024)           = 1 (ModelTypeProjected)
GTRasterTypeGeoKey (1025)          = 1 (RasterPixelIsArea)
GTCitationGeoKey (1026)            = "WGS 84 / Pseudo-Mercator"
ProjectedCSTypeGeoKey (3072)       = 3857
VerticalCSTypeGeoKey (4096)        = 5030 (EGM96) or 5029 (WGS84 ellipsoid)
VerticalCitationGeoKey (4097)      = "EGM96 Geoid"
```

NODATA 以 `GDAL_NODATA` 标签字符串写入。

### 10.3 用户需求时间线

- **2026-04-17 22:xx** — jojo 在 QQ 群提出"支持数字高程基本就完美了"
- **2026-04-17 23:xx** — 本文档落地作为独立 RFC

### 10.4 参考资料

- AWS Terrain Tiles: https://registry.opendata.aws/terrain-tiles/
- Mapbox Terrain-RGB: https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-dem-v1/
- Copernicus GLO-30: https://registry.opendata.aws/copernicus-dem/
- GeoTIFF 垂直基准: https://docs.ogc.org/is/19-008r4/19-008r4.html#_vertical_datums
- Cloud Optimized GeoTIFF: https://www.cogeo.org/

### 10.5 相关模块

- [src-tauri/src/fetcher.rs](../src-tauri/src/fetcher.rs) — 瓦片下载（复用）
- [src-tauri/src/tile.rs](../src-tauri/src/tile.rs) — 瓦片坐标计算（复用）
- [src-tauri/src/exporter.rs](../src-tauri/src/exporter.rs) — GeoTIFF 写入（参考）
- [docs/3dtiles-design.md](./3dtiles-design.md) — 3D Tiles 规划（终极联动）
- [docs/tiff-pyramid-overviews-design.md](./tiff-pyramid-overviews-design.md) — 金字塔（DEM 输出联动）
