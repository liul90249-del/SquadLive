// Meta reports keep the advertising account's timezone and attribution window.
// They never overwrite UTC MMP installs, backend users, or verified Apple revenue.
const DAY=86400000;
const fail=message=>Object.assign(new Error(message),{status:400});
const safeId=v=>/^\d{5,30}$/.test(String(v||''));
const amount=v=>{if(!/^\d+(\.\d{1,8})?$/.test(String(v)))throw fail('Meta 返回了无效金额');const n=Math.round(Number(v)*1000);if(!Number.isSafeInteger(n))throw fail('Meta 金额超出范围');return n;};
const count=v=>{if(!/^\d+(\.\d+)?$/.test(String(v)))throw fail('Meta 返回了无效指标');const n=Number(v);if(!Number.isFinite(n)||n>1e12)throw fail('Meta 指标超出范围');return n;};
const text=v=>String(v||'').slice(0,180);
export function metaConfig(env=process.env){return {token:env.CLEANER_META_REPORT_TOKEN||'',accountId:(env.CLEANER_META_AD_ACCOUNT_ID||'1807440220375930').replace(/^act_/,''),version:env.CLEANER_META_GRAPH_VERSION||'',enabled:env.CLEANER_META_SYNC_ENABLED==='true',appId:'1696669821817486',pixelId:'1704162081432639'};}
export function cleanerLanding(value){try{const u=new URL(value);return u.protocol==='https:'&&['www.cleann.top','cleann.top','smart-cleaner-acquisition.liufeng19970513.chatgpt.site'].includes(u.hostname)&&(u.hostname.endsWith('.chatgpt.site')||u.pathname.startsWith('/acquisition/'));}catch{return false;}}
export function classifyMetaAd(ad,config){
 const set=ad.adset||{},p=set.promoted_object||{},c=ad.creative||{};
 const links=[c.object_url,c.object_story_spec?.link_data?.link,c.object_story_spec?.video_data?.call_to_action?.value?.link,c.link_url];
 const landing=links.some(cleanerLanding),app=String(p.application_id||'')===config.appId,pixel=String(p.pixel_id||'')===config.pixelId;
 if(!landing&&!app&&!pixel)return {included:false,route:'unknown'};
 if(set.destination_type==='APP'&&app)return {included:true,route:'app_direct'};
 if(set.destination_type==='WEBSITE'&&landing)return {included:true,route:'web_to_app'};
 if(set.destination_type==='WEBSITE'&&pixel)return {included:true,route:'web'};
 return {included:true,route:'unknown'};
}
const actionMap=rows=>Object.fromEntries((rows||[]).map(r=>[text(r.action_type),count(r.value)]));
export function normalizeMetaRows(rows,ads,account,config,start,end){
 if(!/^[A-Z]{3}$/.test(account.currency||'')||!account.timezone_name)throw fail('Meta 账户币种或统计时区缺失');
 const seen=new Set(),out=[];
 for(const r of rows){
  if(!safeId(r.ad_id)||!safeId(r.adset_id)||!safeId(r.campaign_id)||r.date_start!==r.date_stop||!/^\d{4}-\d{2}-\d{2}$/.test(r.date_start)||r.date_start<start||r.date_start>end)throw fail('Meta 报表日期或广告层级不完整，原数据保留');
  const ad=ads[r.ad_id];if(!ad)throw fail('Meta 广告元数据不完整，原数据保留');
  const route=classifyMetaAd(ad,config);if(!route.included)continue;
  const key=JSON.stringify([r.date_start,r.ad_id]);if(seen.has(key))throw fail('Meta 报表存在重复广告行');seen.add(key);
  if(r.account_currency&&r.account_currency!==account.currency)throw fail('Meta 账户币种不一致');
  const actions=actionMap(r.actions),values=actionMap(r.action_values);
  out.push({key,date:r.date_start,channel:'facebook',accountId:config.accountId,timezone:account.timezone_name,currency:account.currency,route:route.route,adId:r.ad_id,adName:text(r.ad_name),adGroupId:r.adset_id,adGroupName:text(r.adset_name),campaignId:r.campaign_id,campaignName:text(r.campaign_name),spendMilliunits:amount(r.spend),impressions:count(r.impressions),clicks:count(r.clicks),actions,actionValues:values,attributionSetting:text(r.attribution_setting)||'广告组归因设置',actionReportTime:'impression',source:'meta-insights-api'});
 }
 return out;
}
export function metaStatus(config,state={},running=false){return {configured:Boolean(config.token&&safeId(config.accountId)&&/^v\d+\.\d+$/.test(config.version)),enabled:config.enabled,accountId:safeId(config.accountId)?config.accountId:null,running,lastAttempt:state.lastAttempt||null,lastSuccess:state.lastSuccess||null,error:state.error||null,conversionError:state.conversionError||null,timezone:state.timezone||null,currency:state.currency||null,start:state.start||null,end:state.end||null,rows:state.rows??null,schedule:'每 15 分钟回补最近 28 个账户统计日',source:'Meta Ads Insights',actionReportTime:'impression',requiredPermission:'ads_read'};}
export function createMetaSync({getStore,saveStore,config=metaConfig(),fetchImpl=fetch,clock=Date.now}){
 let running;
 async function request(path,params={},stage='广告资料'){
  const u=new URL(`https://graph.facebook.com/${config.version}/${path}`);for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  let r,body;
  try{r=await fetchImpl(u,{headers:{Authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(45000),redirect:'error'});body=await r.text();}catch{throw fail(`Meta ${stage}请求失败或超时，原数据保留`);}
  let b={};
  try{if(body.length>4000000)throw Error();b=JSON.parse(body)||{};}catch{if(r.ok)throw fail(`Meta ${stage}响应格式无效，原数据保留`);}
  if(!r.ok||b.error){
   const code=Number(b.error?.code);
   const hint=r.status===401||r.status===403||code===190?'，请核对广告账号、ads_read 权限及口令有效期':'';
   throw Object.assign(fail(`Meta ${stage}读取失败（HTTP ${r.status}${Number.isInteger(code)?`，错误码 ${code}`:''}）${hint}`),{retryable:r.status>=500});
  }
  return b;
 }
 async function pages(path,params,stage){const out=[];let after;const cursors=new Set();for(let i=0;i<50;i++){const b=await request(path,{...params,...after?{after}: {}},stage);if(!Array.isArray(b.data))throw fail('Meta 报表格式无效');out.push(...b.data);if(out.length>10000)throw fail('Meta 报表超过单次上限，原数据保留');if(!b.paging?.next)return out;after=b.paging.cursors?.after;if(!after||cursors.has(after))throw fail('Meta 分页不完整，原数据保留');cursors.add(after);}throw fail('Meta 分页超出上限，原数据保留');}
 const status=async()=>metaStatus(config,(await getStore()).cleanerMetaReports?.status,running!==undefined);
 async function perform(){
  const root=await getStore(),previous=root.cleanerMetaReports,now=clock();
  try{
   const account=await request(`act_${config.accountId}`,{fields:'id,currency,timezone_name'},'账户信息');
   let today;try{today=new Intl.DateTimeFormat('en-CA',{timeZone:account.timezone_name,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));}catch{throw fail('Meta 账户时区无效');}
   const start=new Date(Date.parse(today+'T00:00:00Z')-27*DAY).toISOString().slice(0,10),end=today;
   const insights=`act_${config.accountId}/insights`;
   const spendFields='date_start,date_stop,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,account_currency';
   const params={level:'ad',time_increment:1,time_range:JSON.stringify({since:start,until:end}),limit:500};
   let rows,conversionError;
   try{
    rows=await pages(insights,{...params,fields:spendFields+',actions,action_values,attribution_setting',action_report_time:'impression',use_unified_attribution_setting:'true'},'花费与转化报表');
   }catch(error){
    if(!error.retryable)throw error;
    conversionError=error.message;
    rows=await pages(insights,{...params,fields:spendFields},'基础花费报表');
   }
   const ads={};const ids=[...new Set(rows.map(r=>r.ad_id))];
   for(let i=0;i<ids.length;i+=25){const group=ids.slice(i,i+25);if(!group.every(safeId))throw fail('Meta 广告 ID 无效');const b=await request('',{ids:group.join(','),fields:'id,adset{destination_type,promoted_object},creative{object_url,object_story_spec,link_url}'});for(const id of group)if(b[id]&&!b[id].error)ads[id]=b[id];}
   const normalized=normalizeMetaRows(rows,ads,account,config,start,end);
   const old=previous?.accountId===config.accountId?previous.rows||[]:[];
   const oldByKey=new Map(old.map(row=>[row.key,row]));
   const reportRows=conversionError?normalized.map(row=>{
    const previousRow=oldByKey.get(row.key);
    return {...row,actions:previousRow?.actions,actionValues:previousRow?.actionValues,attributionSetting:previousRow?.attributionSetting,conversionsUnavailable:!previousRow||previousRow.conversionsUnavailable};
   }):normalized;
   root.cleanerMetaReports={accountId:config.accountId,rows:[...old.filter(r=>r.date<start||r.date>end),...reportRows].filter(r=>Date.parse(r.date)>=now-730*DAY),status:{lastAttempt:now,lastSuccess:now,error:null,conversionError,rows:reportRows.length,start,end,timezone:account.timezone_name,currency:account.currency}};
   try{await saveStore(root);}catch{root.cleanerMetaReports=previous;throw fail('Meta 报表保存失败，原数据保留');}
   return metaStatus(config,root.cleanerMetaReports.status);
  }catch(e){root.cleanerMetaReports={...(previous||{accountId:config.accountId,rows:[]}),status:{...previous?.status,lastAttempt:now,error:e.status===400?e.message:'Meta 同步失败，原数据保留'}};try{await saveStore(root);}catch{root.cleanerMetaReports=previous;}throw fail(e.status===400?e.message:'Meta 同步失败，原数据保留');}
 }
 const run=()=>{if(!metaStatus(config).configured)return Promise.reject(fail('尚未配置 Meta 广告账号、只读报表口令及 Graph API 版本'));if(!running)running=perform().finally(()=>{running=undefined;});return running;};
 return {status,run,async tick(){if(!config.enabled||running)return;const s=await status();if(!s.configured||s.lastAttempt&&clock()-s.lastAttempt<(s.error?3600000:900000))return;try{await run();}catch{}}};
}
export function metaReportDataset(root){const s=root.cleanerMetaReports;return {rows:s?.rows||[],timezone:s?.status?.timezone||null,currency:s?.status?.currency||null};}
