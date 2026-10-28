# GeoDownloader v3.6.20

本次新增按图源配置自定义请求头，方便接入需要 Token、Cookie 或来源校验的瓦片服务。

- 在「图源管理 → 新增 / 编辑」中添加 Authorization、X-API-Key、Cookie、Referer、User-Agent 等请求头，内置图源覆盖和智能解析同样支持。
- 图源测试、地图预览和下载共用请求头。地图仍随平移、缩放自动加载，支持光栅与 MVT 矢量瓦片的本地认证请求。
- 请求头值默认隐藏，支持查看和删除；重复名称、换行及无效内容会在保存前提示。
- 同站重定向保留配置，跨站重定向停止，避免把凭证发送到其他站点；请求头值不拼进瓦片 URL，也不写入瓦片元信息。
- 带请求头的下载按地址和凭证隔离缓存；修改配置后重建当前预览图层，避免继续显示旧图层。
- 调整图源管理的窄屏页签布局，避免横向溢出。

请求头随本机图源配置保存，未额外加密。凭证过期后需要自行更新；本功能不包含自动登录、验证码处理或动态签名。

验证：本地认证 HTTP 服务覆盖测试、预览、下载及重定向，6 项桌面请求头测试、8 项图源解析回归、66 项前端测试和生产构建通过；浏览器验证图源表单和地图平移缩放。实际第三方认证图源仍需使用相应服务的有效凭证。

## English

GeoD 3.6.20 adds per-source custom HTTP headers for authenticated tile services, including Authorization, API keys, Cookie, Referer and User-Agent. Source testing, desktop map preview and downloads share the configuration. Custom sources, built-in overrides and smart URL analysis are supported.

Header values are hidden by default, validated before saving, excluded from tile URLs and metadata, and not forwarded across origins. Downloads use separate cache identities when headers change. Source management also fits narrow windows more reliably.

Headers are stored in the local source configuration without additional encryption. Expired credentials must be updated manually; automatic login, CAPTCHA handling and dynamic request signing are not included.
