import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY,buildMarketingReport,marketingDataset} from '../marketing-core.mjs';
import {prepareMarketingImport,applyMarketingImport,CSV_HEADERS} from '../marketing-import.mjs';
import {createSharedProductReferrals} from '../shared-product-referrals.mjs';
const start=Date.parse('2026-10-01T00:00:00Z'),now=start+30*DAY;
const source={channel:'meta',campaignId:'c1',adGroupId:'g1',creativeId:'a1'};
const user=(id,extra={})=>({id,createdAt:new Date(start).toISOString(),acquiredAt:new Date(start).toISOString(),attribution:source,trackedFrom:new Date(start).toISOString(),events:{onboarding_complete:start+1000},...extra});
const cost=(extra={})=>({date:'2026-10-01',...source,currency:'USD',spendMilliunits:10000,impressions:100,clicks:10,installs:2,...extra});
const order=(id,userId,days,amount,extra={})=>({transactionId:id,accountId:userId,originalTransactionId:'chain-'+userId,purchasedAt:new Date(start+days*DAY).toISOString(),priceMilliunits:amount,currency:'USD',refundedMilliunits:0,kind:'subscription',...extra});
const fixture=()=>({product:'cleaner',now,users:[user('u1'),user('u2',{trackedFrom:null,events:{},attribution:null})],costs:[cost()],orders:[order('t1','u1',1,20000),order('t2','u1',8,5000),order('t3','u2',1,9000)],imports:[]});
test('cohort windows use acquisition day, currency and refunds; unknown is separate',()=>{
  const data=fixture();data.orders.push(order('gbp','u1',2,999000,{currency:'GBP'}));data.orders[0].refundedMilliunits=5000;data.orders[0].refundedAt=new Date(start+20*DAY).toISOString();
  const r=buildMarketingReport(data,{currency:'USD'});
  const c=r.cohorts.find(c=>c.channel==='meta');
  assert.equal(c.windows[7].net,15000);assert.equal(c.windows[14].net,20000);assert.equal(c.windows[7].roas,150);
  assert.equal(r.quality.unknownAttribution,1);assert.equal(r.quality.funnelUnknown,1);assert.equal(r.quality.mixedCurrencyOrders,1);
  assert.equal(r.events.find(e=>e.key==='onboarding_complete').denominator,1);
});
test('observation maturity has exact UTC boundary and zero/absent cost never means infinite return',()=>{
  const data=fixture();data.now=start+7*DAY-1;
  assert.equal(buildMarketingReport(data).cohorts[0].windows[7].mature,false);
  data.now++;assert.equal(buildMarketingReport(data).cohorts[0].windows[7].mature,true);
  data.costs[0].spendMilliunits=0;assert.equal(buildMarketingReport(data).cohorts.find(c=>c.channel==='meta').windows[7].roas,null);
  data.costs=[];const r=buildMarketingReport(data);assert.equal(r.totals.spend,null);assert.equal(r.cohorts[0].windows[7].roas,null);
});
test('creative costs roll up to campaign, drilldown only includes selected source',()=>{
  const data=fixture();data.costs.push(cost({creativeId:'a2',spendMilliunits:5000}));
  let r=buildMarketingReport(data,{channel:'meta',level:'campaign'});
  assert.equal(r.groups.length,1);assert.equal(r.groups[0].spend,15000);assert.equal(r.cohorts[0].windows[7].roas,20000/15000*100);
  r=buildMarketingReport(data,{channel:'meta',campaignId:'c1',adGroupId:'g1',creativeId:'a2',level:'creative'});
  assert.equal(r.totals.users,0);assert.equal(r.cohorts[0].windows[7].roas,null);
});
test('trial conversion excludes immature trials, non-trial zero orders and another subscription chain',()=>{
  const data=fixture();data.users=[user('u1'),user('u2'),user('u3'),user('u4')];
  data.orders=[order('trial1','u1',0,0,{isFreeTrial:true,expiresAt:new Date(start+7*DAY).toISOString()}),order('paid1','u1',7,10000),
    order('trial2','u2',29,0,{isFreeTrial:true,expiresAt:new Date(now+6*DAY).toISOString()}),
    order('zero3','u3',0,0),order('paid3','u3',1,10000),
    order('trial4','u4',0,0,{isFreeTrial:true,expiresAt:new Date(start+7*DAY).toISOString()}),order('paid4','u4',8,10000,{originalTransactionId:'another'})];
  const r=buildMarketingReport(data);assert.deepEqual(r.trial,{started:3,ended:2,converted:1,rate:50,unknownEnd:0,pending:1});
  assert.equal(r.totals.paid,3);
});
const root=()=>({sharedPartnerReferrals:{cleaner:{accounts:{u1:{id:'u1',createdAt:new Date(start).toISOString()}}}}});
const csv=(kind,rows)=>[CSV_HEADERS[kind].join(','),...rows.map(r=>r.join(','))].join('\n');
const costRow=['2026-10-01','UTC','meta','c1','campaign','g1','group','a1','creative','USD','10.25','100','12','2'];
test('cost import validates before mutating; reimport updates same key, never doubles spend',()=>{
  const store=root(),text=csv('costs',[costRow]);
  const p=prepareMarketingImport(store,'cleaner','costs',text,now);
  assert.equal(store.marketing,undefined);assert.equal(p.added,1);applyMarketingImport(store,'cleaner',p,now);
  const q=prepareMarketingImport(store,'cleaner','costs',text,now);assert.equal(q.replaced,1);
  applyMarketingImport(store,'cleaner',q,now);assert.equal(Object.values(store.marketing.cleaner.costs).length,1);
  assert.equal(Object.values(store.marketing.cleaner.costs)[0].spendMilliunits,10250);
});
test('CSV rejects duplicates, invalid calendar dates, mixed timezones, unsafe money and malformed quoting',()=>{
  assert.throws(()=>prepareMarketingImport(root(),'cleaner','costs',csv('costs',[costRow,costRow]),now),/重复/);
  for(const [index,value] of [[0,'2026-02-30'],[1,'America/Los_Angeles'],[10,'-1'],[11,'NaN']]){
    const row=[...costRow];row[index]=value;assert.throws(()=>prepareMarketingImport(root(),'cleaner','costs',csv('costs',[row]),now));
  }
  assert.throws(()=>prepareMarketingImport(root(),'cleaner','costs',CSV_HEADERS.costs.join(',')+'\n"unfinished',now),/引号/);
});
test('mixed campaign totals and creative details rejected against persisted rows too',()=>{
  const store=root();applyMarketingImport(store,'cleaner',prepareMarketingImport(store,'cleaner','costs',csv('costs',[costRow]),now),now);
  const row=[...costRow];for(const i of [5,6,7,8])row[i]='';
  assert.throws(()=>prepareMarketingImport(store,'cleaner','costs',csv('costs',[row]),now),/层级/);
});
test('attribution imports require same-product user, timezone, first acquisition date and source',()=>{
  const row=['u1','2026-10-01T00:00:00Z','meta','c1','campaign','g1','group','a1','creative','Singular export'];
  const p=prepareMarketingImport(root(),'cleaner','attribution',csv('attribution',[row]),now);
  assert.equal(p.records[0].acquiredAt,'2026-10-01T00:00:00.000Z');
  for(const [index,value] of [[0,'other-product-user'],[1,'2026-10-20T00:00:00Z'],[1,'2026-10-01'],[9,'']]){
    const invalid=[...row];invalid[index]=value;assert.throws(()=>prepareMarketingImport(root(),'cleaner','attribution',csv('attribution',[invalid]),now));
  }
});
test('dataset exposes only allowlisted marketing identity data, never credential or Singular device ID',()=>{
  const store=root();store.sharedPartnerReferrals.cleaner.accounts.u1.singularSdid='private';store.sharedPartnerReferrals.cleaner.accounts.u1.accountToken='secret';
  const data=marketingDataset(store,'cleaner',{users:[{id:'u1',createdAt:new Date(start).toISOString()}],orders:[]},now);
  assert.equal(JSON.stringify(data).includes('private'),false);assert.equal(JSON.stringify(data).includes('secret'),false);
});
test('authenticated session first events are allowlisted, monotonic and cannot mutate another identity',async()=>{
  const store={},service=createSharedProductReferrals({getStore:async()=>store,saveStore:async()=>{},clients:{},products:{cleaner:{}},now:()=>now});
  const first=await service.session('cleaner',{deviceId:'10000000-0000-4000-8000-000000000001',funnelTrackingV1:true,funnelEvents:{paywall_open:start}});
  await service.session('cleaner',{credential:first.token,deviceId:'10000000-0000-4000-8000-000000000002',funnelTrackingV1:true,funnelEvents:{paywall_open:now}});
  assert.equal(store.sharedPartnerReferrals.cleaner.accounts[first.user_id].funnelEvents.paywall_open,start);
  assert.equal(Object.keys(store.sharedPartnerReferrals.cleaner.accounts).length,1);
  await assert.rejects(service.session('cleaner',{credential:first.token,funnelTrackingV1:true,funnelEvents:{revenue:100000}}),/funnel/);
  await assert.rejects(service.session('cleaner',{credential:first.token,funnelTrackingV1:true,funnelEvents:{paywall_open:now+DAY}}),/funnel/);
});
