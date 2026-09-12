import test from 'node:test';import assert from 'node:assert/strict';
import {createPartnerAttribution} from '../partner-attribution.mjs';
const current=1800000000000,seconds=current/1000;
function fixture(){
 let state={users:{u:{id:'u',appleSubject:'apple',createdAt:new Date(current-60000).toISOString()}},appleTransactions:{}};
 const calls=[];let failDelivery=false;
 const client={request:async()=>({valid:true}),identify:async()=>{},bind:async()=>({binding:{id:'b',customer_id:'u',product:'squadlive',partner_id:'p',bound_at:seconds-10,expires_at:seconds+86400,commission_bps:3000}}),activate:async()=>{},purchase:async b=>{if(failDelivery)throw Error('offline');calls.push(['purchase',b]);return {ok:true}},refund:async id=>{calls.push(['refund',id]);return {ok:true}}};
 const options={getStore:async()=>state,saveStore:async s=>{},client,product:'squadlive',bundleId:'app',skus:{coins:'iap',weekly:'subscription'},now:()=>current};
 const service=createPartnerAttribution(options),identity={customerId:'u',registeredAt:seconds-60};
 const transaction=(token,changes={})=>({bundleId:'app',productId:'coins',type:'Consumable',transactionId:'t',originalTransactionId:'t',purchaseDate:current,environment:'Production',appAccountToken:token,price:4990,currency:'USD',inAppOwnershipType:'PURCHASED',...changes});
 return {service,state,calls,identity,transaction,options,setFailure:v=>failDelivery=v};
}
test('Server token stable, confirmed code required; one purchase counted once across restart',async()=>{
 const f=fixture();const a=await f.service.account(f.state.users.u);assert.equal((await f.service.account(f.state.users.u)).account_token,a.account_token);
 await assert.rejects(f.service.bind(f.identity,'PC123456789ABC',false));
 await f.service.bind(f.identity,'PC123456789ABC',true);
 await assert.rejects(f.service.bind(f.identity,'PC123456789ABD',true));
 await f.service.recordVerified(f.transaction(a.account_token),'signed-proof');await f.service.drain();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].gross_usd_cents,499);
 const restarted=createPartnerAttribution(f.options);await restarted.recordVerified(f.transaction(a.account_token),'signed-proof');await restarted.drain();assert.equal(f.calls.length,1);
});
test('Unknown owners, sandbox, free, foreign currency, old purchase and shared ownership never earn commission',async()=>{
 for(const [change,expected] of [[{appAccountToken:'unknown'},'unattributed'],[{environment:'Sandbox'},'sandbox'],[{price:0},'free'],[{currency:'EUR'},'amount_review'],[{purchaseDate:current-20000},'outside_window'],[{inAppOwnershipType:'FAMILY_SHARED'},'ownership_review']]){
  const f=fixture();const a=await f.service.account(f.state.users.u);await f.service.bind(f.identity,'PC123456789ABC',true);
  assert.equal((await f.service.recordVerified(f.transaction(a.account_token,change),'proof')).status,expected);await f.service.drain();assert.equal(f.calls.length,0);
 }
});
test('Refund before purchase is durable, and repeated old transaction cannot revive commission',async()=>{
 const f=fixture();const a=await f.service.account(f.state.users.u);await f.service.bind(f.identity,'PC123456789ABC',true);
 await f.service.recordVerified(f.transaction(a.account_token),'refund-proof',{refund:true});await f.service.drain();
 await f.service.recordVerified(f.transaction(a.account_token),'purchase-proof');await f.service.drain();assert.deepEqual(f.calls,[['refund','t']]);
});
test('Conflicting transaction owner, subscription chain, amount and unknown SKU rejected',async()=>{
 const f=fixture();const a=await f.service.account(f.state.users.u);await f.service.recordVerified(f.transaction(a.account_token),'proof');
 for(const c of [{appAccountToken:'unknown'},{price:5990},{productId:'invented'},{bundleId:'wrong'},{type:'Auto-Renewable Subscription'},{purchaseDate:0}])await assert.rejects(f.service.recordVerified(f.transaction(a.account_token,c),'proof'));
 f.state.users.v={id:'v',appleSubject:'other',createdAt:new Date(current).toISOString()};const b=await f.service.account(f.state.users.v);
 await assert.rejects(f.service.recordVerified(f.transaction(b.account_token,{transactionId:'renewal'}),'proof'));
});
test('Purchase before binding blocks code adoption; retry errors retain pending receipt',async()=>{
 const f=fixture();const a=await f.service.account(f.state.users.u);await f.service.recordVerified(f.transaction(a.account_token),'proof');await assert.rejects(f.service.bind(f.identity,'PC123456789ABC',true));
 const g=fixture();const b=await g.service.account(g.state.users.u);await g.service.bind(g.identity,'PC123456789ABC',true);await g.service.recordVerified(g.transaction(b.account_token),'proof');g.setFailure(true);await g.service.drain();assert.equal(g.state.partnerReceipts['Production:t'].status,'pending');assert.equal(g.state.partnerReceipts['Production:t'].attempts,1);
});

test('Refund tombstones reject old entitlement claims for coins and subscriptions across restart',async()=>{
 for(const environment of ['Sandbox','Production'])for(const subscription of [false,true]){
  const f=fixture();const a=await f.service.account(f.state.users.u);
  const t=f.transaction(a.account_token,{environment,...(subscription?{productId:'weekly',type:'Auto-Renewable Subscription'}:{})});
  await f.service.recordVerified(t,'apple-refund-notification',{refund:true});
  const restarted=createPartnerAttribution(f.options);
  await assert.rejects(restarted.recordClaim(t,'old-signed-purchase'),/refunded or revoked/);
  assert.equal(f.state.partnerReceipts[environment+':t'].revoked,true);
  const revocation=await restarted.recordClaim({...t,revocationDate:current},'current-revocation-proof');
  assert.equal(revocation.revoked,true);
 }
});
test('Valid first and repeated claims remain accepted before a refund',async()=>{
 const f=fixture();const a=await f.service.account(f.state.users.u);const t=f.transaction(a.account_token);
 assert.equal((await f.service.recordClaim(t,'valid-proof')).revoked,false);
 assert.equal((await f.service.recordClaim(t,'valid-proof')).revoked,false);
});

test('Non-consumable lifetime purchases use iap commission and reject consumable mismatches',async()=>{
 const f=fixture();f.options.skus.lifetime={kind:'iap',appleType:'Non-Consumable'};
 const a=await f.service.account(f.state.users.u);await f.service.bind(f.identity,'PC123456789ABC',true);
 const t=f.transaction(a.account_token,{productId:'lifetime',type:'Non-Consumable'});
 assert.equal((await f.service.recordClaim(t,'verified-lifetime')).status,'pending');
 await f.service.drain();assert.equal(f.calls[0][1].purchase_kind,'iap');
 await assert.rejects(f.service.recordClaim({...t,type:'Consumable'},'wrong-type'),/type does not match/);
 await f.service.recordVerified(t,'refund',{refund:true});
 await assert.rejects(f.service.recordClaim(t,'old-lifetime-proof'),/refunded or revoked/);
});
test('An explicit product catalog rejects cross-product SKUs and preserves subscription classification',async()=>{
 const f=fixture();f.options.skus={weekly:{kind:'subscription',appleType:'Auto-Renewable Subscription'}};
 const service=createPartnerAttribution(f.options);const a=await service.account(f.state.users.u);
 await service.bind(f.identity,'PC123456789ABC',true);
 await assert.rejects(service.recordClaim(f.transaction(a.account_token),'foreign-coins'),/metadata/);
 await service.recordClaim(f.transaction(a.account_token,{productId:'weekly',type:'Auto-Renewable Subscription'}),'subscription');
 await service.drain();assert.equal(f.calls[0][1].purchase_kind,'subscription');
});

test('Mismatched product configuration cannot classify lifetime purchases as subscriptions',async()=>{
 const f=fixture();f.options.skus.lifetime={kind:'subscription',appleType:'Non-Consumable'};
 await assert.rejects(f.service.recordClaim(f.transaction('unknown',{productId:'lifetime',type:'Non-Consumable'}),'proof'),/disagree/);
});
