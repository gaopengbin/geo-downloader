# 2026-04-21 批量 Shapefile 下载功能实现

## Issue #4 — 批量 Shapefile/GeoJSON 独立下载

### 概述
实现了多要素矢量文件的独立下载功能，支持单文件多要素和多文件批量上传两种模式。

### 新增文件
- `static/js/batch-download.js` — 批量下载工具模块
  - `sanitizeFilename` — 清理文件名，去除非法字符和矢量文件扩展名
  - `recommendNameField` — 按优先级推荐命名属性字段
  - `featureBbox` — 计算要素包围盒
  - `bboxAreaKm2` — 从 bbox 估算面积
  - `extractFeaturePolygon` — 提取要素多边形用于裁剪
  - `deduplicateFilenames` — 文件名去重（追加 `_N` 后缀）
  - `collectPropertyKeys` — 收集所有要素的属性键

### 修改文件
- `static/js/app.js`
  - `loadBoundaryFile` 增加多文件检测：多个 .geojson 或多组 .shp 文件逐个解析后合并
  - 新增 `showBatchModeDialog` — 模式选择（合并/独立）
  - 新增 `showBatchPanel` — 要素列表配置面板
  - 新增 `renderBatchFeatureList` — 渲染勾选列表（序号、名称、面积）
  - 新增 `startBatchDownload` — 批量下载调度（目录选择、文件名生成、并发控制）
  - 新增 `initBatchEvents` — 批量面板事件绑定
- `static/index.html`
  - 新增 `batch-mode-dialog` 弹窗 — 合并/独立模式选择
  - 新增 `batch-panel-dialog` 弹窗 — 要素列表、命名字段、并发设置
  - 引入 `batch-download.js` 脚本
- `static/css/style.css`
  - 新增 `.modal-lg`、`.batch-mode-options`、`.batch-feature-list` 等批量面板样式

### 核心流程
1. 加载矢量文件 → 检测要素数 > 1 或多文件
2. 弹出模式选择：合并为单范围 / 每个要素独立下载
3. 独立模式：展示要素列表（勾选、命名字段下拉、面积预览、并发度选择）
4. 选择输出目录 → 按并发度逐个创建下载任务（复用现有 createDownloadTask）
5. 多文件模式：注入 `__source_file` 属性，命名字段默认"来源文件名"

### 提交
- `14def75` — feat(#4): batch shapefile download - multi-feature & multi-file support
