# v3.4.2 — 二维码远程加载修复

## 修复

- **二维码（公众号 / 群 / 微信 / 支付宝）始终显示打包旧图**
  - 根因：`useCachedImage` 用 `fetch()` 拉 GitHub Releases 资源生成 dataURL 缓存，但 GitHub 资源不带 `Access-Control-Allow-Origin` 响应头，WebView2 按 CORS 规则拦截整个请求，错误被 `try/catch` 静默吞掉，永远回退到打包进 App 的本地兜底图。
  - 影响：v3.4.0 / v3.4.1 安装版用户无论 GitHub `assets` release 上传多少次新二维码都看不到。
  - 修复：`useCachedImage` 改为直接返回远程 URL，由 `<img>` 标签加载（`<img>` 不受 CORS 约束）。远程失败时调用方现有的 `onError={fallbackToLocal}` 兜底切回本地图。
  - 受影响文件：[`frontend/src/lib/use-cached-image.ts`](frontend/src/lib/use-cached-image.ts)

## 兼容性

- 与 v3.4.1 完全兼容。建议所有 v3.4.0 / v3.4.1 用户升级以获取最新二维码。

## 完整下载

见 README 下载表格或本页 Assets 区。
