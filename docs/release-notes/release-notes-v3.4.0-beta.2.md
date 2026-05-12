## v3.4.0-beta.2 — 前端整体迁移到 React + shadcn/ui

> 这是 React 化迁移分支的第一个公开预览版。相比 v3.4.0-beta.1，**前端 UI 完全重写**：从原 `static/` 下的纯 HTML + 原生 JS 切换为 React 19 + Vite + TypeScript + shadcn/ui + Tailwind CSS 的现代栈。Tauri 后端命令保持兼容，体感上是同一款 GeoDownloader，但底层 UI 框架已经换代。

### 重大变更：前端架构

- **技术栈**：React 19 + Vite + TypeScript + shadcn/ui + Tailwind CSS
- **入口**：`frontend/`（保留 `static/` 作为兜底，待 QA 通过后移除）
- **类型化 Tauri API**：所有命令调用走类型化封装，编辑器内提示与类型检查
- **错误边界 + 关于对话框 + 模式 Tab** 等基础壳层完整落地

### 功能模块（React 化已覆盖）

- **影像（Imagery）**
  - 下载表单 MVP（数据源、缩放级别、范围、并发、Referer 等）
  - 地图选区 + Shapefile 导入（支持 .zip / .shp / .geojson）
  - 缩放级别区间下载
  - **每模式独立记忆数据源选择**，切换 Tab 不丢失上次配置
- **矢量瓦片（Vector）**
  - 独立页面拆分
  - 新增区域选择器（RegionSelector）
  - 按模式提供默认数据源
- **Wayback 时间机器**
  - 时间轴重新设计：年份分隔线 + hover 提示气泡，去掉 Slider，操作更直观
- **任务面板**
  - MVP 完成，可恢复任务在标题栏入口暴露
  - 自动估算瓦片数量
- **设置 / 图源管理**
  - 基础设置面板
  - 图源管理对话框
  - 设置整合到统一入口

### 内务 / 工程化

- 二维码资源中心化：公众号 / 微信群 / 微信 / 支付宝二维码改为从 GitHub Releases (`assets` tag) 拉取，本地 `images/` 作为兜底；后续更新二维码无需提交代码
- `imagery-page` 调试日志清理
- 同步 `Cargo.lock`

### 已知遗留

- React 化进入收尾阶段，`static/` 目录待全模式 QA 通过后移除
- 当前发布在 `feat/react-migration` 分支，正式版 `v3.4.0` 会合回 `main`
- 仍可能存在边角 case，欢迎反馈

### 安装包

- Windows: `GeoDownloader_3.4.0-beta.2_windows_x64-setup.exe`
- macOS Apple Silicon: `GeoDownloader_3.4.0-beta.2_macos_arm64.dmg`
- macOS Intel: `GeoDownloader_3.4.0-beta.2_macos_x64.dmg`
- Linux: `.deb` / `.AppImage`

### 反馈

遇到问题欢迎在 [Issues](https://github.com/gaopengbin/geo-downloader/issues) 提交，或扫描应用内二维码加入交流群。

---

完整提交历史详见 [v3.4.0-beta.1...v3.4.0-beta.2](https://github.com/gaopengbin/geo-downloader/compare/v3.4.0-beta.1...v3.4.0-beta.2)。
