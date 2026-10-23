# CLI / MCP 自动发布

## 正常发布

1. 在经过验证的源码版本上打包 CLI 或 MCP；不要修改已发布的同版本内容。
2. 创建 GitHub **草稿** Release，上传全部安装包及校验清单：
   - CLI：标签 `geod-cli-vX.Y.Z`，`geod-cli-X.Y.Z.tgz`、`CLI-SHA256SUMS.txt`。
   - MCP：标签 `geod-mcp-vX.Y.Z`，`geod-mcp-X.Y.Z.tgz`、`MCP-SHA256SUMS.txt`。
3. 校验完附件后公开 Release。`geod-npm-publish.yml` 自动校验并在 Windows 上安装测试；通过后用 OIDC 发布到 npm，回读安装包校验值，再做公开版本的 Windows 安装验证。
4. 在 Actions 查看所有 job 成功及 `npm-publication-receipt`，不能只看到 `npm publish` 被接受就宣布完成。

稳定版本发布到 `latest`；预发布版本必须同时标为 GitHub prerelease，发布到 `next`。此工作流不触发桌面 GeoD 的 npm 发布。由 GitHub Actions 自带 `GITHUB_TOKEN` 创建的 Release 不会触发另一工作流，需要显式 dispatch；维护者或 GitHub App 创建的正式 Release 正常触发。

## 一次性 npm 设置

两个包分别绑定以下可信发布者：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `gaopengbin/geo-downloader` |
| Workflow | `geod-npm-publish.yml` |
| Environment | `npm-production` |
| Permission | `npm publish` |

不配置长期 npm 写入 Token，不关闭账号 2FA。GitHub 的 `npm-production` 环境仅允许 `main` 分支和 `geod-cli-v*`、`geod-mcp-v*` 标签；工作流只使用 GitHub 托管 runner。

npm 当前要求新增可信发布者在 2 天内完成首次真实发布，因此设置后立即用维护版本完成一次真实验收。只跑 dry-run 或跳过已存在版本不等于已经验证 OIDC 发布。

## 恢复与重跑

Actions → Publish GeoD npm packages → Run workflow，选择 **main**，填写已经公开的 Release 标签。`verify_only=true` 仅下载、校验和安装，不能验证 npm 写入权限。

工作流提交前检查 npm：同版本、相同 integrity 直接跳过上传并检查公开下载；同版本、不同内容立即失败；401、403、429、5xx 不会被当作“未发布”。发布只提交一次。npm 处理缓慢会等候注册表可见；超时保留失败信息，重跑先核对注册表，不盲目重试上传。每次只运行一个相同标签的发布流程。

所有安装均在隔离目录进行，并关闭本地遥测。不会为验证自动发布再创建生产测试账号、发起模型调用或重复下载地图。

## 手动认证兜底

如果可信发布配置被删掉或失效，先修复配置；不要自动退回交互认证。确有紧急手动发布需求时，先完成打包校验、确认账号登录，只启动一个发布进程，立即显示该进程生成的新链接。安全密钥成功后必须确认命令行收到回执。出现 404 或进程结束后链接作废，不再让用户点击旧链接。

官方依据：https://docs.npmjs.com/trusted-publishers/
