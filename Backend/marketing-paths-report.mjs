// Advertising-platform outcomes remain separate from first-party associations
// and Apple-verified orders. Never add overlapping Meta action aliases.
export const ROUTE_NAMES={web:'Web · 网页内转化',web_to_app:'Web → App · 网页引导下载',app_direct:'App · 直接投放',unknown:'目的地待核对'};
export function buildMarketingPathsReport(data,{start='',end='',currency='USD',channel='',campaignId='',adGroupId='',creativeId=''}={}){
 const conversionFields=['landingPageViews','webCheckouts','webPurchases','webPurchaseMilliunits','appInstalls','appPurchases','appPurchaseMilliunits'];
 const groups=new Map();
 for(const r of data?.rows||[]){
  if(r.currency!==currency||start&&r.date<start||end&&r.date>end||channel&&!['facebook','meta','facebook ads'].includes(channel.toLowerCase())||campaignId&&r.campaignId!==campaignId||adGroupId&&r.adGroupId!==adGroupId||creativeId&&r.adId!==creativeId)continue;
  const key=JSON.stringify([r.date,r.timezone,r.route,r.campaignId,r.adGroupId,r.adId]);
  if(groups.has(key))continue;
  const a=r.actions||{},v=r.actionValues||{};
  const outcome={...r,landingPageViews:a.landing_page_view||0,webCheckouts:a['offsite_conversion.fb_pixel_initiate_checkout']||0,webPurchases:a['offsite_conversion.fb_pixel_purchase']||0,webPurchaseMilliunits:Math.round((v['offsite_conversion.fb_pixel_purchase']||0)*1000),appInstalls:a.mobile_app_install||0,appPurchases:a['app_custom_event.fb_mobile_purchase']||0,appPurchaseMilliunits:Math.round((v['app_custom_event.fb_mobile_purchase']||0)*1000)};
  if(r.conversionsUnavailable)for(const field of conversionFields)outcome[field]=null;
  groups.set(key,outcome);
 }
 const rows=[...groups.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.route.localeCompare(b.route));
 const routes=Object.keys(ROUTE_NAMES).map(route=>({route,label:ROUTE_NAMES[route],rows:rows.filter(r=>r.route===route)}));
 for(const r of routes){r.spendMilliunits=r.rows.length?r.rows.reduce((n,v)=>n+v.spendMilliunits,0):null;for(const k of ['impressions','clicks',...conversionFields])r[k]=r.rows.length&&r.rows.every(row=>row[k]!==null)?r.rows.reduce((n,v)=>n+v[k],0):null;}
 return {rows,routes,currency,timezones:[...new Set(rows.map(r=>r.timezone))],source:'Meta Ads Insights',actionReportTime:'impression',appleRevenueIncluded:false};
}
