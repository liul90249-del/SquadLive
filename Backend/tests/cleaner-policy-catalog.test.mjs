import test from 'node:test';import assert from 'node:assert/strict';
import {policyCatalogEntry,createPolicyCatalogReader,requireAvailableTerritories} from '../cleaner-policy-catalog.mjs';
const now=Date.parse('2026-10-22T00:00:00Z');
const rel=(territory,point)=>({territory:{data:{id:territory}},subscriptionPricePoint:{data:{id:point}}});
const subscription={attributes:{productId:'com.hecathehe.PhoneCleaner.weekly.intro099',state:'APPROVED',subscriptionPeriod:'ONE_WEEK'}};
const prices={data:[{attributes:{},relationships:rel('USA','regular')}],included:[{type:'territories',id:'USA',attributes:{currency:'USD'}},{type:'subscriptionPricePoints',id:'regular',attributes:{customerPrice:'9.90'}}]};
const offers=()=>({data:[{attributes:{duration:'ONE_WEEK',numberOfPeriods:1,offerMode:'PAY_UP_FRONT'},relationships:rel('USA','intro')}],included:[{type:'subscriptionPricePoints',id:'intro',attributes:{customerPrice:'0.99'}}]});
test('Apple amounts and territory map to cents and one week, never configured display text',()=>{const r=policyCatalogEntry(subscription,prices,offers(),'USA',now);assert.equal(r.introPriceCents,99);assert.equal(r.regularPrice,9.9);assert.equal(r.introDays,7);assert.equal(r.currency,'USD');});
test('future or overlapping introductions are not silently selected',()=>{const o=offers();o.data[0].attributes.startDate='2026-10-23';assert.equal(policyCatalogEntry(subscription,prices,o,'USA',now).introDays,null);delete o.data[0].attributes.startDate;o.data.push(structuredClone(o.data[0]));assert.equal(policyCatalogEntry(subscription,prices,o,'USA',now).introPriceCents,null);});
test('missing credentials prevent publishing an enabled offer but allow disabling',async()=>{const read=createPolicyCatalogReader({});assert.deepEqual(await read({enabled:false}),[]);await assert.rejects(()=>read({enabled:true}),/凭据/);});

test('storefront validation follows all territory pages and rejects unlisted regions',async()=>{
  const calls=[];
  const fetcher=async url=>{
    calls.push(url.pathname+url.search);
    const body=url.pathname.endsWith('/subscriptionAvailability')?{data:{id:'availability'}}:
      url.search.includes('cursor=next')?{data:[{id:'CAN'}]}:
      {data:[{id:'USA'}],links:{next:'https://api.appstoreconnect.apple.com/v1/subscriptionAvailabilities/availability/availableTerritories?cursor=next'}};
    return {ok:true,json:async()=>body};
  };
  await requireAvailableTerritories('weekly',['USA','CAN'],'test',fetcher);
  assert.equal(calls.length,3);
  await assert.rejects(()=>requireAvailableTerritories('weekly',['GBR'],'test',fetcher),/未在全部目标地区/);
});
test('missing or failed availability prevents publishing rather than assuming worldwide sale',async()=>{
  await assert.rejects(()=>requireAvailableTerritories('weekly',['USA'],'test',async()=>({ok:true,json:async()=>({data:[]})})),/未返回商品销售范围/);
  await assert.rejects(()=>requireAvailableTerritories('weekly',['USA'],'test',async()=>({ok:false,status:503})),/503/);
});
test('explicit included storefronts suffice, while partial inclusion never proves another storefront',async()=>{
  let calls=0;
  const fetcher=async url=>{
    calls++;
    if(!url.pathname.endsWith('/subscriptionAvailability'))return {ok:false,status:403};
    assert.equal(url.searchParams.get('include'),'availableTerritories');
    return {ok:true,json:async()=>({data:{id:'weekly',relationships:{availableTerritories:{meta:{paging:{total:175,limit:10}},data:[{type:'territories',id:'USA'}]}}}})};
  };
  await requireAvailableTerritories('weekly',['USA'],'test',fetcher);
  assert.equal(calls,1);
  await assert.rejects(()=>requireAvailableTerritories('weekly',['CAN'],'test',fetcher),/403/);
});
