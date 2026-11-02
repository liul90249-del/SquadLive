import {reportingDate,CLEANER_REPORT_TIMEZONE} from './marketing-time.mjs';
import {createHash} from 'node:crypto';
import {WEB_RETURN_ORIGINS} from './web-return-attribution.mjs';
const DAY=86400000,sha=v=>createHash('sha256').update(v).digest('hex');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const keys=['utm_source','utm_medium','utm_campaign','utm_content','campaign_id','adset_id','adset_name','ad_id'];
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function createWebFunnel({getStore,saveStore,clock=Date.now}){
 let queue=Promise.resolve();
 const record=(body,origin)=>{
  const task=queue.then(async()=>{
   if(!WEB_RETURN_ORIGINS.has(origin)||body?.consent!==true)throw fail('Measurement consent and website origin required',403);
   if(!uuid(body.eventId)||!uuid(body.visitId)||!['PageView','WebOnboardingComplete','WebDownloadClick'].includes(body.name))throw fail('Invalid website event');
   const campaign={};for(const k of keys){const v=body.campaign?.[k];if(typeof v==='string'&&v.trim()&&v.length<=160&&!/[\u0000-\u001f{}]/.test(v))campaign[k]=v.trim();}
   const root=await getStore(),previous=root.cleanerWebFunnel,time=clock(),events={...previous?.events};
   const id=sha(body.eventId);if(events[id])return {recorded:true,duplicate:true};
   for(const [key,e] of Object.entries(events))if(e.at<time-90*DAY)delete events[key];
   if(Object.keys(events).length>=50000)throw fail('Website measurement temporarily full',503);
   events[id]={at:time,name:body.name,visit:sha(body.visitId),campaign,flow:body.flow==='onboarding'?'onboarding':'landing'};
   root.cleanerWebFunnel={events,startedAt:previous?.startedAt||time};
   try{await saveStore(root);}catch(e){root.cleanerWebFunnel=previous;throw e;}return {recorded:true};
  });queue=task.catch(()=>{});return task;
 };
 return {record};
}
export function webFunnelDataset(root){
 const groups=new Map(),s=root.cleanerWebFunnel;
 for(const e of Object.values(s?.events||{})){
  const date=reportingDate(e.at),key=JSON.stringify([date,...keys.map(k=>e.campaign[k]||'')]);
  if(!groups.has(key))groups.set(key,{date,campaign:e.campaign,visits:new Set(),completions:new Set(),downloadVisits:new Set(),pageViews:0,downloadClicks:0});
  const r=groups.get(key);if(e.name==='PageView'){r.visits.add(e.visit);r.pageViews++;}if(e.name==='WebOnboardingComplete')r.completions.add(e.visit);if(e.name==='WebDownloadClick'){r.downloadVisits.add(e.visit);r.downloadClicks++;}
 }
 return {startedAt:s?.startedAt||null,timezone:CLEANER_REPORT_TIMEZONE,retentionDays:90,rows:[...groups.values()].map(r=>({...r,visits:r.visits.size,completions:r.completions.size,downloadVisits:r.downloadVisits.size}))};
}
