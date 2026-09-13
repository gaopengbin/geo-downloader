# GeoD CLI：包管理器安装

当前二进制版本为 **0.1.1，Windows x64 公开预览版**。npm 包内置同一份经过校验的原生程序；安装不需要 Rust、GeoD 桌面端或 GDAL，也不会运行安装脚本来额外下载 GitHub 文件。

## npm 安装

需要 Windows x64 和 Node.js 18+（包含 npm）。可以直接安装 GitHub Release 中的 npm 包：

```powershell
npm install -g "https://github.com/gaopengbin/geo-downloader/releases/download/geod-cli-v0.1.1/geod-cli-0.1.1.tgz"
if ($LASTEXITCODE -ne 0) { throw 'GeoD CLI 安装失败' }
geod --version
geod --help
```

npm 会在自己的全局命令目录创建 `geod`。如果当前终端找不到命令，请重新打开终端，并检查 `npm prefix -g` 对应的目录是否在用户 PATH 中。此方式不创建独立安装器的 Windows 卸载记录。

这条 URL 安装命令不要求登录 npm 账户。短包名 `npm install -g geod-cli` 的可用状态以 npm 注册表上架结果和 Release 说明为准。

卸载：

```powershell
npm uninstall -g geod-cli
```

## 第一次获取数据

从 npm 安装目录读取内置的河南边界示例：

```powershell
$npmRoot = (npm root -g).Trim()
$request = Join-Path $npmRoot 'geod-cli\examples\geod-cli\henan-boundary.json'
$out = Join-Path (Get-Location) ('henan-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

geod plan --request $request
if ($LASTEXITCODE -ne 0) { throw '请求校验失败' }
geod fetch --request $request --out $out
if ($LASTEXITCODE -ne 0) { throw '数据获取失败' }
geod inspect --bundle $out
if ($LASTEXITCODE -ne 0) { throw '成果校验失败' }
```

示例访问 DataV 公开边界源，返回 GeoJSON 和 `manifest.json`，不调用付费 AI。`plan` 成功仅表示请求通过校验；`fetch` 仍需上游服务可用。数据来源与使用限制见 [CLI 使用文档](geod-cli.md)。

## WinGet

包标识为 `GeoD.CLI`，独立于 GeoD 桌面版。清单位于 [distribution/winget](../distribution/winget/)。收录前不能把 `winget install --id GeoD.CLI --exact` 视为已可用；微软社区源审核合并并同步索引后才能使用。

## 安装内容与校验

npm 包包含原生 `geod.exe`、命令启动器、使用说明、示例、许可证及构建来源信息。没有地图数据、模型、后台服务、安装期脚本或运行依赖包。

原生二进制 SHA-256：`c0001175440b44d888e51fb02735f0b7aefe6577c0d9e7d7b93df3f75780263c`。发布包的校验文件见 [GeoD CLI Release](https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.1.1)。
