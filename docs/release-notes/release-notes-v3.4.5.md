# v3.4.5 — 缓存命中性能起飞 / 部分失败导出策略 / 下载预估精度修复

## 关键改进

- **缓存命中性能起飞**（Issue #25 + #26，~3000× 提升）
- **部分失败任务导出策略**（Issue #31，5-commit 闭环）
- **下载预估精度修复**（Issue #30，原 17× 偏差）
- **shapefile 单 .shp 文件导入修复**
- **5 项任务管理 UX 修复**
- **后端单测 42/42 全过**（新增 11 个）

> 详细分类见下方「新增 / 性能优化 / 修复 / 架构改造 / 测试 / 已知问题」六个小节。

## 新增

- **部分失败导出策略（Issue #31，5-commit 闭环）** — 大任务睡前启动、睡醒就有 TIF 的"幸福路径"：
  - 默认 `min_export_success_ratio = 0.0`（设置页新增滑块），少量失败仍自动导出，状态进入 `CompletedWithGaps` 并打**缺块比例徽章**（绿 <1% / 黄 <10% / 橙 <50% / 红 ≥50%）。
  - 阈值调到 1.0 时，部分失败任务进入 `Paused` 待决策状态，缓存保留供后续操作。
  - 任务面板新增三个按钮：
    - **补漏重导**（CompletedWithGaps 上的 RefreshCw）— 仅下载缺失瓦片，全成功后自动覆盖原 TIF
    - **强制按现状导出**（Paused 上的 Download）— 跳过下载，从 temp_dir 直接走流式导出（GeoTIFF / DEM / PNG），缺块在输出栅格上表现为白底或 NoData
    - **从列表移除** — 集中清理 task_file + temp_dir
  - 后端新命令 `export_partial_task(task_id)` + helper `scan_temp_dir_for_zoom`。

- **设置项**：`min_export_success_ratio`（自动导出最低成功率阈值，0.0 - 1.0，步长 5%）。

## 性能优化

- **缓存命中批量预过滤（Issue #25）** — `tile_cache::Store::contains_batch` 一条 SQL 批量识别已缓存瓦片：
  - 1258 张全命中场景 SQL 仅 3-5ms（vs 原 per-tile prepare/query ~10s × N，约 **3000× 提升**）。
  - 单批 300 个坐标走 `WHERE (zoom_level, tile_column, tile_row) IN (VALUES ...)`，主键索引查找 O(N log N)。

- **缓存命中零拷贝（Issue #26）** — 在 #25 基础上消除 temp_dir 写盘 IO：
  - 新增 `merger::TileSource { Path(PathBuf), Bytes(Arc<Vec<u8>>) }` enum，统一 11 处 `merge_tiles` / `tile_pack` / `streaming_*` 函数签名。
  - 缓存命中分支直接把 SQLite 取出的 bytes 装进 `Arc<Vec<u8>>` 共享给 merger，写盘 482ms 降到 <50ms。
  - `HashMap.clone()` 给 `spawn_blocking` 时仅复制 Arc 引用计数，避免 ~60MB Vec 全量复制。

- **行内多瓦片并行解码（Issue #27 部分实现）**：streaming_tiff 解码侧用 rayon `par_iter` 并行处理同一行内瓦片，8 核机器 4-6× 加速（跨 strip 缓冲留待后续）。

## 修复

- **下载预估偏低 17×（Issue #30）** — 实测 Google z16 125 万张预估 23GB / 实际 408GB：
  - 后端新增 `SourceKind` 枚举 + `avg_tile_size_kb(kind, zoom)` LUT + `compression_ratio(kind, comp)` 表。
  - GeoTIFF 走 `raw_rgb_mb × pyramid_mul × comp_mul`（pyramid 1.33×、LZW 卫星 0.95、Deflate 卫星 0.85）；mbtiles/tiles ≈ tile_download_mb；png/jpeg 单图按 raw 0.4。
  - 前端 imagery / wayback 页 UI 新增**双字段**：「输出文件大小」+「瓦片下载流量」分开显示。

- **单 .shp 文件导入报 `but-unzip~2`（shapefile）** — shpjs 6.x 默认入口仅接受 ZIP，单 .shp 必报错：
  - 改走 `parseShp + combine`（properties 默认 `{}`，几何完整满足圈选场景）。
  - `but-unzip~{1,2,3}` 错误码翻译成中文友好提示（"找不到 ZIP 文件结束标记，可能是损坏或非 ZIP 文件"等）。

- **5 项任务管理 / UX 修复**：
  - wayback 任务恢复时报"未知图源"（`resume_task` 加 `wayback_` 前缀分支）。
  - 丢弃任务对话框拆为两步（步 1 = 是否移除条目；步 2 = 是否同时删缓存），点"否"不再无反馈。
  - 暂停后任务计时仍在跑、按钮状态没切换（terminal-state guard）。
  - 取消任务后任务条目还在（`cancel_task` 立即 `mark_cancelled`）。
  - 行政区划顶部加"全国/全部"清空选项。

## 架构改造

- **`merger::TileSource` enum** — 替换 `HashMap<(x,y), PathBuf>` → `HashMap<(x,y), TileSource>`，统一 11 处函数签名（merger / tile_pack / streaming_tiff / streaming_raster / downloader / commands.rs overlay composite）。
- **`tile_cache::contains_batch`** — 批量主键 SQL 一条搞定 N 个瓦片命中查询，配合 `TileCoord: Hash` 派生支持 HashSet 集合操作。
- **`TaskStatus::CompletedWithGaps`** + `TaskInfo.success_count` 自动推算 + 3 处终态保护。

## 测试

- **后端 cargo test --lib：42/42 全过**（v3.4.4 是 31 个，新增 11 个：6 个 `merger::tile_source_tests` + 4 个 `tile_cache::contains_batch_*` + 1 个 `detect_tile_format` Bytes 变体）。
- **前端 tsc --noEmit：0 错误**。

## 已知问题（待跟进）

- 3D Tiles 大数据集尾段卡死（瓦片已下完，卡 `resolve_and_stream` 超时缺失），等用户复现日志定位。
- MVT mbtiles/gpkg 在 QGIS 看不到图层（缺 `vector_layers` JSON metadata）。
- exporter OOM（C3/C4，`Vec` 聚合未流式），单独 RFC 跟踪。
- `export_partial_task` 当前仅支持 GeoTIFF / DEM / PNG 流式格式；MBTiles / GPKG / 原始瓦片目录的强制导出建议走「补漏重试」路径。
