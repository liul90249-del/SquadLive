import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedProductReferrals} from '../shared-product-referrals.mjs';

function fixture(){
 let root={};const calls=[];
 const client={
  request:async()=>({ok:true}),install:async x=>calls.push(['install',x]),register:async x=>calls.push(['register',x]),
  attribution:async id=>({binding:{id:'b1',customer_id:id,product:'cleaner',partner_id:'p1',bound_at:100,expires_at:9999999999,commission_bps:2000}}),
  activate:async x=>calls.push(['activate',x]),purchase:async x=>(calls.push(['purchase',x]),{ok:true}),refund:async x=>calls.push(['refund',x])
 };
 const products={cleaner:{bundle:'x',skus:new Map([['sku',{kind:'subscription'}]])}};
 const service=createSharedProductReferrals({getStore:async()=>root,saveStore:async s=>{root=s},clients:{cleaner:client},products,now:()=>200000});
 return {service,calls,get root(){return root}};
}

test('server identity binds once and delivers verified purchase/refund',async()=>{
 const f=fixture(),device='10000000-0000-4000-8000-000000000001';
 const session=await f.service.session('cleaner',{deviceId:device});
 assert.match(session.token,/^anon_/);assert.match(session.account_token,/^[0-9a-f-]{36}$/);
 await f.service.preview('cleaner','Bearer '+session.token,'PCABCDEF123456');
 await f.service.bind('cleaner','Bearer '+session.token,'PCABCDEF123456',true);
 const t={environment:'Production',transactionId:'t1',originalTransactionId:'o1',productId:'sku',purchaseDate:150000,price:4990,currency:'USD',appAccountToken:session.account_token,type:'Auto-Renewable Subscription'};
 const sent=await f.service.recordVerified('cleaner',t,'signed proof '.repeat(20));
 assert.equal(sent.attribution_status,'sent');assert.equal(f.calls.filter(x=>x[0]==='purchase').length,1);
 const refunded=await f.service.recordVerified('cleaner',t,'refund proof '.repeat(20),{refund:true});
 assert.equal(refunded.attribution_status,'refunded');assert.equal(f.calls.filter(x=>x[0]==='refund').length,1);
});

test('unbound and sandbox transactions never deliver commission',async()=>{
 const f=fixture(),session=await f.service.session('cleaner',{deviceId:'20000000-0000-4000-8000-000000000002'});
 const base={transactionId:'t2',originalTransactionId:'o2',productId:'sku',purchaseDate:150000,price:4990,currency:'USD',appAccountToken:session.account_token,type:'Auto-Renewable Subscription'};
 const unbound=await f.service.recordVerified('cleaner',{...base,environment:'Production'},'proof '.repeat(30));
 assert.equal(unbound.attribution_status,'unattributed');
 const sandbox=await f.service.recordVerified('cleaner',{...base,transactionId:'t3',environment:'Sandbox'},'proof '.repeat(30));
 assert.equal(sandbox.attribution_status,'sandbox');
 assert.equal(f.calls.filter(x=>x[0]==='purchase').length,0);
});
