# GeoDownloader React Frontend

这是 GeoDownloader 的新前端工程，用于逐步替换旧版 `static/` 巨石脚本前端。

当前阶段只提供 React + Vite + TypeScript + Tailwind + shadcn/ui 空壳，旧版 `static/` 仍是主 Tauri 入口。

## 技术栈

- React + TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui 风格的本地组件
- Tauri 2 JavaScript API

## 常用命令

在仓库根目录执行：

```bash
cd frontend
npm install
npm run dev
npm run build
npm run lint
```

## Tauri React 预览入口

主配置 `src-tauri/tauri.conf.json` 仍指向旧版 `../static`。

如需用 React 前端启动 Tauri，使用专用覆盖配置：

```bash
cd src-tauri
cargo tauri dev --config tauri.react.conf.json
```

该配置会：

- 启动 `../frontend` 的 Vite dev server
- 使用 `http://127.0.0.1:1420` 作为 Tauri dev URL
- 构建时输出并读取 `../frontend/dist`

## 迁移原则

1. 保留旧版 `static/`，新前端未覆盖全部核心功能前不删除。
2. 每个业务域单独迁移、单独提交，避免大爆炸重写。
3. UI 组件不直接调用 Tauri command，统一走 `src/lib/tauri.ts` 或 feature API 文件。
4. Leaflet / Cesium 组件必须在 React effect 中清理事件和实例。
5. 不在 UI 中使用 emoji，图标使用 SVG 或文字。

详细路线见：`../docs/frontend-react-vite-shadcn-refactor-plan.md`。
