# GeoD CLI 0.3：选择图源并在本机下载影像

GeoD CLI 是 Windows x64 独立命令行工具。下载、拼接与导出在运行命令的电脑上完成，不依赖 GeoD 桌面端或 GeoStyle。便携 ZIP 和安装程序不需要 Node.js；npm 安装需要 Node.js 18+。软件不附带影像数据，请使用允许离线下载的图源；标准 OpenStreetMap 交互瓦片服务会被拒绝。

## 使用

```powershell
geod --version
geod plan --request .\job.json
geod fetch --request .\job.json --out .\output\job-001 --work-dir .\work\job-001
geod inspect --bundle .\output\job-001
```

`plan` 只校验参数、估算瓦片数量及范围，不访问图源。`fetch` 同步下载，且不覆盖已有输出目录。`--work-dir` 可选，会持久保存已验证的主图层和叠加图层瓦片；中断后用**同一请求**、新的 `--out` 重跑即可复用。工作目录绑定请求内容，图源或范围变更后不能复用。`inspect` 按清单复核所有资产的大小和 SHA-256。stdout 返回单个 JSON，stderr 输出 JSON 行进度。错误退出码为 1，Ctrl+C 为 130。

## 影像请求

示例使用 NASA GIBS Blue Marble **概览底图**，不代表实时或高清卫星影像。替换图源时请填写实际来源与署名。

无需手写 URL 也可以在 `imagery` 中使用内置或已注册图源的 `sourceId`，例如 `"sourceId": "nasa_gibs_blue_marble"`。命令行的 `--source ID` 会覆盖请求中的主图源；叠加图层也可使用 `sourceId`。如果任务未写图源，可先用 `geod sources default --id ID` 设置默认图源。

```json
{
  "schemaVersion": "1.0",
  "name": "区域影像",
  "bounds": [116.3, 39.8, 116.5, 40.0],
  "imagery": {
    "url": "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg",
    "source": "NASA GIBS Blue Marble Shaded Relief Bathymetry",
    "attribution": "NASA GIBS",
    "zoom": 5,
    "zoomLevels": [5, 6],
    "format": "geotiff",
    "compression": "deflate",
    "buildPyramid": true,
    "generateSidecars": true,
    "concurrency": 4
  }
}
```

`bounds` 为 WGS84 `[西, 南, 东, 北]`，不能跨反经线。模板须为 HTTP(S)，包含 `{z}`、`{x}` 和 `{y}` 或 `{-y}`；使用 `{s}` 时需给 `subdomains` 数组。每张瓦片必须解码为 256×256 像素。输出按瓦片边界对齐，实际足迹在清单 `assets[].bounds`；GeoTIFF 和瓦片包采用 EPSG:3857。

| 能力 | 字段 | 说明 |
| --- | --- | --- |
| 多级别 | `zoom`、`zoomMax`、`zoomLevels` | `zoomLevels` 优先，可选择离散级别 |
| 输出格式 | `format` | `geotiff`、`png`、`jpeg`、`mbtiles`、`gpkg`、`tiles` |
| 压缩与金字塔 | `compression`、`buildPyramid` | GeoTIFF 支持 `none/lzw/deflate`；未裁剪的 GeoTIFF 可写内置金字塔 |
| GIS 辅助文件 | `generateSidecars` | 为 GeoTIFF 生成 `.tfw`、`.prj` |
| 叠加图层 | `overlays` | 最多 4 个自定义 XYZ 源，按数组顺序 alpha 合成；可设 `maxZoom`、`subdomains` |
| 多边形裁剪 | `cropToShape` + `polygon`，或 `clipToLayer` + `vector` | 仅 PNG/GeoTIFF；范围外透明，JPEG/瓦片包不可裁剪 |
| 缺块处理 | `allowMissing` | 默认失败；显式允许后清单标记 `partial` |
| 断点复用 | `--work-dir` | 中断后保留瓦片，相同请求重跑 |

## 图源选择与注册

```powershell
geod sources list
geod sources default --id nasa_gibs_blue_marble
geod sources register --id my_tiles --name "我的授权图源" --url "https://example.com/{z}/{x}/{y}.png" --attribution "数据提供方" --max-zoom 18
geod sources probe --id my_tiles --zoom 5 --x 26 --y 12
geod plan --request .\job.json --source my_tiles
geod fetch --request .\job.json --source my_tiles --out .\output\job-001
```

`sources list` 返回客户端内置的栅格图源与本机注册的图源，并标明默认项和不可用原因。`sources register` 检查 ID、URL 模板和离线下载规则；同一 ID 修改用 `sources update`，删除用 `sources remove --id ID`。`sources analyze --url "实际瓦片请求 URL"` 可推导模板并做一次样例探测；`sources probe` 下载**一张**指定坐标的瓦片，验证响应和 256×256 图像。注册、选择和探测都不启动批量下载。

注册支持 `{z}/{x}/{y}`、`{-y}`、`{q}` QuadKey 和 `{s}` 子域。TMS 图源可加 `--scheme tms`，把模板中的 `{y}` 转换为反向 Y；子域用 `--subdomains a,b,c`。单个图源最大级别由 `--max-zoom` 限制。天地图内置图源需要在本机配置你自己的 `GEOD_TIANDITU_TOKEN`；不会使用桌面端的共享 Token。标准 OpenStreetMap 公共瓦片可出现在内置目录中，但不可用于离线批量下载。

自定义图源默认保存在当前用户的 `%APPDATA%\GeoD CLI\sources.json`；`GEOD_CLI_HOME` 可指定独立目录。这份配置不上传 GeoD 服务，也不读取 GeoD 桌面端配置。图源 URL 若含密钥会原样保存在本地配置文件中，请保护该文件，不要把它或 `sources show` 输出公开分享。使用内置图源仍须遵守提供方的授权和服务限制。

直接画范围的 `polygon` 使用桌面端相同的 `{lat,lng}` 点数组，例如：

```json
"cropToShape": true,
"polygon": [[
  {"lat": 39.86, "lng": 116.32},
  {"lat": 39.86, "lng": 116.45},
  {"lat": 39.96, "lng": 116.45},
  {"lat": 39.96, "lng": 116.32}
]]
```

每条数组是一片面，末点可不重复首点；裁剪范围必须与下载区域相交。`clipToLayer` 引用同次请求 `vector` 产生的面图层 ID，可保留 Polygon/MultiPolygon 的洞。两种裁剪方式不能同时指定。叠加图层示例：

```json
"overlays": [{
  "url": "https://example.com/labels/{z}/{x}/{y}.png",
  "source": "My licensed labels",
  "attribution": "Provider name",
  "maxZoom": 18
}]
```

自定义服务地址和密钥由用户提供。不要把含密钥的请求文件公开分享。

## 范围、成果和限制

默认单任务最多 256 张瓦片、16,777,216 像素、180 秒。在本机可通过 `limits.maxTiles/maxPixels/timeoutSeconds` 显式提高到 16,384 张、1,073,741,824 像素、43,200 秒；JPEG 和裁剪影像每级仍限 67,108,864 像素，因为它们使用完整内存画布。远程 MCP 仍有更低上限。`plan` 的估算不保证上游当前可用，也不是精确磁盘占用。

成果目录包含 `manifest.json`、`imagery-preview.png` 与影像资产：单级 `imagery.tif/png/jpg`，多级 `imagery-z{级别}.tif/png/jpg`，或 `imagery.mbtiles/gpkg`，或 `tiles/{z}/{x}/{y}.{扩展名}`。瓦片包统一存 PNG；原始瓦片目录尽量保留源格式。清单记录尺寸、坐标系、实际足迹、缺块、警告、来源署名与资产 SHA-256。`manifest.json` 是最终完成标记。

CLI 还可通过 `vector.input`、`vector.url` 或有界 Overpass 获取 GeoJSON，矢量可与影像在一个成果包内交付。Overpass 公共服务的可用性不作保证。CLI 不做地名解析、AI 意图识别、DEM/3D Tiles 或地图制图。

示例请求：[多级 GeoTIFF](../examples/geod-cli/imagery-multizoom.json)、[MBTiles](../examples/geod-cli/imagery-offline-package.json)、[画范围裁剪](../examples/geod-cli/imagery-crop.json)。
