## v3.4.1 — 修复 3D Tiles 模块 CesiumJS 加载失败

### 修复

- **3D Tiles 模块「CesiumJS 加载失败，请检查网络连接」**：v3.4.0 安装版的 CSP `script-src` 配置遗漏 `https:`，导致 WebView2 拒绝从 jsdelivr CDN 加载 `Cesium.js`，3D 标签页无法初始化。本版本在 `script-src` 加入 `https:`，与其他指令保持一致。

### 升级建议

- v3.4.0 用户请直接升级 v3.4.1，3D Tiles 模块（包含 Cesium Ion 自动预览、表面拾取、本地预览等所有 v3.4.0 GA 新特性）才能正常使用。
- 其他模块（GeoTIFF / DEM / Wayback / 矢量）不受影响。

**Full Changelog**: https://github.com/gaopengbin/geo-downloader/compare/v3.4.0...v3.4.1
