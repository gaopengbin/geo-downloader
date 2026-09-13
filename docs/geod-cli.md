# GeoD CLI：获取数据并交给 GeoStyle 制图

GeoD CLI 0.1.1 是 Windows x64 独立命令行工具，提供“参数请求 → 数据包 → 可选 GeoStyle 导入与渲染”链路。AI 可以运行命令、解析 JSON，再把 GeoTIFF、GeoJSON 交给后续程序处理。

数据获取不需要安装 GeoD 桌面端、Rust、Node.js 或 GDAL。浏览器排版成图另需兼容的 GeoStyle 服务、Node.js 22+ 和 Chrome/Edge，安装包不包含该服务。

## 安装与首次运行

从 [GeoD CLI 0.1.1 Releases](https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.1.1) 下载：

- `geod-cli-0.1.1-windows-x64-setup.exe`：当前用户安装程序；安装后新开终端即可运行 `geod`。
- `geod-cli-0.1.1-windows-x64.zip`：便携版；解压后直接运行 `geod.exe`，不修改 PATH。
- `SHA256SUMS.txt`：下载文件的 SHA-256 校验值。

安装程序默认目录为 `%LOCALAPPDATA%\Programs\GeoD CLI`。可从 Windows“已安装的应用”卸载。安装后需新开终端，已有终端不会自动取得更新后的 PATH。自定义目录或便携版可使用 `geod.exe` 的绝对路径。

```powershell
geod --version
geod --help
$example = Join-Path $env:LOCALAPPDATA 'Programs\GeoD CLI\examples\geod-cli\henan-boundary.json'
$out = Join-Path (Get-Location) ('henan-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
geod plan --request $example
if ($LASTEXITCODE -ne 0) { throw '请求校验失败' }
geod fetch --request $example --out $out
if ($LASTEXITCODE -ne 0) { throw '获取失败，请查看返回的 error' }
geod inspect --bundle $out
```

上述示例只获取 DataV 河南行政区边界，输出 `data.geojson` 和 `manifest.json`，不需要模型或付费 AI。自定义安装目录或便携版请调整 `$example`。下载需要网络，`plan` 成功不代表上游可用。

这是首个公开预览版，本次仅发布 Windows x64；Linux/macOS 预编译包、npm、crates.io 和 MCP 安装包不属于本次发布。CLI 同步执行，没有后台服务、中断续传或自动更新。软件不附带地图数据，也不授予第三方数据的转售权。

## 跑通河南概览

[henan-overview.json](../examples/geod-cli/henan-overview.json) 使用两个真实来源：

- NASA GIBS 的 `BlueMarble_ShadedRelief_Bathymetry`，用于全省自然地理背景。它是 Blue Marble 概览影像，**不是实时影像，也不是高清景区卫星图**。
- Alibaba Cloud DataV 的河南行政区 GeoJSON。本次真实获取结果包含 **18 个地市边界要素**。

[henan-overview.openstyle.json](../examples/geod-cli/henan-overview.openstyle.json) 为边界设置颜色和地市名称标注。这个例子验证文旅地图的底图获取与交接，**不包含已获取并核验的旅游 POI、景区等级、景点介绍或推荐路线**。

### 1. 构建 geod.exe

使用安装程序或便携版可跳过本节。以下是源码构建方法；必须使用发布标签的完整仓库，内核暂时通过源码路径共享 `src-tauri/src` 中的非 Tauri 模块，不能只复制 `crates` 目录。

需要 Rust 工具链和该机器可用的 Rust Windows 编译环境。在 GeoD 仓库根目录执行：

```powershell
# 在完整源码仓库根目录运行
cargo build -p geod-cli --release --locked
if ($LASTEXITCODE -ne 0) { throw 'GeoD build failed' }

$geod = (Resolve-Path '.\target\release\geod.exe').Path
& $geod --version
& $geod --help
```

此构建使用独立 Rust workspace，不启动 Tauri 桌面窗口。默认输出为 `target\release\geod.exe`；如自行设置了 `CARGO_TARGET_DIR`，请相应调整路径。

### 2. 启动本地 GeoStyle

仅需下载数据时，可跳过服务启动、导入和浏览器渲染步骤。若已有兼容的 GeoStyle checkout，在它的目录中另开终端启动。该服务所需的 Node.js、pnpm 和 OpenStyle 依赖按对应项目说明配置。

```powershell
# 在兼容的 GeoStyle 服务目录运行
pnpm install
pnpm dev --hostname 127.0.0.1 --port 3100
```

保持服务终端运行。下文以 `3100` 为例，若选其他端口，需同步替换后续地址。公开 CLI 在线体验页不是私人数据导入服务。

### 3. 估算、下载、校验、导入

每次下载必须选择不存在的输出目录，下面用时间戳避免覆盖已有成果：

```powershell
# 在便携包或源码目录中运行；安装版可将 $geod 设为 'geod'
$geod = (Resolve-Path '.\geod.exe').Path
$bundle = Join-Path (Get-Location) ('henan-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

& $geod plan --request .\examples\geod-cli\henan-overview.json
if ($LASTEXITCODE -ne 0) { throw 'GeoD plan failed' }

$fetchJson = & $geod fetch --request .\examples\geod-cli\henan-overview.json --out $bundle
if ($LASTEXITCODE -ne 0) { throw $fetchJson }
$download = $fetchJson | ConvertFrom-Json
$download.manifest.quality

& $geod inspect --bundle $bundle
if ($LASTEXITCODE -ne 0) { throw 'GeoD bundle verification failed' }

$importJson = & $geod geostyle-import --bundle $bundle --url http://127.0.0.1:3100 --style .\examples\geod-cli\henan-overview.openstyle.json
if ($LASTEXITCODE -ne 0) { throw $importJson }
$imported = $importJson | ConvertFrom-Json
$imported.geostyle
```

`$imported.geostyle.createUrl` 是编辑入口，`renderUrl` 是固定尺寸渲染页，`manifestUrl` 是数据与样式查询接口。导入和固定渲染不需要 LLM；在编辑器内继续让 Agent 调整样式时，使用 GeoStyle 原有的模型配置和创建入口规则。

### 4. 导出两种引擎的地图图片

需要 **Node.js 22 或更新版本**和 Chrome/Chromium。脚本也会寻找常见 Windows Edge 路径。它用独立临时浏览器配置启动无头浏览器，等待真实渲染完成标记，然后保存完整指定尺寸的 PNG。

```powershell
$openlayersUrl = $imported.geostyle.renderUrl + '?renderer=openlayers'
$maplibreUrl = $imported.geostyle.renderUrl + '?renderer=maplibre'

node .\scripts\geod-render.mjs --url $openlayersUrl --out (Join-Path $bundle 'henan-openlayers.png') --width 1600 --height 1000
if ($LASTEXITCODE -ne 0) { throw 'OpenLayers rendering failed' }

node .\scripts\geod-render.mjs --url $maplibreUrl --out (Join-Path $bundle 'henan-maplibre.png') --width 1600 --height 1000
if ($LASTEXITCODE -ne 0) { throw 'MapLibre rendering failed' }
```

浏览器不在默认位置时添加 `--chrome "C:\path\to\chrome.exe"`，或设置 `CHROME_PATH` 环境变量。宽高均支持 `256..4096`，默认 `1600 × 1000`。输出图片及附属文件不能已经存在。

一次成功渲染输出：

```text
henan-openlayers.png
henan-openlayers.png.render.json
henan-openlayers.png.openstyle.json
```

第一项是实际地图截图，第二项包含数据包、引擎、视域、时间和图像诊断，第三项是实际使用的 OpenStyle。截图包含来源署名；数据为 `partial` 时也显示部分数据标记。`ready` 表示渲染完成，不能代替 AI 检查来源完整性、标注和视觉结果。

## 四个命令的机器接口

| 命令 | 行为 | 主要返回内容 |
| --- | --- | --- |
| `plan --request job.json` | 校验参数与资源上限，估算影像矩阵 | `ok`、请求范围、瓦片数、像素数、预计 RGB 字节数、实际足迹、矢量模式 |
| `fetch --request job.json --out NEW_DIR` | 同步获取、规范、导出和发布 | `ok`、`bundleDir`、`manifestPath`、`manifest` |
| `inspect --bundle DIR_OR_MANIFEST` | 检查清单、文件、路径范围、大小和 SHA-256 | `ok`、`manifest` |
| `geostyle-import --bundle DIR_OR_MANIFEST --url BASE_URL` | 校验本地成果，上传数据和可选样式 | `ok`、`geostyle` 摘要 |

`geostyle` 摘要包含 `id`、`createPath/renderPath/manifestPath`、对应的绝对 `createUrl/renderUrl/manifestUrl`，以及 `quality`、`layers`。完整数据和样式可按返回接口读取，避免重复塞入 AI 上下文。

除 `--help`、`--version` 外，**stdout 输出一个 JSON 结果对象，stderr 输出 JSON 行进度**。`--json` 可用但不是必需。不要将两个通道合并后再解析 JSON。

失败返回 `{"ok":false,"error":{"code":"...","message":"..."}}`，退出码为 `1`；Ctrl+C 取消为 `130`。`plan` 不下载文件、不读取完整本地 GeoJSON、不验证网络可达性，也不预测 Overpass 实际要素数。

## 请求文件与矢量通道

请求为严格 JSON，未知字段、格式和非法范围都会报错。`schemaVersion` 固定为 `"1.0"`，`imagery` 和 `vector` 至少提供一项。

```json
{
  "schemaVersion": "1.0",
  "name": "河南边界",
  "bounds": [110.3, 31.3, 116.7, 36.5],
  "vector": {
    "url": "https://geo.datav.aliyun.com/areas_v3/bound/410000_full.json",
    "source": "https://geo.datav.aliyun.com/areas_v3/bound/410000_full.json",
    "attribution": "Alibaba Cloud DataV administrative boundaries",
    "layers": ["boundary"]
  },
  "limits": { "timeoutSeconds": 180 }
}
```

`bounds` 是 WGS84 的 **西、南、东、北**，要求西小于东、南小于北，纬度处于 Web Mercator 有效范围。跨反经线区域需拆分。`vector.input` 相对路径以**请求 JSON 所在目录**为基准；`--out`、`--style` 等命令行相对路径以终端当前目录为基准。

三种矢量通道互斥：

| 通道 | `vector` 配置 | 用途 |
| --- | --- | --- |
| 本地文件 | `input`，可附 `source/attribution/layers` | 准备好的省域或主题 GeoJSON |
| GeoJSON URL | `url`，可附 `source/attribution/layers` | 直接下载 HTTP(S) GeoJSON |
| Overpass | `layers`，可选 `endpoint`；不设置 `input/url` | 小区域 OSM 分类获取 |

本地输入配置示例：

```json
{
  "schemaVersion": "1.0",
  "name": "河南主题数据",
  "bounds": [110.3, 31.3, 116.7, 36.5],
  "vector": {
    "input": "./henan.geojson",
    "source": "用户核验后的河南主题数据",
    "attribution": "请填写数据实际要求的署名"
  }
}
```

支持 Feature/FeatureCollection 和 Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon 六类几何。要求有限 WGS84 经度/纬度；投影坐标、旧 `crs` 声明、空几何、未闭合多边形、GeometryCollection 会拒绝。CLI 可以产出带警告的无要素查询结果；GeoStyle 拒绝纯空矢量包，空矢量加有效影像预览可以导入。

原属性保留，增加或规范 `layer/name/class`；被覆盖的源值保留在 `geod:originalProperties` 等属性中。明确自定义图层可以保留；未知语义不会因为“线几何”就被猜成道路。可在源数据写明 `properties.layer`，或指定唯一请求类别帮助归类。

`layers` 参数允许 `boundary`、`roads`、`railways`、`water`、`landuse`、`places`、`pois`、`tourism`。输出常用层 ID 为 `boundary`、`transportation`、`waterway`、`water`、`landuse`、`place`、`poi`。**样式绑定使用清单里的实际层 ID，而不是照抄请求类别。**

Overpass 默认地址是 `https://overpass-api.de/api/interpreter`，使用白名单 `out geom` 查询，不接受任意查询字符串。旅游类别包含 tourism、historic 及适用文化场所 amenity；不会补写来源没有的等级、介绍和营业信息。程序去重 OSM 类型/ID，可组装常见多边形关系和洞；不可靠、歧义或超出有界拓扑验证规模的关系会明确跳过并标记 `partial`。

[luoyang-tourism.json](../examples/geod-cli/luoyang-tourism.json) 是小区域请求示例：

```powershell
& $geod plan --request .\examples\geod-cli\luoyang-tourism.json
& $geod fetch --request .\examples\geod-cli\luoyang-tourism.json --out .\output\luoyang-tourism-new
```

**2026-09-07 的两次真实 Overpass 请求均返回 HTTP 504，在线 POI 获取未通过验收。** 本地 HTTP 测试验证了请求和转换，不能证明公共服务当前可用。省域地图应先用准备好的 GeoJSON；在线 Overpass 单次估算面积不得超过 `400 km²`。

矢量文件/响应上限 `64 MiB`，要素上限 `100,000`。当前按要素包围盒或 Overpass 区域选择，保留完整几何，**没有完成河南行政区精确多边形裁剪**；越界会给出警告。

## 影像参数与预算

输入是含 `{z}`、`{x}`、`{y}` 的 HTTP(S) XYZ 模板，每块要求解码为 `256 × 256`，并填写实际 `source/attribution`。应使用允许下载的图源；内核拒绝 OSM 标准交互瓦片服务的批量下载。

| 参数 | 默认值 | 当前范围/含义 |
| --- | --- | --- |
| `imagery.zoom` | 必填 | `0..22`，还受具体图源能力限制 |
| `imagery.format` | `geotiff` | `png/jpeg/geotiff` |
| `imagery.concurrency` | `4` | `1..32` |
| `imagery.allowMissing` | `false` | 缺块默认失败；允许后标为 `partial`，空洞为白色 |
| `imagery.clipToLayer` | 不裁剪 | 引用本次矢量数据中的面图层 ID，例如 `boundary`；按面并集设透明掩膜 |
| `limits.maxTiles` | `256` | `1..4096` |
| `limits.maxPixels` | `16777216` | `1..67108864` |
| `limits.timeoutSeconds` | `180` | `1..1800`，获取和导出整个任务的期限 |

下载后再次检查解码尺寸和图像有效性。`estimatedRgbBytes` 仅代表 RGB 数据量，不是进程峰值内存。第一版为有界拼接，不能通过提高上限承诺无限大省域高清下载。

### 沿行政边界裁剪（0.1.1）

在 `imagery` 中加入 `"clipToLayer": "boundary"`，并在同一请求中取得对应面图层。已有的 [四川请求](../examples/geod-cli/sichuan-overview.json) 已开启此参数。

```powershell
& $geod fetch --request .\examples\geod-cli\sichuan-overview.json --out .\output\sichuan-clipped-new
```

裁剪采用所有匹配 Polygon/MultiPolygon 的并集，保留多边形洞和不相连区域，重叠部分保留。以 Web Mercator 栅格的像素中心判断覆盖，省界外像素 RGBA 均为零。PNG 预览和 PNG/GeoTIFF 原图均保留透明度；GeoTIFF 写入地理标签及明确的 alpha 标记。JPEG 不支持透明裁剪，会提前报错；无对应面或没有像素覆盖也会报错，不会默默输出未裁剪图。

这是一种地理边界掩膜：文件仍有矩形行列与原始空间范围，边界外透明，不改变像元大小和定位。矢量几何本身保持原样；GeoStyle 按样式底色显示透明区，因此最终带署名的地图截图不等同于透明 PNG 原图。`plan.imagery.clip` 返回裁剪意图，完成清单的 `quality.warnings` 记录裁剪图层和矢量未改动的说明。

## 成果契约与发布方式

同时请求矢量和 GeoTIFF 时，目录包含：

```text
manifest.json
data.geojson
imagery.tif
imagery-preview.png
```

PNG/JPEG 原始影像分别为 `imagery.png`、`imagery.jpg`。预览统一为 PNG，最长边不超过 2048 像素；原始影像保留完整拼接尺寸。

- `manifest.bounds`：请求范围，GeoStyle 据此确定视域。
- `assets[]`：相对路径、角色、MIME、字节数、SHA-256、CRS、实际足迹及尺寸/要素数。
- `layers[]`：实际层 ID、`point/line/polygon/mixed`、数量和字段集合。
- `quality`：`complete/partial`、缺块和警告。`complete` 不表示来源已包含所有景点或内容经过人工核验。
- `provenance[]`：来源、署名、获取时间。时间不是卫星拍摄时间；HTTP 来源记录移除 URL 查询和用户凭据。

所有 `bounds` 都用 WGS84 经纬度表达，`assets[].crs` 才是文件内部坐标/像素网格。GeoJSON 为 EPSG:4326，XYZ 影像和预览网格为 EPSG:3857。GeoTIFF 包含地理标签；PNG/JPEG 通过清单交接定位。影像按瓦片边界拼接，实际范围通常大于请求范围；定位必须使用实际足迹，不能把整张图压缩到请求范围。

CLI 先在临时目录获取和导出，再以不覆盖方式创建目标目录，逐个移动资产，**最后发布 manifest.json 作为完成标记**。这不是整个文件夹的一次原子重命名。中断或磁盘错误可能留下没有清单的未完成目录；下游不能只凭目录存在就使用。正常完成后运行 `inspect` 校验文件；CLI 不覆盖已有输出目录。

GeoStyle 再次核对文件和哈希、图层、真实字段、坐标及图像解码，以不可变 ID 保存。相同清单和样式可复用 ID，不同样式产生不同 ID。JSON/base64 上传中，CLI 限资产总量 `68 MiB`；GeoStyle 限单资产 `64 MiB`、整个请求 `96 MiB`。超限需要减少数据或影像精度。

## 自定义样式和令牌

`--style` 接受 OpenStyle 0.6 JSON，使用 `selector.sourceLayers` 绑定实际图层，覆盖所有数据层。几何、分类字段、标注字段必须匹配清单和真实数据；用于标注/分类的字段需要可用的标量值。没有该参数时使用确定性基础样式。

可以取得当前样式供 AI 修改：

```powershell
curl.exe --fail --output .\henan-edit.openstyle.json ($imported.geostyle.manifestUrl + '?style=1')
```

修改文件后重新 `geostyle-import --style .\henan-edit.openstyle.json`，用新返回的 `renderUrl` 渲染。便携样式不接受外部图标、生成资源 URL 或需额外资源的渲染扩展；需要能在当前两种引擎中编译。

兼容服务的开发模式没有配置令牌时允许本地导入；设置 `GEOSTYLE_GEOD_IMPORT_TOKEN` 后必须提供正确令牌。只向你有权使用的服务发送数据，不要将令牌值写进请求文件或命令行参数。

在服务器和调用端环境中注入相同令牌后，只向 CLI 传环境变量名：

```powershell
$importJson = & $geod geostyle-import --bundle $bundle --url http://127.0.0.1:3100 --token-env GEOSTYLE_GEOD_IMPORT_TOKEN --style .\examples\geod-cli\henan-overview.openstyle.json
if ($LASTEXITCODE -ne 0) { throw $importJson }
$imported = $importJson | ConvertFrom-Json
```

服务端可用 `GEOSTYLE_GEOD_STORE_DIR` 指定存储目录，默认 `.data/geod-bundles`。目前知道包 ID 即可读取对应元数据、资产和渲染页，尚无每用户私有数据权限，应按本地或可信主机工作流使用。

## 验证与后续范围

此前本地验证跑通过河南边界与 NASA 影像的获取、校验、GeoStyle 导入及两种浏览器引擎渲染。发布安装测试与最新验证结果以本次 Release 记录为准。自动测试覆盖矢量转换、坏图/缺块、裁剪透明度、哈希和目录保护。

浏览器渲染依赖额外服务和样式，地市标注仍可能因引擎碰撞避让出现差异；当前 CLI 输出主要用于地理数据交接，不等同于自动完成专题图排版。

目前没有自动地名解析、AI 意图判定、任意省域完整细节采集、矢量与行政区的精确几何求交、DEM、3D Tiles 或中断续传。完整文旅成图仍需另行获取并核验主题数据。
