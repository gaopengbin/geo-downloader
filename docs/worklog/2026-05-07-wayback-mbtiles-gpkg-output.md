# 2026-05-07 Wayback 下载补齐 MBTiles / GeoPackage 输出

## 背景

同一用户反馈：

> geotif 可选 mbtiles gpkg，wayback 没有 mbtiles gpkg 可选

普通影像下载页（imagery-page）和设置页都有 5 种输出格式（GeoTIFF / PNG / JPEG / 原始瓦片目录 / MBTiles / GeoPackage），唯独 Wayback 历史影像下载只暴露了 GeoTIFF / PNG / JPEG 三项。
README v3.4.3 release notes 已写「统一普通影像、DEM、Wayback、3D Tiles 与矢量下载的输出参数体验」，但 Wayback 这部分实际没落地，本次补齐。

## 调研结论

后端无需改动：

- `create_wayback_task`（[`commands.rs`](../../src-tauri/src/commands.rs)）和 `download_wayback_incremental` 都已经把 `request.format` 透传给统一的 `execute_download_task` 流水线
- 后者已实现 mbtiles/gpkg 分支（`is_pack` 路径，调用 `tile_pack::append_zoom_to_mbtiles` / `append_zoom_to_gpkg`）
- Wayback 与普通影像的差异只在「图源选择」环节，进入打包阶段后处理逻辑完全一致

只需前端把两个新选项加入下拉，并在 `save_path` 文件名生成时映射正确扩展名。

## 改动

仅一个文件：[`frontend/src/features/wayback/wayback-page.tsx`](../../frontend/src/features/wayback/wayback-page.tsx)

1. `FORMAT_OPTIONS` 新增 mbtiles 和 gpkg 两项
2. `extOf` 由三元运算改为 switch，新增 `mbtiles` / `gpkg` 分支
3. `supportsSelectionCrop` 由 `format === 'geotiff' || format === 'png'` 扩展为同时包含 `mbtiles` / `gpkg`
   - 对于打包格式，`crop_to_shape` 的语义是按多边形过滤瓦片（不是裁切图像），后端已支持

未改动的现有逻辑：

- `compression: format === 'geotiff' ? compression : 'none'` 三处保持不变；mbtiles/gpkg 自然走 'none'
- `build_pyramid: format === 'geotiff' && buildPyramid` 同上
- TiffCompressionSelect / BuildPyramidToggle 的 UI 渲染条件 `{format === 'geotiff' && (...)}` 保持不变，新格式下自动隐藏
- 未加 `tiles`（原始瓦片目录）选项；用户没要，且会引入文件夹 vs 文件路径的分支逻辑，等需求明确再做

## 影响面

- 单版本下载、批量下载、增量下载三种 Wayback 模式都自动获得 mbtiles/gpkg 输出能力（共用同一个 `format` state）
- 后端零改动，无新依赖
- 前端 `npm run build` 通过；Rust `cargo check` 不需要重新跑（无 Rust 改动）

## 验证

- 前端类型检查 + 生产构建通过
- 待用户在桌面端实测：选择 mbtiles 输出 → 任务完成后用 QGIS 直接打开 `.mbtiles` 文件应能加载

## 风险

低：

- 后端 mbtiles/gpkg 分支已被普通影像下载验证多次
- 文件名扩展名由 `extOf` 统一映射，不会出现「.mbtiles 内容写到 .tif 文件」之类错位
- crop_to_shape 在打包格式下的行为是「保留与多边形相交的瓦片」，与现有 mbtiles/gpkg 后端一致

## 后续待办

- 若用户希望「天地图标注层（cia/cva）也能像图源一样主动下载」，下一步在 imagery-page 的 sources 列表里增加 cia/cva 两项即可（已在缓存层注册过）
- v3.4.4 release notes 应明确说明 Wayback 现已支持 mbtiles/gpkg，避免 v3.4.3 的「写了功能却没落地」二次出现
