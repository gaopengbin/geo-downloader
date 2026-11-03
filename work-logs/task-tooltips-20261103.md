# 下载中心自定义 Tooltip（2026-11-03）

按用户要求，将下载中心及任务弹窗的原生 HTML title 提示替换为统一的 Tooltip。

- 新增基于现有 Radix 体系的 Tooltip 封装，固定依赖 `@radix-ui/react-tooltip@1.4.1`。使用现有 popover 主题色、边框、圆角和阴影；350ms 悬停延迟，支持键盘聚焦与 Esc 关闭。
- 通过 asChild 保留触发元素原有布局，Portal 避免被侧栏裁切；按可用视口自动避让，长路径/错误换行并限制尺寸。普通与深色主题使用同一组件。
- 底部操作仍保留短标签。TaskCardAction 接收的 title 仅作为 Tooltip 内容，不再写到 DOM；名称、图源、状态、完整日期、错误摘要、下载中心工具栏、任务弹窗及恢复任务入口同步替换。图标按钮补足独立的可访问名称，侧栏拖拽提示也改用同一组件。

验证：前端构建、94 项测试、变更范围 ESLint、git diff --check 通过。浏览器加载实际组件、模拟原生接口，确认下载中心与任务弹窗内原生 title 属性为零；380px 最小侧栏的五个底部按钮仍在同一行。实测悬停展示与移出关闭、键盘聚焦、Esc 关闭、完整秒级日期、长路径深色提示、上边缘自动切到下方、弹窗内层级，以及原有打开/复制与拖拽下限行为。未操作用户鼠标、真实任务或资源管理器。

证据：`G:/code/tif-downloader/artifacts/task-tooltips-20261103/`，包含普通路径、深色长路径、下方避让、弹窗提示截图，以及 `browser-proof.json`、`verified-result.json`。独立 1437 验证服务结束后关闭，保留 1420 开发服务。本次未发布更新。

API 与组合方式参考：[Radix Tooltip 官方文档](https://www.radix-ui.com/primitives/docs/components/tooltip)，并核对已安装 1.4.1 的类型声明和实现。
