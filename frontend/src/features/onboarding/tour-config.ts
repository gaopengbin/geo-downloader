import type { DriveStep } from 'driver.js'

/**
 * 引导版本号：升级后即使用户已看过旧引导也会再次自动弹出。
 */
export const TOUR_VERSION = 2

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
      title: '欢迎使用 GeoD',
      description:
        'GeoD 是一款桌面 GIS 数据工具，支持影像、DEM、Wayback、3D Tiles、MVT 和 OSM 等数据工作流。<br/><br/>下面用 1 分钟带你认识主界面。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="mode-tabs"]',
    popover: {
      title: '① 选择数据类型',
      description:
        '顶部可切换 GeoTIFF、DEM、Wayback、3D Tiles、MVT 和 OSM。每种模式都有独立的图源、参数和输出流程。',
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
        '在这里选择下载范围、图源、缩放级别、输出格式和保存路径。复杂边界可以从文件导入，也可以保存为范围书签重复使用。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="map-canvas"]',
    popover: {
      title: '④ 地图选区',
      description:
        '在地图上拖拽矩形或绘制多边形圈定下载范围。左侧还有行政区、地名搜索、边界导入和范围书签。',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="history-tab"]',
    popover: {
      title: '⑤ 下载中心',
      description: '下载、暂停、继续、批量操作和历史记录都集中在下载中心；意外中断的任务也可以从这里恢复。',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '[data-tour="settings-tab"]',
    popover: {
      title: '⑥ 设置入口',
      description:
        '代理、并发、缓存目录、图源管理等全局选项都在设置中。一般用户可以先保持默认，需要时再调整。',
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

/** 区域选择、范围书签和地图工具引导 */
export const REGION_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: '区域与地图工具',
      description: '下载范围是各类任务的共同起点。下面介绍选区、书签、量测和经纬网。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="region-selector"]',
    popover: {
      title: '① 选择下载范围',
      description:
        '可以搜索地名、加载行政边界、上传 GeoJSON / Shapefile / KML / KMZ，也可以在地图上手绘后通过四至坐标精确调整。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="map-canvas"]',
    popover: {
      title: '② 在地图上绘制',
      description: '使用地图左上角的矩形或多边形工具绘制选区；编辑后，面积和下载估算会自动更新。',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="region-bookmarks"]',
    popover: {
      title: '③ 保存范围书签',
      description: '将当前选区保存为命名书签，以后可一键恢复。书签只保存范围，不会绑定图源、层级和输出格式。',
      side: 'bottom',
      align: 'center',
    },
  },
  {
    element: '[data-tour="measure-tools"]',
    popover: {
      title: '④ 距离与面积量测',
      description: '地图工具条可量测距离或面积；量测结果仅用于查看，不会改变下载范围。',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '[data-tour="graticule-control"]',
    popover: {
      title: '⑤ 经纬网',
      description: '可开启经纬网，并选择自动细化或固定间隔。它只影响地图显示，不会叠加到下载成果中。',
      side: 'left',
      align: 'start',
    },
  },
]

/** 下载中心详细引导 */
export const DOWNLOAD_CENTER_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: '下载中心',
      description: '进行中的任务和已经结束的记录统一在这里管理。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="active-tasks-section"]',
    popover: {
      title: '① 任务管理',
      description:
        '每个任务卡片内都可以查看进度、暂停、继续或删除；勾选多个任务后可执行批量操作。意外中断的任务也会在这里提供恢复入口。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="history-section"]',
    popover: {
      title: '② 历史记录',
      description:
        '已完成或失败的任务会进入历史记录。这里可以定位输出文件、查看日志、补建金字塔或删除记录；删除记录不会删除已下载成果。',
      side: 'right',
      align: 'start',
    },
  },
]

/** MVT 矢量瓦片下载详细引导 */
export const MVT_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: 'MVT 矢量瓦片流程',
      description: 'MVT / PBF 会保持原始瓦片字节，适合离线切片包和后续样式渲染。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="imagery-source-section"]',
    popover: {
      title: '① 选择 MVT 图源和层级',
      description: '选择已配置的 MVT 图源和需要下载的 zoom 级别。自定义服务可先到设置中的图源管理完成配置。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="map-canvas"]',
    popover: {
      title: '② 预览并圈定范围',
      description: 'MVT 图源会直接显示在主地图上；确认内容正确后，用矩形或多边形工具圈定下载范围。',
      side: 'left',
      align: 'center',
    },
  },
  {
    element: '[data-tour="imagery-output-section"]',
    popover: {
      title: '③ 设置输出',
      description: '选择原始 PBF 目录或切片包等输出方式，并设置任务名称和保存位置。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="imagery-submit-bar"]',
    popover: {
      title: '④ 创建任务',
      description: '确认瓦片数量和保存路径后创建任务，随后可在下载中心查看进度。',
      side: 'top',
      align: 'center',
    },
  },
]

/** OSM 矢量数据下载详细引导 */
export const OSM_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: 'OSM 矢量数据流程',
      description: '通过 Overpass 获取道路、建筑、水系、POI 等 OSM 要素，并保存为 GeoJSON。',
      side: 'over',
      align: 'center',
    },
  },
  {
    element: '[data-tour="region-selector"]',
    popover: {
      title: '① 选择查询范围',
      description: '绘制或导入一个范围用于 OSM 查询。范围过大可能导致 Overpass 超时，建议分区下载。',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="osm-feature-type"]',
    popover: {
      title: '② 选择要素类型',
      description: '选择道路、建筑、水系、土地利用、POI、铁路或自然要素。每次任务下载一种类型。',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '[data-tour="osm-download-actions"]',
    popover: {
      title: '③ 下载 OSM 或行政边界',
      description:
        '“下载 OSM”使用当前地图选区；“下载边界”保存当前行政区边界。选择路径后任务会进入下载中心。',
      side: 'right',
      align: 'center',
    },
  },
  {
    element: '[data-tour="osm-panel"]',
    popover: {
      title: '④ 加载本地矢量数据',
      description: '也可以加载本地 GeoJSON 等矢量文件叠加到地图，便于对照检查；这不会自动创建下载任务。',
      side: 'right',
      align: 'end',
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
