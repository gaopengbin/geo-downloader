# v3.4.4 — 矢量瓦片下载 / 注记叠加 / mbtiles MVT 修复 / DEM 信息卡

## 新增

- **矢量瓦片（MVT/PBF）下载支持**
  - 新增独立的"矢量瓦片"主 Tab（App 顶部模式切换），整套下载流水线打通：raw tiles 文件夹输出、mbtiles 打包（自动写 `format=pbf` 元信息）、gzip(1F 8B) 内容嗅探、按 hint 修正格式。
  - 内置默认源：`mvt_openfreemap`（OpenFreeMap 全球，使用版本化 URL `planet/20260429_001001_pt/{z}/{x}/{y}.pbf`，因裸 URL 返回 0 字节）/ `mvt_versatiles_osm`（VersaTiles OSM 全球）。
  - **主地图直接渲染 MVT**：通过 `@maplibre/maplibre-gl-leaflet` 把 MapLibre GL 作为 L.Layer 注入现有 Leaflet 地图，所有选区 / 绘制 / wayback 逻辑零改动。
  - 新增 `discoverLayers`（TileJSON 优先 + 多点探测）+ `buildStyle`，自动识别 source-layer 并生成可视化样式；`canonicalTileUrl` 优先使用 TileJSON 返回的真实带版本号 URL，避免 OpenFreeMap 裸 URL 失效。

- **天地图注记图层**
  - 新增 `tianditu_satellite_label`（cia_w）/ `tianditu_vector_label`（cva_w）/ `tianditu_terrain_label`（cta_w）三个注记源。
  - 可作为底图单独下载导出，也可在影像下载时通过新增的"叠加注记图层"多选块勾选，下载阶段自动透明合成到瓦片上。

- **DEM 模式信息卡**
  - DEM 页面图源选择器下方新增提示卡，显示原始分辨率（Terrarium 全球约 30 m）/ 覆盖范围 / 编码格式 / 当前 zoom 在赤道处的采样间距（如 z15 ≈ 5 m/px），随 zoom 实时刷新。

## 修复

- **mbtiles 在 QGIS 报"无效图层"**：根因是 GDAL 在 Windows 中文路径下打不开 SQLite 数据库。下载默认任务名对 `mbtiles` / `gpkg` 自动改用 ASCII 图源 id（如 `tianditu_satellite_z11`），其他栅格格式仍保留中文人友好名，用户手填的任务名始终透传。
- **MVT/PBF 输出 mbtiles 类型识别**：`detect_format` / `detect_tile_format_with_hint` 增加 TIFF 魔数识别，避免 mbtiles `metadata.format` 写错。
- **目录类输出污染父目录**：tiles / pbf 格式选择目录后，时间戳子目录现在生成在所选目录**内部**（如选 `zj/` → 写入 `zj/zj_<timestamp>/`），不再在同级冒出兄弟目录。

## 已知问题（待跟进）

- 3D Tiles 大数据集下到尾部偶发"卡死"：瓦片均已下载完，卡的是 tileset.json 解析流水线（缺硬超时 + 缺失败 URL 落盘）。等用户提供下次复现日志后定位具体卡死域名再修，方案见 [docs/worklog/2026-05-08-mbtiles-mvt-and-dem-info.md](https://github.com/gaopengbin/geo-downloader/blob/main/docs/worklog/2026-05-08-mbtiles-mvt-and-dem-info.md)。
