"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, CheckCircle2, Copy, Mail } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { applicationProducts, productLabels, applicationRequest, applicationEvent, applicationSource, ApplicationRequestError, type ApplicationProduct } from "@/lib/applications";
import styles from "../applications.module.css";

export default function ApplicationForm() {
  const [selected,setSelected]=useState<ApplicationProduct[]>(["mcp"]);
  const [email,setEmail]=useState(""),[name,setName]=useState(""),[useCase,setUseCase]=useState(""),[consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[receipt,setReceipt]=useState<{id:string;createdAt:string}|null>(null),[copied,setCopied]=useState(false);
  const submission=useRef(""),lastBody=useRef(""),started=useRef(false),opened=useRef(false),inFlight=useRef(false),source=useRef<ReturnType<typeof applicationSource>>();
  const emailInput=useRef<HTMLInputElement>(null),useCaseInput=useRef<HTMLTextAreaElement>(null),errorNode=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{
    if(opened.current)return;opened.current=true;
    const product=new URLSearchParams(window.location.search).get("product") as ApplicationProduct;
    const next=applicationProducts.includes(product)?[product]:["mcp" as const];setSelected(next);source.current=applicationSource();
    submission.current=crypto.randomUUID();applicationEvent("opened",next,source.current.sourcePath,undefined,submission.current);
  },[]);
  function touch(){if(!started.current){started.current=true;applicationEvent("started",selected,source.current?.sourcePath||"/apply",undefined,submission.current);}}
  function invalid(message:string,field?:"email"|"useCase") {setError(message);applicationEvent("failed",selected,source.current?.sourcePath||"/apply","validation",submission.current);window.setTimeout(()=>field==="email"?emailInput.current?.focus():field==="useCase"?useCaseInput.current?.focus():errorNode.current?.focus(),0);}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(inFlight.current)return;setError("");
    if(!selected.length)return invalid("请选择你想使用的产品。");
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))return invalid("请输入有效的联系邮箱。","email");
    if(useCase.trim().length<10)return invalid("请用至少 10 个字说明你想做什么。","useCase");
    if(!consent)return invalid("请确认同意保存联系方式，用于处理这次申请。");
    const website=String(new FormData(event.currentTarget).get("website")||"");
    const body={products:selected,email:email.trim(),name:name.trim(),useCase:useCase.trim(),...(source.current||applicationSource()),consent:true,website};
    const fingerprint=JSON.stringify(body);if(lastBody.current&&lastBody.current!==fingerprint)submission.current=crypto.randomUUID();lastBody.current=fingerprint;
    inFlight.current=true;setBusy(true);applicationEvent("submitted",selected,body.sourcePath,undefined,submission.current);
    try {const result=await applicationRequest<{id:string;createdAt:string}>("",{...body,submissionId:submission.current});setReceipt(result);window.setTimeout(()=>document.getElementById("application-success")?.focus(),0);}
    catch(reason){setError(reason instanceof Error?reason.message:"申请暂未完成，请重试。");applicationEvent("failed",selected,body.sourcePath,reason instanceof ApplicationRequestError&&reason.code==="APPLICATION_RATE_LIMIT"?"rate_limit":reason instanceof ApplicationRequestError&&reason.code==="NETWORK"?"network":"server",submission.current);}
    finally{inFlight.current=false;setBusy(false);}
  }
  async function copy(){try{await navigator.clipboard.writeText(receipt!.id);setCopied(true);}catch{setError("复制未完成，请选中申请编号手动复制。");}}
  return <main className={styles.page}>
    <section className={styles.intro}><span className={styles.eyebrow}>LET’S BUILD WITH GEOD</span><h1>告诉我们，你想用 GeoD 做什么。</h1><p className={styles.muted}>接入遇到问题，或想参与后续功能测试？留下产品和使用场景，我们会通过邮箱联系。GeoD 账号可直接注册，无需先提交申请。</p></section>
    <div className={styles.layout}><section className={styles.card}>
      {receipt?<div className={styles.success}><CheckCircle2 className={styles.successIcon} size={54} aria-hidden="true" /><h2 id="application-success" tabIndex={-1}>申请已保存</h2><p className={styles.muted}>我们已收到你的用途和联系方式。请保留编号，方便后续查询；提交申请不会自动开通权限。</p><div><div className={styles.muted}>申请编号</div><div className={styles.receipt}>{receipt.id}</div></div><div className={styles.actions}><Button variant="secondary" onClick={()=>void copy()}><Copy size={16} />{copied?"已复制":"复制编号"}</Button><ButtonLink href="/">返回官网<ArrowRight size={16} /></ButtonLink></div>{error&&<p className={styles.error} role="alert">{error}</p>}</div>
      :<form className={styles.form} onSubmit={event=>void submit(event)} noValidate onFocus={touch}>
        <div className={styles.field}><span id="product-label">想使用的产品 <small>可多选</small></span><div className={styles.chips} role="group" aria-labelledby="product-label">{applicationProducts.map(product=><button type="button" className={styles.chip} aria-pressed={selected.includes(product)} key={product} disabled={busy} onClick={()=>setSelected(value=>value.includes(product)?value.filter(p=>p!==product):[...value,product])}>{selected.includes(product)&&<Check size={14} aria-hidden="true" />}{productLabels[product]}</button>)}</div></div>
        <label className={styles.field}><span>联系邮箱</span><input ref={emailInput} className={styles.input} type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} disabled={busy} value={email} onChange={e=>setEmail(e.target.value)} /></label>
        <label className={styles.field}><span>怎么称呼你 <small>选填</small></span><input className={styles.input} autoComplete="name" placeholder="你的名字或昵称" maxLength={80} disabled={busy} value={name} onChange={e=>setName(e.target.value)} /></label>
        <label className={styles.field}><span>你想做什么</span><textarea ref={useCaseInput} className={styles.textarea} placeholder="例如：想在 Codex 中按县界裁剪影像，已经安装 MCP，但登录时遇到了问题。" required minLength={10} maxLength={1200} disabled={busy} value={useCase} onChange={e=>setUseCase(e.target.value)} /><small className={styles.muted}>{useCase.length} / 1200 · 请勿填写密码、令牌或图源密钥。</small></label>
        <label className={styles.honeypot} aria-hidden="true">网站<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <button type="button" role="checkbox" aria-checked={consent} className={styles.consent} disabled={busy} onClick={()=>setConsent(!consent)}><span className={styles.check}>{consent&&<Check size={15} aria-hidden="true" />}</span><span>同意保存我的联系方式和申请内容，用于处理申请及回复问题。只有 GeoD 管理员可查看。</span></button>
        {error&&<p ref={errorNode} tabIndex={-1} className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}><Button type="submit" disabled={busy}>{busy?"正在保存…":"提交申请"}<ArrowRight size={16} aria-hidden="true" /></Button><span className={styles.muted}>无需登录即可提交</span></div>
      </form>}
    </section><aside className={styles.aside}><Mail size={24} color="var(--activeBaseColor)" aria-hidden="true" /><h2>已有产品，可以直接开始</h2><p>桌面端、CLI、MCP 和浏览器影像已有公开入口，不需要等待邀请码。更高级别的下载会引导你登录自己的 GeoD 账号。</p><p><a href="/cli">安装 CLI</a> · <a href="/mcp">接入 MCP</a> · <a href="/browser">浏览器影像</a></p><h2>提交之后</h2><p>申请会生成独立编号，并保存产品、来源页面和处理状态。需要进一步确认时，我们会通过你留下的邮箱联系。</p></aside></div>
  </main>;
}
