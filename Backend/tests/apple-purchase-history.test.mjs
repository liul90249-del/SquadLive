import test from 'node:test';import assert from 'node:assert/strict';
import {createPurchaseHistory,historyClientFromEnvironment} from '../apple-purchase-history.mjs';
const metadata={bundleId:'com.liuzhigang.NutriScan',appId:6786940107,environment:'Production'};
const transaction={bundleId:metadata.bundleId,environment:'Production',appTransactionId:'123',purchaseDate:Date.now()-1000,price:0};
const page=(signedTransactions=[],more={})=>({bundleId:metadata.bundleId,appAppleId:metadata.appId,environment:'Production',hasMore:false,signedTransactions,...more});
function service(pages,proofs={}){const calls=[];return {calls,api:createPurchaseHistory({...metadata,client:{async getTransactionHistory(...args){calls.push(args);const p=pages.shift();if(p instanceof Error)throw p;return p}},verifier:{async verifyAndDecodeTransaction(proof){if(!proofs[proof])throw Error('bad');return proofs[proof]}}})}}
test('Only complete verified production history can qualify; pagination includes refunded payments',async()=>{
 const f=service([page(['free'],{hasMore:true,revision:'next'}),page(['paid'])],{free:transaction,paid:{...transaction,price:100,revocationDate:Date.now()}});
 const result=await f.api.check('123');assert.equal(result.eligible,false);assert.equal(result.has_paid,true);assert.equal(result.transaction_count,2);
 assert.deepEqual(f.calls,[['123',null,{},'v2'],['123','next',{},'v2']]);
 assert.equal((await service([page()]).api.check('123')).eligible,true);
});
test('Incomplete, mismatched and failed history never qualify',async()=>{
 for(const pages of [[new Error('offline')],[page([],{hasMore:undefined})],[page([],{bundleId:'other'})],[page([],{environment:'Sandbox'})],[page([],{appAppleId:1})],[page([],{hasMore:true})],[page([],{hasMore:true,revision:'r'}),page([],{hasMore:true,revision:'r'})]])await assert.rejects(service(pages).api.check('123'),{status:503});
 for(const changed of [{appTransactionId:'456'},{environment:'Sandbox'},{purchaseDate:0}])await assert.rejects(service([page(['x'])],{x:{...transaction,...changed}}).api.check('123'),{status:503});
 await assert.rejects(service([page(['bad'])]).api.check('123'),{status:503});
});
test('Missing prices require review and sandbox never qualifies for commission',async()=>{
 for(const price of [undefined,null,-1,0.5]){const result=await service([page(['x'])],{x:{...transaction,price}}).api.check('123');assert.equal(result.eligible,false);assert.equal(result.amount_unknown,true)}
 const api=createPurchaseHistory({...metadata,environment:'Sandbox',client:{async getTransactionHistory(){return page([],{environment:'Sandbox'})}},verifier:{}});
 assert.equal((await api.check('123')).eligible,false);
});
test('Missing product credentials fail closed and page limits cannot qualify',async()=>{
 assert.equal(historyClientFromEnvironment({PARTNER_EVENT_KEY:'unrelated'},metadata),null);
 await assert.rejects(createPurchaseHistory(metadata).check('123'),{status:503});
 const api=createPurchaseHistory({...metadata,maxPages:1,client:{async getTransactionHistory(){return page([],{hasMore:true,revision:'r'})}},verifier:{}});
 await assert.rejects(api.check('123'),{status:503});
});
