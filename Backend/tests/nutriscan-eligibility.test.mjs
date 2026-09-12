import test from 'node:test';import assert from 'node:assert/strict';
import {createNutriScanEligibility} from '../nutriscan-eligibility.mjs';
import {createPartnerAttribution} from '../partner-attribution.mjs';
const at=1800000000000;
const identity={customerId:'n1',product:'nutriscan',environment:'Production',identityVerified:true,appTransactionId:'123',registeredAt:at/1000-60};
const evidence={product:'nutriscan',environment:'Production',app_transaction_id:'123',original_purchase_date:at-86400000};
const clear={complete:true,has_paid:false,amount_unknown:false,eligible:true,checked_at:at};
const gate=(e=evidence,h=clear)=>createNutriScanEligibility({now:()=>at,loadAppEvidence:async()=>e,checkHistory:async()=>h});
test('NutriScan gate rejects unverified, stale, old, paid and mismatched identities',async()=>{
 assert.equal((await gate()(identity)).verified,true);
 for(const patch of [{identityVerified:false},{product:'squadlive'},{environment:'Sandbox'},{registeredAt:undefined},{registeredAt:at/1000+1},{registeredAt:at/1000-7*86400-1}])await assert.rejects(gate()({...identity,...patch}));
 await assert.rejects(gate({...evidence,app_transaction_id:'wrong'})(identity));
 await assert.rejects(gate({...evidence,original_purchase_date:at+86400000})(identity));
 for(const patch of [{complete:false},{has_paid:true},{amount_unknown:true},{checked_at:at-1},{eligible:false}])await assert.rejects(gate(evidence,{...clear,...patch})(identity));
});
function fixture(verifyEligibility){
 const state={users:{n1:{id:'n1',createdAt:new Date(identity.registeredAt*1000).toISOString()}},appleTransactions:{}};let remoteBindings=0,activations=0;
 const client={request:async()=>({}),identify:async()=>{},bind:async()=>{remoteBindings++;return {binding:{id:'b1',product:'nutriscan',customer_id:'n1',bound_at:at/1000,expires_at:at/1000+86400}}},activate:async()=>{activations++}};
 const api=createPartnerAttribution({getStore:async()=>state,saveStore:async()=>{},client,product:'nutriscan',bundleId:'app',skus:{},verifyEligibility,now:()=>at});
 return {api,state,counts:()=>({remoteBindings,activations})};
}
test('Unconfigured or failed NutriScan eligibility never creates remote binding',async()=>{
 for(const check of [undefined,async()=>{throw Error('offline')},async()=>undefined,async()=>({verified:false})]){const f=fixture(check);await assert.rejects(f.api.bind(identity,'PC123456789ABC',true));assert.equal(f.counts().remoteBindings,0)}
});
test('Binding rechecks history after remote bind and holds a purchase race for review',async()=>{
 let n=0;const f=fixture(async()=>{if(++n===2)throw Error('purchase arrived');return {verified:true}});
 await assert.rejects(f.api.bind(identity,'PC123456789ABC',true),/manual review/);
 assert.equal(f.state.partnerBindings.n1.review_required,true);assert.equal(f.counts().activations,0);
 await assert.rejects(f.api.bind(identity,'PC123456789ABC',true),/review/);
});
test('Successful binding checks twice and exact retries preserve existing source',async()=>{
 let checks=0;const f=fixture(async()=>{checks++;return {verified:true}});
 await f.api.bind(identity,'PC123456789ABC',true);await f.api.bind(identity,'PC123456789ABC',true);
 assert.equal(checks,2);await assert.rejects(f.api.bind(identity,'PC123456789ABD',true),/different/);
});
