## v3.4.0 — React 全新前端 / 浏览即缓存 / 3D Tiles 增强

> 这是 v3.4.0 的第一个正式版（GA），合并了 beta.1 与 beta.2 全部内容并新增 Issue #14 等大型功能。本版本包含 GeoDownloader 历史上最大的一次架构变更：**前端从原生 HTML/JS 完全迁移到 React 19 + TypeScript + shadcn/ui**，并围绕影像 / 矢量 / 3D Tiles / Wayback / 任务面板做了系统化重构。

### 核心变更

#### 1. 前端架构（React 重构）

- **技术栈**：React 19 + Vite + TypeScript + shadcn/ui + Tailwind CSS v4
- 类型化的 Tauri API 封装，编辑器内提示与类型检查
- 错误边界、关于对话框、模式 Tab 等基础壳层完整落地
- 主题切换、Dialog、Toast（sonner）统一交互组件
- 旧 `static/` 仍保留作兜底（后续版本下线）

#### 2. 浏览即缓存 — Issue #14（6-stage RFC 全套）

- **本地瓦片缓存**：`tile_cache` 模块（pool + store），LRU + 容量上限，多源隔离
- **缓存即数据源**：浏览过程中自动缓存的瓦片可直接打包成产物，无需重新下载
- **多种导出格式**：MBTiles、GeoPackage、目录树、ZIP
- **设置面板**：可视化查看缓存大小、清理、按数据源筛选
- **`tile_pack` 打包器**：单源 / 多源批量打包，进度 + 取消支持
- 设计文档：[docs/browse-as-cache-design.md](docs/browse-as-cache-design.md)
- 工作日志：[docs/worklog/2026-05-08-browse-as-cache.md](docs/worklog/2026-05-08-browse-as-cache.md)
- 21 个新单元测试覆盖核心路径

#### 3. 3D Tiles 增强

- **Cesium Ion 自动预览**：填入 Asset ID + Token 点「解析数据源」后，Cesium 视图自动加载模型
- **绘制贴合表面**：在 Cesium viewer 中绘制矩形 / 多边形选区时，使用 `scene.pickPosition` 拾取 3D Tiles 实际表面（不再贴在椭球上）
- **手动绘制不重定位**：完成绘制后保持当前视角，避免不必要的 flyTo
- **本地预览**：「预览本地」按钮可加载本地 tileset.json（基于 `serve_local_tiles` 内置 HTTP 服务）
- **模型调控面板**：实时调节 SSE 精度、不透明度、经纬高偏移、包围盒可视化
- 自动预览统一通过 `gd:preview-tileset` 自定义事件解耦，便于后续扩展

#### 4. 区域选择能力

- **多格式导入**：支持 Shapefile (`.zip` / `.shp`)、GeoJSON、KML、KMZ
- **多 feature 批量提交**：一次性下载多个不规则区域
- **DispatchModeRadio**：按要素逐个 / 合并外包矩形 等多种调度模式

#### 5. 影像下载（Imagery）

- 完整下载表单 MVP（数据源 / 缩放级 / 范围 / 并发 / Referer）
- 缩放级别区间下载
- 每个模式独立记忆数据源选择，切换 Tab 不丢失上次配置

#### 6. 矢量瓦片（Vector）

- 独立页面拆分
- 新增区域选择器（RegionSelector）
- 按模式提供默认数据源

#### 7. Wayback 时间机器

- 时间轴重新设计：年份分隔线 + hover 提示气泡
- 去掉传统 Slider，操作更直观

#### 8. 任务与历史面板

- MVP 完成，可恢复任务在标题栏入口暴露
- 自动估算瓦片数量
- 历史记录与下载结果浏览

#### 9. 设置 / 图源管理

- 基础设置面板（代理、并发、Cesium Ion Token、瓦片缓存等）
- 图源管理对话框
- 设置整合到统一入口

### 工程化改进

- macOS CI 增加 npm ci 失败重试（应对 npm "Exit handler never called" 偶发问题）
- README 重新设计：功能概览、平台下载、Discussions 入口
- 二维码资源中心化：从 GitHub Releases (`assets` tag) 拉取，无需提交代码即可更新
- `frontend/.vite/` 加入 .gitignore，避免误提交本机产物
- 类型声明 `Tiles3dSource` 统一 union（url / cesium_ion 两态）

### 已修复的关键 Bug（历史累积）

- WebView2 上 `window.confirm()` 非阻塞导致下载提前触发 → 改用 `tauri-plugin-dialog` 的 `ask`
- BigTIFF 小数据 tag 必须 inline 存储（修复 QGIS/GDAL 无法打开生成的 BigTIFF）
- TIFF LZW 编码必须用 `weezl::Encoder::with_tiff_size_switch`
- 3D Tiles 多处问题：URL `Url::join` 解析、Google Ion session 透传、ECEF→WGS-84 改用 Bowring 椭球迭代
- 多 replace 跨文件同形替换误拼接（已记入工程教训）

### 安装包

- Windows: `GeoDownloader_3.4.0_windows_x64-setup.exe`
- macOS Apple Silicon: `GeoDownloader_3.4.0_macos_arm64.dmg`
- macOS Intel: `GeoDownloader_3.4.0_macos_x64.dmg`
- Linux: `.deb` / `.AppImage`

### 升级提示

- 从 v3.3.x 升级：旧版任务历史和缓存数据库会自动迁移；建议升级前手动备份 `app data` 目录
- 从 v3.4.0-beta.x 升级：直接覆盖安装即可
- Cesium Ion Token 现存于设置中，从环境变量切换的用户请重新配置一次

### 反馈

遇到问题欢迎在 [Issues](https://github.com/gaopengbin/geo-downloader/issues) 或 [Discussions](https://github.com/gaopengbin/geo-downloader/discussions) 反馈，或扫描应用内二维码加入交流群。

---

完整提交历史：[v3.4.0-beta.2...v3.4.0](https://github.com/gaopengbin/geo-downloader/compare/v3.4.0-beta.2...v3.4.0)
