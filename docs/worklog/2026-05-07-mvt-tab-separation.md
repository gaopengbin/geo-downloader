# 2026-05-07 拆分「矢量切片(MVT)」与「OSM 矢量数据」标签页

## 背景

QQ 群讨论中 GIS混混 提到矢量瓦片话题。复盘发现现有 UI 上的"矢量"标签页其实是 OSM Overpass 数据下载（输出 GeoJSON），**不是 MVT/PBF 矢量瓦片下载**。新用户进入会以为这就是 MVT 下载入口，造成强烈误导。

## 改动

### 类型层 `frontend/src/store/app-store.ts`

`AppMode` 增加 `'mvt'` 成员。

### 主壳 `frontend/src/App.tsx`

- 新增图标导入 `Layers3`
- `MODES` 列表：
  - 新增 `mvt` 项：`label: '矢量切片'`, `short: 'MVT'`, 描述强调 "MVT/PBF 矢量瓦片下载（需自定义图源）"
  - 原 `vector` 项重命名：`label: '矢量数据 (OSM)'`, `short: 'OSM'`, 描述明确 "OSM Overpass 道路/建筑/POI 等要素数据下载（GeoJSON）"
- 路由分支追加 `mode === 'mvt' ? <MvtPage /> : ...`

### 新页面 `frontend/src/features/mvt/mvt-page.tsx`

- 复用 `RegionSelector`
- 通过 URL 模板正则 `\.(pbf|mvt)(\?|$)` 自动识别可用 MVT 图源
- "已识别的 MVT 图源" 列表：有则展示 name + url；无则给出添加自定义图源的指引（带 Maptiler 示例 URL）
- 标黄"功能尚在开发中"卡片，链接到设计文档 [docs/vector-tiles-design.md](docs/vector-tiles-design.md)
- 列出当前后端缺口（PBF 识别、专用提交链路、样式预览）

## 当前未实现的部分（明确列出）

1. MVT 下载提交链路（避免误走 GeoTIFF/PNG 拼接）
2. `tile_pack::detect_format` 对 PBF 字节的识别（目前 fallback 到 `"png"`）
3. MVT 样式预览（MapLibre GL）

这些归入下个迭代，本次仅完成结构性拆分与诚实说明。

## 验证

- `npm run build` 通过（vite 439ms）
- 无新警告

## 影响面

- UI：导航多出一个"矢量切片 (MVT)"按钮，原"矢量"改名为"矢量数据 (OSM)"
- 类型：`AppMode` 联合扩成 6 项，所有 `Partial<Record<AppMode, ...>>` 类型自动兼容（无破坏）
- 后端：未改动
- 设置/store：旧 `selectedSourceByMode.vector` 字段保持兼容；新 `selectedSourceByMode.mvt` 默认空
