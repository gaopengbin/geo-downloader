# GeoD 官网

GeoD（GeoDownloader）的正式产品官网，基于 Next.js 14 构建并导出为纯静态站点。

- 官网：<https://geodownloader.pages.dev>
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

Cloudflare Pages 推荐配置：

- 构建命令：`yarn build`
- 输出目录：`out`
- Node.js：20 LTS

## 品牌约定

面对用户统一使用 **GeoD**。`GeoDownloader` 仅保留在仓库名、安装包名和兼容性标识等技术场景中。品牌基准色为蓝色。
