"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, MapPinned, Square, Zap } from "lucide-react";
import { downloadBrowserImagery, planBrowserImagery, type Bounds, type ImageryPlan } from "../../lib/browser-imagery";
import styles from "./browser.module.css";

type ModelContext = {
  registerTool: (tool: {
    name: string;
    description: string;
    inputSchema: object;
    annotations?: object;
    execute: (input: any, options?: { signal?: AbortSignal }) => Promise<object>;
  }, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

const EXAMPLES: { name: string; bounds: Bounds }[] = [
  { name: "河南", bounds: [110.3, 31.3, 116.7, 36.5] },
  { name: "四川", bounds: [97.3, 26.0, 108.5, 34.3] },
];
const BOUNDS_LABELS = ["西经度", "南纬度", "东经度", "北纬度"];
const BOUNDS_KEYS = ["west", "south", "east", "north"];
const boundsSchema = {
  type: "object",
  properties: {
    west: { type: "number", description: "WGS84 西边界经度" },
    south: { type: "number", description: "WGS84 南边界纬度" },
    east: { type: "number", description: "WGS84 东边界经度" },
    north: { type: "number", description: "WGS84 北边界纬度" },
    zoom: { type: "integer", minimum: 0, maximum: 8, description: "NASA Blue Marble 级别，0 到 8" },
  },
  required: ["west", "south", "east", "north", "zoom"],
  additionalProperties: false,
};

function asRequest(input: Record<string, unknown>) {
  const bounds = [input.west, input.south, input.east, input.north];
  if (bounds.some(value => typeof value !== "number")) throw new Error("请提供数字格式的 west、south、east、north。");
  return planBrowserImagery(bounds as Bounds, input.zoom as number);
}

function planSummary(plan: ImageryPlan) {
  return {
    source: plan.source,
    bounds: plan.bounds,
    zoom: plan.zoom,
    tileCount: plan.tiles,
    width: plan.width,
    height: plan.height,
    execution: "用户当前浏览器直接从 NASA GIBS 下载并拼接；GeoD 服务器不处理影像。",
  };
}

export default function BrowserImagery() {
  const [values, setValues] = useState(["110.3", "31.3", "116.7", "36.5"]);
  const [zoom, setZoom] = useState(7);
  const [plan, setPlan] = useState<ImageryPlan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<{ preview: string; archive: string } | null>(null);
  const [webMcpStatus, setWebMcpStatus] = useState("检测中");
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const urlsRef = useRef<string[]>([]);

  const clearReady = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
    setReady(null);
  }, []);

  const runFetch = useCallback(async (nextPlan: ImageryPlan, externalSignal?: AbortSignal) => {
    if (busyRef.current) throw new Error("已有下载任务正在运行，请先等待或取消。");
    busyRef.current = true;
    setBusy(true);
    setValues(nextPlan.bounds.map(String));
    setZoom(nextPlan.zoom);
    setPlan(nextPlan);
    setMessage("正在浏览器中下载和拼接影像…");
    clearReady();
    const controller = new AbortController();
    abortRef.current = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    try {
      const result = await downloadBrowserImagery(nextPlan, (done, total) => setProgress({ done, total }), controller.signal);
      const preview = URL.createObjectURL(result.png);
      const archive = URL.createObjectURL(result.zip);
      urlsRef.current = [preview, archive];
      setReady({ preview, archive });
      setMessage("拼接完成。点击“保存数据包”把影像、定位文件和来源说明存到你的电脑。");
      return { ...planSummary(nextPlan), archiveReady: true, archiveBytes: result.zip.size, nextStep: "请让用户在本页面点击“保存数据包”；文件不会上传到 GeoD 服务器。" };
    } catch (error) {
      setMessage(error instanceof Error && error.name === "AbortError" ? "任务已取消。" : error instanceof Error ? error.message : "下载失败，请重试。");
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }, [clearReady]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) {
      setWebMcpStatus("当前浏览器未开放 WebMCP；手动操作仍可用");
      return;
    }
    const controller = new AbortController();
    const tools = [
      {
        name: "geod_browser_capabilities",
        description: "查看 GeoD 浏览器本地影像下载能力。影像在用户浏览器中直接下载、拼接和保存，不使用 GeoD 服务器算力。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => ({ source: "NASA GIBS Blue Marble 地形概览", zoom: "0–8", maxTiles: 256, maxPixels: 16_777_216, output: "PNG + EPSG:3857 PGW/PRJ + manifest.json，打包为 ZIP", requiresOpenPage: true }),
      },
      {
        name: "geod_browser_plan",
        description: "按 WGS84 西南东北范围和级别估算本地浏览器影像下载；不发起网络下载。",
        inputSchema: boundsSchema,
        annotations: { readOnlyHint: true },
        execute: async (input: Record<string, unknown>) => planSummary(asRequest(input)),
      },
      {
        name: "geod_browser_fetch",
        description: "仅在用户要求下载时调用。由当前浏览器直接从 NASA GIBS 下载瓦片并拼接，完成后用户在页面点击保存 ZIP。不要用来测试连接。",
        inputSchema: boundsSchema,
        annotations: { readOnlyHint: false },
        execute: async (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => runFetch(asRequest(input), options?.signal),
      },
    ];
    Promise.all(tools.map(tool => context.registerTool(tool, { signal: controller.signal })))
      .then(() => setWebMcpStatus("WebMCP 工具已就绪"))
      .catch(() => setWebMcpStatus("WebMCP 注册失败；手动操作仍可用"));
    return () => controller.abort();
  }, [runFetch]);

  useEffect(() => () => {
    abortRef.current?.abort();
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
  }, []);

  function currentPlan() {
    return planBrowserImagery(values.map(Number) as Bounds, zoom);
  }

  function handlePlan() {
    try {
      const nextPlan = currentPlan();
      setPlan(nextPlan);
      setMessage(`范围有效：${nextPlan.tiles} 块瓦片，输出约 ${nextPlan.width} × ${nextPlan.height} 像素。`);
    } catch (error) {
      setPlan(null);
      setMessage(error instanceof Error ? error.message : "范围无效。");
    }
  }

  async function handleFetch() {
    try { await runFetch(currentPlan()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "下载失败，请重试。"); }
  }

  return (
    <div className={styles.workspace}>
      <section className={styles.formCard} aria-labelledby="browser-request-title">
        <div className={styles.sectionTop}>
          <span className={styles.sectionIcon}><MapPinned size={20} aria-hidden="true" /></span>
          <div><span className={styles.kicker}>01 / REQUEST</span><h2 id="browser-request-title">选择下载范围</h2></div>
        </div>
        <p className={styles.description}>当前提供 NASA Blue Marble 地形概览图。它适合验证浏览器端下载流程，不代表近期高分辨率卫星影像。</p>
        <div className={styles.exampleRow} aria-label="示例区域">
          {EXAMPLES.map(example => <button type="button" key={example.name} disabled={busy} onClick={() => { setValues(example.bounds.map(String)); setPlan(null); clearReady(); }}>
            {example.name}示例
          </button>)}
        </div>
        <div className={styles.boundsGrid}>
          {BOUNDS_LABELS.map((label, index) => <label key={label}>
            <span>{label}</span>
            <input aria-label={label} type="number" inputMode="decimal" step="any" value={values[index]} disabled={busy}
              onChange={event => { setValues(current => current.map((value, i) => i === index ? event.target.value : value)); setPlan(null); clearReady(); }} />
            <small>{BOUNDS_KEYS[index]}</small>
          </label>)}
        </div>
        <div className={styles.zoomHeading}><span>影像级别</span><strong>{zoom}</strong></div>
        <div className={styles.zoomRow} role="group" aria-label="影像级别">
          {[4, 5, 6, 7, 8].map(level => <button type="button" key={level} aria-pressed={zoom === level} disabled={busy}
            onClick={() => { setZoom(level); setPlan(null); clearReady(); }}>{level}</button>)}
        </div>
        <div className={styles.actionRow}>
          <button type="button" className={styles.secondary} disabled={busy} onClick={handlePlan}>估算大小</button>
          <button type="button" className={styles.primary} disabled={busy} onClick={handleFetch}><Zap size={17} aria-hidden="true" />在本机下载并拼接</button>
          {busy && <button type="button" className={styles.cancel} onClick={() => abortRef.current?.abort()}><Square size={14} aria-hidden="true" />取消</button>}
        </div>
        <p className={styles.status} role="status">{message || "先估算，再决定是否下载。"}</p>
        {busy && progress && <progress className={styles.progress} aria-label="瓦片下载进度" value={progress.done} max={progress.total} />}
      </section>

      <section className={styles.resultCard} aria-labelledby="browser-result-title">
        <div className={styles.sectionTop}>
          <span className={styles.sectionIcon}><Download size={20} aria-hidden="true" /></span>
          <div><span className={styles.kicker}>02 / RESULT</span><h2 id="browser-result-title">保存到你的设备</h2></div>
        </div>
        {ready ? <>
          <div className={styles.preview}><img src={ready.preview} alt="当前浏览器拼接的 NASA Blue Marble 影像预览" /></div>
          <a className={styles.download} href={ready.archive} download={`geod-browser-${Date.now()}.zip`}><Download size={17} aria-hidden="true" />保存数据包</a>
          <p className={styles.finePrint}>ZIP 包含 imagery.png、imagery.pgw、imagery.prj 和 manifest.json。保存操作由浏览器完成，文件不会经过 GeoD 服务器。</p>
        </> : <div className={styles.empty}>
          {plan ? <><strong>{plan.tiles} 块瓦片</strong><span>{plan.width} × {plan.height} 像素 · 预计 RGBA 内存约 {Math.ceil(plan.width * plan.height * 4 / 1024 / 1024)} MiB</span></> : <><strong>等待范围规划</strong><span>结果会在当前页面生成，不占用 GeoD 服务器的下载和拼接资源。</span></>}
        </div>}
        <div className={styles.runtime}><span className={styles.dot} />{webMcpStatus}</div>
        <p className={styles.finePrint}>WebMCP 需要 Agent 打开此页面并支持网页工具。即使不支持 WebMCP，也可用上面的按钮手动下载；关闭页面会中止未完成的任务。</p>
      </section>
    </div>
  );
}
