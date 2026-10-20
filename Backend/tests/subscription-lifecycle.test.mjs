import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSubscriptionLifecycle,readSubscriptionLifecycle,subscriptionAnalytics,createDailySubscriptionCheck,nextSubscriptionCheck,reconcileSubscriptionStatuses} from '../subscription-lifecycle.mjs';
const ms=s=>Date.parse(s+'T12:00:00Z');
const tx={type:'Auto-Renewable Subscription',environment:'Production',transactionId:'trial',originalTransactionId:'original',productId:'weekly',appAccountToken:'owner',purchaseDate:ms('2026-08-01'),originalPurchaseDate:ms('2026-08-01'),expiresDate:ms('2026-08-08')};
const renewal=(at,status)=>({originalTransactionId:'original',environment:'Production',signedDate:at,autoRenewStatus:status});
const notification=(id,at,subtype)=>({notificationUUID:id,signedDate:at,notificationType:'DID_CHANGE_RENEWAL_STATUS',subtype});
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'subscription-lifecycle-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,service:createSubscriptionLifecycle({directory,now:()=>ms('2026-10-20')})};}
test('duplicate / late notifications retain a historical cancellation without undoing a newer re-enable',async t=>{
 const {directory,service}=await fixture(t),off={renewal:renewal(ms('2026-08-02'),0),notification:notification('off',ms('2026-08-02'),'AUTO_RENEW_DISABLED')};
 await service.record('cleaner',tx,off);
 await service.record('cleaner',tx,{renewal:renewal(ms('2026-08-03'),1),notification:notification('on',ms('2026-08-03'),'AUTO_RENEW_ENABLED')});
 await service.record('cleaner',tx,off);
 const state=await readSubscriptionLifecycle(directory);
 assert.equal(Object.values(state.events).length,2);
 const chain=Object.values(state.chains)[0];assert.equal(chain.autoRenewStatus,1);assert.equal(chain.everDisabled,true);
 await assert.rejects(async()=>service.record('cleaner',tx,{renewal:{...renewal(ms('2026-08-04'),0),originalTransactionId:'foreign'}}),/identity/);
});
test('notifications and scheduler writes from separate instances do not lose each other; sandbox isolated',async t=>{
 const {directory,service}=await fixture(t),other=createSubscriptionLifecycle({directory});
 await Promise.all([service.record('cleaner',tx,{renewal:renewal(ms('2026-08-01'),1)}),other.sync('cleaner',{completedDay:'2026-10-20'})]);
 await other.record('cleaner',{...tx,environment:'Sandbox'},{renewal:{...renewal(ms('2026-08-02'),0),environment:'Sandbox'}});
 const state=await readSubscriptionLifecycle(directory);assert.equal(state.sync.completedDay,'2026-10-20');assert.equal(Object.values(state.chains)[0].autoRenewStatus,1);
});
test('trial conversion, refund separation, unknown state, daily events and historical cohort backfill',()=>{
 const orders=[{transactionId:'trial',originalTransactionId:'original',kind:'subscription',accountId:'a',purchasedAt:new Date(tx.purchaseDate).toISOString(),priceMilliunits:0},
 {transactionId:'paid',originalTransactionId:'original',kind:'subscription',accountId:'a',purchasedAt:new Date(ms('2026-08-08')).toISOString(),priceMilliunits:9990,refunded:true},
 {transactionId:'unknown',originalTransactionId:'unknown',kind:'subscription',accountId:'b',purchasedAt:new Date(ms('2026-08-01')).toISOString(),priceMilliunits:0},
 {transactionId:'lifetime',originalTransactionId:'life',kind:'iap',accountId:'c',purchasedAt:new Date(ms('2026-08-01')).toISOString(),priceMilliunits:99900}];
 const operations={orders,users:['a','b','c'].map(id=>({id,createdAt:'2026-08-01T00:00:00Z',hasCompletedCleanup:id==='b'?false:id==='c'?true:null})),daily:[{date:'2026-10-20',activeUsers:7},{date:'2026-10-19',activeUsers:0}]};
 const state={chains:{a:{originalId:'original',firstSubscribedAt:tx.purchaseDate,latestPurchaseAt:ms('2026-08-08'),autoRenewStatus:1,everDisabled:true}},events:{off:{originalId:'original',type:'DID_CHANGE_RENEWAL_STATUS',subtype:'AUTO_RENEW_DISABLED',occurredAt:ms('2026-10-19')},refund:{originalId:'original',type:'REFUND',occurredAt:ms('2026-10-20')}},sync:{}};
 const report=subscriptionAnalytics(operations,state,{},ms('2026-10-20'));
 assert.equal(report.rows.length,81);assert.equal(report.rows[0].date,'2026-10-20');
 assert.equal(report.rows[0].openedUsers,7);assert.equal(report.rows[1].openedUsers,0);assert.equal(report.rows.at(-1).openedUsers,null);
 const cohort=report.rows.at(-1);assert.deepEqual(cohort.newSubscribers,['a','b']);assert.deepEqual(cohort.cohortCancelled,['a']);assert.equal(cohort.unknownRenewal,1);assert.equal(cohort.cancellationRate,null);
 assert.deepEqual(cohort.cleanupUsers,['c']);assert.equal(cohort.cleanupUnknownUsers,1);assert.equal(report.people.find(p=>p.id==='c').subscribedAt,null);
 assert.equal(cohort.subscriptionRate,66.7);assert.equal(cohort.paidConversionRate,33.3);assert.equal(cohort.trialToPaidRate,50);
 assert.deepEqual(report.rows[1].cancellations,['a']);assert.deepEqual(report.rows[0].cancellations,[]);assert.equal(report.rows.find(r=>r.date==='2026-08-08').firstPayers.length,1);
 state.chains.b={originalId:'unknown',firstSubscribedAt:tx.purchaseDate,autoRenewStatus:1};
 assert.equal(subscriptionAnalytics(operations,state,{},ms('2026-10-20')).rows.at(-1).cancellationRate,50);
});
test('status reconciliation backfills cancellation cohort but never invents a cancellation date',async t=>{
 const {directory,service}=await fixture(t);
 await service.record('cleaner',tx,{renewal:renewal(ms('2026-10-20'),0),source:'reconciliation'});
 const state=await readSubscriptionLifecycle(directory),report=subscriptionAnalytics({orders:[],users:[]},state,{},ms('2026-10-20'));
 assert.equal(report.rows.at(-1).cohortCancelled.length,1);assert.equal(report.rows[0].cancellations.length,0);assert.equal(report.unlinked,1);
});
test('08:00 Beijing boundary, restart catchup, no overlap, failed-run retry and persisted daily success',async()=>{
 let now=Date.parse('2026-10-20T23:59:59Z'),runs=0,release;
 const state={sync:{completedDay:'2026-10-20'}};
 const tick=createDailySubscriptionCheck({now:()=>now,read:async()=>state,save:async patch=>Object.assign(state.sync,patch),run:async()=>{runs++;await new Promise(r=>release=r);return {checked:1,failed:0};}});
 assert.equal(new Date(nextSubscriptionCheck(now)).toISOString(),'2026-10-21T00:00:00.000Z');await tick();assert.equal(runs,0);
 now+=1000;const pending=tick();await new Promise(r=>setImmediate(r));await tick();assert.equal(runs,1);release();await pending;await tick();assert.equal(runs,1);assert.equal(state.sync.completedDay,'2026-10-21');
 now+=86400000;let attempts=0;
 const retry=createDailySubscriptionCheck({now:()=>now,read:async()=>state,save:async patch=>Object.assign(state.sync,patch),run:async()=>{attempts++;return attempts===1?{checked:0,failed:1}:{checked:1,failed:0};}});
 await retry();assert.equal(state.sync.status,'partial');assert.equal(state.sync.completedDay,'2026-10-21');await retry();assert.equal(attempts,1);now+=900000;await retry();assert.equal(state.sync.completedDay,'2026-10-22');
});
test('reconciliation verifies both signed payloads, rejects mismatches and preserves partial failure',async()=>{
 const saved=[];const bundleId='com.example.cleaner',appId=12;
 const client={getAllSubscriptionStatuses:async id=>({bundleId,appId,appAppleId:appId,environment:'Production',data:[{lastTransactions:[{originalTransactionId:id,signedTransactionInfo:id,signedRenewalInfo:id}]}]})};
 const verifier={verifyAndDecodeTransaction:async id=>({...tx,bundleId,originalTransactionId:id}),verifyAndDecodeRenewalInfo:async id=>{
   if(id==='forged')throw new Error('invalid signature');return {...renewal(ms('2026-10-20'),0),originalTransactionId:id==='wrong-owner'?'other':id};
 }};
 const options={client,verifier,originals:['good','wrong-owner','forged','good'],bundleId,appId,record:async t=>saved.push(t.originalTransactionId)};
 assert.deepEqual(await reconcileSubscriptionStatuses(options),{checked:1,failed:2});assert.deepEqual(saved,['good']);
 assert.deepEqual(await reconcileSubscriptionStatuses({...options,appId:99,originals:['good']}),{checked:0,failed:1});
});
