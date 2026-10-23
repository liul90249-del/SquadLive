// Remote policy selects approved StoreKit products; it never sets a charge amount.
export const OFFER_TIERS = Object.freeze([
  {id:'free7',amount:0,label:'7 天免费'},
  {id:'intro099',amount:99,label:'首 7 天 $0.99'},
  {id:'intro199',amount:199,label:'首 7 天 $1.99'},
  {id:'intro399',amount:399,label:'首 7 天 $3.99'},
  {id:'intro699',amount:699,label:'首 7 天 $6.99'}
]);
export const PAYWALL_TEMPLATES = ['storage','compact','comparison'];
// Resource IDs verified in App Store Connect on 2026-10-22/23.
// A saved mapping is not approval: every enabled publication rechecks Apple.
const APPLE_SUBSCRIPTIONS = Object.freeze({
  free7:'6761750091',intro099:'6825629063',intro199:'6825702250',
  intro399:'6825789166',intro699:'6825844584'
});
const clone=x=>structuredClone(x);
export function defaultPaywallPolicy(){return {schemaVersion:1,enabled:false,selectedTier:'free7',template:'storage',
  tiers:OFFER_TIERS.map(t=>({id:t.id,productId:t.id==='free7'?'com.hecathehe.PhoneCleaner.weekly':`com.hecathehe.PhoneCleaner.weekly.${t.id}`,appleSubscriptionId:APPLE_SUBSCRIPTIONS[t.id],territories:['USA']})),
  surprise:{enabled:false,productId:'com.hecathehe.PhoneCleaner.yearly',appleSubscriptionId:'6761750205',minVisits:2,minIntervalHours:24,dismissCooldownHours:72,maxPer7Days:2},
  maxMarketingPer24Hours:1,minAppVersion:'1.11.0'};}
function invalid(message){throw Object.assign(new Error(message),{status:400});}
function integer(value,min,max,name){if(!Number.isInteger(value)||value<min||value>max)invalid(`${name}必须为 ${min}–${max} 的整数`);return value;}
function product(value,optional=false){if(optional&&value==='')return '';if(typeof value!=='string'||!/^com\.hecathehe\.PhoneCleaner\.[A-Za-z0-9._-]{1,100}$/.test(value))invalid('商品 ID 必须属于 Smart Cleaner');return value;}
export function validatePaywallPolicy(input){
  if(!input||typeof input!=='object'||Array.isArray(input))invalid('无效策略');
  if(typeof input.enabled!=='boolean')invalid('请选择启用状态');
  if(!OFFER_TIERS.some(t=>t.id===input.selectedTier))invalid('未知首期档位');
  if(!PAYWALL_TEMPLATES.includes(input.template))invalid('未知付费页模板');
  if(!Array.isArray(input.tiers)||input.tiers.length!==5)invalid('必须保留全部五个档位');
  const seen=new Set();const products=new Set();
  const tiers=input.tiers.map(t=>{
    if(!t||!OFFER_TIERS.some(o=>o.id===t.id)||seen.has(t.id))invalid('档位重复或无效');seen.add(t.id);
    const id=product(t.productId,true);
    const expected=t.id==='free7'?'com.hecathehe.PhoneCleaner.weekly':`com.hecathehe.PhoneCleaner.weekly.${t.id}`;
    if(id&&id!==expected)invalid('该档位必须使用已接入订单验证的对应商品 ID');
    if(id&&products.has(id))invalid('并行档位必须映射不同商品');if(id)products.add(id);
    if(!Array.isArray(t.territories)||!t.territories.length||t.territories.length>175||t.territories.some(s=>typeof s!=='string'||! /^[A-Z]{3}$/.test(s)))invalid('销售地区必须为三字母地区代码');
    if(t.appleSubscriptionId&&!/^\d{1,30}$/.test(t.appleSubscriptionId))invalid('苹果订阅资源 ID 必须为数字');
    return {id:t.id,productId:id,appleSubscriptionId:t.appleSubscriptionId||'',territories:[...new Set(t.territories)]};
  });
  const s=input.surprise;if(!s||typeof s.enabled!=='boolean')invalid('无效特惠设置');
  if(s.appleSubscriptionId&&!/^\d{1,30}$/.test(s.appleSubscriptionId))invalid('特惠苹果订阅资源 ID 必须为数字');
  if(typeof input.minAppVersion!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.minAppVersion))invalid('最低版本应为 x.y.z');
  return {schemaVersion:1,enabled:input.enabled,selectedTier:input.selectedTier,template:input.template,tiers,
    surprise:{enabled:s.enabled,productId:product(s.productId),appleSubscriptionId:s.appleSubscriptionId||'',minVisits:integer(s.minVisits,1,100,'访问次数'),
      minIntervalHours:integer(s.minIntervalHours,1,720,'特惠间隔'),dismissCooldownHours:integer(s.dismissCooldownHours,1,720,'关闭冷却'),maxPer7Days:integer(s.maxPer7Days,1,14,'每周次数')},
    maxMarketingPer24Hours:integer(input.maxMarketingPer24Hours,1,5,'每日营销次数'),minAppVersion:input.minAppVersion};
}
// catalog entries must be obtained by the server from Apple, never from an admin request body.
export function validatePublication(policy,catalog,now=Date.now()){
  const p=validatePaywallPolicy(policy);if(!p.enabled)return p;
  const tier=p.tiers.find(t=>t.id===p.selectedTier);const expected=OFFER_TIERS.find(t=>t.id===p.selectedTier);
  if(!tier.productId)invalid('选中的档位尚未配置苹果商品');
  for(const territory of tier.territories){
    const entry=catalog?.find(e=>e.productId===tier.productId&&e.territory===territory);
    if(!entry||entry.state!=='APPROVED'||!Number.isFinite(entry.checkedAt)||now-entry.checkedAt>3600000||entry.checkedAt>now||entry.period!=='ONE_WEEK'||entry.introDays!==7||!(entry.regularPrice>0))invalid('苹果商品或首期优惠尚未通过最新核对');
    if(territory==='USA'&&(entry.currency!=='USD'||entry.introPriceCents!==expected.amount))invalid('苹果美国区首期价格与档位不一致');
    if(territory==='USA'&&Math.round(entry.regularPrice*100)!==999)invalid('美国区后续续费价必须为每周 $9.99');
    if(expected.amount===0&&entry.offerMode!=='FREE_TRIAL')invalid('该商品没有七天免费资格方案');
    if(expected.amount>0&&!['PAY_UP_FRONT','PAY_AS_YOU_GO'].includes(entry.offerMode))invalid('该商品没有付费首期优惠');
  }
  if(p.surprise.enabled)for(const territory of tier.territories){
    if(!catalog?.some(e=>e.productId===p.surprise.productId&&e.territory===territory&&e.state==='APPROVED'&&e.period==='ONE_YEAR'&&e.regularPrice>0&&Number.isFinite(e.checkedAt)&&e.checkedAt<=now&&now-e.checkedAt<=3600000))invalid('特惠商品尚未通过该销售地区的苹果核对');
  }
  return p;
}
export function policyState(store){return clone(store.cleanerPaywallPolicy||{revision:0,draft:defaultPaywallPolicy(),published:null,history:[]});}
export function editPolicy(store,input,expectedRevision,now=Date.now()){
  const state=policyState(store);
  if(expectedRevision!==state.revision)throw Object.assign(new Error('配置已被其他操作更新，请刷新后再保存'),{status:409});
  state.draft=validatePaywallPolicy(input);state.revision++;state.updatedAt=new Date(now).toISOString();store.cleanerPaywallPolicy=state;return clone(state);
}
export function publishPolicy(store,expectedRevision,catalog,now=Date.now()){
  const state=policyState(store);
  if(expectedRevision!==state.revision)throw Object.assign(new Error('配置已变化，请重新预览'),{status:409});
  const policy=validatePublication(state.draft,catalog,now);
  if(state.published)state.history=[state.published,...state.history].slice(0,50);
  state.revision++;state.published={revision:state.revision,publishedAt:new Date(now).toISOString(),policy};
  store.cleanerPaywallPolicy=state;return clone(state);
}
export function publicPolicy(store){const state=policyState(store);return state.published?clone(state.published):{revision:0,publishedAt:null,policy:defaultPaywallPolicy()};}

// Restoring history changes only the draft. Publication always rechecks Apple.
export function restorePolicyDraft(store,sourceRevision,expectedRevision,now=Date.now()){
  const state=policyState(store);
  if(expectedRevision!==state.revision)throw Object.assign(new Error('配置已被其他操作更新，请刷新后再恢复'),{status:409});
  if(!Number.isInteger(sourceRevision))invalid('请选择有效的发布历史版本');
  const source=[state.published,...state.history].find(item=>item?.revision===sourceRevision);
  if(!source)throw Object.assign(new Error('该发布版本已不存在，请刷新历史记录'),{status:404});
  return editPolicy(store,source.policy,expectedRevision,now);
}
