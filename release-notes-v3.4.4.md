# v3.4.4 — 注记叠加 / mbtiles MVT 修复 / 中文文件名规避 / DEM 信息

## 新增

- **天地图注记图层**：新增 `tianditu_satellite_label`（cia_w）/ `tianditu_vector_label`（cva_w）/ `tianditu_terrain_label`（cta_w）三个注记源，可作为底图单独导出，也可在影像下载时通过新增的"叠加注记图层"多选块勾选并自动透明合成到瓦片上，输出时已合成。
- **DEM 模式信息卡**：DEM 高程页面的图源选择器下方新增提示卡，显示原始分辨率（Terrarium 全球约 30 m）/ 覆盖范围 / 编码格式 / 当前 zoom 在赤道处的采样间距（如 z15 ≈ 5 m/px），随 zoom 选择实时更新。

## 修复

- **mbtiles 在 QGIS 报"无效图层"**：根因是 GDAL 在 Windows 中文路径下打不开 SQLite 数据库。下载默认任务名对 `mbtiles` / `gpkg` 自动改用 ASCII 图源 id（如 `tianditu_satellite_z11`），其他栅格格式仍保留中文人友好名，用户手填的任务名始终透传。
- **MVT/PBF 输出 mbtiles 类型识别**：`detect_format` / `detect_tile_format_with_hint` 增加 TIFF 魔数识别，避免 mbtiles `metadata.format` 写错。
- **目录类输出污染父目录**：tiles / pbf 格式选择目录后，时间戳子目录现在生成在所选目录**内部**（如选 `zj/` → 写入 `zj/zj_<timestamp>/`），不再在同级冒出兄弟目录。

## 已知问题（待跟进）

- 3D Tiles 大数据集下到尾部偶发"卡死"：瓦片均已下载完，卡的是 tileset.json 解析流水线（缺硬超时 + 缺失败 URL 落盘）。等用户提供下次复现日志后定位具体卡死域名再修，方案见 [docs/worklog/2026-05-08-mbtiles-mvt-and-dem-info.md](https://github.com/gaopengbin/geo-downloader/blob/main/docs/worklog/2026-05-08-mbtiles-mvt-and-dem-info.md)。
