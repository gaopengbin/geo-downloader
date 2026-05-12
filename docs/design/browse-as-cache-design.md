# 浏览即缓存 + 缓存导出 MBTiles/GPKG/大图 — 技术设计文档（RFC）

> 创建日期: 2026-05-08
> 状态: RFC（征求意见 / 设计阶段）
> 关联 Issue: [#14](https://github.com/gaopengbin/geo-downloader/issues/14)
> 关联 Issue: [#7](https://github.com/gaopengbin/geo-downloader/issues/7) Wayback 增量、[#8](https://github.com/gaopengbin/geo-downloader/issues/8) 矢量切片、[#11](https://github.com/gaopengbin/geo-downloader/issues/11) 多 zoom 批量
> 优先级：P2（设计先行，分阶段实施）

---

## 1. 背景与目标

### 1.1 用户诉求（来自 Issue #14）

1. 在地图面板浏览 / 平移 / 缩放时，**途经的瓦片自动写入本地缓存**，对标 SASPlanet、ArcGIS、BIGEMAP 的「浏览即缓存」机制。
2. 缓存按「图源 — 系列 — 历史版本时期（如有）」命名（例：`world_imagery`、`wayback_2024-03-14`），同一图源跨多次打开 / 多个任务**复用一个 db**。
3. 下载导出时**优先从本地缓存拼接，未命中再走网络**。
4. 导出形态扩展：
   - 单张大 TIFF（保留现状）
   - **MBTiles**（栅格 / 矢量）
   - **GeoPackage / GPKG**（栅格 / 矢量）
5. 命名 / metadata 表遵循公开规范，QGIS / mapbox-gl / 第三方工具直接打开。

### 1.2 非目标

- 本期不做缓存的可视化管理面板（仅命令行 + 设置入口的清理 / 容量上限）。
- 不实现矢量切片浏览即缓存（依赖 Issue #8 矢量切片管线就绪后再扩展，本设计预留接口）。
- 不实现跨设备同步 / 云端缓存。
- 不实现缓存的多用户共享锁（单机单进程使用）。

### 1.3 成功指标

- 浏览过的瓦片在「重新打开 App / 离线」状态下可继续显示。
- 重复下载同一区域同一 zoom 段，**网络请求量 ≥ 80% 命中缓存**（取决于浏览覆盖度）。
- MBTiles 导出文件可被 QGIS / MapTiler Engine / mbview 直接打开。
- GPKG 导出文件可被 QGIS / GDAL 直接打开。
- 单库 1GB 量级下，瓦片读写 P50 < 10 ms。

---

## 2. 现状分析

### 2.1 现有缓存体系

| 模块 | 类型 | 位置 | TTL |
|---|---|---|---|
| Wayback 元数据扫描 | 持久 JSON | `<cache_dir>/geo-downloader/wayback_cache/<sha>.json` | 7 天，LRU 50 条 |
| Wayback releases 列表 | 进程内 OnceLock | 内存 | 1 小时 |
| 静态远程图（QR） | localStorage（dataURL） | 浏览器 | 7 天 |
| TanStack Query | 内存 | 浏览器 | 30s / 5min |

**关键差距**：地图瓦片本身**完全不缓存**（仅靠 WebView2 默认 HTTP 缓存，行为不可控）；下载流水**不查询任何本地缓存**，每次都拉网络。

### 2.2 现有下载流水

- 入口：`commands::execute_imagery_task` / `wayback` / `tiles3d` 三条独立路径。
- 拉取层：`downloader.rs`（影像）、`tiles3d/fetcher.rs`（3D Tiles）、`wayback.rs`（历史影像），**全部直接 reqwest get → 写盘 / 写流式 TIFF**。
- 输出层：`streaming_tiff.rs`（BigTIFF 流式）、`exporter.rs`（拼接器）、`merger.rs`。

### 2.3 现有地图层

- `frontend/src/features/map/map-canvas.tsx` 用 Leaflet `L.tileLayer(url, …)`，瓦片走浏览器原生请求，没有自定义协议拦截。

---

## 3. 总体架构

```
┌─────────────────────────────── 前端（React + Leaflet） ───────────────────────────────┐
│                                                                                       │
│   L.tileLayer(url) ──┐                                                                │
│                      │  自定义 createCachedTileLayer({ source, version })            │
│                      ▼                                                                │
│   getTileUrl(z,x,y) ──► tauri://invoke("cache_get_tile_or_url", …)                   │
│                          ├─ 命中：返回 data:image/png;base64,…                        │
│                          └─ 未命中：返回原 https URL（浏览器照常请求 + 旁路上报）     │
│                                              │                                        │
│                                              ▼                                        │
│   <img onload> ──► tauri://invoke("cache_put_tile", { source, z,x,y, bytes })        │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌──────────────────────────────────  后端（Rust）  ────────────────────────────────────┐
│                                                                                       │
│   tile_cache::Store  ─────────────────►  cache/<source>/<version>.mbtiles            │
│     · open(source, version) -> &Db  (LruCache<source_key, Connection>)               │
│     · get(z,x,y) -> Option<Bytes>                                                    │
│     · put(z,x,y, bytes, content_type)                                                │
│     · stats() -> CacheStats                                                          │
│     · prune(max_size_mb)                                                             │
│                                                                                       │
│   downloader / wayback / tiles3d                                                      │
│     · 拉取前先 cache::get → 命中跳过 HTTP                                            │
│     · 拉取后 cache::put → 旁路写入                                                   │
│                                                                                       │
│   exporter::ExportFormat::{Tiff, Mbtiles, Gpkg}                                       │
│     · Tiff   : 现状 streaming_tiff                                                   │
│     · Mbtiles: 直接复制缓存表 + 重写 metadata + 区域裁切                             │
│     · Gpkg   : sqlite + gpkg_contents / gpkg_tile_matrix（栅格）                     │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 数据模型

### 4.1 缓存目录布局

```
<app_cache_dir>/geo-downloader/
  ├── wayback_cache/                  # 既有，Wayback 元数据缓存，保持不变
  └── tile_cache/
      ├── world_imagery.mbtiles        # ESRI World Imagery
      ├── tdt_img.mbtiles              # 天地图影像
      ├── tdt_vec.mbtiles              # 天地图矢量底图（伪矢量，仍是 PNG）
      ├── wayback_2024-03-14.mbtiles   # 单 release 一个文件
      ├── wayback_2024-09-12.mbtiles
      └── _index.json                  # 元数据汇总（容量、最后访问时间、source 元信息）
```

**命名规则**：`<source_key>.mbtiles`，`source_key` = `slug(图源)` 或 `slug(图源)_<version>`（version 仅 Wayback 等多版本图源使用）。

### 4.2 单库 Schema（MBTiles 1.3）

直接使用 [MBTiles 1.3 spec](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md)，**与导出格式同构**，做到「缓存即可导出」：

```sql
-- 必备表
CREATE TABLE metadata (name TEXT, value TEXT);
CREATE TABLE tiles (
    zoom_level  INTEGER,
    tile_column INTEGER,
    tile_row    INTEGER,        -- TMS 行号（注意与 XYZ 行号互转）
    tile_data   BLOB,
    PRIMARY KEY (zoom_level, tile_column, tile_row)
);

-- 推荐索引（PRIMARY KEY 已自动建索引）
CREATE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row);

-- metadata 必填字段（MBTiles 规范）
INSERT INTO metadata VALUES
  ('name',        'World Imagery'),
  ('format',      'png' | 'jpg' | 'webp' | 'pbf'),
  ('bounds',      '-180,-85.05,180,85.05'),
  ('center',      '0,0,2'),
  ('minzoom',     '0'),
  ('maxzoom',     '19'),
  ('type',        'baselayer'),
  ('version',     '1'),
  ('description', 'Cached by GeoDownloader v3.5'),
  -- GeoDownloader 扩展字段（带 gd_ 前缀避免冲突）
  ('gd_source_key',  'world_imagery'),
  ('gd_url_template','https://server.../tile/{z}/{y}/{x}'),
  ('gd_capture_at',  '2024-03-14'),     -- 仅 Wayback
  ('gd_created_at',  '2026-05-08T00:00:00Z'),
  ('gd_last_used_at','2026-05-08T12:00:00Z');
```

**行号约定**：MBTiles 用 TMS（左下角原点），App 内部用 XYZ（左上角原点）。统一在缓存边界做转换：`tms_y = (1 << z) - 1 - xyz_y`。

### 4.3 GPKG 栅格 Schema（导出可选）

与 MBTiles 等价，遵循 [OGC GPKG R8 Tiles](https://www.geopackage.org/spec/#tiles)：

```sql
-- 必备元数据表（gpkg_spatial_ref_sys / gpkg_contents / gpkg_tile_matrix_set / gpkg_tile_matrix）
-- 数据表（命名自定，例如 'tiles'）：
CREATE TABLE tiles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    zoom_level    INTEGER NOT NULL,
    tile_column   INTEGER NOT NULL,    -- 注意：GPKG 用 XYZ 而非 TMS，与 MBTiles 相反
    tile_row      INTEGER NOT NULL,
    tile_data     BLOB    NOT NULL,
    UNIQUE (zoom_level, tile_column, tile_row)
);
```

---

## 5. 后端设计（Rust）

### 5.1 新模块 `src-tauri/src/tile_cache/`

```
tile_cache/
  ├── mod.rs        # 公共 API：Store / SourceKey / TileCoord / CacheStats
  ├── store.rs      # MBTiles 读写实现（rusqlite）
  ├── pool.rs       # LruCache<SourceKey, Arc<Mutex<Connection>>>，最多 8 个常驻
  ├── metadata.rs   # _index.json 汇总（容量统计、LRU 淘汰）
  └── tests.rs
```

#### 5.1.1 公共 API

```rust
pub struct SourceKey(pub String);            // 例如 "world_imagery", "wayback_2024-03-14"

pub struct TileCoord { pub z: u8, pub x: u32, pub y: u32 }

pub struct StoredTile {
    pub bytes: Vec<u8>,
    pub content_type: String,                 // "image/png" / "image/jpeg" / "application/x-protobuf"
}

pub struct Store { /* 内部：Arc<Mutex<TileCachePool>> */ }

impl Store {
    pub fn global() -> &'static Store;        // OnceLock 单例
    pub async fn get(&self, src: &SourceKey, c: TileCoord) -> Result<Option<StoredTile>, Error>;
    pub async fn put(&self, src: &SourceKey, c: TileCoord, tile: StoredTile) -> Result<(), Error>;
    pub async fn put_batch(&self, src: &SourceKey, batch: Vec<(TileCoord, StoredTile)>) -> Result<(), Error>;
    pub async fn ensure_source(&self, src: &SourceKey, info: SourceInfo) -> Result<(), Error>;
    pub async fn stats(&self) -> Result<Vec<SourceStats>, Error>;
    pub async fn clear(&self, src: Option<&SourceKey>) -> Result<u64, Error>;
    pub async fn prune(&self, max_total_bytes: u64) -> Result<PruneReport, Error>;
}
```

**并发**：每个 source 一把 `Mutex<Connection>`，写操作串行；不同 source 之间并行。读操作可考虑 SQLite WAL + 多 RO 连接，但首版先单连接顺序执行，确保正确。

**事务**：`put_batch` 内部 `BEGIN IMMEDIATE … COMMIT`，避免高并发浏览时 fsync 风暴。

**SQLite 调优**：
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -8000;       -- 8 MB page cache
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;    -- 256 MB
```

#### 5.1.2 LRU 与容量上限

- `Store::prune(max_total_bytes)`：按 `metadata.gd_last_used_at` 升序整库淘汰（先删整个最少访问的 source 文件，避免单库内 VACUUM 的代价）。
- 默认上限：**5 GB**，可在「设置」中调整。
- 触发时机：每次 App 启动 + 每写入 1000 个瓦片检查一次。

### 5.2 Tauri 命令

```rust
#[tauri::command]
pub async fn cache_get_tile(source: String, z: u8, x: u32, y: u32)
    -> Result<Option<TileResponse>, String>;
//  Returns { content_type, base64 } 或 null

#[tauri::command]
pub async fn cache_put_tile(source: String, z: u8, x: u32, y: u32,
                             content_type: String, base64: String)
    -> Result<(), String>;

#[tauri::command]
pub async fn cache_stats() -> Result<Vec<SourceStats>, String>;

#[tauri::command]
pub async fn cache_clear(source: Option<String>) -> Result<u64, String>;

#[tauri::command]
pub async fn cache_set_max_size_mb(mb: u64) -> Result<(), String>;
```

> base64 存在编码开销（~33%），单瓦片 < 200 KB 影响可接受。后续可改用自定义协议 `gdcache://world_imagery/14/3413/6720` 直接走二进制，零拷贝（见 §9 演进）。

### 5.3 下载流水接入

在 `downloader.rs` 与 `wayback.rs` / `tiles3d/fetcher.rs` 的瓦片下载点：

```rust
// 伪代码
let coord = TileCoord { z, x, y };
if let Some(t) = cache.get(&source, coord).await? {
    return Ok(t.bytes);
}
let bytes = http_client.get(url).send().await?.bytes().await?.to_vec();
cache.put(&source, coord, StoredTile { bytes: bytes.clone(), content_type }).await.ok();
Ok(bytes)
```

**关键点**：
- 仅在 200 OK + 非空响应时写缓存，避免错误瓦片污染。
- 写缓存失败**不阻塞下载**（log warn）。
- Range 请求 / 部分内容不进缓存（仅整瓦片）。

### 5.4 导出格式

`exporter.rs` 新增枚举：

```rust
pub enum ExportFormat {
    Tiff,        // 现状：流式 BigTIFF
    Mbtiles,     // 新增：直接从 cache 复制 + 裁切
    Gpkg,        // 新增：sqlite + GPKG 元数据
}
```

#### 5.4.1 MBTiles 导出

最简实现 = 「拷贝缓存 + 区域过滤 + 重写 metadata」：

```rust
pub fn export_mbtiles(
    src_db: &Path, dst_db: &Path,
    bbox: [f64; 4], zoom_min: u8, zoom_max: u8,
    name: &str, attribution: Option<&str>,
) -> Result<ExportReport>
```

步骤：
1. 创建目标 mbtiles 空库 + schema。
2. 计算 bbox 在每个 zoom 上覆盖的瓦片范围 `(z, x_min..=x_max, y_min..=y_max)`。
3. `INSERT INTO dst.tiles SELECT ... FROM src.tiles WHERE zoom_level=? AND tile_column BETWEEN ? AND ? AND tile_row BETWEEN ? AND ?`（XYZ → TMS 行号转换）。
4. 对未命中区域：调用统一下载入口拉取 → 写源 cache → 写目标 db（边写边导）。
5. 写入 metadata（bounds / minzoom / maxzoom / format / name / attribution）。
6. `VACUUM` + `PRAGMA optimize`。

**导出模式**：
- **精简模式**（默认）：仅复制 bbox 严格覆盖的瓦片，最小体积。
- **完整模式**：额外复制 bbox 边缘外 N 个瓦片的缓冲区（默认 N=2），便于二次浏览不出现边缘空白。

#### 5.4.2 GPKG 栅格导出

类似 MBTiles，但 schema 复杂：需要 `gpkg_spatial_ref_sys`（EPSG:3857 / EPSG:4326）、`gpkg_contents`、`gpkg_tile_matrix_set`、`gpkg_tile_matrix`（每个 zoom 一行：matrix_width / matrix_height / pixel_x_size / pixel_y_size）。建议封装为 `gpkg_writer.rs`。

#### 5.4.3 大 TIFF 导出

保持现状，但**前置插入缓存命中分支**：在 `streaming_tiff` 拉取每个瓦片前先查缓存，未命中再走网络。

---

## 6. 前端设计

### 6.1 自定义 TileLayer 包装

`frontend/src/features/map/cached-tile-layer.ts`：

```ts
import L from 'leaflet'
import { invoke } from '@tauri-apps/api/core'

interface CachedTileLayerOpts extends L.TileLayerOptions {
  sourceKey: string                    // 'world_imagery' / 'wayback_2024-03-14'
  urlTemplate: string                  // 原 https URL 模板
  enableCache?: boolean                // 默认 true，可在设置中关
}

export function createCachedTileLayer(opts: CachedTileLayerOpts): L.TileLayer {
  const layer = L.tileLayer(opts.urlTemplate, opts)
  if (!opts.enableCache) return layer

  // 1. 优先返回 cache 命中的 dataURL
  const origCreateTile = layer.createTile.bind(layer)
  layer.createTile = function (coords, done) {
    const tile = document.createElement('img')
    tile.alt = ''
    void (async () => {
      const hit = await invoke<{ content_type: string; base64: string } | null>(
        'cache_get_tile',
        { source: opts.sourceKey, z: coords.z, x: coords.x, y: coords.y },
      )
      if (hit) {
        tile.src = `data:${hit.content_type};base64,${hit.base64}`
        done(null, tile)
        return
      }
      // 2. 未命中走原 URL，加载完成后旁路写缓存
      tile.crossOrigin = ''
      tile.src = layer.getTileUrl(coords)
      tile.onload = async () => {
        const base64 = await imageToBase64(tile)
        await invoke('cache_put_tile', {
          source: opts.sourceKey, z: coords.z, x: coords.x, y: coords.y,
          contentType: 'image/png', base64,
        })
        done(null, tile)
      }
      tile.onerror = (e) => done(e as any, tile)
    })()
    return tile
  }
  return layer
}
```

**注意**：
- `imageToBase64` 用 `<canvas>.toDataURL`，会重编码为 PNG（与原始 JPG 体积有差异）。**优化版**：用 `fetch(url)` 拿原始字节再写缓存（避免 canvas 重编码），代价是双 IO。首版可走 canvas，后续替换。
- 跨域：必须 `crossOrigin='anonymous'`，但很多瓦片服务端没设 CORS → 退化为「不写缓存，仅显示」。需要在后端走代理或自定义协议（见 §9）。

### 6.2 接入点

`map-canvas.tsx` 中现有的 `L.tileLayer(c.url, …)` 替换为 `createCachedTileLayer({ sourceKey: c.key, urlTemplate: c.url, … })`。`baseLayersRef` / `waybackLayersRef` 类型不变。

### 6.3 设置面板

`settings-page` 新增「瓦片缓存」分组：

| 控件 | 说明 |
|---|---|
| 启用浏览即缓存（开关） | 默认开 |
| 缓存上限（数字 GB） | 默认 5 GB，0 表示无上限 |
| 缓存目录（路径 + 「选择」按钮） | 默认 `<app_cache_dir>/geo-downloader/tile_cache`；允许用户切换（如指向 SSD / 大盘），切换时弹确认提示是否搬迁旧目录 |
| 已使用容量（只读 + 进度条） | 调 `cache_stats` 实时刷新 |
| 按图源列表（表格） | 每行：图源名 / 大小 / 瓦片数 / 上次使用 / 「清理」按钮 |
| 一键清理全部 | 二次确认 |

### 6.4 导出面板

下载提交栏新增「输出格式」下拉：

- TIFF（大图）— 默认，对应现状
- MBTiles（瓦片包）
- GeoPackage（GPKG，瓦片包）

后两个跳过「输出尺寸」「分块策略」等只对 TIFF 有意义的字段，仅保留 zoom 范围 + bbox + 文件名。

---

## 7. 兼容性与边界

| 议题 | 决策 |
|---|---|
| 已存在的 mbtiles（用户从外部带入）能否被识别 | 通过 `_index.json` 注册，缺失 `gd_*` 字段也照样 read-only 可用 |
| 瓦片格式混合（同库 PNG + JPG） | 不允许，metadata.format 锁定一种；首次写入决定 |
| Wayback 多 release 是否共享一个库 | 拆分（每 release 一库），命名 `wayback_<YYYY-MM-DD>` |
| 矢量切片（PBF） | 预留 source.format='pbf'，本期不实现 |
| 同图源多 zoom 范围 | 不限制，metadata.minzoom/maxzoom 取实际写入的 min/max |
| 跨进程 / 多窗口 | SQLite WAL 多 reader 单 writer 可承受；首版假设单实例 |
| 删库时 App 在用 | Pool 引用计数 → 释放后再 fs::remove_file |
| 单库容量上限 | 软上限 2 GB（提示），硬上限取决于 SQLite (TB 级，无问题) |

---

## 8. 实施阶段与里程碑

### 阶段 1：缓存核心（最小可用）
- [ ] `tile_cache/store.rs` MBTiles 读写
- [ ] `tile_cache/pool.rs` LRU 连接池
- [ ] Tauri 命令：`cache_get_tile` / `cache_put_tile` / `cache_stats` / `cache_clear`
- [ ] 单元测试：读写 / 并发 / 行号转换

### 阶段 2：浏览即缓存
- [ ] 前端 `createCachedTileLayer`
- [ ] `map-canvas.tsx` 接入，所有底图 / Wayback 走缓存
- [ ] 设置面板「瓦片缓存」分组
- [ ] 跨域 / canvas 重编码问题验证

### 阶段 3：下载缓存命中
- [ ] `downloader.rs` / `wayback.rs` / `streaming_tiff.rs` 接入 cache.get → 命中跳过 HTTP
- [ ] 同步把网络回包写回 cache（旁路写）
- [ ] benchmark：重复下载同区域，网络请求数对比

### 阶段 4：MBTiles 导出
- [ ] `exporter.rs::ExportFormat::Mbtiles` 实现
- [ ] 导出面板「输出格式」下拉
- [ ] 缓存命中 + 网络补全
- [ ] QGIS / mbview 兼容性验证

### 阶段 5：GPKG 导出
- [ ] `gpkg_writer.rs`
- [ ] `ExportFormat::Gpkg` 实现
- [ ] QGIS / GDAL 兼容性验证

### 阶段 6（可选）：自定义协议优化
- [ ] `gdcache://` 协议替换 base64，减少 33% 传输与编解码
- [ ] 瓦片预热 / 预热区域选择 UI

---

## 9. 后续演进

1. **自定义协议 `gdcache://`**：Tauri 2.0 支持 `register_uri_scheme_protocol`，瓦片字节直接通过协议返回，免 base64 + JS 调用开销。
2. **矢量切片缓存**：Issue #8 落地后，复用同一 Store，仅 metadata.format='pbf'。
3. **缓存预热**：「框选区域 + zoom 段 → 后台批量拉取入缓存」，无需立即导出。
4. **多用户 / 团队共享缓存**：把 cache 目录指向网络驱动器（SQLite WAL 多读单写要小心）。
5. **跨格式导出复用**：MBTiles / GPKG 之间互相转换（纯 SQL）。

---

## 10. 风险与待澄清

| 风险 | 缓解 |
|---|---|
| 跨域瓦片无法 canvas 抓字节 | 走 Tauri 后端代理（http_client.get → 写缓存 → 返回 bytes），统一所有图源 |
| SQLite 单库高频写入 fsync 性能 | WAL + synchronous=NORMAL + put_batch 事务 |
| 缓存膨胀失控 | 严格 LRU + 默认 5 GB 上限 + 设置面板可视容量 |
| 用户误清缓存 | 二次确认对话框 + 操作日志 |
| Wayback release 太多导致库文件爆炸 | 默认仅缓存「最近浏览的 N 个 release」（N=5），其余只走网络 |
| TMS / XYZ 行号转换错误 | 100% 单元测试覆盖；导出后 mbview 实际验证 |

待澄清议题已敲定（2026-05-08）：

1. **默认缓存上限**：5 GB（用户可在「设置 → 瓦片缓存」中自由调整，0 表示无上限）。
2. **缓存目录位置**：默认 `<app_cache_dir>/geo-downloader/tile_cache`；允许用户在设置中切换到自定义路径（例如指向大容量 SSD）。切换时弹确认对话框，提示是否将旧目录搬迁过去。
3. **Wayback 多 release**：按 release 拆分为独立 db，命名 `wayback_<YYYY-MM-DD>.mbtiles`；单 release 可直接整库导出，无需扫描。
4. **MBTiles 导出模式**：提供「精简模式」（仅按 bbox 严格裁切，最小体积）与「完整模式」（保留缓存中 bbox 边缘外一定缓冲区瓦片，便于二次浏览）。默认精简，复选框切换。

---

## 11. 验收清单

- [x] 浏览同一区域重启 App 后离线可见。（gdcache 协议 + Store 持久化已落地）
- [x] 设置面板能看到容量、按图源拆分、可清理。（`cache_stats` / `cache_clear` / `cache_clear_all` 已接入）
- [ ] 同区域下载第二次，网络请求 < 第一次的 30%。（待手测）
- [ ] 导出 MBTiles 在 QGIS 中能加载，metadata 字段完整。（写入路径已实现，待手测）
- [ ] 导出 GPKG 在 QGIS / `gdalinfo` 中能加载。（写入路径已实现，待手测）
- [x] 缓存超上限自动 LRU 淘汰，不会撑爆磁盘。（`Store::prune` 已实现，启动时调用）
- [x] 清缓存操作不会误删非本工具的 mbtiles / gpkg 文件。（仅扫描 `tile_cache/<sha>__<slug>.mbtiles` 自带命名空间）

---

## 12. 实现状态（2026-05-08 收尾）

### 12.1 与 RFC 的差异

| 主题 | RFC 设计 | 实际实现 | 原因 |
|---|---|---|---|
| 文件命名 | `<source_key>.mbtiles` | `<sha8>__<slug>.mbtiles` | 防止用户图源名重名/特殊字符冲突，slugify 仅用于人眼辨识 |
| 缓存读取协议 | base64 over `cache_get_tile` 命令 | 自定义 URI scheme `gdcache://` (Win 上为 `http://gdcache.localhost`) | 阶段 6 提前到主线，省 33% 编码开销，零 JS round-trip |
| 写入路径 | 前端 canvas 抓字节后 `cache_put_tile` | 前端 fetch 原始字节 → `cache_put_tile`（base64） | canvas 重编码会丢失 JPG 优势，fetch 直接拿原字节 |
| 导出 writer 位置 | 嵌在 `exporter.rs` | 独立 `tile_pack.rs` 模块（460 行） | 导出器只处理 RGB/RGBA 拼接，瓦片包写入与拼接耦合度低 |
| MBTiles 复制策略 | `INSERT … SELECT … FROM src.tiles` 跨库 | `execute_zoom_level` 下载完一个 zoom 后，把瓦片文件目录批量灌入 mbtiles | 复用现有下载流水的 retry/限速/进度，不需要为导出再写一份调度器 |

### 12.2 已交付模块

| 模块 | 行数 | 关键 API |
|---|---|---|
| `src-tauri/src/tile_cache/mod.rs` | 310 | `SourceKey::new`, `xyz_to_tms_row`, `parse_gdcache_uri`, `slugify` |
| `src-tauri/src/tile_cache/store.rs` | ~280 | `Store::open`, `get`, `put`, `put_batch`, `stats`, `clear`, `prune` |
| `src-tauri/src/tile_cache/pool.rs` | ~120 | LRU 连接池，最多 8 个常驻 |
| `src-tauri/src/tile_pack.rs` | 480 | `append_zoom_to_mbtiles`, `append_zoom_to_gpkg`, `detect_tile_format`, `lonlat_bbox_to_mercator` |
| `src-tauri/src/lib.rs` (gdcache scheme) | +30 | `register_uri_scheme_protocol("gdcache", …)` |
| `src-tauri/src/commands.rs` (导出+缓存命令) | +120 | 7 个 `cache_*` 命令 + `execute_zoom_level` 的 mbtiles/gpkg 分支 |
| `frontend/src/features/map/cached-tile-layer.ts` | ~140 | `createCachedTileLayer` |
| `frontend/src/features/settings/cache-section.tsx` | ~180 | 设置面板「瓦片缓存」分组 |

### 12.3 测试覆盖（21 通过 / 0 失败）

- `tile_cache::store` 2 个：读写、批写
- `tile_cache::pool` 1 个：端到端 get/put
- `tile_cache::tests` 4 个：slugify、xyz↔tms、`parse_gdcache_uri` 正负样例
- `tile_pack::tests` 5 个：mbtiles 元数据/TMS row、追加 zoom 合并 min/max、gpkg application_id/SRS/matrix/XYZ row、格式探测、Mercator bbox
- 其余 9 个为既有 `tile`/`budget`/`tiles3d::filter` 测试

### 12.4 未完成项

1. 「同区域下载第二次网络请求 ≤ 30%」基准测试 — 需要手动跑两次同任务对比 `cache_stats`。
2. QGIS / mbview 打开实际产物的兼容性目检。
3. 缓存目录切换 + 旧目录搬迁 UI（RFC §6.3）首版未做，留作 v3.5.1。
4. 「完整模式」导出（bbox 边缘缓冲）首版未做，仅精简模式。

### 12.5 关键工程决策记录

- **MBTiles row 用 TMS，GPKG row 用 XYZ**：参见 `xyz_to_tms_row`，单测覆盖往返。
- **小数据内联存储**：BigTIFF 路径不受影响，但 mbtiles 写入需特别注意 metadata 表的 `minzoom/maxzoom` 字符串化（QGIS 要 string，不是 int）。
- **gdcache scheme 跨平台行为**：Windows/Android `http://gdcache.localhost`，其他 `gdcache://localhost`，前端通过 UA sniff 拼前缀。
- **CSP 同步更新**：`tauri.conf.json` 的 img-src 必须包含 `gdcache:` 与 `http://gdcache.localhost`，否则瓦片被浏览器拦截。
