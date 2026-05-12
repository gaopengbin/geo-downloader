# v3.4.3 — 缓存清理与导出体验修复

## 修复

- **mbtiles WAL/SHM 残留**
  - 缓存连接关闭前执行 WAL checkpoint，并切回 DELETE journal mode 后关闭连接。
  - 连接池驱逐、缓存目录切换、单源关闭、全局 shutdown 和应用退出都统一触发关闭流程。

- **Wayback 历史影像预览空白**
  - 预览与下载统一使用 Esri 官方 `wayback-a.maptiles.arcgis.com` 瓦片地址。
  - 前端预览采用直连优先、本地代理 fallback，减少代理配置差异导致的空白图层。
  - 瓦片图片使用 `no-referrer`，本地代理请求上游时补齐必要来源头。

- **Wayback 下载范围体验**
  - 矩形选区默认按范围裁剪，避免导出完整瓦片矩阵后用户感知为边界偏移。
  - 多边形选区继续按多边形裁剪。

## 改进

- **输出参数一致性**
  - 普通影像、DEM、Wayback 统一输出格式、TIFF 压缩、金字塔、选区裁剪、任务名称和保存目录交互。
  - 普通 GeoTIFF 与 DEM 路径按钮改为选择目录，程序根据任务名称自动生成文件名，同时兼容手动输入完整文件路径。
  - Wayback 单个、批量、增量下载统一保存目录选择和任务名称设置。
  - 3D Tiles 与 OSM 矢量下载补充任务名称/保存目录等通用输出参数。

## 兼容性

- 与 v3.4.2 配置和历史数据兼容。
- 当前裁剪仍以透明 mask 为主；如需输出栅格外框也严格贴合选区，后续会继续做像素级 crop 与 geotransform 调整。

## 验证

- `npm run build`
- `cargo check --quiet`
- `git diff --check`
