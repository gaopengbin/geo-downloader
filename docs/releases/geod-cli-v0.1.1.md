# GeoD CLI 0.1.1 — Windows x64 公开预览版

这是 GeoD 独立命令行工具的首个公开安装版本。AI、脚本和终端用户可以通过 JSON 参数获取边界、矢量和有范围限制的影像数据，再读取带来源、坐标和 SHA-256 的成果清单继续处理。

## 下载与安装

| 文件 | 用途 |
| --- | --- |
| `geod-cli-0.1.1-windows-x64-setup.exe` | Windows x64 当前用户安装程序 |
| `geod-cli-0.1.1-windows-x64.zip` | 无需安装的便携包 |
| `SHA256SUMS.txt` | 下载文件的 SHA-256 校验值 |

安装程序默认写入 `%LOCALAPPDATA%\Programs\GeoD CLI`，支持添加当前用户 PATH 和卸载。安装后新开终端：

```powershell
geod --version
geod --help
```

无需安装 GeoD 桌面端、Rust、Node.js 或 GDAL 即可获取数据。便携版不修改 PATH，可直接使用 `geod.exe` 的完整路径。此安装包未使用代码签名证书签名。

## 获取河南边界

```powershell
$example = Join-Path $env:LOCALAPPDATA 'Programs\GeoD CLI\examples\geod-cli\henan-boundary.json'
$out = Join-Path (Get-Location) ('henan-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
geod plan --request $example
geod fetch --request $example --out $out
geod inspect --bundle $out
```

便携版或自定义安装目录请相应调整 `$example`。每条命令都应检查退出码后再继续。示例从 DataV 获取河南行政区边界，不调用付费 AI；输出 GeoJSON 和 `manifest.json`。

## 主要能力

- `plan`：参数检查与瓦片、像素、空间范围预算。
- `fetch`：本地/HTTP GeoJSON、有界 XYZ 影像及受限 Overpass 查询，输出 PNG/JPEG/GeoTIFF 和矢量清单。
- `inspect`：核对资产、文件大小和 SHA-256。
- PNG/GeoTIFF 支持行政区面掩膜，保留透明度和洞。
- `geostyle-import` 与 `geod-render.mjs` 可选衔接兼容 GeoStyle 服务，供后续地图渲染。

stdout 为机器可读 JSON，stderr 为 JSON 行进度；失败退出码为 1，取消为 130。成果目录不覆盖，`manifest.json` 为完成标记。AI 应检查退出码、quality、来源和实际字段。

## 当前范围

本次只发布 Windows x64 安装包，不是 GeoD 桌面版更新。GitHub 标记为预发布，桌面版 latest 保持原有版本。

CLI 不包含地图数据、模型或 GeoStyle 服务；完整浏览器渲染另需兼容服务、Node.js 22+ 和 Chrome/Edge。没有自动地名解析、AI 意图分析、任意规模下载、DEM/3D Tiles、自动更新或中断续传。公网 Overpass 可能超时，其在线 POI 获取不作为本次发布的通过项。Blue Marble 示例是概览背景，不是实时高清影像。

数据获取和地图数据的使用范围取决于实际数据源授权，软件发布不授予数据转售权。网页版 CLI 在线体验仍只提供带水印预览，暂不开放成果下载。

完整参数、裁剪和 AI 调用说明见安装包中的 `docs/geod-cli.md`，或本标签对应的[使用文档](https://github.com/gaopengbin/geo-downloader/blob/geod-cli-v0.1.1/docs/geod-cli.md)。
