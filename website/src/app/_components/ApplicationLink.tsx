"use client";
import type { ApplicationProduct } from "@/lib/applications";
import { applicationEvent } from "@/lib/applications";
export default function ApplicationLink({product="mcp",children,className}:{product?:ApplicationProduct;children:React.ReactNode;className?:string}) {
  return <a className={className} href={`/apply?product=${product}`} onClick={event=>{
    const path=window.location.pathname;const query=new URLSearchParams(window.location.search);
    const target=new URL(event.currentTarget.href);target.searchParams.set("from",path);
    for(const key of ["utm_source","utm_medium","utm_campaign"]){const value=query.get(key);if(value)target.searchParams.set(key,value);}
    event.currentTarget.href=target.href;applicationEvent("entry_clicked",[product],path);
  }}>{children}</a>;
}
