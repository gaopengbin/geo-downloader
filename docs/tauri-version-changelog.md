# Tauri 版本更新日志

## 概述

本分支 (`tauri-version`) 将原有的 Python/FastAPI + PyWebView 桌面应用完全重构为 Tauri + Rust 实现，带来显著的性能提升和更小的安装包体积。

## 技术栈变更

| 组件 | 旧版本 | 新版本 |
|------|--------|--------|
| 后端 | Python 3.10 + FastAPI | Rust + Tauri 2.0 |
| 前端 | HTML/CSS/JS + Leaflet | 同上 (保持不变) |
| 桌面封装 | PyWebView + PyInstaller | Tauri (原生 WebView) |
| 图像处理 | PIL/Pillow + Rasterio | image + tiff-encoder |
| HTTP 客户端 | aiohttp | reqwest (异步) |

## 新增功能

### 1. 多图源与自定义图源
- 内置 10+ 图源：OSM、ArcGIS 卫星/地形/街道、天地图矢量/卫星/地形、Carto、Google Maps、高德地图/卫星、OpenTopoMap
- 支持用户自定义图源（`{z}/{x}/{y}` 格式），可添加/编辑/删除
- 图源按名称首字母排序

### 2. 多任务并行下载
- 支持同时创建多个下载任务（影像 + OSM 矢量）
- 每个任务独立进度显示，支持取消
- **支持暂停/继续下载**（任务卡片“暂停”按钮，暂停后停止拉取新瓦片，已在飞行中的自然完成）
- 完成的任务 2 秒后自动移除
- 后端使用 tokio 异步任务 + CancellationToken + PauseControl

### 3. 下载历史记录
- 自动记录每次下载（图源、缩放、瓦片数、文件大小）
- 支持快速打开文件所在文件夹
- 支持单条删除和一键清空

### 4. 设置持久化
- 天地图 Token、代理、并发数、缩放级别、自定义图源等设置自动保存至 `settings.json`

### 5. GCJ-02 坐标处理
- 自动检测高德/Google 等 GCJ-02 图源并显示偏移警告
- 行政边界坐标自动转换为 WGS-84

### 6. 任务日志系统
- 每个任务独立日志，实时记录下载/重试/拼接/导出全流程
- 任务卡片“日志”按钮展开终端风格日志面板（深色背景、等宽字体、颜色分级）
- 日志同步持久化到文件 (`{AppData}/geo-downloader/logs/task_*.log`)
- 内存中最多保留 500 条，自动滚动到底部

### 7. 断点续传
- 任务开始前持久化任务参数到 `{AppData}/geo-downloader/tasks/`
- 崩溃/异常退出后重启可看到“中断的任务”，支持“继续下载”或“丢弃”
- 下载时自动跳过已存在的瓦片文件（按文件名 + 非空检查）
- 活动任务自动排除在可恢复列表之外

### 8. GeoTIFF 优化
- 导出带完整 GeoTIFF 投影标签 (EPSG:3857 Web Mercator)
- 支持 LZW 无损压缩
- 大图像自动使用 BigTIFF 格式
- 流式写入器支持超大范围导出（内存仅需一行瓦片宽度）

### 9. 界面全面优化
- Tab 导航：下载配置 / 下载中心 / 设置
- 自定义标题栏（最小化/最大化/关闭）
- 缩放级别直观描述（z15 · 街道级）
- Leaflet 本地化部署，无 CDN 依赖

## 性能优化

### 1. 瓦片拼接优化
- 使用 `image::imageops::replace` 替代逐像素操作
- 内存预分配，减少重新分配开销

### 2. 多边形裁剪优化
- 实现扫描线算法替代逐点检测
- 直接操作字节数组，性能提升 10x+

### 3. TIFF 导出优化
- 使用 `TiffEncoder` 直接编码
- 预分配缓冲区，避免多次内存分配

### 4. 下载稳定性
- 每个请求独立 8 秒超时，单瓦片最多重试 2 次
- 打乱瓦片顺序避免限速时失败集中在同一列
- 失败瓦片进入重试队列（最多 3 轮，递减并发 + 递增等待）
- `tokio::select!` + 独立 3 秒定时器，即使所有瓦片卡在重试也能报告进度
- 实时显示“N 个瓦片正在重试”状态

## 代码结构

```
src-tauri/src/
├── lib.rs          # 应用入口，插件注册
├── commands.rs     # Tauri 命令 (供前端调用)
├── config.rs       # 配置常量，内置图源定义
├── tile.rs         # 瓦片坐标计算
├── downloader.rs   # 异步并发下载器
├── merger.rs       # 瓦片拼接，多边形裁剪
├── exporter.rs     # 图像导出 (GeoTIFF/PNG/JPEG)
├── admin.rs        # 行政区划数据
├── streaming_tiff.rs # 流式 BigTIFF 写入器
├── task.rs         # 多任务管理、暂停控制、日志、断点续传
├── history.rs      # 下载历史记录
└── settings.rs     # 用户设置持久化
```

## 前端变更

### index.html
- Tab 导航布局：下载配置 / 下载中心 / 设置
- 自定义标题栏控件
- 动态图源下拉框（从后端 API 加载）
- 自定义图源管理 UI
- 任务卡片和下载历史列表

### style.css
- 现代设计风格，变量化主题
- 任务卡片样式（下载中/完成/失败状态）
- Tab 导航样式
- Leaflet 控件主题适配

### app.js
- 动态图源加载与排序 (`loadMapSources`)
- 自定义图源 CRUD (`addOrUpdateCustomSource`, `editCustomSource`, `removeCustomSource`)
- 多任务管理 (`addTaskCardToUI`, `startTaskListener`, `updateTaskCard`)
- 下载历史 (`loadDownloadHistory`, `renderHistoryCard`)
- 设置持久化 (`saveAllSettings`, `applySettings`)
- GCJ-02 偏移警告

### api.js
- Tauri IPC 适配层，封装所有后端命令

## 已删除的旧代码

- `app/` - Python FastAPI 后端
- `desktop.py` - PyWebView 入口
- `requirements.txt` - Python 依赖
- `*.bat` - 旧的批处理脚本
- `*.spec` - PyInstaller 配置

### 全国行政区划
- 省份下拉顶部新增“全国”选项 (adcode 100000)

### 10. 多边形裁剪 Mercator 投影修正
- 多边形裁剪坐标参考从用户选区改为瓦片网格边界，修复裁剪边界整体偏移
- 纬度→像素映射从线性插值改为 Mercator 投影 (`ln(tan(π/4 + lat/2))`)，修复行政边界与实际影像的偏移
- 同步修复 `crop_to_bounds` 的同类问题

## 后续计划

- [x] 支持断点续传
- [x] 任务暂停/继续
- [x] GeoTIFF 地理参考与多边形裁剪偏移修复
- [x] 3D Tiles 下载功能
- [x] CesiumJS 3D 预览
- [x] 本地 3D Tiles 模型预览
- [ ] 国际化支持

---

## 3D Tiles 功能模块

> 日期: 2026-04-05

### 11. 3D Tiles 按区域下载

**后端 (`src-tauri/src/tiles3d/`)**
- `tileset.rs` — 数据结构：Tileset、Tile、BoundingVolume、TileContent、Tiles3dSource（`#[serde(tag = "type")]` 枚举，支持 Cesium Ion / 自定义 URL）
- `filter.rs` — 空间过滤：SelectionRegion、包围体（box/region/sphere）与多边形相交判断、filter_tileset/filter_tileset_all
- `fetcher.rs` — 下载编排：resolve_source（含 Cesium Ion token 交换）、fetch_tileset、download（Arc 回调进度、并发控制、URI 重写）
- `mod.rs` — 模块导出
- `commands.rs` — 3 个 Tauri 命令：analyze_3dtiles、estimate_3dtiles、create_3dtiles_task

**前端**
- 模式切换：TIF 瓦片 / 3D Tiles 双标签页
- 数据源面板：自定义 URL / Cesium Ion Asset ID + Access Token
- 解析 → 估算 → 下载全流程 UI
- 下载设置：并发数滑块

### 12. CesiumJS 3D 地球集成

- CesiumJS 1.140.0 CDN 集成
- `initCesiumViewer()`：OpenStreetMap 底图 + EllipsoidTerrainProvider（无 Ion 依赖）
- `switchMode()` 使用 `requestAnimationFrame` 延迟初始化解决容器 `display:none` → 零尺寸问题
- `loadTilesetInCesium()` 支持 Ion Asset / 直接 URL 两种加载方式

**CSP 调整 (`tauri.conf.json`)**
- `style-src` 加 `https:` 允许 CesiumJS CDN 样式表
- `worker-src 'self' blob: https:` 允许 CesiumJS Web Workers
- `img-src` 加 `http:` 覆盖 asset 协议纹理加载
- `connect-src 'self' https: http:` 覆盖异步数据请求

### 13. 本地 3D Tiles 模型预览

**方案演进**
- ~~方案 A: Tauri asset 协议 (`convertFileSrc`)~~ — Windows 路径编码问题：`encodeURIComponent` 将 `\` 编码为 `%5C`，整个路径变为单一 URL 段，CesiumJS 相对路径解析失败（tile 文件 404）
- **方案 B: 本地 HTTP 文件服务器** ✅ — 零新依赖，复用已有 tokio

**实现**
- `serve_local_tiles` 命令 (`commands.rs`)：
  - `tokio::net::TcpListener::bind("127.0.0.1:0")` 绑定随机端口
  - 极简 HTTP/1.1 响应：解析 GET 请求路径 → URL 解码 → 读文件 → 带 CORS 头返回
  - MIME 类型映射：json/glb/gltf/b3dm/i3dm/pnts/cmpt/png/jpg/ktx2
  - 路径穿越防护：`canonicalize()` + `starts_with()` 校验
  - `PREVIEW_SERVER_PORT` 原子变量跟踪活跃端口
- 前端 `previewLocal3dTiles()`：
  - Tauri 文件对话框选择 `tileset.json`
  - 提取目录路径 → `invoke('serve_local_tiles', { dirPath })`
  - 返回 `http://127.0.0.1:<port>` → 拼接 tileset 文件名 → CesiumJS 加载
  - 加载状态反馈（loading spinner / 错误提示）
- UI: "预览本地模型"按钮（文件夹图标），"或"分隔符

**状态**: 代码完成，待验证（需本地 3D Tiles 测试数据）

---

## 3D Tiles 下载质量与兼容性修复

> 日期: 2025-07-16

### 14. 下载缺块三大 Bug 修复

参考 GitHub 开源仓库：Sogrey/3dtiles-downloader (Rust)、pxret/3dtiles_download (Node.js)、lukaslaobeyer/3dtiles-dl (Python) 等实现，诊断并修复以下问题：

1. **URL 解析重写** — `resolve_url()` 从简单字符串拼接改为 `reqwest::Url::parse(base)?.join(relative)?`，正确处理 OSGB 数据中的 `../` 相对路径
2. **重试退避策略** — MAX_RETRIES 3→5，增加指数退避（500ms × 2^(n-1)），防止服务器限流时快速耗尽重试
3. **通道发送错误处理** — `let _ = tx.send(...)` 改为日志记录，不再静默丢弃失败的瓦片
4. **解析并发降低** — `buffer_unordered` 50→20，减少对服务器的并发压力

### 15. Query 参数传递

- 支持 `?token=mars3d` 等 CDN 认证参数
- `download()` 从 tileset_url 提取 query 参数，传入 `resolve_and_stream()`
- 新增 `append_query(url, query)` 工具函数
- HTTP 请求 URL 附加 query，本地存储路径保持干净

### 16. Referer 防盗链支持

**问题**：OSS/CDN 通过 Referer 白名单控制访问，直接请求返回 403

**后端**
- `download()` 改为 `&mut self`，自动从 tileset_url origin 推断 Referer
- `execute_3dtiles_task` 中先调用 `resolve_source()` 再 `download()` 以继承 auth_headers

**前端**
- 新增 Referer 输入框 (`tiles3d-referer-input`)
- `buildTiles3dSource()` 将 Referer 放入 `source.headers`

### 17. CesiumJS 预览反向代理

**问题**：浏览器安全策略禁止 JavaScript 设置 `Referer` header，CesiumJS 无法直接加载 Referer 保护的远端数据

**方案**：本地反向代理（`start_tile_proxy` 命令）
- `tokio::net::TcpListener::bind("127.0.0.1:0")` 绑定随机端口
- 接收 CesiumJS 请求，转发到远端并带上自定义 headers（Referer 等）
- 自动从 base_url 提取 query 参数并附加到所有转发请求（如 `?token=mars3d`）
- 响应带 `Access-Control-Allow-Origin: *` 供 WebView 跨域访问
- `reqwest::Client` 带 `default_headers` 注入 Referer

**前端**
- `loadTilesetInCesium()` 改为 `async`
- 检测到 Referer → 调用 `startTileProxy(baseUrl, headers)` → CesiumJS 从 `http://127.0.0.1:PORT/tileset.json` 加载
- 子瓦片请求同样走代理，query 参数由代理层自动附加

### 18. UI 亮色主题修复

- `.cesium-controls` 背景从深色 `rgba(15,23,42,0.92)` 改为亮色 `rgba(255,255,255,0.95)`
- `.map-status-bar` 背景从 `rgba(30,41,59,0.8)` 改为 `rgba(255,255,255,0.9)`
- 文字颜色统一使用 `var(--text)` CSS 变量

---

## Google 3D Tiles 兼容性修复与产品重命名

> 日期: 2026-04-07

### 19. Google 3D Tiles 下载三处 Bug 修复

**问题现象**：框选台湾台中一小块区域（~120.647°-120.650°E, 24.213°-24.216°N），仅下载了最外层几块地球瓦片（6个 glb），无高精度细节。

**Bug 1: JSON 扩展名检测失败**
- Google 内容 URI 含 query 参数：`file.json?session=CL34hcL28MKHVRDJ7tTOBg`
- `uri.to_lowercase().ends_with(".json")` 返回 false，子瓦片集未被识别为 JSON
- 修复：`uri.split('?').next().unwrap_or(uri)` 去除 query 再判断，影响 3 处（`fetcher.rs` ×2、`tileset.rs` ×1）

**Bug 2: Session 参数未传播到子瓦片集内容**
- Google 根级 tileset 的内容 URI 已嵌入 `?session=xxx`
- 但子瓦片集中的内容 URI **不含** session 参数，请求返回 403
- 修复：从 initial_uris 提取 `session=xxx`，构建 `effective_query` 包含 key + session，shadow `query_params` 使后续所有请求自动携带
- 修复后：6个 glb → 137个 glb + 82个 json

**Bug 3: 子瓦片集 URI 未本地化**
- 下载的子瓦片集 JSON 仍含 Google 绝对路径 `/v1/3dtiles/datasets/CgIYAQ/files/xxx.glb`
- 本地预览时 CesiumJS 无法解析这些路径
- 修复：下载子瓦片集时构建 `sub_uri_map: HashMap<String, String>`，调用 `rewrite_tileset_uris()` 将 URI 转为本地相对路径

### 20. 调试日志清理

- 移除所有 `_debug_resolve.log` 文件写入
- 移除所有 `eprintln!("[DEBUG]...")` 调试输出
- 错误处理改用 `log::warn!`

### 21. 产品重命名 tif-downloader → GeoDownloader

**变更范围（14+ 文件）**：
- `Cargo.toml`: name → `geo-downloader`，description 更新
- `tauri.conf.json`: productName / identifier / title → `GeoDownloader`
- `admin.rs`: User-Agent → `GeoDownloader/1.0`（2处）
- `commands.rs`: 安装包名 → `GeoDownloader_{}_setup.exe`，User-Agent 更新
- `settings.rs` / `history.rs` / `task.rs`: AppData 路径 → `geo-downloader`
- `index.html`: 版本显示文本、GitHub 链接
- `app.js`: `GITHUB_REPO = 'gaopengbin/geo-downloader'`
- `release.yml`: 安装包名称、Release 标题
- `README.md`: 标题、功能描述、项目结构、Star History
- `promotion.md` / `3dtiles-design.md` / `MASTER.md`: 产品名更新

### 22. 版本升级 2.0.0 → 3.0.0

- `tauri.conf.json` / `Cargo.toml` / `app.js` 版本号统一升至 3.0.0
- `README.md` 新增 v3.0.0 版本说明段落
- GitHub 仓库重命名 `gaopengbin/tif-downloader` → `gaopengbin/geo-downloader`（自动 301 重定向）
- 本地 git remote 更新
- 创建 v3.0.0 tag 并触发 Release CI
