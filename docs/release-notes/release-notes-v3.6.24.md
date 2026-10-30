# GeoD v3.6.24

本次修复 Wayback 时间轴遮挡弹窗的问题，建议使用历史影像功能的用户更新。

- 修复历史时间轴盖住 AI 助手启用确认等弹窗、遮挡底部按钮的问题。
- 将时间轴、地图提示和地图控件的层级限制在地图工作区内，弹窗与遮罩正常显示。
- 关闭弹窗后，时间轴日期切换与地图缩放正常使用。
- 包含 3.6.23 的历史日期切换 React #185 修复。

验证：在真实 App 布局、设置弹窗、Leaflet 地图及时间轴的隔离测试页复现并修复；深浅主题、弹窗遮罩、取消后日期切换和地图缩放通过。TypeScript / Vite 生产构建通过。

## English

GeoD 3.6.24 fixes the Wayback timeline appearing above modal dialogs and covering their buttons. Map overlays now stay within the map workspace, beneath global dialog backdrops. Date switching and map zoom continue to work after closing a dialog. Includes the historical-date React #185 fix from 3.6.23.

Verified with the actual App layout, settings dialogs, Leaflet and timeline using isolated native data in dark and light themes. TypeScript and the production frontend build passed.
