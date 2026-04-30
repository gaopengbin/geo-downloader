# <img src="https://img.shields.io/badge/GeoD-ownloader-blue?style=for-the-badge&labelColor=2563eb&color=475569" alt="GeoDownloader" height="36">

一个基于 Tauri + Rust 的高性能地理空间数据下载与导出桌面工具。支持 2D 地图瓦片、3D Tiles 裁剪下载、Esri Wayback 历史影像，导出 GeoTIFF。

**🌐 [官网 geodownloader.pages.dev](https://geodownloader.pages.dev)**

> **⚠️ 免责声明**：本工具仅是基于开源协议发布的桌面客户端，不内置任何地图数据。所有数据来源于使用者自行配置的第三方服务（Esri / Google / Bing / 天地图 / 高德 / OSM 等）。**使用者须自行获取目标数据源的合法授权**，并遵守其使用条款、Referer / 配额限制以及当地法律法规（包括但不限于《测绘法》《数据安全法》）。下载所得数据的版权归原数据方所有，本项目作者及贡献者不对使用者的下载行为承担任何法律责任。下载、安装或使用本工具即视为已阅读并同意完整的[**使用条款与免责声明**](https://geodownloader.pages.dev/disclaimer.html)。

欢迎沟通交流
<img width="228" height="320" alt="e92a6914f9624900cff90e6438ebb8f8" src="https://github.com/user-attachments/assets/c485726e-14ee-4717-9d5b-cb693a019964" />

![Rust](https://img.shields.io/badge/rust-1.77+-orange.svg)
![Tauri](https://img.shields.io/badge/tauri-2.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![GitHub Release](https://img.shields.io/github/v/release/gaopengbin/geo-downloader)
![Downloads](https://img.shields.io/github/downloads/gaopengbin/geo-downloader/total?color=brightgreen&label=downloads)
![Latest Downloads](https://img.shields.io/github/downloads/gaopengbin/geo-downloader/latest/total?label=latest%20downloads)

## 🎉 v3.2.x — 压缩与稳定性

### 新增
- **TIFF 压缩三选一**：无压缩（最快导出）/ LZW（通用兼容）/ Deflate（推荐，速度快压缩率高）
- **BigTIFF 流式写入器**加入 LZW + Deflate 压缩支持，超大范围导出也能压缩
- **任务日志系统**：每个任务独立日志文件，实时记录全流程
- **断点续传增强**：崩溃后重启可恢复中断的任务
- **缩放级别智能约束**：不同图源按已知最大级别约束滑块

### 修复
- BigTIFF IFD 字段内联存储修复（QGIS 读取兼容性）
- `read_log_file` 路径穿越防护
- 404 瓦片残文件清理，防止续传误判
- 前端 `confirm()` 全部替换为异步对话框

## 🎉 v3.0.0 — 大版本更新

> 产品更名：TIF地图下载工具 → **GeoDownloader**，覆盖 2D 瓦片 + 3D Tiles 全场景。

### 📦 新增功能
- **3D Tiles 下载**：支持 Cesium Ion / Google 3D Tiles / 自定义 URL，空间过滤裁剪
- **3D Tiles 本地预览**：下载完即可离线浏览三维模型
- **CesiumJS 3D 视图**：在线预览 3D Tiles 数据集，框选下载区域

### 🔧 改进
- 修复 Google 3D Tiles session 参数传播问题
- 子 tileset URI 自动重写为本地相对路径
- 自动更新支持新安装包名

## ✨ 功能特性

### 🗳️ 地图下载
- **多图源支持**：OSM、ArcGIS 卫星/地形/街道、天地图、Carto、Google Maps、高德地图/卫星、OpenTopoMap 等
- **自定义图源**：支持添加任意 `{z}/{x}/{y}` 格式的瓦片图源
- **多任务并行下载**：支持同时创建多个下载任务，实时进度显示
- **多格式导出**：GeoTIFF（带地理坐标 + 可选 LZW/Deflate 压缩）、PNG、JPEG
- **按边界裁剪**：支持按多边形边界裁剪，透明背景
- **可调并发**：支持 10-100 并发下载，快速高效
- **下载历史**：自动记录每次下载，支持快速打开文件夹

### 📍 区域选择
- **地名搜索**：输入地名快速定位
- **行政区划**：中国省/市/区县三级联动选择
- **自定义边界**：
  - 上传 GeoJSON (.json/.geojson)
  - 上传 Shapefile (.shp + .shx + .dbf)
  - 地图上手动绘制矩形或多边形

### 📦 矢量数据（高级功能）
- OSM 数据下载（道路、建筑、水系等）
- 行政区划边界下载
- 本地矢量文件加载预览

### 🏙️ 3D Tiles
- **多源支持**：Cesium Ion 资产、Google 3D Tiles（全球倾斜摄影）、自定义 URL
- **空间裁剪**：在 3D 地图上框选区域，只下载选区内的瓦片
- **递归下载**：自动递归解析子 tileset，完整下载多层级 LOD
- **离线预览**：下载后 URI 自动本地化，支持离线 3D 浏览

## 🚀 快速开始

### 环境要求
- [Rust](https://www.rust-lang.org/tools/install) 1.70+
- [Node.js](https://nodejs.org/) (可选，仅开发时需要)

### 开发运行

```bash
cd src-tauri
cargo tauri dev
```

### 构建发布

```bash
cd src-tauri
cargo tauri build
```

构建完成后，安装包位于 `src-tauri/target/release/bundle/` 目录。

## 🏗️ 项目结构

```
geo-downloader/
├── src-tauri/          # Rust 后端 (Tauri)
│   ├── src/
│   │   ├── lib.rs        # 应用入口
│   │   ├── commands.rs   # Tauri 命令
│   │   ├── config.rs     # 配置和内置图源
│   │   ├── tile.rs       # 瓦片坐标计算
│   │   ├── downloader.rs # 异步并发下载器
│   │   ├── merger.rs     # 瓦片拼接与裁剪
│   │   ├── exporter.rs   # 图像导出 (GeoTIFF/PNG/JPEG)
│   │   ├── admin.rs      # 行政区划数据
│   │   ├── task.rs       # 多任务管理
│   │   ├── history.rs    # 下载历史记录
│   │   ├── settings.rs   # 用户设置持久化
│   │   └── tiles3d/      # 3D Tiles 下载模块
│   │       ├── mod.rs
│   │       ├── tileset.rs  # tileset.json 解析
│   │       ├── filter.rs   # 空间过滤 (OBB/ECEF)
│   │       └── fetcher.rs  # 递归下载 + 管线化
│   └── Cargo.toml
├── static/             # 前端静态文件
│   ├── index.html
│   ├── css/style.css
│   ├── lib/            # 本地 Leaflet 库
│   └── js/
│       ├── api.js      # Tauri API 适配层
│       └── app.js      # 前端主逻辑
└── docs/               # 文档
```

## ⚙️ 配置说明

### 天地图 Token
内置了默认 Token，建议在「高级选项」中配置您自己的 Token 以获得更好的服务。

### 代理设置
访问 Google 等国外图源时，请在「高级选项」中启用代理并配置正确的代理地址。

## 📝 注意事项

- 下载的地图数据版权归原图商所有，请遵守相关使用条款
- 大范围高缩放级别下载可能需要较长时间，请耐心等待
- 建议根据网络状况调整并发数（网络不稳定时降低并发数）

## 📄 许可证

MIT License

## ☕ 赞助

如果这个项目对你有帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="./static/images/wx.jpg" alt="微信赞赏" width="250">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="./static/images/zfb.jpg" alt="支付宝赞赏" width="250">
</p>
<p align="center">
  <sub>微信</sub>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <sub>支付宝</sub>
</p>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=gaopengbin/geo-downloader&type=Date)](https://star-history.com/#gaopengbin/geo-downloader&Date)
