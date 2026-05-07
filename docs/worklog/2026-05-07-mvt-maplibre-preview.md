# 2026-05-07 MVT 实时预览（MapLibre GL）

## 背景

MVT 下载链路打通后，用户希望在「矢量切片 (MVT)」tab 内能直接看到所选图源的渲染效果，
而不是凭 URL 盲选。

## 方案选型

用户在三个方案中选择「MapLibre GL（独立预览窗口）」：

| 方案 | bundle 增量 | 侵入性 | 选用 |
| --- | --- | --- | --- |
| Leaflet.VectorGrid | +~80KB | 零侵入 |  |
| MapLibre GL（独立窗口） | +~800KB(实测+1MB) | 零侵入 | yes |
| MapLibre GL（替换主地图） | 同上 | 大改 |  |

## 实现

### 新增依赖

- `maplibre-gl` ^5.x：核心渲染
- `@mapbox/vector-tile`：解析首块瓦片，自动发现图层名
- `pbf`：vector-tile 的依赖

### 新组件 `frontend/src/features/mvt/mvt-preview.tsx`

工作流程：

1. 接收 `urlTemplate`（例如 `https://.../{z}/{x}/{y}.pbf`）
2. 计算选区中心 → 转 z=10 瓦片坐标 (x, y)
3. fetch 这块瓦片二进制
4. 若头两字节为 `1F 8B`（gzip）→ 用浏览器内置 `DecompressionStream('gzip')` 解压
5. 用 `@mapbox/vector-tile` + `pbf` 解析，列出所有 `source-layer` 名字 + 几何类型
6. 动态构建 MapLibre style：
   - OSM raster 底图（30% 透明度做参考）
   - 每个矢量图层根据几何类型挂 `fill` / `line` / `circle`
   - 颜色用 layer 名字哈希到 16 色调色板（保持稳定）
7. 用 MapLibre 创建地图实例，自动加载剩余瓦片
8. 选区变化时自动 `fitBounds`

### 集成到 ImageryPage

在 mvt 模式下，源选择器后插入预览区块（`isMvtMode &&`），高度 320px。
非 mvt 模式完全无影响。

## 优点

- 不需要 TileJSON / style.json，单纯靠采样首块瓦片就能渲染
- 不需要用户输入额外配置
- 颜色稳定（相同 layer 名永远同色），便于和 GIS 软件中的图例对齐
- 自动支持 gzip 压缩（很多 MVT CDN 默认 gzip 但漏配 Content-Encoding）
- 选区联动：拉选区后自动飞向选区

## 已知局限

- 不渲染文字/图标（没接 sprites + glyph 之外的）
- 用 OSM 公网瓦片做底图（无 token 时直接可用，被 OSM 限频时会失败）
- 首块采样在选区外极远时可能落在空白瓦片导致 0 图层（fallback 默认 [120, 30]）
- bundle +~1MB，主要是 MapLibre 自己

## 验证

- `npm run build`：成功，0 TS 错误
- 输出 `dist/assets/index-CfZvTZZi.js  2255KB (gzip 644KB)` —— 比此前增加约 1MB

## 影响面

| 区域 | 影响 |
| --- | --- |
| 影像/DEM tab | 0 影响（`isMvtMode` 短路）|
| MVT tab | 多一个预览面板 |
| bundle 体积 | gzip 后 +280KB |
| 网络请求 | MVT 模式首次加载会请求 OSM 底图 + 用户 MVT 服务的瓦片 |

## 待续

- 替换 OSM 底图为可配置（让用户选 ESRI / Stadia / 关闭底图）
- 支持加载用户自定义 style.json（Mapbox/Maptiler 风格表）
- 接入 sprite + glyph 以渲染文字/图标

## 追加：默认 MVT 图源

为了开箱可用，在 `src-tauri/src/config.rs::default_tile_sources` 内追加：

- id: `mvt_openfreemap`
- name: `OpenFreeMap (MVT 全球)`
- url: `https://tiles.openfreemap.org/planet/<版本号>/{z}/{x}/{y}.pbf`
- maxZoom: 14
- 免 token / 免费 / 公开

启动后，MVT tab 会自动识别该源（`isMvtUrl` 命中 `.pbf`），用户无需任何配置即可体验下载和预览。

第二个源：

- id: `mvt_versatiles_osm`
- name: `VersaTiles OSM (MVT 全球)`
- url: `https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}` （无后缀）
- maxZoom: 14
- 免 token / 免费 / 公开

## 追加：OpenFreeMap 版本号陷阱

实际验证发现，OpenFreeMap 的官方"裸"URL `https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf`
**返回 200 OK 但 body 为 0 字节**（CDN 只在版本化路径下才有真实数据）：

```powershell
Invoke-WebRequest -Uri 'https://tiles.openfreemap.org/planet/10/853/422.pbf'
# 200 0 bytes, content-encoding=
```

正确做法：
1. 先 GET `https://tiles.openfreemap.org/planet`（TileJSON）
2. 从响应里读 `tiles[0]`，得到带版本号的真实 tile URL，例如
   `https://tiles.openfreemap.org/planet/20260429_001001_pt/{z}/{x}/{y}.pbf`
3. 用这个 URL 给 MapLibre 当 source

修复落到两处：
- `default_tile_sources` 写死当前版本号 URL（版本会过期，需要定期更新）
- `MvtPreview` 组件 `discoverViaTileJson` 现在会返回 `canonicalTileUrl`，预览始终用 TileJSON 给出的真实 tile URL，而不是用户存的可能"过期"模板

### 副作用

- VersaTiles URL 没有 .pbf 后缀，`isMvtUrl` 已扩展识别 `tiles.versatiles.org/tiles/(osm|landuse|natural)`
- 下载时仍用用户存储的 URL，所以 OpenFreeMap 版本号过期时下载会得到 0 字节空文件 — 文档已注明「版本会过期，需重新访问 TileJSON 更新」

## 已知局限（更新版）

- 不渲染文字/图标（没接 sprites/glyphs）
- 底图固定 OSM 公网（被限频会失败）
- bundle +~1MB（gzip 280KB）—— MapLibre 必须代价
- OpenFreeMap 版本号会随时间失效，需要手动 `Invoke-RestMethod https://tiles.openfreemap.org/planet | % tiles` 取新 URL 并更新 `config.rs`
- 下载使用用户配置的原 URL，预览使用 TileJSON 真实 URL —— 两者可能短暂不一致

## 待续

- 替换 OSM 底图为可配置（让用户选 ESRI / Stadia / 关闭底图）
- 支持加载用户自定义 style.json（Mapbox/Maptiler 风格表）
- 接入 sprite + glyph 以渲染文字/图标
- 后端下载链路也走 TileJSON 自动解析，让"OpenFreeMap 版本过期"问题彻底自愈

## 追加：主地图区直接渲染 MVT（@maplibre/maplibre-gl-leaflet）

之前的方案是表单内嵌一个独立 MapLibre 预览面板（`MvtPreview`，h-480），主地图区仍是 Leaflet 栅格 + 选区绘制。用户反馈：「地图区为什么还是 leaflet 地图呢」——希望选区时直接看到 MVT 真实数据。

### 方案

引入 `@maplibre/maplibre-gl-leaflet@0.1.3`（官方维护的桥接包），把 MapLibre GL 作为 `L.Layer` 挂到现有 Leaflet 地图：

```ts
import '@maplibre/maplibre-gl-leaflet'  // 副作用：扩展 L.maplibreGL
import 'maplibre-gl/dist/maplibre-gl.css'

const layer = L.maplibreGL({ style, attributionControl: false })
layer.addTo(map)
```

好处：
- 选区绘制（leaflet-draw）、bbox、矢量图层、wayback 等所有 Leaflet 逻辑零改动
- MapLibre 视图自动跟随 Leaflet zoom/pan，无需手写同步
- 切换底图时 MVT 图层与栅格图层走同一套生命周期管理

### 改动

1. 共享 `mvt-style.ts`：把 `discoverLayers` + `buildStyle` 从 `MvtPreview` 抽取，新增 `includeBaseRaster: false` 选项让 Leaflet 底图透出
2. `map-canvas.tsx`：
   - 新增 `mvtLayerRef` / `mvtKeyRef`
   - 现有 `desiredBaseKey` 切换 effect 中前置检查：若选中的 src 是 MVT URL → 走 MapLibre 分支（异步 `discoverMvtLayers` → `buildMvtStyle` → `L.maplibreGL().addTo(map)`），否则走原栅格分支
   - 切换时互相清理（MVT→栅格 时 removeMvtLayer，栅格→MVT 时 removePrevRaster）
3. `imagery-page.tsx`：移除嵌入式 `<MvtPreview>`，换成一行说明文字「MVT 数据已直接渲染到上方主地图」
4. 删除 `imagery-page.tsx` 内重复的 `isMvtUrl` 函数定义（移到 `frontend/src/features/mvt/is-mvt-url.ts` 共享）
5. `map-canvas.tsx` 注册栅格图层时跳过 `isMvtUrl(c.url)`，避免 Leaflet 把 PBF 当 PNG 请求

### 验证

- `npm run build` ✅ 663ms 0 error
- 入口 bundle 涨到 2.26MB（gzip 645KB），主要来自 maplibre-gl 完整加入
- `MvtPreview` 组件保留未删（潜在未来用途，例如缩略图）
