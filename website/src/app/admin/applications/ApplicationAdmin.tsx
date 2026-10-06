"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, RefreshCw, Search } from "lucide-react";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { applicationRequest, ApplicationRequestError, applicationProducts, applicationStatuses, productLabels, statusLabels, notificationLabels, type ApplicationProduct, type ApplicationStatus, type ApplicationRecord } from "@/lib/applications";
import styles from "../../applications.module.css";

type Results={items:ApplicationRecord[];total:number;counts:{status:ApplicationStatus;count:number}[];funnel:{event_name:string;count:number}[];notificationConfigured:boolean};
const date=(value:string)=>new Date(value).toLocaleString("zh-CN",{hour12:false});
const funnelLabels:Record<string,string>={entry_clicked:"入口点击",opened:"打开申请",started:"开始填写",submitted:"提交尝试",accepted:"成功保存",failed:"提交失败"};
export default function ApplicationAdmin(){
  const [product,setProduct]=useState<ApplicationProduct|"">(""),[status,setStatus]=useState<ApplicationStatus|"">(""),[search,setSearch]=useState(""),[query,setQuery]=useState(""),[offset,setOffset]=useState(0);
  const [data,setData]=useState<Results|null>(null),[active,setActive]=useState<ApplicationRecord|null>(null),[editStatus,setEditStatus]=useState<ApplicationStatus>("new"),[note,setNote]=useState("");
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[gate,setGate]=useState("");
  const generation=useRef(0),activeId=useRef(""),action=useRef(false);
  function choose(item:ApplicationRecord|null){activeId.current=item?.id||"";setActive(item);setEditStatus(item?.status||"new");setNote(item?.note||"");setNotice("");}
  const load=useCallback(async()=>{
    const sequence=++generation.current;setLoading(true);setError("");
    try{const value=await applicationRequest<Results>("/admin/query",{product,status,query,offset});if(sequence!==generation.current)return;setData(value);setGate("");choose(value.items.find(v=>v.id===activeId.current)||value.items[0]||null);}
    catch(reason){if(sequence!==generation.current)return;const code=reason instanceof ApplicationRequestError?reason.code:"";if(["AUTH_REQUIRED","APPLICATION_ADMIN_REQUIRED"].includes(code)){setGate(code);setData(null);choose(null);}else setError(reason instanceof Error?reason.message:"读取未完成，请重试。");}
    finally{if(sequence===generation.current)setLoading(false);}
  },[product,status,query,offset]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  async function save(){if(!active||action.current)return;action.current=true;setBusy(true);setError("");setNotice("");
    try{const {item}=await applicationRequest<{item:ApplicationRecord}>("/admin/update",{id:active.id,version:active.version,status:editStatus,note});const oldStatus=active.status;choose(item);setData(value=>value?{...value,items:value.items.map(v=>v.id===item.id?item:v),counts:applicationStatuses.map(s=>({status:s,count:(value.counts.find(v=>v.status===s)?.count||0)+(item.status!==oldStatus?(s===oldStatus?-1:s===item.status?1:0):0)}))}:value);setNotice("处理记录已保存。");}
    catch(reason){setError(reason instanceof Error?reason.message:"保存未完成。");}finally{action.current=false;setBusy(false);}
  }
  async function notify(){if(!active||action.current)return;action.current=true;setBusy(true);setError("");
    try{const {item}=await applicationRequest<{item:ApplicationRecord}>("/admin/notify",{id:active.id});choose(item);setData(value=>value?{...value,items:value.items.map(v=>v.id===item.id?item:v)}:value);setNotice(`通知状态：${notificationLabels[item.notification]||item.notification}。`);}
    catch(reason){setError(reason instanceof Error?reason.message:"通知未完成。");}finally{action.current=false;setBusy(false);}
  }
  function find(event:FormEvent){event.preventDefault();setOffset(0);setQuery(search.trim());if(query===search.trim()&&offset===0)void load();}
  return <main className={styles.page}>
    <section className={styles.intro}><span className={styles.eyebrow}>GEOD / OPERATIONS</span><h1>每个申请，都有后续。</h1><p className={styles.muted}>按产品查看用途与来源，记录联系进展。这里的状态由管理员维护，标记“已发邀请”不会自动发送邀请码。</p></section>
    {gate?<section className={styles.card}><h2>{gate==="AUTH_REQUIRED"?"请先登录管理员账号":"当前账号没有申请管理权限"}</h2><p className={styles.muted}>申请记录仅向配置在 GeoD 管理员名单中的账号开放。</p><div className={styles.actions}><ButtonLink href="/login?returnTo=%2Fadmin%2Fapplications">登录 GeoD<ArrowRight size={16} /></ButtonLink><ButtonLink variant="secondary" href="/dashboard">个人控制台</ButtonLink></div></section>:<>
      <div className={styles.metrics}>{applicationStatuses.map(s=><div className={styles.metric} key={s}><span>{statusLabels[s]}</span><strong>{data?(data.counts.find(v=>v.status===s)?.count||0):"—"}</strong></div>)}</div>
      <p className={styles.funnel}>最近 30 天申请事件：{data?.funnel.length?data.funnel.map(v=>`${funnelLabels[v.event_name]||v.event_name} ${v.count}`).join(" · "):"暂无事件"}。事件数包含多次操作；“成功保存”来自服务端，不代表已开通。</p>
      {data&&!data.notificationConfigured&&<p className={styles.notice}>邮件通知尚未配置。申请已正常保存，可在这里处理；通知模板配置后再补发管理员通知。</p>}
      <section className={styles.filters} aria-label="申请筛选">
        <div className={styles.chips} role="group" aria-label="筛选产品"><button className={styles.chip} aria-pressed={!product} disabled={busy} onClick={()=>{setProduct("");setOffset(0);}}>所有产品</button>{applicationProducts.map(p=><button key={p} className={styles.chip} aria-pressed={product===p} disabled={busy} onClick={()=>{setProduct(p);setOffset(0);}}>{productLabels[p]}</button>)}</div>
        <div className={styles.chips} role="group" aria-label="筛选状态"><button className={styles.chip} aria-pressed={!status} disabled={busy} onClick={()=>{setStatus("");setOffset(0);}}>所有状态</button>{applicationStatuses.map(s=><button key={s} className={styles.chip} aria-pressed={status===s} disabled={busy} onClick={()=>{setStatus(s);setOffset(0);}}>{statusLabels[s]}</button>)}</div>
        <form className={styles.search} onSubmit={find}><input className={styles.input} aria-label="搜索邮箱或申请编号" placeholder="邮箱或申请编号" maxLength={254} disabled={busy} value={search} onChange={e=>setSearch(e.target.value)} /><Button variant="secondary" type="submit" disabled={busy||loading}><Search size={16} />搜索</Button><Button variant="ghost" aria-label="刷新申请" disabled={busy||loading} onClick={()=>void load()}><RefreshCw size={16} /></Button></form>
      </section>
      {error&&<p className={styles.error} role="alert">{error} <button className={styles.chip} disabled={busy} onClick={()=>void load()}>刷新列表</button></p>}
      {loading?<p role="status" className={styles.muted}>正在读取申请…</p>:data&&!data.items.length?<section className={styles.card}><h2>还没有符合条件的申请</h2><p className={styles.muted}>调整筛选条件，或从申请页提交一条记录。</p></section>:data&&<div className={styles.adminLayout}>
        <section className={styles.list} aria-label="申请列表"><p className={styles.muted}>共 {data.total} 条 · 第 {offset+1}–{Math.min(offset+50,data.total)} 条</p>{data.items.map(item=><button key={item.id} className={styles.listItem} aria-pressed={active?.id===item.id} disabled={busy} onClick={()=>choose(item)}><span className={styles.badge}>{statusLabels[item.status]} · {item.products.map(p=>productLabels[p]).join(" / ")}</span><strong>{item.name||item.email}</strong><small>{item.id}</small><small>{date(item.createdAt)}</small></button>)}<div className={styles.actions}><Button variant="secondary" disabled={!offset||busy} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</Button><Button variant="secondary" disabled={offset+50>=data.total||busy} onClick={()=>setOffset(offset+50)}>下一页</Button></div></section>
        {active&&<section className={`${styles.card} ${styles.detail}`} aria-label="申请详情"><h2>{active.id}</h2><dl className={styles.details}><dt>联系邮箱</dt><dd>{active.email}</dd><dt>称呼</dt><dd>{active.name||"未填写"}</dd><dt>产品</dt><dd>{active.products.map(p=>productLabels[p]).join("、")}</dd><dt>用途</dt><dd>{active.useCase}</dd><dt>来源页面</dt><dd>{active.sourcePath}</dd><dt>来源域名</dt><dd>{active.referrerHost||"未记录"}</dd><dt>渠道</dt><dd>{[active.source,active.medium,active.campaign].filter(Boolean).join(" / ")||"未标注"}</dd><dt>提交时间</dt><dd>{date(active.createdAt)}</dd><dt>通知</dt><dd>{notificationLabels[active.notification]||active.notification}</dd></dl>
          {active.notification==="unknown"&&<p className={styles.notice}>上次发送结果不确定。请先按申请编号核对收件箱，避免重复通知。</p>}
          {data.notificationConfigured&&["pending","failed","unconfigured"].includes(active.notification)&&<Button variant="secondary" disabled={busy} onClick={()=>void notify()}>补发管理员通知</Button>}
          <div className={styles.field}><span id="edit-status-label">处理状态</span><div className={styles.chips} role="group" aria-labelledby="edit-status-label">{applicationStatuses.map(s=><button key={s} className={styles.chip} disabled={busy} aria-pressed={editStatus===s} onClick={()=>setEditStatus(s)}>{editStatus===s&&<Check size={13} />}{statusLabels[s]}</button>)}</div></div>
          <label className={styles.field}>处理备注<textarea className={styles.textarea} maxLength={2000} placeholder="例如：已回复接入步骤，等待用户测试结果。" disabled={busy} value={note} onChange={e=>setNote(e.target.value)} /></label><div className={styles.actions}><Button disabled={busy} onClick={()=>void save()}>{busy?"处理中…":"保存处理记录"}</Button>{notice&&<span role="status" className={styles.muted}>{notice}</span>}</div>
          <div className={styles.history}><strong>处理历史</strong>{active.history.length?<ul>{active.history.slice().reverse().map((entry,i)=><li key={i}>{date(entry.at)} · {statusLabels[entry.status]}<br />{entry.note||"无备注"}</li>)}</ul>:<p className={styles.muted}>尚未处理。</p>}</div>
        </section>}
      </div>}
    </>}
  </main>;
}
