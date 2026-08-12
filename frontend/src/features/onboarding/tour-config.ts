import type { DriveStep } from 'driver.js'

/**
 * 引导版本号：升级后即使用户已看过旧引导也会再次自动弹出。
 */
export const TOUR_VERSION = 1

/**
 * localStorage 键名：记录用户已经看过的引导版本（按引导 id 维度）。
 * 结构：{ [tourId]: number }
 */
export const TOUR_STORAGE_KEY = 'gd:tour:seen'

/**
 * 主界面首次引导。覆盖：模式 Tabs、侧边栏 Tab、控制面板、地图、标题栏入口。
 *
 * 目标元素需要在对应组件上挂载 `data-tour="<key>"`。
 */
export const MAIN_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: '欢迎使用 GeoDownloader',
      description:
        '这是一款一体化的地理数据下载工具，支持影像、DEM、Wayback、3D Tiles、矢量瓦片等多种数据源。<br/><br/>下面用 1 分钟带你走一遍主界面。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="mode-tabs"]',
    popover: {
      title: '① 选择数据类型',
      description:
        '顶部切换不同模式：影像、DEM、Wayback 历史影像、3D Tiles、矢量瓦片。每个模式对应不同的下载流程与参数面板。',
      side: 'bottom',
      align: 'center',
    },
  },
  {
    element: '[data-tour="sidebar-tabs"]',
    popover: {
      title: '② 三大功能页',
      description:
        '<b>资源下载</b>：配置参数并发起任务。<br/><b>下载中心</b>：查看进行中和历史任务。<br/><b>设置</b>：图源、并发、代理、Cesium Token 等全局配置。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="download-panel"]',
    popover: {
      title: '③ 参数控制面板',
      description:
        '在这里设置数据源、缩放级别、输出格式、保存路径等。多要素时还可选择「合并下载」或「拆分下载」。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="map-canvas"]',
    popover: {
      title: '④ 地图选区',
      description:
        '在地图上拖拽矩形或绘制多边形圈定下载范围；也可以导入 GeoJSON、Shapefile、KML 或 KMZ 边界。',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="resumable-tasks"]',
    popover: {
      title: '⑤ 断点续传入口',
      description: '上次未完成的任务会出现在这里，一键恢复继续下载。',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="settings-tab"]',
    popover: {
      title: '⑥ 设置入口',
      description:
        '推荐先打开「设置」配置默认并发、网络代理、Cesium Ion Token 等全局参数，再开始下载。',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '[data-tour="help-button"]',
    popover: {
      title: '⑦ 随时重启引导',
      description: '右上角「帮助」按钮可以随时再次播放本引导，也可在这里启动各模式的详细引导。开始探索吧！',
      side: 'bottom',
      align: 'end',
    },
  },
]

/** 影像 / DEM 下载详细引导 */
export const IMAGERY_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: '影像下载流程',
      description: '下面用 5 步带你完成一次完整的影像/DEM 下载。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="map-canvas"]',
    popover: {
      title: '① 在地图上选区',
      description: '使用矩形或多边形工具圈定下载范围；也可以导入 GeoJSON、Shapefile、KML 或 KMZ 边界。',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="imagery-source-section"]',
    popover: {
      title: '② 选择图源与缩放级别',
      description:
        '先选择数据源（天地图、Bing、Google 等），再勾选要下载的 zoom 级别。可任意离散组合，也可用预设范围按钮快速选择。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="imagery-output-section"]',
    popover: {
      title: '③ 配置输出参数',
      description:
        '选择输出格式（GeoTIFF / PNG / 切片包等）、压缩方式、保存路径。多要素时可在此切换「合并 / 拆分」下载策略。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="imagery-submit-bar"]',
    popover: {
      title: '④ 创建下载任务',
      description:
        '上方会自动估算瓦片数量与文件大小，确认无误后点击「创建下载任务」。任务进度可在「下载中心」查看。',
      side: 'top',
      align: 'center',
    },
  },
]

/** 3D Tiles 下载详细引导 */
export const TILES3D_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: '3D Tiles 下载流程',
      description: '下面用 4 步带你下载 3D Tiles 模型。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="map-canvas"]',
    popover: {
      title: '① 选区（可选）',
      description: '在地图上圈定空间范围以裁剪模型；不选则下载整个 tileset。',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="tiles3d-source-tabs"]',
    popover: {
      title: '② 选择数据源类型',
      description:
        '<b>URL</b>：直接填 tileset.json 地址（自定义 OSGB / 公开数据）。<br/><b>Cesium Ion</b>：填 Asset ID + Token，下载 Ion 资产。',
      side: 'bottom',
      align: 'center',
    },
  },
  {
    element: '[data-tour="tiles3d-source-section"]',
    popover: {
      title: '③ 填写参数',
      description:
        '根据所选模式填写 URL/Asset/Token，OSS/CDN 防盗链场景可设置 Referer。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="tiles3d-actions"]',
    popover: {
      title: '④ 解析与下载',
      description:
        '先点「解析数据源」获取瓦片统计；确认后点「下载模型」开始任务，进度可在「下载中心」查看。',
      side: 'top',
      align: 'center',
    },
  },
]

/** Wayback 历史影像下载详细引导 */
export const WAYBACK_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: 'Wayback 历史影像流程',
      description: 'Esri Wayback 提供全球历史影像版本，下面带你过一遍三种下载模式。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="map-canvas"]',
    popover: {
      title: '① 选区',
      description: '在地图上圈定要查询和下载的范围。',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="wayback-mode-tabs"]',
    popover: {
      title: '② 选择下载模式',
      description:
        '<b>单个</b>：选某一期版本下载。<br/><b>批量</b>：勾选多个版本一次下载。<br/><b>增量</b>：扫描所有版本，按覆盖率/优势度自动筛选有效影像。',
      side: 'bottom',
      align: 'center',
    },
  },
  {
    element: '[data-tour="wayback-section"]',
    popover: {
      title: '③ 配置与下载',
      description:
        '面板内可调整扫描模式（fast/fine）、覆盖率阈值、是否仅取每年最新等参数；时间轴在地图右侧底部，可定位到具体日期。',
      side: 'right',
      align: 'center',
    },
  },
]
