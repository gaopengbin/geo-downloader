# 2026-05-07 MVT 矢量瓦片下载链路（PBF 真正可用）

## 背景

上一轮把"矢量切片 (MVT)"独立成 tab，但点进去只是占位。本轮把下载链路真正打通：
能在选择 MVT 图源后输出 `{z}/{x}/{y}.pbf` 目录，或打包成 MBTiles / GPKG（format=pbf）。

## 后端改动

### `src-tauri/src/exporter.rs`

- `ExportFormat` 增加两个变体：
  - `Tiles`：原始瓦片目录（不重编码、不拼接），扩展名空字符串
  - `Pbf`：`.pbf` 矢量瓦片，content-type `application/x-protobuf`
- `from_str` 新增映射：`"tiles" | "raw" → Tiles`、`"pbf" | "mvt" → Pbf`
- 全部 `match format { ... }` 分支补齐 `Tiles | Pbf` 守卫（返回明确错误"不走 RGB/RGBA 拼接路径"），避免误走图像路径

### `src-tauri/src/tile_pack.rs`

- `detect_format` 增加 gzip 头识别（`1F 8B` → `pbf`），因为 MVT 服务常用 gzip 压缩
- 新增 `detect_tile_format_with_hint(tile_files, hint: Option<&str>)`：调用方可显式传 `Some("pbf")`，避免 protobuf 无 magic 时被误判成 png
- 新增 `write_raw_tiles_folder(save_dir, z, tile_files, ext)`：把下载下来的瓦片直接 `std::fs::copy` 到 `{save_dir}/{z}/{x}/{y}.{ext}`，不做任何重编码

### `src-tauri/src/commands.rs`

`execute_zoom_level`:

- 计算 `is_raw_tiles = matches!(format, Tiles | Pbf)`
- 计算 `format_hint`：`Pbf → Some("pbf")`、`Png → Some("png")`、`Jpeg → Some("jpg")`
- 新增 raw tiles 分支（在 is_pack 之前）：直接调 `tile_pack::write_raw_tiles_folder`
- 原 is_pack 分支改用 `detect_tile_format_with_hint(..., format_hint)`，让 pbf 走 mbtiles 时元数据 `format=pbf` 而不是 png

`execute_download_task`:

- `pack_single_file` 扩展为 `Mbtiles | Gpkg | Tiles | Pbf`：保证多 zoom 下载时仍写到同一个目录（pbf 自己用 z/x/y 分层）

## 前端改动

### `frontend/src/features/imagery/imagery-page.tsx`

复用现有 ImageryPage（避免重复实现表单/区域/估算/任务派发），扩展 `mode` prop：

- `mode: 'imagery' | 'dem' | 'mvt'`
- 新常量 `MVT_FORMAT_OPTIONS`：仅 `pbf` / `mbtiles` / `gpkg`
- 新工具 `isMvtUrl(url)`：URL 含 `.pbf` / `.mvt` 或 `format=mvt|pbf` 即视为 MVT 源
- 源列表过滤：
  - imagery：排除 DEM 源 + 排除 MVT 源
  - dem：仅 DEM
  - mvt：仅 MVT
- format 默认值：mvt 模式默认 `pbf`，缩放级别默认 `[10..14]`
- `FORMAT_EXT.pbf = ''`、`appendTimestamp` / `resolveSavePath` 把 pbf 当目录处理（同 tiles）
- `supportsSelectionCrop` 在 mvt 模式恒为 false
- format 下拉框在 mvt 模式只显示 MVT 三选项，并提示"矢量瓦片不拼接/不重编码，PBF 原始字节原样保存"
- mvt 模式跳过 `useImageryParamsStore` 同步（不参与"批量下载到 GeoTIFF"流程）
- zod schema 接受 `'pbf'`

### `frontend/src/App.tsx`

- 路由 `mode === 'mvt'` 改为 `<ImageryPage mode="mvt" />`，删除 placeholder MvtPage 文件

## 设计取舍

| 备选方案 | 选择 | 理由 |
| --- | --- | --- |
| 新建独立 MvtPage 重写表单 | 否 | 复用 ImageryPage 所有成熟能力（区域选择、估算、并发、任务派发、保存路径解析），3 处 mode 分支即可 |
| MVT URL 判定走"图源元数据 type 字段" | 否 | 改 settings/store schema 影响面大；URL 模板正则零侵入 |
| 把 PBF 检测加到 detect_format 中（按字节） | 部分 | 仅识别 gzip 头；裸 protobuf 无可靠 magic，必须依赖 `format_hint` |

## 验证

- `cargo check`：0 错误
- `npm run build`：vite 405ms，0 TS 错误

## 已知不在本轮范围

- 未做 MVT 样式预览（MapLibre GL）
- 未在地图 tab 上显示 MVT 图层（地图组件目前只支持 raster）
- 未在内置图源里加 Maptiler/Mapbox 等公共 MVT 源（需要用户自己 token）
- 未单独测试真实 MVT 服务的下载链路（需要可访问的 MVT 服务做端到端验证）

## 影响面

| 区域 | 影响 |
| --- | --- |
| 后端 ExportFormat 消费方 | 已用穷尽匹配补齐分支；二进制行为对 png/jpeg/tif/mbtiles/gpkg 无变化 |
| MBTiles/GPKG 元数据 | 当下载 MVT 源时 `format=pbf`（之前会写成 png）|
| 影像 tab 图源列表 | 自动隐藏 MVT 源（避免误选下载成 GeoTIFF）|
| 多 zoom + 'tiles' 输出 | 现在会写到同一基目录的多个 z/ 子目录（之前会按 z 切到 `parent/z{N}/...` 子目录里）— 行为微调，但更符合 XYZ tiles 标准布局 |

## 验证 checklist（用户可手动跑）

1. 在"图源管理"添加自定义 MVT 源：`https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=YOUR_KEY`
2. 切到"矢量切片 (MVT)"tab，应能看到这个源
3. 选区域、勾 z10~14、保存目录
4. 选 PBF 输出 → 期望 `<save_path>_<ts>/10/{x}/{y}.pbf` ... `14/{x}/{y}.pbf`
5. 选 MBTiles → 期望 `.mbtiles` 文件，sqlite 里 metadata.format = 'pbf'


## 待跟进（2026-05-07 晚）

- **QGIS 无法读取导出的 GPKG / MBTiles 矢量瓦片**
  - 现象：MVT 下载链路跑通，文件已生成，但拖进 QGIS 后看不到任何图层 / 内容。
  - 排查方向：
    1. 检查 metadata 表：MBTiles 必须有 `format=pbf`、`json` 字段（vector_layers 描述）；GPKG 需要 `gpkg_contents` 中的 `data_type='2d-gridded-coverage'` 或 `tiles`，并且 `gpkg_extensions` 注册了 mvt 扩展。
    2. 检查 PBF 数据是否被 gzip 压缩（QGIS 期望未压缩或 gzip 头正确）。
    3. 用 `sqlite3` 直接查 tiles 表的 blob 前几个字节（`1F 8B` = gzip，否则可能 raw protobuf）。
    4. 对照 mbutil / tippecanoe 生成的标准 MBTiles，看 metadata 行少了什么。
  - 可能根因：`tile_pack.rs` 的 MBTiles/GPKG 写入逻辑当初是为栅格 PNG 设计，对 MVT 缺少 `vector_layers` JSON metadata。
  - 优先级：明天处理。
