import {reportingDate} from './marketing-time.mjs';

// Advertising-platform outcomes remain separate from first-party associations
// and Apple-verified orders. Never add overlapping Meta action aliases.
export const ROUTE_NAMES={web:'Web · 网页内转化',web_to_app:'Web → App · 网页引导下载',app_direct:'App · 直接投放',unknown:'目的地待核对'};
const isMetaChannel=channel=>['facebook','meta','facebook ads'].includes(channel?.toLowerCase());
export function buildMarketingPathsReport(data,{start='',end='',currency='USD',channel='',campaignId='',adGroupId='',creativeId='',level='campaign',timezone}={},users=[]){
 const conversionFields=['landingPageViews','webCheckouts','webPurchases','webPurchaseMilliunits','appInstalls','appPurchases','appPurchaseMilliunits'];
 const groups=new Map();
 for(const r of data?.rows||[]){
  if(r.currency!==currency||start&&r.date<start||end&&r.date>end||channel&&!isMetaChannel(channel)||campaignId&&r.campaignId!==campaignId||adGroupId&&r.adGroupId!==adGroupId||creativeId&&r.adId!==creativeId)continue;
  const key=JSON.stringify([r.date,r.timezone,r.route,r.campaignId,r.adGroupId,r.adId]);
  if(groups.has(key))continue;
  const a=r.actions||{},v=r.actionValues||{};
  const outcome={...r,landingPageViews:a.landing_page_view||0,webCheckouts:a['offsite_conversion.fb_pixel_initiate_checkout']||0,webPurchases:a['offsite_conversion.fb_pixel_purchase']||0,webPurchaseMilliunits:Math.round((v['offsite_conversion.fb_pixel_purchase']||0)*1000),appInstalls:a.mobile_app_install||0,appPurchases:a['app_custom_event.fb_mobile_purchase']||0,appPurchaseMilliunits:Math.round((v['app_custom_event.fb_mobile_purchase']||0)*1000)};
  if(r.conversionsUnavailable)for(const field of conversionFields)outcome[field]=null;
  groups.set(key,outcome);
 }
 const rows=[...groups.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.route.localeCompare(b.route));
 const routes=Object.keys(ROUTE_NAMES).map(route=>({route,label:ROUTE_NAMES[route],rows:rows.filter(r=>r.route===route)}));
 const fields=['spendMilliunits','impressions','clicks',...conversionFields];
 const summarize=records=>Object.fromEntries(fields.map(field=>[field,
  records.length&&records.every(row=>row[field]!==null)
   ? records.reduce((total,row)=>total+row[field],0)
   : null
 ]));
 for(const route of routes)Object.assign(route,summarize(route.rows));
 const depth={channel:0,campaign:1,adGroup:2,creative:3}[level]??1;
 const platformGroups=new Map();
 for(const row of rows){
  const ids=[row.campaignId,row.adGroupId,row.adId].slice(0,depth);
  const names=[row.campaignName,row.adGroupName,row.adName].slice(0,depth);
  const key=JSON.stringify(ids);
  if(!platformGroups.has(key))platformGroups.set(key,{ids,names,rows:[],singularUsers:new Map()});
  platformGroups.get(key).rows.push(row);
 }
 // Compare the same local dates, joining strictly by IDs at the selected level.
 for(const user of users){
  const a=user.attribution;
  if(!user.singularDeviceAttributed||!user.id||!isMetaChannel(a?.channel)||channel&&!isMetaChannel(channel))continue;
  if(campaignId&&a.campaignId!==campaignId||adGroupId&&a.adGroupId!==adGroupId||creativeId&&a.creativeId!==creativeId)continue;
  const acquiredAt=new Date(a.acquiredAt);
  if(!a.acquiredAt||!Number.isFinite(acquiredAt.getTime()))continue;
  const date=reportingDate(acquiredAt,timezone);
  if(start&&date<start||end&&date>end)continue;
  const ids=[a.campaignId,a.adGroupId,a.creativeId].slice(0,depth);
  if(ids.some(id=>!id))continue;
  const key=JSON.stringify(ids);
  if(!platformGroups.has(key)){
   const names=[a.campaignName,a.adGroupName,a.creativeName].slice(0,depth);
   platformGroups.set(key,{ids,names,rows:[],singularUsers:new Map()});
  }
  platformGroups.get(key).singularUsers.set(user.id,date);
 }
 const breakdown=[...platformGroups.values()].map(group=>{
  const costDates=new Set(group.rows.filter(row=>Number.isFinite(row.spendMilliunits)).map(row=>row.date));
  return {
  label:['Meta',...group.ids.map((id,i)=>group.names[i]||id)].join(' / '),
  campaignId:group.ids[0]||'',adGroupId:group.ids[1]||'',creativeId:group.ids[2]||'',
  singularUsers:group.singularUsers.size,
  singularUserIds:[...group.singularUsers.keys()],
  hasCostForAcquiredUsers:[...group.singularUsers.values()].every(date=>costDates.has(date)),
  ...summarize(group.rows)
  };
 }).sort((a,b)=>b.spendMilliunits-a.spendMilliunits||a.label.localeCompare(b.label));

 return {rows,routes,breakdown,totals:summarize(rows),currency,timezones:[...new Set(rows.map(r=>r.timezone))],source:'Meta Ads Insights',actionReportTime:'impression',appleRevenueIncluded:false};
}
