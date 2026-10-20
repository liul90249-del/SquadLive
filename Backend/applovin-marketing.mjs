import {csvRows,CSV_HEADERS,prepareMarketingImport,applyMarketingImport} from './marketing-import.mjs';
import {DAY,dateOf} from './marketing-core.mjs';

// Advertiser UA spend only. MAX publisher revenue and retargeting cannot be
// substituted for acquisition costs. Credentials never leave this module.
export const APPLOVIN_COLUMNS=['day','campaign_package_name','campaign_ad_type','campaign_id_external','campaign','creative_set_id','creative_set','cost','impressions','clicks','conversions'];
const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
const failure=m=>Object.assign(new Error(m),{status:400});
export function applovinConfig(env=process.env) {
  return {key:env.CLEANER_APPLOVIN_REPORT_KEY||'',currency:env.CLEANER_APPLOVIN_CURRENCY||'',
    bundleId:'com.hecathehe.PhoneCleaner',enabled:env.CLEANER_APPLOVIN_SYNC_ENABLED==='true'};
}
export function applovinStatus(config,state={}) {
  return {configured:Boolean(config.key&&/^[A-Z]{3}$/.test(config.currency)),enabled:config.enabled,
    currency:config.currency||null,lastAttempt:state.lastAttempt||null,lastSuccess:state.lastSuccess||null,
    error:state.error||null,rows:state.rows??null,start:state.start||null,end:state.end||null,
    schedule:'00:00 UTC / 北京时间 08:00',granularity:'广告系列 / 素材组'};
}
export function normalizeApplovinRows(rows,config,start,end) {
  if(!/^[A-Z]{3}$/.test(config.currency))throw failure('请在服务器配置并核实 AppLovin 报表币种');
  return rows.map(r=>{
    if(r.campaign_package_name!==config.bundleId||r.campaign_ad_type!=='ua')throw failure('AppLovin 返回了其他产品或再营销数据，已停止导入');
    if(!r.day||r.day<start||r.day>end||!r.campaign_id_external||!r.creative_set_id)throw failure('AppLovin 日期或稳定来源 ID 不完整');
    if(!/^\d+(?:\.\d+)?$/.test(String(r.cost)))throw failure('AppLovin 花费格式无效');
    const amount=Number(r.cost);
    if(!Number.isFinite(amount)||amount>9999999999)throw failure('AppLovin 花费超出允许范围');
    return [r.day,'UTC','applovin',r.campaign_id_external,r.campaign,r.creative_set_id,r.creative_set,'','',
      config.currency,amount.toFixed(3),r.impressions,r.clicks,r.conversions];
  });
}
export async function fetchApplovinCosts(config,{start,end,fetchImpl=fetch}={}) {
  if(!config.key)throw failure('尚未配置 AppLovin Report Key');
  const records=[];let emptyResponse=false;
  for(let offset=0;offset<=2000;offset+=500){
    const url=new URL('https://r.applovin.com/report');
    const params={api_key:config.key,start,end,format:'csv',report_type:'advertiser',day_column:'day',
      columns:APPLOVIN_COLUMNS.join(','),filter_campaign_package_name:config.bundleId,
      filter_campaign_ad_type:'ua',limit:'500',offset:String(offset),sort_day:'ASC',
      sort_campaign_id_external:'ASC',sort_creative_set_id:'ASC'};
    for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    let response,text;
    try{
      response=await fetchImpl(url,{signal:AbortSignal.timeout(25000),redirect:'error'});
      if(!response.ok)throw new Error();
      text=await response.text();
    }catch{throw failure('AppLovin 请求失败，请核对服务器 Report Key、权限与网络后重试');}
    if(Buffer.byteLength(text)>700000)throw failure('AppLovin 报表过大，已停止同步');
    const lines=text.replace(/^\uFEFF/,'').trim();
    // A new, inactive account can return HTTP 200 with a zero-byte CSV.
    // Permit connection verification, but never erase existing costs from it.
    if(!lines){emptyResponse=true;break;}
    // csvRows requires a data row; allow a valid header-only zero-spend report.
    const parsed=csvRows(lines+'\n'+APPLOVIN_COLUMNS.map(()=>'__sentinel__').join(','));
    parsed.pop();const header=parsed.shift();
    if(header.length!==APPLOVIN_COLUMNS.length||!APPLOVIN_COLUMNS.every(c=>header.includes(c)))throw failure('AppLovin 报表列不匹配，保留原数据');
    for(const row of parsed){
      if(row.length!==header.length)throw failure('AppLovin 报表列数不匹配');
      records.push(Object.fromEntries(header.map((h,i)=>[h,row[i]])));
    }
    if(records.length>2000)throw failure('AppLovin 报表超过 2000 行，请缩小同步范围');
    if(parsed.length<500)break;
  }
  const normalized=normalizeApplovinRows(records,config,start,end);
  if(emptyResponse)normalized.emptyResponse=true;
  return normalized;
}

export function createApplovinSync({getStore,saveStore,config=applovinConfig(),fetchImpl=fetch,clock=Date.now}) {
  let running;
  const status=async()=>applovinStatus(config,(await getStore()).marketing?.cleaner?.applovin);
  async function perform(){
    const now=clock(),end=dateOf(now-DAY),start=dateOf(now-7*DAY);
    const store=await getStore(),state=(store.marketing||={}).cleaner||={costs:{},attributions:{},imports:[]};
    state.applovin={...state.applovin,lastAttempt:now,error:null};
    try{
      // Fetch every page first; a partial or failed response must never erase costs.
      const rows=await fetchApplovinCosts(config,{start,end,fetchImpl});
      const current=store.marketing.cleaner,staged=structuredClone(current);
      if(!rows.length&&rows.emptyResponse&&Object.values(staged.costs||{}).some(r=>r.channel==='applovin'&&r.date>=start&&r.date<=end))
        throw failure('AppLovin 返回空响应，已有成本保留；请核对平台报表后重试');
      for(const [key,r] of Object.entries(staged.costs||{})){
        if(r.channel!=='applovin'||r.date<start||r.date>end)continue;
        if(r.source!=='applovin-api')throw failure('同步范围已有手动导入的 AppLovin 成本，请先统一数据来源，避免重复');
        delete staged.costs[key];
      }
      const shadow={...store,marketing:{...store.marketing,cleaner:staged}};
      if(rows.length){
        const csv=[CSV_HEADERS.costs,...rows].map(r=>r.map(quote).join(',')).join('\n');
        const prepared=prepareMarketingImport(shadow,'cleaner','costs',csv,now);
        prepared.records.forEach(r=>{r.source='applovin-api';});
        applyMarketingImport(shadow,'cleaner',prepared,now);
      }
      staged.applovin={lastAttempt:now,lastSuccess:now,error:null,rows:rows.length,start,end};
      store.marketing.cleaner=staged;
      try{await saveStore(store);}catch(error){store.marketing.cleaner=current;throw error;}
      return applovinStatus(config,staged.applovin);
    }catch(error){
      // Persist only bounded, controlled messages, never fetch URLs or keys.
      const message=error.status===400?error.message:'AppLovin 同步保存失败，原成本保留';
      store.marketing.cleaner.applovin={...store.marketing.cleaner.applovin,error:message};
      await saveStore(store);
      throw failure(message);
    }
  }
  const run=()=>{
    if(!config.key||!/^[A-Z]{3}$/.test(config.currency))return Promise.reject(failure('请先在服务器配置 AppLovin Report Key 与报表币种'));
    if(!running)running=perform().finally(()=>{running=null;});
    return running;
  };
  return {status,run,async tick(){
    if(!config.enabled)return;
    const s=await status(),now=clock();
    if(!s.configured||s.lastSuccess&&dateOf(s.lastSuccess)===dateOf(now)||s.lastAttempt&&now-s.lastAttempt<3600000)return;
    try{await run();}catch{/* Error is persisted and shown in authenticated admin. */}
  }};
}
