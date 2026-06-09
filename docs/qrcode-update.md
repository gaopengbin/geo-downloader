# 二维码更新指南

所有二维码（公众号 / 交流群 / 微信收款 / 支付宝收款）托管在镜像服务器 `https://laogao.xyz/packages/qr-assets/`，同时 GitHub Releases 的 `assets` tag 保留备份。桌面 App、官网、README、legacy 静态站全部引用镜像 URL。

## 更新流程

### 方法 A：直接替换服务器文件

在服务器 `C:\nginx-1.30.2\packages\qr-assets\` 下替换对应图片（保持同名），即时生效。

文件名：
- `gzh.jpg`（公众号）
- `wxq_sq.png`（技术交流群）
- `wx.jpg`（微信收款码）
- `zfb.jpg`（支付宝收款码）

### 方法 B：GitHub Release + 同步到服务器

1. 更新 GitHub Release（tag: `assets`）里的图片
2. 下载后通过 SFTP 上传到服务器 `C:\nginx-1.30.2\packages\qr-assets\`

## 引用 URL（已硬编码到代码中）

```
https://laogao.xyz/packages/qr-assets/gzh.jpg
https://laogao.xyz/packages/qr-assets/wxq_sq.png
https://laogao.xyz/packages/qr-assets/wx.jpg
https://laogao.xyz/packages/qr-assets/zfb.jpg
```

## 兜底机制

- 桌面 App：`<img onError>` 在远程加载失败时自动回退到打包进 App 的本地图（`frontend/public/images/`）
- 官网 / legacy 静态站：HTML `onerror` 内联回退到本地 `images/`
- README：加载失败显示 alt 文本

**因此：本地 `frontend/public/images/`、`site/images/`、`static/images/` 下的图作为兜底图保留。**

## 涉及文件清单

| 文件 | 引用 |
|---|---|
| `frontend/src/lib/qr-assets.ts` | 远程 URL 集中定义 + onError 工具函数 |
| `frontend/src/features/promo/community-dialog.tsx` | 公众号 + 交流群 |
| `frontend/src/features/promo/sponsor-dialog.tsx` | 微信 + 支付宝收款码 |
| `site/index.html` | 官网公众号 + 交流群 |
| `static/index.html` + `static/js/app.js` | legacy 静态站 |
| `README.md` | 微信 + 支付宝赞赏码 |
