import { LocalizedContent } from "@/app/_components/LocaleProvider";
import { ArrowRight, Box, CalendarClock, Database, FileCheck2, FileImage, FileOutput, FolderOpen, History, Layers3, MapPinned, Mountain, PencilRuler, Plug, RefreshCw, ShieldCheck, Terminal, Timer, Waypoints, Workflow, HardDrive, MessageSquare } from "lucide-react";
import styles from "./agent.module.css";

export const dataTypes = [
  { id: "imagery", title: "影像下载", label: "影像", Icon: FileImage, intro: "从图源选择到拼接裁剪，带回可继续使用的影像。", points: ["XYZ / WMTS 与 ArcGIS ImageServer 图源", "多级别任务、影像与注记合成", "多边形裁剪、压缩、金字塔与 BigTIFF"], output: "GeoTIFF · MBTiles · PNG / JPEG · GeoPackage · 原始瓦片", proof: "开发版已验证六种输出与独立文件读回" },
  { id: "dem", title: "DEM 高程", label: "DEM", Icon: Mountain, intro: "把编码高程瓦片转成真正的米制高程数据。", points: ["Terrarium 高程解码", "Float32 米制高程与 NoData", "范围下载、金字塔与地图读取"], output: "高程 GeoTIFF · 本机预览", proof: "真实模型任务与实际高程文件已读回核验" },
  { id: "wayback", title: "历史影像", label: "历史影像", Icon: History, intro: "按版本回看同一区域，为对比和归档准备数据。", points: ["Esri Wayback 版本目录与历史下载", "区分版本发布日期与区域拍摄日期", "按区域影像元数据比较更新范围"], output: "历史 GeoTIFF · 范围与元数据", proof: "实际历史瓦片与成果已核验；更新范围比较基于元数据" },
  { id: "vector", title: "矢量数据", label: "矢量", Icon: Waypoints, intro: "获取要素或保留源瓦片，按后续用途选择交付。", points: ["MVT / PBF 与 OSM 要素获取", "按矩形、多边形及孔洞筛选相交要素", "在二维地图加载和检查矢量成果"], output: "GeoJSON · GeoPackage · PBF · MBTiles", proof: "相交要素保留完整几何；PBF / MBTiles 保留完整入选瓦片" },
  { id: "tiles3d", title: "3D Tiles", label: "3D Tiles", Icon: Box, intro: "下载授权三维数据，并在当前工作区查看。", points: ["Cesium Ion、URL 与认证服务连接", "矩形 / 多边形筛选，递归收集资源", "离线成果核验，Cesium 加载与定位"], output: "本机 tileset 与资源包 · 完整性清单", proof: "已验证官方样例与 Ion 建筑；范围筛选保留整块模型" },
];

const taskFeatures = [
  { title: "多个区域，一次安排", Icon: Layers3, text: "保留多个输入范围，选中后合并下载，或按区域拆分为独立任务。计划、保存目录与成果各有归属。" },
  { title: "进度与成果集中管理", Icon: Workflow, text: "统一查看待确认、执行中和已完成任务；展开详情、批量处理、加载到地图或打开本机成果。" },
  { title: "暂停、取消与恢复", Icon: RefreshCw, text: "影像任务保存已核验瓦片，暂停后继续；应用重启后可恢复下载。矢量与三维中断任务可重新核对并重试。" },
  { title: "失败后补漏，也可只用缓存", Icon: FileCheck2, text: "为影像任务生成新的补漏计划，复用有效缓存；也能仅导出已缓存的部分，明确标注缺失覆盖。" },
  { title: "下载计划按时执行", Icon: CalendarClock, text: "支持单次和周期影像下载，矢量 / 三维也可保存定时模板。运行记录保留，暂停未来触发与取消本次分开操作。" },
  { title: "让缓存有账可查", Icon: HardDrive, text: "查看磁盘占用，核验完整性、整理历史缓存、迁移存储目录。跨任务复用与图源版本绑定，迁移前检查可用空间。" },
];

export function DataFeatures() {
  return <LocalizedContent><section id="data" className={styles.section} aria-labelledby="data-title">
    <span className={styles.eyebrow}>五类数据工作流</span>
    <h2 id="data-title">从平面影像，到三维场景。</h2>
    <p className={styles.sectionLead}>在同一个对话工作区中规划、下载和查看不同类型的数据。当前公开测试版为 0.2.4，具体能力与验证范围请查看版本说明。</p>
    <div className={styles.dataGrid}>{dataTypes.map(({ id, title, Icon, intro, points, output, proof }) => <article id={id} key={id} className={styles.dataCard}>
      <div className={styles.dataCardTop}><Icon size={28} strokeWidth={1.5} aria-hidden="true" /><span>开发版已验证</span></div>
      <h3>{title}</h3><p>{intro}</p>
      <ul>{points.map(point => <li key={point}>{point}</li>)}</ul>
      <div className={styles.outputLabel}><FileOutput size={16} aria-hidden="true" /><span>{output}</span></div>
      <p className={styles.dataProof}>{proof}</p>
    </article>)}</div>
    <p className={styles.sectionNote}>数据的可访问性、分辨率和下载许可由具体图源决定。图源连接成功并不代表获得数据下载授权。</p>
  </section></LocalizedContent>;
}

export function InputFeatures() {
  const inputs = [
    { title: "在地图上画", Icon: PencilRuler, text: "拖动绘制矩形，逐点画多边形；编辑顶点、命名、保存书签，再把范围用于当前对话。", tags: ["矩形", "多边形", "范围书签"] },
    { title: "从已有文件读", Icon: FolderOpen, text: "把项目边界附到对话，读取并转换坐标。多面与孔洞保留，不必手动复制大段坐标。", tags: ["GeoJSON", "SHP / ZIP", "GeoPackage", "KML / KMZ", "GML", "FlatGeobuf", "空间 SQLite", "CSV WKT / EWKT"] },
    { title: "连接 PostGIS", Icon: Database, text: "发现数据库中的空间图层，读取字段与范围；用查询得到的区域继续下载。数据库密码由本机凭据管理。", tags: ["空间图层发现", "属性读取", "坐标转换"] },
    { title: "读取在线范围", Icon: Plug, text: "输入在线矢量文件或返回要素的数据地址，读取范围并接到任务计划。", tags: ["在线 GeoJSON", "WFS GetFeature", "ArcGIS query", "OGC Features"] },
  ];
  return <LocalizedContent><section id="inputs" className={styles.section} aria-labelledby="inputs-title">
    <span className={styles.eyebrow}>范围与图源</span><h2 id="inputs-title">从你已有的数据开始。</h2>
    <p className={styles.sectionLead}>文件、数据库、在线要素和手绘范围，都可以成为任务起点。13 种输入方式已在本机完成读取、规划、下载裁剪与成果核验。</p>
    <div className={styles.inputGrid}>{inputs.map(({ title, Icon, text, tags }) => <article key={title}><Icon size={24} aria-hidden="true" /><h3>{title}</h3><p>{text}</p><div className={styles.chips}>{tags.map(tag => <span key={tag}>{tag}</span>)}</div></article>)}</div>
    <div className={styles.sourceStrip}><div><ShieldCheck size={24} aria-hidden="true" /><h3>把自己的图源安全接进来。</h3></div><p>图源预设与自定义服务统一管理，支持影像注记、子域轮换和已适配图源的坐标处理。图源认证可使用查询参数、Bearer Token 或自定义请求头；Key / Token 保存在本机凭据库，模型读取配置摘要。</p></div>
    <p className={styles.sectionNote}>在线输入支持要素响应读取；自动遍历服务目录、完整分页合并和更多数据库类型仍在推进。</p>
  </section></LocalizedContent>;
}

export function TaskFeatures() {
  return <LocalizedContent><section id="tasks" className={styles.section} aria-labelledby="tasks-title">
    <span className={styles.eyebrow}>任务与执行</span><h2 id="tasks-title">长任务，也能看得清、接得住。</h2>
    <p className={styles.sectionLead}>Agent 组织计划，本机接管下载与监控。你可以继续对话，也可以随时回到任务区查看真实状态。</p>
    <div className={styles.capabilities}>{taskFeatures.map(({ title, text, Icon }) => <article key={title}><Icon className={styles.featureIcon} size={25} strokeWidth={1.6} aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div>
    <div className={styles.taskNote}><Timer size={21} aria-hidden="true" /><p>定时任务需要本机后台保持运行。关闭窗口后可继续，显式停止后台后不执行。到时是否自动执行取决于当前权限，错过的周期会在重新连接时合并处理。</p></div>
  </section></LocalizedContent>;
}

export function ExtensionFeatures() {
  const extensions = [
    { title: "二维地图操作", Icon: MapPinned, text: "内置 OpenLayers 工具：调整视野、管理图层、添加 GeoJSON 与标注、加载影像成果并读取地图状态。" },
    { title: "三维场景操作", Icon: Box, text: "内置 Cesium 工具：调整相机、控制建筑图层、添加对象、切换底图；二维 / 三维来回切换时保留已有场景。" },
    { title: "本机 GIS 处理", Icon: Terminal, text: "多格式范围导入、矢量转换、矢量分析、栅格检查、栅格转换可分别安装。需要时提示下载，安装后继续任务，文件操作围绕当前工作区执行。" },
    { title: "Skill 能力包", Icon: FolderOpen, text: "搜索技能目录、粘贴链接或导入本地包。GitHub / 本地 Skill 保留脚本、参考资料和资源，检查后启用。" },
    { title: "MCP 外部工具", Icon: Plug, text: "发现 HTTP MCP 服务，先连接并列出真实工具，再确认启用。工具参数、结果和错误在对话中可查。" },
    { title: "可追溯的 Agent 对话", Icon: MessageSquare, text: "使用 GeoD 托管模型，或配置自己的模型服务与兼容网关。展开执行记录、补充要求或停止本轮；会话与任务历史按工作区保留。" },
  ];
  return <LocalizedContent><section id="extensions" className={styles.section} aria-labelledby="extensions-title">
    <span className={styles.eyebrow}>技能与连接器</span><h2 id="extensions-title">让地图、数据和工具一起工作。</h2>
    <p className={styles.sectionLead}>从内置地图到本机处理，再到你选择的扩展。Agent 依据真实工具结果继续任务，新增连接器在启用前由你确认。</p>
    <div className={styles.capabilities}>{extensions.map(({ title, Icon, text }) => <article key={title}><Icon className={styles.featureIcon} size={25} strokeWidth={1.6} aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div>
    <p className={styles.sectionNote}>Skill 脚本需要相应本机依赖；0.2.4 将 GIS 能力拆为独立技能，依赖在本机共享。HTTP / stdio MCP、认证请求头与浏览器 OAuth 已接入，外部服务需逐项验证。已接入的三维工具中，相机、对象、图层、底图与视图切换已验证；更多场景工具将逐项验收。</p>
  </section></LocalizedContent>;
}

export function DeliveryFeatures() {
  return <LocalizedContent><section id="delivery" className={styles.section} aria-labelledby="delivery-title">
    <span className={styles.eyebrow}>成果交付</span><h2 id="delivery-title">带走文件，也带走它的来历。</h2>
    <p className={styles.sectionLead}>成果保存在本机工作区。下载完成后，在地图中看结果，并通过文件清单检查交付是否完整。</p>
    <div className={styles.deliveryGrid}>
      <article><FileOutput size={25} aria-hidden="true" /><h3>按用途选择格式</h3><p>栅格、矢量、瓦片库与三维资源包分别输出。0.2.4 默认不压缩，也可选择压缩与金字塔。指定 EPSG 坐标系后重投影，继续进入已有 GIS 工具。</p></article>
      <article><FileCheck2 size={25} aria-hidden="true" /><h3>核验实际文件</h3><p>记录大小、哈希与资源引用，检查实际成果。缺失覆盖或部分导出会标明，不把有空缺的结果显示为完整交付。</p></article>
      <article><MapPinned size={25} aria-hidden="true" /><h3>回到地图确认</h3><p>加载本机影像、矢量和三维成果，定位到任务范围。计划、图源与运行记录跟随任务，后续复查有依据。</p></article>
    </div>
  </section></LocalizedContent>;
}

export function ScenarioFeatures() {
  const examples = [
    { title: "多地区影像整理", prompt: "“按这几个区域分别下载影像，再生成一份合并裁剪结果。”", target: "tasks", result: "区域拆分或合并 → 任务分配 → 独立成果" },
    { title: "数据库驱动的任务", prompt: "“读取 PostGIS 里的项目范围，用它裁剪需要的影像。”", target: "inputs", result: "连接与图层发现 → 读取范围 → 下载裁剪" },
    { title: "历史资料归档", prompt: "“查看这个区域的历史影像版本，下载选定日期的影像。”", target: "wayback", result: "发现版本 → 核对日期 → 历史成果" },
    { title: "三维成果查看", prompt: "“加载三维成果，从南侧斜看建筑，再切回二维地图。”", target: "extensions", result: "加载场景 → 相机调整 → 视图切换" },
  ];
  return <LocalizedContent><section id="scenarios" className={styles.section} aria-labelledby="scenarios-title">
    <span className={styles.eyebrow}>从这样的需求开始</span><h2 id="scenarios-title">把工作流，说给 Agent 听。</h2>
    <p className={styles.sectionLead}>示例需求用于说明能力组合。实际执行前仍需核对图源、范围、格式和权限。</p>
    <div className={styles.scenarioGrid}>{examples.map(item => <a href={`#${item.target}`} key={item.title}><span>{item.title}<ArrowRight size={17} aria-hidden="true" /></span><p>{item.prompt}</p><small>{item.result}</small></a>)}</div>
  </section></LocalizedContent>;
}

export function RoadmapFeatures() {
  return <LocalizedContent><section className={styles.section} aria-labelledby="roadmap-title">
    <span className={styles.eyebrow}>版本与使用范围</span><h2 id="roadmap-title">先体验，再把你的工作流带进来。</h2>
    <div className={styles.roadmapGrid}>
      <article><span>当前可下载</span><h3>0.2.3 · Windows 测试版</h3><p>独立桌面应用，支持模型渠道、二维与三维地图、任务管理、在线更新与消息中心。真实收费尚未开放。</p></article>
      <article><span>本地准备中</span><h3>0.2.4 · 本次候选</h3><p>本页候选改进已在本机验证。安装包、升级回归与干净 Windows 验收完成后，才会更新公开下载入口。</p></article>
      <article><span>具体数据具体核对</span><h3>授权、精度与覆盖</h3><p>数据许可、访问额度、影像日期与分辨率取决于图源。3D Tiles 范围筛选保留整块模型；并非精确切割模型。</p></article>
    </div>
  </section></LocalizedContent>;
}
