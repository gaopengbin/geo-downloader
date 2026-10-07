# GeoD 官网

GeoD（GeoDownloader）的正式产品官网，基于 Next.js 14 构建并导出为纯静态站点。

- 官网：<https://geod.laogao.xyz>
- 浏览器影像：<https://geod.laogao.xyz/browser>
- 仓库：<https://github.com/gaopengbin/geo-downloader>
- 最新版本：<https://github.com/gaopengbin/geo-downloader/releases/latest>

## 页面

- `/`：产品能力、真实界面与各平台下载入口
- `/agent`：GeoD Agent 功能展示，包含五类数据工作流、七组界面截图、范围与图源、任务与缓存、Skill / MCP、成果交付及公开测试 / 本地候选状态；首页提供对应功能入口
- `/history`：从 GitHub Releases 同步的正式版本列表
- `/disclaimer`：使用条款、数据授权边界与匿名统计说明

## 本地开发

```bash
npm install
npm run dev
```

访问 <http://127.0.0.1:3401>。本地开发代理把网站页面交给 3402 端口的 Next.js，并将 `/api/account` 转发到现有账号服务；不要在本地验收中随意提交真实账号操作。

## 中英文

中文保留 `/`、`/agent` 等现有网址，英文使用 `/en`、`/en/agent` 等网址。首页、Agent、浏览器影像、CLI、MCP、版本、使用条款、工具与账号页面共用组件，英文文案在渲染时从 `src/lib/i18n/en.json` 和 `templates.json` 读取，构建输出包含完整英文 HTML。

顶栏提供 EN / 中文切换，保留当前页面、查询参数和锚点。手动选择记录在浏览器 `geod.website.language` 中；首次访问中文默认网址时按浏览器语言判断中英文，未识别的语言回退中文。直接访问英文网址始终保持英文。没有 IP 地区识别服务。

两种语言分别生成 HTML lang、标题、说明、canonical、hreflang 和 sitemap。`/api`、图片、下载地址及 `/geod` 独立工作台路径不添加语言前缀。实际产品截图仍展示开发版原有界面；用户输入、邮箱、图源名称和数据文件不翻译。

## 构建与部署

```bash
yarn build
```

构建产物位于 `out/`，可直接替换 Cloudflare Pages 或任意静态 Web 服务器上的站点文件。构建期间会读取 GitHub Releases API 生成当前稳定版和历史版本下载链接；网络不可用时会使用内置的最新稳定版兜底数据。

腾讯云正式站由 `/srv/laogao/current/geod-website` 指向独立静态发布目录。只发布本目录构建的 `out/`，不要混入桌面应用、CLI 工作台或运行数据。官网图片、图标和二维码使用 `/geod-site/`；`/geod` 和 `/geod/` 属于在线工作台的代理路由，不能用作官网静态资源前缀。

正式发布前在本机完成构建和校验，再上传完整静态产物到新 release 目录并原子切换官网 symlink；保留原目录用于回滚。此静态发布不需要重启 Node、改 Nginx 或替换 `/geod-app/` 数据缓存，也不得在服务器下载 GitHub 资源。网页通过普通链接进入浏览器影像与其他独立工作台。

复用本机构建目录时，需核对生成首页的稳定版本与官方 Releases 一致。`force-cache` 可能复用 `.next/cache/fetch-cache` 中的旧版本响应；发现旧数据时先保留并移出该构建缓存，再获取官方元数据重建，不能把过期兜底版本作为正式下载入口发布。

Cloudflare Pages 推荐配置：

- 构建命令：`yarn build`
- 输出目录：`out`
- Node.js：20 LTS

## 品牌约定

面对用户统一使用 **GeoD**。`GeoDownloader` 仅保留在仓库名、安装包名和兼容性标识等技术场景中。品牌基准色为蓝色。
