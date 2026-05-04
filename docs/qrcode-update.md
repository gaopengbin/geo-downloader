# 二维码更新指南（无需 commit 代码）

所有二维码（公众号 / 交流群 / 微信收款 / 支付宝收款）统一托管在 GitHub Releases 的 `assets` tag 下，桌面 App、官网、README、legacy 静态站全部引用同一组远程 URL。**更新二维码不需要改代码、不需要 commit、不需要发版**。

## 一次性初始化（仅首次）

1. 在仓库 https://github.com/gaopengbin/geo-downloader 创建一个永久 release：
   - Tag：`assets`
   - Title：`QR Code Assets`
   - Body：`二维码资源仓库，供桌面 App / 官网 / README 引用。请勿删除此 release。`
   - 不要勾选 "Set as the latest release"
2. 把当前的 4 张图作为 asset 上传（**文件名必须严格保持下面这几个**）：
   - `gzh.jpg`（公众号）
   - `wxq_sq.png`（技术交流群）
   - `wx.jpg`（微信收款码）
   - `zfb.jpg`（支付宝收款码）

## 日常更新流程（核心）

### 方法 A：浏览器（推荐，无需任何工具）

1. 打开 https://github.com/gaopengbin/geo-downloader/releases/tag/assets
2. 点右上角 `Edit`（铅笔图标）
3. 找到要替换的图，点 `×` 删除
4. 把新图拖进 attachments 区域（**保持同名**）
5. 点底部 `Update release` 保存
6. 完成。所有平台立即生效（GitHub raw 链接无 CDN 缓存）

### 方法 B：gh CLI（脚本化）

```powershell
gh release upload assets wxq_sq.png --clobber --repo gaopengbin/geo-downloader
```

`--clobber` 会覆盖同名文件。

## 引用 URL（已硬编码到代码中，仅供参考）

```
https://github.com/gaopengbin/geo-downloader/releases/download/assets/gzh.jpg
https://github.com/gaopengbin/geo-downloader/releases/download/assets/wxq_sq.png
https://github.com/gaopengbin/geo-downloader/releases/download/assets/wx.jpg
https://github.com/gaopengbin/geo-downloader/releases/download/assets/zfb.jpg
```

## 兜底机制

- 桌面 App：`<img onError>` 在远程加载失败时自动回退到打包进 App 的本地图（`frontend/public/images/`）
- 官网 / legacy 静态站：HTML `onerror` 内联回退到本地 `images/`
- README：GitHub 读者直接看远程 URL，加载失败显示 alt 文本

**因此：本地 `frontend/public/images/`、`site/images/`、`static/images/` 下的图作为兜底图保留，等几个月没人反映问题再考虑删除。**

## 涉及文件清单

| 文件 | 引用 |
|---|---|
| `frontend/src/lib/qr-assets.ts` | 远程 URL 集中定义 + onError 工具函数 |
| `frontend/src/features/promo/community-dialog.tsx` | 公众号 + 交流群 |
| `frontend/src/features/promo/sponsor-dialog.tsx` | 微信 + 支付宝收款码 |
| `site/index.html` | 官网公众号 + 交流群 |
| `static/index.html` + `static/js/app.js` | legacy 静态站 |
| `README.md` | 微信 + 支付宝赞赏码 |

如需新增二维码品类（如 QQ 群、Discord 等）：
1. 在 release `assets` 上传新图
2. 在 `frontend/src/lib/qr-assets.ts` 的 `QR_ASSETS` 对象里加一项
3. 对应组件里 `<img src={QR_ASSETS.xxx.remote} onError={(e) => fallbackToLocal(e, 'xxx')} />`
