# GeoDownloader v3.6.18

本次更新主要完善 Wayback 历史影像浏览、图源适配与下载反馈。

## 关键改进

- **Google Earth 历史影像随地图加载**：在 Wayback 中选择 Google Earth 和日期后，平移、缩放自动读取对应影像，无需先框选或手动查询。
- **更多历史图源集中到 Wayback**：新增 NASA Landsat 历史底图、EOX Sentinel-2 年度影像及星图授权图源适配，普通影像列表与历史版本分开显示。
- **下载过程持续反馈**：点击后立即建立任务，显示准备索引、读取影像、缓存与导出状态。小任务逐块刷新，文件写完才显示 100%。
- **时间轴更容易点击**：整条 40px 高轨道均可选择最近日期，悬停显示日期；支持方向键及 Home/End 切换。
- **历史工作区布局统一**：区域选择恢复到顶部；日期选择保留一个入口，浏览与下载范围各自独立。
- **保留已有可靠性改进**：继续支持天地图备用 Key 切换、任务暂停/恢复、低内存缓存读取与凭据保护。

## 历史影像使用说明

- 日期列表随视野中心及源级别更新，所选日期保持不变。不同位置的可用日期和清晰度可能不同。
- 影像按不晚于所选日期的可用资料读取，必要时使用较早资料或父层影像。所选日期不代表整幅图片每个像素的实际拍摄日。
- 下载时选择范围和输出级别。GeoD 会固定本次数据快照，并为 GeoTIFF/PNG 保留透明缺测掩膜和来源清单。
- 星图需要配置用户自己的 Key，并以该 Key 已开通的接口权限为准。Key 保存在系统凭据存储中。

## English

- Google Earth historical imagery now streams as you pan and zoom in Wayback, with location-dependent dates and independent download selections.
- Added NASA Landsat, EOX annual mosaics and Geovis source adapters to the historical workspace.
- Tasks report preparation, imagery reading and export progress in real time. The timeline supports a larger click area, hover dates and keyboard navigation.
- Existing token failover, resumable tasks, bounded cache processing and credential protection are retained.
