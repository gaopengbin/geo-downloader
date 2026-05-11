# geo-downloader — 项目核心层记忆

> 高频上下文。每次新会话开工前必读。≤ 200 行，超量沉到 mem0。
> 通用规则见 [`_rules.md`](./_rules.md)。

## 项目标识

- 仓库：`gaopengbin/geo-downloader`
- 工作区：`g:/code/tif-downloader`
- 产品名：GeoDownloader（原 tif-downloader，v3.0.0 更名）
- 当前发布：v3.4.4（稳定）
- mem0：`app_id=geo-downloader`、`agent_id=copilot-vscode`、`userId=mem0-mcp`

## 技术栈速记

- 后端：Rust + Tauri 2.x（`src-tauri/`）
- 前端：React 19 + Vite 8 + TypeScript + shadcn/ui (new-york) + Tailwind v4 + Zustand + TanStack Query（`frontend/`）
- 地图：Leaflet 2.x + leaflet-draw + MapLibre GL（含 `@maplibre/maplibre-gl-leaflet` 桥接）+ Cesium 1.140
- 数据：GDAL（可选 feature `geotiff`）、`tiff`/`png`/`image` crate、`rusqlite`（MBTiles/GPKG/瓦片缓存）
- 官网：`site/`（Cloudflare Pages，手动 wrangler 部署，**不联动 git push**）

## 启动 / 构建

```powershell
# 开发模式（React 前端 + Tauri 后端）
npm ci --prefix frontend
cargo tauri dev --manifest-path src-tauri/Cargo.toml --config src-tauri/tauri.react.conf.json

# 仅前端
npm --prefix frontend run build

# 仅 Rust 后端语法检查
cargo check --manifest-path src-tauri/Cargo.toml

# 发布构建
cargo tauri build --manifest-path src-tauri/Cargo.toml

# 官网部署（不会自动触发）
npx --yes wrangler@latest pages deploy site --project-name=geodownloader --branch=main
```

## 协作红线

- **不自动 commit / push**：用户明确说"提交" / "推送"才执行
- 改 Rust 必跑 `cargo check`；改前端必跑 `npm run build`
- 改完代码必检查 VS Code Problems / `get_errors` 输出
- 不写入密钥 / Token / API Key 到记忆或代码
- 不删 `static/`（旧前端 fallback，保留至 React 版 QA 通过）
- 跨分支搬单文件用 `git checkout <src-branch> -- <file>`，不要 `git stash`

## 已知踩坑（每次都要警惕）

- **Tailwind v4 字号 cascade**：顶层 `button, input, select, textarea { font: inherit }` 会覆盖 `text-xs/sm` 工具类。必须用 `font-family: inherit` 且整体包入 `@layer base`
- **TIFF LZW 编码**：用 `weezl::Encoder::with_tiff_size_switch`（不是 `new`），否则 libtiff 解码失败
- **BigTIFF inline 存储**：≤ 8 字节的 tag 必须 inline，不能写外部 offset，否则 GDAL/QGIS 读不开
- **WebView2 `window.confirm()` 非阻塞**：必须 `await window.__TAURI__.dialog.ask()`，否则代码继续执行
- **Tauri `convertFileSrc` 在 Windows**：会把 `\` 编码为 `%5C`，破坏相对路径解析。3D Tiles 必须走本地 HTTP 服务 `serve_local_tiles`
- **Leaflet z-index 200-800**：`.leaflet-container { isolation: isolate }` 否则 Dialog 蒙层被盖
- **QGIS 中文路径打不开 mbtiles/gpkg**：Windows narrow `fopen` + UTF-8 字节导致。对 sqlite 类输出用 ASCII id 命名（`tianditu_satellite_z11.mbtiles`）
- **`multi_replace_string_in_file` 同形替换 bug**：跨文件相似 oldString 会拼接成乱码。必须 per-file 单次 replace + 立即 `cargo check`
- **PowerShell UTF-8 输出**：执行 `gh` 等输出中文的命令前先 `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; chcp 65001 > $null`
- **PowerShell stdout 截断（Cascade 终端）**：直调 `gh ... --json ... | Out-File / Set-Content / Out-Host` 经常截断或显示空输出，即使 exit 0。绕开：`cmd /c "gh ... 2>&1"` 包装 + 文件中转 + `Get-Content -Encoding UTF8` 读
- **`code_search` 子代理幻觉**：其返回的 "believes that the following snippets are relevant" 代码片可能是推测补全而非真实文件内容。修改前必须 `read_file` / `grep_search` 二次确认，不可直接依据其 snippet 决定代码结构
- **`gh api -f` 类型**：sub-issues 等需要整数参数时必须用 `-F`，`-f` 总是字符串会 422
- **`gh issue comment` 传中文 body**：必须用 `--body-file <path>`，避免 ConvertTo-Json 中文转义坑

## 关键路径

- 命令入口：`src-tauri/src/commands.rs`（130 KB）
- 配置 + 内置图源：`src-tauri/src/config.rs`
- 下载链路：`downloader.rs` → `merger.rs` / `streaming_tiff.rs` → `exporter.rs` / `tile_pack.rs`
- 瓦片缓存：`src-tauri/src/tile_cache/` + 自定义 scheme `gdcache://`（Win 上 `http://gdcache.localhost`）
- 前端入口：`frontend/src/App.tsx`
- 模式分页：`frontend/src/features/{imagery,vector,mvt,tiles3d,wayback,dem,region,batch,...}`
- 共享输出控件：`frontend/src/features/download/output-controls.tsx`
- 工作记录：`docs/worklog/YYYY-MM-DD-<topic>.md`

## Wayback 专项

- 官方瓦片入口：`https://wayback-a.maptiles.arcgis.com/arcgis/rest/services/world_imagery/mapserver/tile/...`（与 Living Atlas 官网同源）
- 直连失败再代理兜底，预览图层用 `referrerPolicy=no-referrer`
- 扫描双轨：`footprints`（旧）+ `releases`（新，含 `dominant_capture_date` / `coverage_ratio`）
- metadata 文件缓存 7 天，cache key 已纳入 `scan_mode`

## 待办索引（详情见 docs/worklog；2026-05-11 核查更新）

| 来源 | 内容 | 状态 / 优先级 |
|---|---|---|
| #22 | 输出目录不生效 | ✅ **已关**（v3.4.4 `e4dc9fb` child timestamp dir 修复） |
| #30 | 下载预估偏低 17x | ✅ **已关，待发版**（commit `3bbde23` 修完，Cargo.toml 仍 3.4.4） |
| #31 | 部分失败任务的导出策略 | 🟡 设计稿 `docs/partial-export-design.md` 已出，实现未开始 |
| #27 | 多 strip 并行解码 + 大内存缓冲 | 🟡 行内 rayon 已实现（4-6×），跨 strip 缓冲未做（P3 / v3.4.6） |
| #25 | 换格式重导出走完整下载循环 | 🟡 主循环已实现（commit `213f3f8`），retry 循环留后续 PR |
| #24 | zustand persist 启动恢复 | ❌ P1，3 个 store 未接 `persist` |
| #26 | 缓存命中绕过 `temp_dir`，bytes 直接交 merger | ❌ P2，无 `TileSource::Bytes` enum |
| #29 | Sentinel-2 / Landsat 集成 | ❌ P2，`imagery_scene/` 模块未建 |
| #28 | 浏览期间新缓存的瓦片从待下载矩阵动态剔除 | ❌ P4，`tile_cache/` 无事件总线 |
| worklog 05-08 | 3D Tiles 末段卡死（`resolve_and_stream` 无 `tokio::time::timeout`） | 待复现日志 |
| worklog 05-07 | MVT mbtiles/gpkg 在 QGIS 看不到图层（缺 `vector_layers` JSON metadata） | bug |
| worklog 04-17 | exporter OOM（C3/C4，`Vec` 聚合未流式） | 单独 RFC |

未发版本变更（main HEAD 领先 v3.4.4）：
- `3bbde23` (2026-05-10) — 估算精度修复 + 部分失败设计稿 + 5 项顺手 bug 修
- `97e9973` (2026-05-11) — 建立 memories/ 与 `.windsurf/rules/memory.md`
- `f6f7a06` (2026-05-11) — 补充 PowerShell 截断踩坑 + 更新 issue 状态索引
- `213f3f8` (2026-05-11) — #25 主循环批量预过滤（`contains_batch` + 4 单测）

## 历史决策摘要

- **C5/C6 XSS**：`escapeHtml` + `escapeAttr` + `data-*` + `addEventListener` 取代内联 `onclick`
- **TLS 验证**：`config::ALLOW_INVALID_CERTS` 原子量 + `settings.allow_invalid_certs`，默认严格
- **tile.rs 溢出**：`MAX_ZOOM=24` + `clamp_zoom` + u64 中间量 + `saturating_*`
- **DEM 输出**：Float32 BigTIFF + EPSG:4326 + GDAL_NODATA=-9999.0；仅 Terrarium 单源（v3.5 候选 Mapbox / Copernicus / SRTM）
- **browse-as-cache (#14)**：`tile_cache::Store`（rusqlite + WAL + LRU 池）+ `RunEvent::Exit` checkpoint + `gdcache://` scheme
- **KML / KMZ**：客户端 JS 解析（`@tmcw/togeojson` + `jszip`），与 Shapefile `shpjs` 路径一致
- **Wayback 缩放级别**：chip 多选（与 imagery 对齐），后端 `zoom_levels: Option<Vec<u8>>`
- **矩形选区裁剪**：默认开启，复用 `crop_to_shape`（GeoTIFF / PNG，JPEG 不启用避免黑边）
