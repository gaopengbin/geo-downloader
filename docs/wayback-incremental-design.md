# Wayback 增量下载功能 — 技术设计文档

> 创建日期: 2026-04-17
> 状态: 方案设计阶段 · POC 已验证
> 作者: Geo Downloader 团队
> 关联：v3.2.x 后续迭代

## 1. 功能概述

现有 Wayback 历史影像下载功能采用"按 release 全量下载"模式——用户勾选多个 release（如 2020-03、2021-06、2022-09……），系统对每期独立执行完整区域下载。

**痛点**：Esri Wayback 的 180+ 个 release 实际上是"增量快照"——绝大多数瓦片在相邻版本间只是复用同一底图。按 release 盲下会产生严重冗余，且混淆了"发布日期"与"影像拍摄日期"两个不同概念。

### 核心需求

> 来自真实用户反馈（研究亚马逊、刚果盆地森林变化监测）：
>
> "想只下载实际更新地区的影像。这可能需要影像拍摄的时间，不是影像发布的时间。"

三个关键能力：

- **按拍摄日期而非发布日期**筛选影像
- **跨 release 去重**：同一拍摄日期、同一区域的影像只下一次
- **瓦片级精确过滤**：只下有真实数据的 footprint 区域，避免下载底图复用块

---

## 2. Esri Wayback 数据结构调研（POC 已验证）

### 2.1 Release 清单

```
GET https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
```

返回 192 个 release（截至 2026-04），结构：

```json
{
  "22869": {
    "itemID": "b4c5c1b59c4141c5b503335b5baa2df4",
    "itemTitle": "World Imagery (Wayback 2026-03-26)",
    "itemURL": "https://wayback.maptiles.arcgis.com/.../tile/22869/{level}/{row}/{col}",
    "metadataLayerUrl": "https://metadata.maptiles.arcgis.com/.../World_Imagery_Metadata_2026_r03/MapServer",
    "metadataLayerItemID": "eafaa19cb03a4bcba592ef12fb6e14e5",
    "layerIdentifier": "WB_2026_R03"
  }
}
```

**关键字段**：`metadataLayerUrl` 是单独的 ArcGIS MapServer，每个 release 有独立 metadata 服务。

### 2.2 Metadata 服务分层

每个 metadata MapServer 按**影像空间分辨率**分为 13 个 Feature Layer：

| Layer ID | 分辨率 | 适用 zoom |
|---|---|---|
| 0 | 1.9 cm | ~z22 |
| 1 | 3.7 cm | ~z21 |
| 2 | 7.5 cm | ~z20 |
| 3 | 15 cm | ~z18-19 |
| 4 | 30 cm | ~z17-18 |
| 5 | 60 cm | ~z16-17 |
| 6 | 1.2 m | ~z15-16 |
| 7 | 2.4 m | ~z14 |
| 8 | 4.8 m | ~z13 |
| 9 | 9.6 m | ~z11-12 |
| 10 | 19 m | ~z10 |
| 11 | 38 m | ~z9 |
| 12 | 75 m | ~z6-8 |

**查询时必须选对 layer**——单一 layer 只包含对应分辨率的 footprint。实际开发中按用户 zoom 范围选 2-3 个 layer 查询。

### 2.3 Footprint 字段（经 POC 验证真实存在）

```json
{
  "SRC_DATE2":    1693094400000,     // Unix 毫秒时间戳 → 2023-08-27 UTC（拍摄日期）
  "SRC_DATE":     20230827,           // 整数 yyyymmdd（冗余）
  "NICE_NAME":    "Vivid Advanced",   // 数据源（Maxar Vivid / Vivid Advanced / TerraColor NextGen）
  "NICE_DESC":    "...",
  "SRC_RES":      0.31,                // 空间分辨率（米）
  "SRC_ACC":      5.0,                 // 定位精度（米）
  "MinMapLevel":  12,                  // 此影像适用的最小 zoom
  "MaxMapLevel":  17,                  // 最大 zoom
  "ReleaseName":  "WB_2026_R03",
  "BlockName":    "...",
  "DrawOrder":    0,
  "SRC_DESC":     "..."
}
```

### 2.4 查询示例

```
GET {metadataLayerUrl}/6/query
  ?geometry=-60.5,-3.5,-59.5,-2.5
  &geometryType=esriGeometryEnvelope
  &inSR=4326
  &spatialRel=esriSpatialRelIntersects
  &where=1=1
  &outFields=SRC_DATE2,NICE_NAME,SRC_RES,MinMapLevel,MaxMapLevel
  &returnGeometry=true
  &outSR=4326
  &f=geojson
```

**必需 HTTP 头**：
- `Referer: https://livingatlas.arcgis.com/wayback/`
- `User-Agent: Mozilla/5.0`

缺少则返回 403。

### 2.5 POC 实测：马瑙斯 1°×1° 区域

扫描 10 个最新 release 的 Layer 6：

| Release | 拍摄日期集合 |
|---|---|
| 2026-03-26 ~ 2025-10-23（6 期） | **相同** 3 个日期：2023-08-27 / 2023-09-15 / 2024-07-17 |
| 2025-09-25 ~ 2025-09-04 | 5 个日期：2018-11-13 / 2019-06-24 / 2021-08-11 / 2023-09-03 / 2025-03-19 |
| 2025-07-31 ~ 2025-06-26 | 5 个日期：2018-11-13 / 2019-03-18 / 2019-06-24 / 2021-08-11 / 2023-09-03 |

**观察**：
- 前 6 期数据完全重复（冗余率 100%）
- 10 个 release 按拍摄日期去重后仅 ~8 个独立日期
- 配合用户时间范围过滤可进一步压至 3-4 个

---

## 3. 技术方案

### 3.1 三阶段流水线

```
┌──────────────────────────────────────────────────────────────┐
│ Phase 1: 全量扫描（后台并发）                                │
│   for release in all_releases（192 个）:                      │
│     for layer_id in relevant_layers（按用户 zoom 选 2-3 个）: │
│       footprints = query metadata(release, layer, user_bbox) │
│       merge into global_index                                │
│   输出：global_index = [{capture_date, geometry_hash,        │
│                          source, resolution, min/max_level,  │
│                          release_num}]                       │
├──────────────────────────────────────────────────────────────┤
│ Phase 2: 去重 + 前端呈现                                     │
│   dedupe by (SRC_DATE2, geometry_hash) → 独立拍摄清单        │
│   按 capture_date 倒序排列                                   │
│   前端时间轴组件展示：                                       │
│     "2024-07-17 · Vivid · 0.31m · 覆盖 95%"                  │
│     "2023-09-15 · Vivid · 0.31m · 覆盖 80%"                  │
│     ...                                                      │
│   用户勾选需要的拍摄时间                                     │
├──────────────────────────────────────────────────────────────┤
│ Phase 3: 精确下载                                            │
│   对每个勾选项：                                             │
│     tiles = compute_tiles(footprint ∩ user_polygon, zoom)    │
│     download from release's itemURL                          │
│   命名：{capture_date}_{source}_{res}m.tif                   │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 去重键设计

核心键：`(SRC_DATE2_day, geometry_hash)`

- `SRC_DATE2_day`：Unix 毫秒截断到日（同日多次扫描视为同一次拍摄）
- `geometry_hash`：对 footprint 几何做简化后（Douglas-Peucker tolerance=0.001°）取 SHA-1

同一 `(date, geom_hash)` 在多个 release 中出现时，保留**最老 release 的 release_num**（影像最早可用版本），用于实际下载。

### 3.3 缓存策略

首次扫描耗时估计：
- 192 releases × 2 layers × ~1.5s/query = **~10 分钟**

需要缓存：

```
C:\Users\{user}\AppData\Roaming\geo-downloader\wayback_cache\
  {bbox_hash_8}.json        # bbox 转 SHA-1 前 8 字节
    {
      "bbox": [-60.5, -3.5, -59.5, -2.5],
      "zoom_range": [12, 17],
      "scanned_at": "2026-04-17T14:30:00Z",
      "expires_at": "2026-04-24T14:30:00Z",
      "releases_scanned": 192,
      "footprints": [...]
    }
```

- TTL：7 天
- 增量更新：下次扫描时只查 `releases_scanned` 之后新增的 release
- 容量上限：50 个 bbox 条目，LRU 淘汰

### 3.4 zoom → layer 映射

静态表驱动：

```rust
// 用户选定 zoom_range = (z_min, z_max)
// 返回需要查询的 metadata layer ID 集合
fn select_layers(z_min: u32, z_max: u32) -> Vec<u32> {
    let mut layers = HashSet::new();
    for zoom in z_min..=z_max {
        match zoom {
            22.. => { layers.insert(0); }
            21   => { layers.insert(1); }
            20   => { layers.insert(2); }
            18..=19 => { layers.insert(3); }
            17   => { layers.insert(4); }
            16   => { layers.insert(5); }
            14..=15 => { layers.insert(6); }
            13   => { layers.insert(7); layers.insert(8); }
            11..=12 => { layers.insert(9); }
            10   => { layers.insert(10); }
            9    => { layers.insert(11); }
            _    => { layers.insert(12); }
        }
    }
    layers.into_iter().collect()
}
```

---

## 4. 架构设计

### 4.1 后端模块划分

新增文件：

```
src-tauri/src/
  wayback.rs                 # 现有，保留
  wayback_metadata.rs        # 新增：metadata 扫描 + 缓存（~400 行）
  wayback_incremental.rs     # 新增：增量下载协调（~200 行）
```

新增 Tauri commands（`commands.rs`）：

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `scan_wayback_metadata` | `{bbox, zoom_range, force_refresh}` | `{footprints, cached, scanned_at}` | 触发/获取扫描结果 |
| `get_wayback_scan_progress` | `{scan_id}` | `{current, total, elapsed_sec}` | 轮询扫描进度 |
| `download_wayback_incremental` | `{selected_footprints, bbox, zoom_range, save_dir, compression}` | `{task_ids[]}` | 批量发起下载任务 |

### 4.2 核心数据结构

```rust
// wayback_metadata.rs
#[derive(Serialize, Deserialize, Clone)]
pub struct WaybackFootprint {
    pub capture_date: i64,           // Unix 秒（从 SRC_DATE2 ms / 1000）
    pub capture_date_str: String,    // "2023-08-27"
    pub source_name: String,         // NICE_NAME
    pub resolution_m: f64,           // SRC_RES
    pub min_map_level: u32,
    pub max_map_level: u32,
    pub release_num: u32,            // 最老包含此影像的 release
    pub release_date: String,        // 该 release 的 itemTitle 日期
    pub geometry: geojson::Geometry, // footprint 多边形（WGS84）
    pub geometry_hash: String,       // 去重用
    pub coverage_ratio: f64,         // 与用户 polygon 的覆盖比例 0..1
}

#[derive(Serialize, Deserialize)]
pub struct WaybackScanResult {
    pub bbox: [f64; 4],
    pub zoom_range: (u32, u32),
    pub scanned_at: String,
    pub expires_at: String,
    pub releases_scanned: u32,
    pub footprints: Vec<WaybackFootprint>,
}
```

### 4.3 并发控制

- 扫描 192 releases 使用 `tokio::spawn` + `Semaphore`（并发 8）
- 每个请求独立超时 20s，失败重试 2 次
- 进度通过 Tauri `emit` 推送到前端

### 4.4 前端组件

`static/js/app.js` 新增模块（约 400 行）：

```
wayback-metadata-panel
├─ 扫描按钮 + 进度条
├─ 时间轴 SVG 组件（横向滚动）
│  ├─ 节点（按 capture_date）
│  ├─ 节点颜色 = 数据源（Maxar 蓝 / Vivid 绿 / Terra 灰）
│  ├─ 节点大小 = 覆盖率
│  └─ hover 卡片（日期/源/分辨率/覆盖率）
├─ 勾选框列表（备选视图）
└─ [下载选中项] 按钮
```

时间轴推荐用原生 SVG 手绘（避免引入 d3 等大库）。

---

## 5. UX 设计

### 5.1 入口与流程

```
[顶部模式切换]  GeoTIFF │ 3D Tiles │ 历史影像
                                    │
                                    └─> 进入 Wayback 面板
                                        │
                                        ├─ (原有) 按 release 下载
                                        └─ (新增) 按拍摄日期下载
                                            │
                                            ├─ 1. 绘制/导入选区
                                            ├─ 2. 设置 zoom 范围
                                            ├─ 3. 点击"扫描影像清单"
                                            ├─ 4. 时间轴呈现独立拍摄
                                            ├─ 5. 勾选 / 批量（按时间段 / 按源）
                                            └─ 6. 下载
```

### 5.2 关键交互

- **扫描预估**：点扫描前显示"预计耗时约 10 分钟"，带取消按钮
- **缓存提示**：有缓存时显示"上次扫描于 2 天前，是否刷新？"
- **时间段批选**：快捷按钮"仅 2020 后"/"仅 2022-2024"/"每年最新一期"
- **数据源过滤**：复选框 "Maxar / Vivid / TerraColor"
- **覆盖率阈值**：滑块"仅显示覆盖 ≥ 80% 的影像"
- **预估大小**：勾选后实时计算"3 个影像共 1.2 GB / ~45 分钟"

### 5.3 输出组织

```
{save_dir}/
  wayback_{bbox_hash}_{zoom}/
    2024-07-17_Vivid_0.31m.tif
    2023-09-15_Vivid_0.31m.tif
    2023-08-27_VividAdvanced_0.31m.tif
    timeseries_manifest.json   # 所有下载影像的元数据汇总
```

`timeseries_manifest.json` 便于后续 Python/QGIS 批处理分析。

---

## 6. 实施计划

### 6.1 里程碑

| 阶段 | 内容 | 估计工期 |
|---|---|---|
| **MVP-1** | 后端 `wayback_metadata.rs` + `scan_wayback_metadata` 命令 + 缓存 | 1 天 |
| **MVP-2** | 前端时间轴组件 + 扫描进度 UI | 1 天 |
| **MVP-3** | 精确下载（复用现有任务系统）+ 文件命名与 manifest | 0.5 天 |
| **打磨** | 数据源筛选、批选快捷、预估、文案 | 0.5 天 |
| **测试** | 亚马逊、刚果、纽约、北京四区域验证 | 0.5 天 |
| **总计** | | **~3.5 天** |

### 6.2 发布策略

- 作为 **v3.3.0** 主要特性发布
- 保留原有"按 release 下载"入口不变（兼容老用户习惯）
- 新增"按拍摄日期"tab 切换

---

## 7. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| Esri 关闭 metadata 公开查询 | 低 | 高 | 缓存可继续使用；监测 API 错误率，必要时回退到按 release 下载 |
| 首次扫描超 10 分钟用户流失 | 中 | 中 | 支持**中断续扫**、边扫边展示已发现结果 |
| 192 releases 并发过高触发限流 | 中 | 低 | Semaphore=8 控制 + 429 退避重试 |
| 大 bbox（如整个刚果盆地）扫描返回数千 footprints | 中 | 中 | 分块查询（拆成 10°×10° 网格）+ 流式合并 |
| SRC_DATE2 为 null（TerraColor 底图） | 已确认存在 | 低 | 归类为"基础底图"，单独分组 |
| 几何简化丢失细节导致去重不准 | 低 | 低 | tolerance 可调，默认 0.001° 对 100km 区域误差 <100m |

---

## 8. 非目标（明确排除）

- ❌ 不支持 Esri 账号登录（所有查询走公开端点）
- ❌ 不实现影像拼接/镶嵌（用户用 QGIS/ENVI 处理）
- ❌ 不做变化检测算法（如 NDVI 差分），这是科研层面的工作
- ❌ 不整合 Sentinel/Landsat 等其他源（后续独立功能）

---

## 9. 后续演进（v3.4+）

- **硬链接去重**：即使按"拍摄日期+footprint"去重后，部分边缘瓦片内容仍可能重复。下载后扫描全部瓦片的 SHA-256，重复时建立硬链接，预计再省 5-15% 存储
- **与 Sentinel-2 等开源数据联动**：在同一时间轴上叠加 Sentinel 可用影像
- **AOI 订阅**：用户保存关心区域，有新拍摄时推送通知
- **批量时序导出**：生成 GIF/视频展示区域时序变化

---

## 10. 附录

### 10.1 POC 验证日期

2026-04-17 — Geo Downloader 团队实测 Esri Wayback API，192 个 release 全部可达，字段结构与官方客户端一致。

### 10.2 参考资料

- 官方 Wayback 客户端：https://github.com/vannizhang/wayback
- Esri REST API 文档：https://developers.arcgis.com/rest/services-reference/
- ArcGIS MapServer Layer query：https://developers.arcgis.com/rest/services-reference/query-feature-service-.htm

### 10.3 相关模块

- [src-tauri/src/wayback.rs](../src-tauri/src/wayback.rs) — 现有 Wayback 基础模块
- [src-tauri/src/commands.rs](../src-tauri/src/commands.rs) — Tauri 命令注册点
- [static/js/app.js](../static/js/app.js) — 前端 Wayback 面板
