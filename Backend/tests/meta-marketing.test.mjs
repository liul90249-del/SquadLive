import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyMetaAd,normalizeMetaRows,createMetaSync,metaStatus,metaConfig} from '../meta-marketing.mjs';
import {buildMarketingPathsReport} from '../marketing-paths-report.mjs';
import {marketingPathsHTML,webFunnelHTML} from '../admin-marketing-paths.mjs';
const config={token:'never-print-this',accountId:'1807440220375930',version:'v25.0',enabled:true,appId:'1696669821817486',pixelId:'1704162081432639'};
const account={currency:'USD',timezone_name:'America/Los_Angeles'};
const raw={date_start:'2026-11-01',date_stop:'2026-11-01',ad_id:'123456',adset_id:'234567',campaign_id:'345678',spend:'50.25',impressions:'1000',clicks:'25',account_currency:'USD',attribution_setting:'7d_click,1d_view',actions:[{action_type:'landing_page_view',value:'10'},{action_type:'offsite_conversion.fb_pixel_purchase',value:'2'},{action_type:'app_custom_event.fb_mobile_purchase',value:'1'},{action_type:'omni_purchase',value:'3'}],action_values:[{action_type:'offsite_conversion.fb_pixel_purchase',value:'19.98'},{action_type:'app_custom_event.fb_mobile_purchase',value:'9.99'},{action_type:'omni_purchase',value:'29.97'}]};
const webAd={adset:{destination_type:'WEBSITE',promoted_object:{pixel_id:config.pixelId}},creative:{object_story_spec:{link_data:{link:'https://www.cleann.top/acquisition/onboarding.html'}}}};
const rows=()=>normalizeMetaRows([raw],{'123456':webAd},account,config,'2026-11-01','2026-11-02');
test('actual destination distinguishes web, web-to-app, app and unknown without campaign-name guesses',()=>{
 assert.equal(classifyMetaAd(webAd,config).route,'web_to_app');
 assert.equal(classifyMetaAd({...webAd,creative:{}},config).route,'web');
 assert.equal(classifyMetaAd({adset:{destination_type:'APP',promoted_object:{application_id:config.appId}}},config).route,'app_direct');
 assert.equal(classifyMetaAd({adset:{destination_type:'APP_AND_WEBSITE',promoted_object:{application_id:config.appId}}},config).route,'unknown');
 assert.equal(classifyMetaAd({name:'Cleaner Web',adset:{destination_type:'APP',promoted_object:{application_id:'99999'}}},config).included,false);
 assert.equal(classifyMetaAd({...webAd,adset:{destination_type:'WEBSITE'},creative:{object_url:'https://www.cleann.top.evil.example/acquisition/'}},config).included,false);
});
test('Meta report preserves account timezone, currency, raw actions and unique daily ad scope',()=>{
 const r=rows()[0];assert.equal(r.spendMilliunits,50250);assert.equal(r.timezone,'America/Los_Angeles');assert.equal(r.actions.omni_purchase,3);
 assert.throws(()=>normalizeMetaRows([raw,raw],{'123456':webAd},account,config,'2026-11-01','2026-11-02'),/重复/);
 assert.throws(()=>normalizeMetaRows([raw],{},account,config,'2026-11-01','2026-11-02'),/元数据/);
 assert.throws(()=>normalizeMetaRows([{...raw,account_currency:'EUR'}],{'123456':webAd},account,config,'2026-11-01','2026-11-02'),/币种/);
});
test('platform outcomes never double-count omni aliases or mix web and app purchase revenue',()=>{
 const r=buildMarketingPathsReport({rows:rows()},{start:'2026-11-01',end:'2026-11-02',currency:'USD',channel:'facebook'}).routes.find(r=>r.route==='web_to_app');
 assert.equal(r.spendMilliunits,50250);assert.equal(r.webPurchases,2);assert.equal(r.appPurchases,1);assert.equal(r.webPurchaseMilliunits,19980);assert.equal(r.appPurchaseMilliunits,9990);
 assert.equal(buildMarketingPathsReport({rows:rows()},{channel:'applovin'}).rows.length,0);
 assert.equal(buildMarketingPathsReport({rows:rows()},{currency:'EUR'}).rows.length,0);
 assert.equal(buildMarketingPathsReport({rows:rows()},{campaignId:'different'}).rows.length,0);
});
function fixture(){const root={marketing:{cleaner:{costs:{keep:{spendMilliunits:123}},attributions:{}}},cleanerMetaReports:{accountId:config.accountId,rows:[{date:'2026-10-30',old:true}],status:{lastSuccess:1}}};const calls=[];let broken=false,saves=0;
 const fetchImpl=async(url,options)=>{assert.equal(url.hostname,'graph.facebook.com');assert.equal(url.searchParams.has('access_token'),false);assert.equal(options.headers.Authorization,'Bearer '+config.token);calls.push(url);if(broken)return new Response(JSON.stringify({error:{message:config.token}}),{status:403});let value;if(url.pathname.endsWith('/insights'))value={data:[raw]};else if(url.searchParams.has('ids'))value={'123456':webAd};else value=account;return new Response(JSON.stringify(value));};
 return {root,calls,break:()=>broken=true,saves:()=>saves,api:createMetaSync({getStore:async()=>root,saveStore:async()=>{saves++;},config,fetchImpl,clock:()=>Date.parse('2026-11-02T06:00:00Z')})};}
test('sync runs read-only, uses account-local date and never rewrites other cost or attribution stores',async()=>{const f=fixture();await f.api.run();assert.equal(f.root.cleanerMetaReports.status.end,'2026-11-01');assert.equal(f.root.cleanerMetaReports.rows.length,1);assert.equal(f.root.marketing.cleaner.costs.keep.spendMilliunits,123);assert.deepEqual(f.root.marketing.cleaner.attributions,{});assert.equal(f.calls.find(u=>u.pathname.endsWith('/insights')).searchParams.get('action_report_time'),'impression');});
test('failed API preserves prior rows and redacts service-supplied secrets from errors and status',async()=>{const f=fixture();f.break();await assert.rejects(f.api.run(),/ads_read/);assert.equal(f.root.cleanerMetaReports.rows[0].old,true);assert.equal(JSON.stringify(f.root).includes(config.token),false);assert.equal(JSON.stringify(await f.api.status()).includes(config.token),false);});
test('conversion HTTP 500 falls back to spend and leaves unavailable conversions blank',async()=>{
 const root={};
 const api=createMetaSync({
  getStore:async()=>root,saveStore:async()=>{},config,clock:()=>Date.parse('2026-11-02T06:00:00Z'),
  fetchImpl:async url=>{
   if(url.pathname.endsWith('/insights')){
    if(url.searchParams.has('action_report_time'))return new Response(JSON.stringify({error:{code:1,message:config.token}}),{status:500});
    return new Response(JSON.stringify({data:[raw]}));
   }
   return new Response(JSON.stringify(url.searchParams.has('ids')?{'123456':webAd}:account));
  }
 });
 const result=await api.run();
 assert.match(result.conversionError,/HTTP 500，错误码 1/);
 assert.equal(result.conversionError.includes(config.token),false);
 const report=buildMarketingPathsReport({rows:root.cleanerMetaReports.rows});
 assert.equal(report.rows[0].spendMilliunits,50250);
 assert.equal(report.rows[0].appInstalls,null);
 assert.equal(report.routes.find(route=>route.route==='web_to_app').appPurchases,null);
});
test('report configuration cannot trigger API calls without all explicit credentials and version',async()=>{assert.equal(metaConfig({}).accountId,'1807440220375930');assert.equal(metaStatus(metaConfig({})).configured,false);const f=createMetaSync({getStore:async()=>({}),saveStore:async()=>{},config:{...config,token:''},fetchImpl:()=>{throw Error('must not fetch');}});await assert.rejects(f.run(),/尚未配置/);});
test('confirmed Beijing account changes reporting day at UTC16:00, not UTC midnight',async()=>{
 for(const [instant,expectedDay] of [['2026-11-01T15:59:59Z','2026-11-01'],['2026-11-01T16:00:00Z','2026-11-02'],['2026-11-02T00:00:00Z','2026-11-02']]){
  const root={};let requestedEnd;
  const api=createMetaSync({getStore:async()=>root,saveStore:async()=>{},config,clock:()=>Date.parse(instant),fetchImpl:async url=>{
   if(url.pathname.endsWith('/insights')){requestedEnd=JSON.parse(url.searchParams.get('time_range')).until;return new Response(JSON.stringify({data:[]}));}
   return new Response(JSON.stringify({currency:'USD',timezone_name:'Asia/Shanghai'}));
  }});
  const result=await api.run();assert.equal(requestedEnd,expectedDay);assert.equal(result.end,expectedDay);assert.equal(result.timezone,'Asia/Shanghai');assert.equal(root.cleanerMetaReports.status.timezone,'Asia/Shanghai');
 }
});
test('admin renders distinct evidence sources and escapes campaign data, never a report token',()=>{const r=rows();r[0].campaignName='<script>alert(1)</script>';const html=marketingPathsHTML({product:'cleaner',now:Date.now(),meta:metaStatus(config),metaReports:{rows:r}},{currency:'USD'});assert.ok(html.includes('Web → App'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes(config.token));assert.ok(html.includes('北京时间 UTC+8'));assert.ok(webFunnelHTML({product:'cleaner'},{currency:'USD'}).includes('不能补造'));});
