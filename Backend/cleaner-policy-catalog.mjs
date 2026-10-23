import {tokenFor,pages} from './asc-subscription-catalog.mjs';
const relation=(item,name)=>item.relationships?.[name]?.data?.id;
const active=(a,today)=>(!a.startDate||a.startDate<=today)&&(!a.endDate||a.endDate>=today);
export function policyCatalogEntry(subscription,prices,offers,territory,now){
  const today=new Date(now).toISOString().slice(0,10);
  const lookup=new Map([...(prices.included||[]),...(offers.included||[])].map(i=>[i.type+':'+i.id,i]));
  const price=prices.data.filter(i=>relation(i,'territory')===territory&&!i.attributes.preserved&&active(i.attributes,today)).sort((a,b)=>String(b.attributes.startDate||'').localeCompare(String(a.attributes.startDate||'')))[0];
  const intro=offers.data.filter(i=>relation(i,'territory')===territory&&active(i.attributes,today));
  // Ambiguous overlapping offers must not be approved by picking an arbitrary one.
  const offer=intro.length===1?intro[0]:null;
  const pricePoint=lookup.get('subscriptionPricePoints:'+relation(price||{},'subscriptionPricePoint'));
  const introPoint=lookup.get('subscriptionPricePoints:'+relation(offer||{},'subscriptionPricePoint'));
  const a=offer?.attributes;
  return {productId:subscription.attributes.productId,state:subscription.attributes.state,period:subscription.attributes.subscriptionPeriod,
    territory,checkedAt:now,currency:lookup.get('territories:'+territory)?.attributes.currency||null,
    regularPrice:pricePoint?.attributes.customerPrice==null?null:Number(pricePoint.attributes.customerPrice),
    offerMode:a?.offerMode||null,introDays:a?.duration==='ONE_WEEK'&&a.numberOfPeriods===1?7:null,
    introPriceCents:a?.offerMode==='FREE_TRIAL'?0:introPoint?.attributes.customerPrice==null?null:Math.round(Number(introPoint.attributes.customerPrice)*100)};
}
// Prices alone do not prove a product is offered in a storefront.
export async function requireAvailableTerritories(subscriptionId, territories, token, fetcher) {
  const availability = await pages(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/subscriptionAvailability`, token, fetcher);
  const id = availability.data[0]?.id;
  if (!id) throw Object.assign(new Error('苹果未返回商品销售范围，不能发布'), {status:422});
  const available = await pages(`/v1/subscriptionAvailabilities/${encodeURIComponent(id)}/availableTerritories?limit=200`, token, fetcher);
  const ids = new Set(available.data.map(item => item.id));
  if (territories.some(territory => !ids.has(territory))) {
    throw Object.assign(new Error('商品未在全部目标地区开放销售，不能发布'), {status:422});
  }
}
export function createPolicyCatalogReader({keyId,issuerId,privateKey,weeklySubscriptionId,fetcher=fetch,now=Date.now}){
  return async policy=>{
    if(!policy.enabled)return [];
    if(!keyId||!issuerId||!privateKey)throw Object.assign(new Error('尚未配置 App Store Connect 商品核对凭据'),{status:422});
    const timestamp=now(),token=tokenFor({keyId,issuerId,privateKey},timestamp);
    const tier=policy.tiers.find(t=>t.id===policy.selectedTier);
    const id=tier.appleSubscriptionId||(tier.id==='free7'?weeklySubscriptionId:null);
    if(!id)throw Object.assign(new Error('请先填写该档位的苹果订阅资源 ID'),{status:422});
    const subscription=(await pages(`/v1/subscriptions/${encodeURIComponent(id)}`,token,fetcher)).data[0];
    if(subscription?.attributes?.productId!==tier.productId)throw Object.assign(new Error('苹果资源 ID 与配置的商品 ID 不匹配'),{status:422});
    await requireAvailableTerritories(id,tier.territories,token,fetcher);
    const result=[];
    for(const territory of tier.territories){
      const query=`?filter%5Bterritory%5D=${encodeURIComponent(territory)}&include=territory,subscriptionPricePoint&limit=200`;
      const [prices,offers]=await Promise.all([pages(`/v1/subscriptions/${id}/prices${query}`,token,fetcher),pages(`/v1/subscriptions/${id}/introductoryOffers${query}`,token,fetcher)]);
      result.push(policyCatalogEntry(subscription,prices,offers,territory,timestamp));
    }
    if(policy.surprise.enabled){
      const specialId=policy.surprise.appleSubscriptionId;
      if(!specialId)throw Object.assign(new Error('请填写特惠商品的苹果订阅资源 ID'),{status:422});
      const special=(await pages(`/v1/subscriptions/${encodeURIComponent(specialId)}`,token,fetcher)).data[0];
      if(special?.attributes?.productId!==policy.surprise.productId)throw Object.assign(new Error('特惠商品 ID 与苹果资源不匹配'),{status:422});
      await requireAvailableTerritories(specialId,tier.territories,token,fetcher);
      for(const territory of tier.territories){
        const query=`?filter%5Bterritory%5D=${encodeURIComponent(territory)}&include=territory,subscriptionPricePoint&limit=200`;
        const prices=await pages(`/v1/subscriptions/${specialId}/prices${query}`,token,fetcher);
        result.push(policyCatalogEntry(special,prices,{data:[],included:[]},territory,timestamp));
      }
    }
    return result;
  };
}
