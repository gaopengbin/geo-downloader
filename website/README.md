# GeoD 官网

GeoD（GeoDownloader）的正式产品官网，基于 Next.js 14 构建并导出为纯静态站点。

- 官网：<https://geod.laogao.xyz>
- CLI 在线体验：<https://geod.laogao.xyz/geod/cli>
- 仓库：<https://github.com/gaopengbin/geo-downloader>
- 最新版本：<https://github.com/gaopengbin/geo-downloader/releases/latest>

## 页面

- `/`：产品能力、真实界面与各平台下载入口
- `/history`：从 GitHub Releases 同步的正式版本列表
- `/disclaimer`：使用条款、数据授权边界与匿名统计说明

## 本地开发

```bash
yarn install --frozen-lockfile
yarn dev -p 4177
```

访问 <http://127.0.0.1:4177>。

## 构建与部署

```bash
yarn build
```

构建产物位于 `out/`，可直接替换 Cloudflare Pages 或任意静态 Web 服务器上的站点文件。构建期间会读取 GitHub Releases API 生成当前稳定版和历史版本下载链接；网络不可用时会使用内置的最新稳定版兜底数据。

腾讯云正式站由 `/srv/laogao/current/geod-website` 指向独立静态发布目录。只发布本目录构建的 `out/`，不要混入桌面应用、CLI 工作台或运行数据。官网图片、图标和二维码使用 `/geod-site/`；`/geod` 和 `/geod/` 属于在线工作台的代理路由，不能用作官网静态资源前缀。

正式发布前在本机完成构建和校验，再上传完整静态产物到新 release 目录并原子切换官网 symlink；保留原目录用于回滚。此静态发布不需要重启 Node、改 Nginx 或替换 `/geod-app/` 数据缓存，也不得在服务器下载 GitHub 资源。网页仅通过普通链接进入 CLI 在线体验。

复用本机构建目录时，需核对生成首页的稳定版本与官方 Releases 一致。`force-cache` 可能复用 `.next/cache/fetch-cache` 中的旧版本响应；发现旧数据时先保留并移出该构建缓存，再获取官方元数据重建，不能把过期兜底版本作为正式下载入口发布。

Cloudflare Pages 推荐配置：

- 构建命令：`yarn build`
- 输出目录：`out`
- Node.js：20 LTS

## 品牌约定

面对用户统一使用 **GeoD**。`GeoDownloader` 仅保留在仓库名、安装包名和兼容性标识等技术场景中。品牌基准色为蓝色。
