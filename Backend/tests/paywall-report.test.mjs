import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPaywallReport,DAY,marketingDataset} from '../marketing-core.mjs';
const at=Date.UTC(2026,9,24);
const sku='com.hecathehe.PhoneCleaner.weekly.intro099';
const exposure=(id,template='storage',start=at)=>[
 {id:id+'o',presentationId:id,name:'paywall_open',at:start,revision:1,tier:'intro099',template,surface:'main',productId:sku},
 {id:id+'c',presentationId:id,name:'purchase_attempt',at:start+100,revision:1,tier:'intro099',template,surface:'main',productId:sku}
];
const user=(events)=>({id:'u',acquiredAt:at,paywallEvents:events});
const order={accountId:'u',sku,transactionId:'t',purchasedAt:at+1000,priceMilliunits:990,currency:'USD'};
test('assigns once to latest matching presentation and excludes renewal',()=>{
 const report=buildPaywallReport([user([...exposure('a'),...exposure('b','compact',at+200)])],
 [order,{...order,transactionId:'renew',purchasedAt:at+7*DAY,priceMilliunits:9990}],{now:at+8*DAY});
 assert.equal(report.rows.find(r=>r.template==='storage').payers,0);
 assert.equal(report.rows.find(r=>r.template==='compact').payers,1);
 assert.equal(report.rows.find(r=>r.template==='compact').net,990);
 assert.equal(report.rows.find(r=>r.template==='compact').viewers,1);
});
test('unmatched products, missing opens and old clicks stay unassigned',()=>{
 for(const [events,transaction] of [[exposure('a'),{...order,sku:'other'}],
  [exposure('a').slice(1),order],[exposure('a'),{...order,purchasedAt:at+2*DAY}]]){
  const r=buildPaywallReport([user(events)],[transaction],{now:at+3*DAY});
  assert.equal(r.unassigned,1);assert.equal(r.rows.reduce((n,r)=>n+r.payers,0),0);
 }
});
test('free trials are not charges; refunds and currency remain explicit',()=>{
 const trial=buildPaywallReport([user(exposure('a'))],[{...order,isFreeTrial:true,priceMilliunits:0}],{now:at+2000});
 assert.equal(trial.rows[0].trials,1);assert.equal(trial.rows[0].payers,0);
 const paid=buildPaywallReport([user(exposure('a'))],[{...order,refundedMilliunits:490}],{now:at+2000});
 assert.equal(paid.rows[0].net,500);
 const other=buildPaywallReport([user(exposure('a'))],[{...order,currency:'EUR'}],{now:at+2000});
 assert.equal(other.rows[0].net,0);assert.equal(other.rows[0].payers,1);
});
test('dataset carries bounded exposure history and coverage without inventing legacy data',()=>{
 const data=marketingDataset({sharedPartnerReferrals:{cleaner:{accounts:{u:{paywallEvents:exposure('a'),paywallHistoryTruncated:true}}}}},'cleaner',
 {users:[{id:'u',createdAt:at},{id:'legacy',createdAt:at}],orders:[]},at+2000);
 const result=buildPaywallReport(data.users,[],{now:data.now});
 assert.equal(result.missing,1);assert.equal(result.incomplete,1);
});
test('trial first charge follows the verified subscription chain without counting later renewals',()=>{
 const trial={...order,isFreeTrial:true,priceMilliunits:0,originalTransactionId:'chain',expiresAt:at+7*DAY};
 const charge={...order,transactionId:'charge',originalTransactionId:'chain',purchasedAt:at+7*DAY,priceMilliunits:9990};
 const report=buildPaywallReport([user(exposure('a'))],[trial,charge,{...charge,transactionId:'renew',purchasedAt:at+14*DAY}],{now:at+15*DAY});
 assert.equal(report.rows[0].trials,1);assert.equal(report.rows[0].payers,1);assert.equal(report.rows[0].net,9990);
 const other=buildPaywallReport([user(exposure('a'))],[trial,{...charge,originalTransactionId:'other'}],{now:at+15*DAY});
 assert.equal(other.rows[0].payers,0);
});
