# 前端 React + Vite + shadcn/ui 重构规划

日期：2026-04-27

## 背景

当前前端仍是纯静态页面架构：

- `src-tauri/tauri.conf.json` 的 `build.frontendDist` 指向 `../static`
- 仓库根目录暂无 `package.json`
- 前端主要文件规模：
  - `static/index.html`：1135 行
  - `static/css/style.css`：2628 行
  - `static/js/app.js`：5260 行 / 212 KB / 167 个函数
  - `static/js/api.js`：432 行
  - `static/js/batch-download.js`：137 行

这说明前端已经从“脚本增强页面”演变成复杂应用。继续在 `app.js` 里叠加 #11 / #12 / #14 / Wayback / 3D Tiles 等功能，会增加回归风险和维护成本。

## 目标

用 React + Vite + TypeScript + shadcn/ui 重构前端，使业务模块边界清晰、UI 组件可复用、状态可追踪，并保持 Tauri 2.x 桌面能力。

核心目标：

1. 保持现有功能可用，不做一次性大爆炸替换。
2. 建立类型化 API 层，统一封装 Tauri `invoke`。
3. 将地图、下载任务、设置、历史、Wayback、3D Tiles 等业务域拆成独立模块。
4. 用 shadcn/ui 统一 Dialog / Tabs / Button / Form / Toast 等基础交互。
5. 保留 Leaflet / Cesium 能力，但纳入 React 生命周期管理。
6. 迁移期间每个阶段都可编译、可回退。

非目标：

- 不重写 Rust 后端命令接口，除非前端类型化时发现字段设计明显不合理。
- 不在第一阶段引入 SSR / Next.js。
- 不直接解析奥维 `.ovsmf` 等专有格式。
- 不在 UI 中使用 emoji；图标使用 SVG 或文字。

## 推荐技术栈

| 类别 | 选择 | 理由 |
|---|---|---|
| 构建 | Vite | Tauri 官方常见组合，启动快，配置轻 |
| 框架 | React + TypeScript | 适合复杂 UI 状态与组件拆分 |
| UI | shadcn/ui + Tailwind CSS | 可复制组件源码，样式可控，不绑定运行时 UI 框架 |
| 状态 | Zustand 或 React Context + reducer | 下载任务、设置、地图状态跨组件共享较多，Zustand 更轻便 |
| 表单 | react-hook-form + zod | shadcn 常用组合，适合设置/下载参数校验 |
| 地图 | leaflet / leaflet-draw / shpjs | 迁移现有二维地图能力 |
| 3D | cesium + vite-plugin-cesium | Cesium 静态资源在 Vite 下需要专门处理 |
| Tauri | @tauri-apps/api | 替代全局 `window.__TAURI__`，逐步类型化 |

包管理器建议先用 `npm`，因为当前仓库没有前端工程，少引入额外工具链；后续如需 monorepo 或缓存优化再切 pnpm。

## 目录规划

建议新增 `frontend/`，保留 `static/` 作为旧版可回退前端：

```text
frontend/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  components.json              # shadcn/ui 配置
  src/
    main.tsx
    App.tsx
    styles/globals.css
    lib/
      tauri.ts                 # invoke 封装
      format.ts                # 格式化、escape、版本比较等纯函数
      geometry.ts              # bbox/polygon/zoom 计算
      constants.ts
    types/
      api.ts                   # Rust command DTO 类型
      map.ts
      task.ts
      wayback.ts
    store/
      app-store.ts             # 全局设置、当前 mode
      download-store.ts        # 下载任务进度
      map-store.ts             # bbox、图层、绘制状态
    components/
      ui/                      # shadcn/ui 生成目录
      layout/
        AppShell.tsx
        Sidebar.tsx
        Titlebar.tsx
      common/
        SourceSelect.tsx
        ZoomRangeInput.tsx
        BoundsSummary.tsx
        ProgressPanel.tsx
    features/
      map/
        LeafletMap.tsx
        DrawToolbar.tsx
        SearchPanel.tsx
        AdminRegionPicker.tsx
      download/
        DownloadForm.tsx
        DownloadEstimate.tsx
        TaskProgress.tsx
        HistoryPanel.tsx
        ResumePanel.tsx
      settings/
        SettingsDialog.tsx
        SourceManager.tsx
        BuiltinSourceList.tsx
        CustomSourceList.tsx
      wayback/
        WaybackPanel.tsx
        WaybackTimeline.tsx
        WaybackIncrementalList.tsx
      tiles3d/
        Tiles3dPanel.tsx
        CesiumViewer.tsx
        ModelControls.tsx
      vector/
        VectorUploadPanel.tsx
        BatchShapefilePanel.tsx
      update/
        UpdateDialog.tsx
        update-service.ts
```

Tauri 配置最终从：

```json
"frontendDist": "../static"
```

切到：

```json
"beforeDevCommand": "npm run dev --prefix ../frontend",
"devUrl": "http://localhost:1420",
"beforeBuildCommand": "npm run build --prefix ../frontend",
"frontendDist": "../frontend/dist"
```

迁移中不要立刻删除 `static/`，先保留到新版功能验收完成。

## 状态模型

建议把全局状态控制在少数 store 中，避免组件互相传参失控。

### AppStore

- 当前模式：`imagery | dem | wayback | tiles3d | vector`
- 应用设置：并发数、默认 zoom、内存预算、代理、token、debug
- 图源列表：内置源、自定义源

### MapStore

- 当前 bbox / polygon
- 当前 zoom / zoomMax
- Leaflet 绘制结果
- 行政区选择结果
- GCJ-02 警告状态

### DownloadStore

- 当前任务 ID
- 当前任务状态
- 进度百分比
- 多 zoom 子进度
- 下载历史
- 断点续传列表

### WaybackStore

- release 列表
- scanMode：`fast | fine`
- 扫描结果
- 选中的拍摄日期 / 服务组
- 增量下载状态

## API 分层

当前 `static/js/api.js` 已经承担 Tauri invoke 封装职责，迁移时应变成 `frontend/src/lib/tauri.ts`。

原则：

1. 所有 `invoke` 只出现在 `lib/tauri.ts` 或 feature service 文件中。
2. UI 组件不直接拼 command 字符串。
3. Rust DTO 在 `types/api.ts` 中定义 TypeScript 类型。
4. 字段命名沿用 Rust serde 约定，避免前端私自改名。

示例分组：

```text
lib/tauri.ts
features/download/download-api.ts
features/settings/settings-api.ts
features/wayback/wayback-api.ts
features/tiles3d/tiles3d-api.ts
```

## 迁移路线

### 第 0 阶段：基线冻结

已完成：

- 当前多 zoom + Wayback scan_mode 修复已提交为 `8da8901 feat: 支持缩放级别区间下载`
- 不推送，等待明确指令

后续重构从该 commit 之后开始，便于回滚和对比。

### 第 1 阶段：搭建 React/Vite 空壳

目标：新增 `frontend/`，不改变现有 `static/` 运行链路。

任务：

1. 创建 Vite React TS 工程。
2. 安装 Tailwind + shadcn/ui。
3. 配置基础主题变量，复用现有品牌色。
4. 建 `AppShell`，实现空布局：标题栏、左侧面板、地图区域占位。
5. 建 `lib/tauri.ts`，验证能调用一个只读命令，如版本号或设置读取。
6. `npm run build` 通过。

验收：

- `frontend` 可独立 `npm run dev`。
- `npm run build` 输出 `frontend/dist`。
- 不影响当前 Tauri 静态版。

### 第 2 阶段：Tauri 双入口切换

目标：让开发者可以在旧版 `static` 和新版 `frontend` 之间切换。

建议做法：

- 先创建 `src-tauri/tauri.react.conf.json` 或记录切换命令，不直接覆盖主配置。
- 新版能启动后再改主 `tauri.conf.json`。

验收：

- 旧版仍能运行。
- 新版 React 能在 Tauri WebView2 中加载。
- `window.__TAURI__` / `@tauri-apps/api` 调用正常。

### 第 3 阶段：迁移基础 UI 与设置

优先迁移低耦合模块：

1. 标题栏控制。
2. Tab / mode 切换。
3. 设置面板。
4. 图源管理。
5. 自动更新对话框。

验收：

- 设置可读取/保存。
- 图源下拉和自定义源管理可用。
- 更新检查可用。
- 不迁移地图和下载主链路。

### 第 4 阶段：迁移二维地图与选择区域

任务：

1. React 封装 Leaflet 初始化与销毁。
2. 迁移绘制控件。
3. 迁移行政区划/地名搜索。
4. 迁移 bbox/polygon 状态。
5. 迁移 GCJ-02 警告。

风险：Leaflet 插件是命令式 API，React 生命周期处理不好会出现重复绑定、地图空白、draw layer 泄漏。

验收：

- 绘制矩形/多边形可用。
- bbox 与 polygon 数据与旧版一致。
- 切换图源后图层刷新正常。

### 第 5 阶段：迁移下载主链路

任务：

1. 迁移下载表单。
2. 迁移估算。
3. 迁移多 zoom 输入与输出命名提示。
4. 迁移任务进度。
5. 迁移历史记录与断点续传。
6. 迁移 DEM 模式。

验收：

- 单 zoom 与多 zoom 都可下载。
- 影像 / DEM 路径正常。
- 取消任务、历史、断点续传正常。

### 第 6 阶段：迁移 Wayback

任务：

1. release 列表与时间范围。
2. scanMode fast/fine。
3. 扫描结果服务级聚合列表。
4. 时间轴组件。
5. 增量下载。

验收：

- fast/fine 不串缓存。
- 服务级聚合显示字段完整。
- 下载 manifest 与输出目录可回溯。

### 第 7 阶段：迁移 3D Tiles / Cesium

任务：

1. 配置 Vite Cesium 静态资源。
2. React 封装 `CesiumViewer`。
3. 迁移 3D Tiles 下载面板。
4. 迁移本地预览服务调用。
5. 迁移模型调控与绘图工具。

风险：Cesium 在 Vite/Tauri 中的资源路径与 worker 加载最容易出问题，此阶段应单独做，不和其他迁移混合。

验收：

- 在线 3D Tiles 加载正常。
- 本地 HTTP 预览正常，不回退 Tauri asset protocol。
- 模型调控、绘图、bbox 可视化正常。

### 第 8 阶段：删除旧静态前端

条件：

- React 版覆盖旧版所有核心功能。
- Windows Tauri dev/build 均通过。
- 至少完成：影像下载、DEM、Wayback、3D Tiles、设置、历史、断点续传的回归清单。

动作：

- 删除或归档 `static/js/app.js`。
- 将 `src-tauri/tauri.conf.json` 正式指向 `../frontend/dist`。
- 更新 README 和工作日志。

## 回归清单

每阶段至少验证：

1. 应用能启动，无白屏。
2. DevTools console 无初始化错误。
3. Tauri command invoke 正常。
4. 设置读取/保存正常。
5. 地图能加载默认图源。
6. 绘制 bbox 后估算正确。
7. 单 zoom 下载正常。
8. 多 zoom 下载正常。
9. DEM 下载正常。
10. Wayback fast/fine 扫描正常。
11. 3D Tiles 预览不受 asset protocol Windows 路径编码影响。
12. 更新检查能识别 prerelease。

## 风险与规避

### 风险 1：大爆炸重写导致长期不可用

规避：旧 `static/` 保留，React 新工程并行建设；每个阶段一个 commit。

### 风险 2：Tauri API 迁移引入行为差异

规避：先封装 `lib/tauri.ts`，UI 不直接调用 `invoke`。

### 风险 3：Leaflet/Cesium 生命周期重复绑定

规避：地图/3D viewer 用单独组件封装，`useEffect` 中明确 cleanup。

### 风险 4：shadcn 样式覆盖现有地图控件

规避：地图容器、Leaflet/Cesium 样式隔离；Tailwind base reset 对 Leaflet 控件做专项检查。

### 风险 5：Windows WebView2 下语法错误导致白屏

规避：每次改动跑 TypeScript、Vite build，必要时 Tauri dev 实测。

### 风险 6：中文编码问题再次污染 GitHub/commit 信息

规避：中文提交信息、issue 评论、release notes 一律使用 UTF-8 文件传参，不用 PowerShell here-string 管道。

## 建议 commit 切分

1. `chore(frontend): scaffold react vite app`
2. `feat(frontend): add app shell and tauri api bridge`
3. `feat(frontend): migrate settings and source manager`
4. `feat(frontend): migrate leaflet map selection`
5. `feat(frontend): migrate download workflow`
6. `feat(frontend): migrate wayback workflow`
7. `feat(frontend): migrate 3d tiles viewer`
8. `chore(frontend): switch tauri frontendDist to react build`
9. `chore(frontend): remove legacy static app`

## 推荐下一步

先做第 1 阶段：搭建 `frontend/` 空壳，不动现有 `static/`。

完成标准：

- `frontend/package.json` 存在
- Vite + React + TypeScript 能 build
- Tailwind + shadcn/ui 初始化完成
- `AppShell` 展示基本布局
- 有一个 Tauri API bridge 文件
- 不修改主 `tauri.conf.json` 的 `frontendDist`

这样即使中途发现 shadcn/Cesium/Vite 配置坑，也不会影响当前可用版本。
