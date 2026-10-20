import {createHash} from 'node:crypto';
import {sourceKey} from './marketing-core.mjs';
const fail=m=>Object.assign(new Error(m),{status:400});
export const CSV_HEADERS={
  costs:['date','timezone','channel','campaignId','campaignName','adGroupId','adGroupName','creativeId','creativeName','currency','spend','impressions','clicks','installs'],
  attribution:['accountId','acquiredAt','channel','campaignId','campaignName','adGroupId','adGroupName','creativeId','creativeName','source']
};
export function csvRows(text) {
  if(typeof text!=='string'||Buffer.byteLength(text)>700000)throw fail('CSV 文件必须小于 700 KB');
  const rows=[];let row=[],field='',quoted=false,closed=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
    if(c==='"'){if(field||closed)throw fail('CSV 引号格式错误');quoted=true;continue;}
    if(c===','||c==='\n'||c==='\r'){row.push(field);field='';closed=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(Boolean))rows.push(row);row=[];}continue;}
    if(closed)throw fail('CSV 引号后存在无效字符');
    field+=c;
  }
  if(quoted)throw fail('CSV 引号未闭合');
  row.push(field);if(row.some(Boolean))rows.push(row);
  if(rows.length<2||rows.length>2001)throw fail('每次导入需要 1–2000 条记录');
  return rows;
}
const clean=(v,max=160)=>{v=String(v??'').trim();if(v.length>max||/[\x00-\x1f]/.test(v))throw fail('字段过长或含控制字符');return v;};
const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const integer=v=>{if(!/^\d{1,12}$/.test(v)||!Number.isSafeInteger(Number(v)))throw fail('展示、点击、安装必须是非负整数');return Number(v);};
const cost=v=>{if(!/^\d{1,10}(\.\d{1,3})?$/.test(v))throw fail('花费必须是非负金额，最多三位小数');return Math.round(Number(v)*1000);};
export function prepareMarketingImport(store,product,kind,text,now=Date.now()) {
  const header=CSV_HEADERS[kind];if(!header)throw fail('未知导入类型');
  const rows=csvRows(text), supplied=rows.shift();
  if(supplied.length!==header.length||supplied.some((v,i)=>v.trim()!==header[i]))throw fail('CSV 列名或顺序不匹配，请使用对应模板');
  const accounts=store.sharedPartnerReferrals?.[product]?.accounts||{}, existing=store.marketing?.[product]||{}, seen=new Set();
  const records=rows.map((values,i)=>{
    try{
      if(values.length!==header.length)throw fail('列数不匹配');
      const r=Object.fromEntries(header.map((h,j)=>[h,clean(values[j])]));
      r.channel=r.channel.toLowerCase();
      if(!r.channel)throw fail('缺少 channel');
      if(r.creativeId&&!r.adGroupId||r.adGroupId&&!r.campaignId)throw fail('素材必须带广告组，广告组必须带广告系列 ID');
      if(kind==='costs'){
        if(['organic','unknown'].includes(r.channel))throw fail('成本只接受明确的广告渠道');
        if(!date(r.date)||Date.parse(r.date)>now)throw fail('日期无效或在未来');
        if(r.timezone!=='UTC')throw fail('请先按 UTC 导出；不能直接混用美国账户当地日期');
        if(!/^[A-Z]{3}$/.test(r.currency))throw fail('币种需为三位大写代码');
        r.spendMilliunits=cost(r.spend);delete r.spend;
        for(const h of ['impressions','clicks','installs'])r[h]=integer(r[h]);
        r.key=JSON.stringify([r.date,r.currency,sourceKey(r)]);
      }else{
        if(!accounts[r.accountId])throw fail('用户 ID 未在该产品后台找到；请先映射为后台用户 ID');
        if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(r.acquiredAt)||!Number.isFinite(Date.parse(r.acquiredAt))||Date.parse(r.acquiredAt)>now+300000)throw fail('acquiredAt 需为带时区的有效时间，且不能在未来');
        if(Date.parse(r.acquiredAt)>Date.parse(accounts[r.accountId].createdAt)+300000)throw fail('获客时间晚于后台首次会话；本入口仅接受首次获客归因，不接受再营销归因');
        if(!r.source)throw fail('需填写归因来源，例如 Singular 导出');
        if(['organic','unknown'].includes(r.channel)&&[r.campaignId,r.adGroupId,r.creativeId].some(Boolean))throw fail('自然量和未知来源不能带广告层级');
        r.acquiredAt=new Date(r.acquiredAt).toISOString();r.key=r.accountId;
      }
      if(seen.has(r.key))throw fail('同一文件存在重复记录');seen.add(r.key);
      return r;
    }catch(e){throw fail(`第 ${i+2} 行：${e.message}`);}
  });
  // Reject mixed granularity for one channel/day/currency: campaign totals plus
  // their children would silently double-count spend. Existing rows count too.
  if(kind==='costs'){
    const combined={...(existing.costs||{})};for(const r of records)combined[r.key]=r;
    const slices=new Map();
    for(const r of Object.values(combined)){
      const key=JSON.stringify([r.date,r.currency,r.channel,r.campaignId]);
      const depth=r.creativeId?3:r.adGroupId?2:1;
      if(slices.has(key)&&slices.get(key)!==depth)throw fail('同一天同一广告系列混合了汇总和明细层级，会重复计算花费；请保持一致的导入层级');
      slices.set(key,depth);
    }
    const rowsAll=Object.values(combined);
    for(const r of rowsAll.filter(r=>!r.campaignId))if(rowsAll.some(v=>v!==r&&v.date===r.date&&v.currency===r.currency&&v.channel===r.channel&&v.campaignId))throw fail('渠道总计与广告系列明细不能同时导入');
  }
  const target=kind==='costs'?'costs':'attributions',old=existing[target]||{};
  const replaced=records.filter(r=>old[r.key]).length;
  return {kind,records,count:records.length,replaced,added:records.length-replaced,
    fingerprint:createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    totals:kind==='costs'?records.reduce((out,r)=>{out[r.currency]=(out[r.currency]||0)+r.spendMilliunits;return out;},{}):null};
}
export function applyMarketingImport(store,product,prepared,now=Date.now()) {
  const state=(store.marketing||={})[product]||={costs:{},attributions:{},imports:[]};
  const key=prepared.kind==='costs'?'costs':'attributions';
  state[key]||={};
  for(const record of prepared.records){const {key:k,...r}=record;state[key][k]={...r,importedAt:now};}
  state.imports||=[];
  state.imports.push({kind:prepared.kind,count:prepared.count,replaced:prepared.replaced,at:now,fingerprint:prepared.fingerprint});
  state.imports=state.imports.slice(-50);
}
