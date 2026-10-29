"use client";
import type { ComponentProps } from 'react';
import CTALink from '../_components/CTALink';
import { trackProductEvent } from '@/lib/product-analytics';
import { AGENT_PUBLIC_VERSION } from '@/lib/agent-release';

export default function AgentDownloadLink({onClick,...props}:ComponentProps<typeof CTALink>){
 return <CTALink {...props} onClick={event=>{
  onClick?.(event);
  if(event.defaultPrevented)return;
  void trackProductEvent('download_clicked',{platform:'windows',version:AGENT_PUBLIC_VERSION,channel:String(props.href).includes('github.com')?'github':'mirror',campaign:'geod-agent-download'});
 }}/>;
}
