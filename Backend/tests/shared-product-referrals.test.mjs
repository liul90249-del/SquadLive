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

test('verified renewal without account token keeps the original subscription owner',async()=>{
 const f=fixture();
 const owner=await f.service.session('cleaner',{deviceId:'40000000-0000-4000-8000-000000000004'});
 await f.service.bind('cleaner','Bearer '+owner.token,'PCABCDEF123456',true);
 const first={environment:'Production',transactionId:'first',originalTransactionId:'original',productId:'sku',purchaseDate:150000,price:9900,currency:'USD',appAccountToken:owner.account_token,type:'Auto-Renewable Subscription'};
 assert.equal((await f.service.recordVerified('cleaner',first,'first proof')).attribution_status,'sent');
 const renewal={...first,transactionId:'renewal',purchaseDate:180000,appAccountToken:undefined};
 const result=await f.service.recordVerified('cleaner',renewal,'renewal proof');
 assert.equal(result.customer_id,Object.values(f.root.sharedPartnerReferrals.cleaner.accounts)[0].id);
 assert.equal(result.attribution_status,'sent');
 assert.equal(f.calls.filter(x=>x[0]==='purchase').length,2);
 assert.equal(f.calls.findLast(x=>x[0]==='purchase')[1].gross_usd_cents,990);
 await f.service.recordVerified('cleaner',renewal,'refund proof',{refund:true});
 assert.equal(f.calls.filter(x=>x[0]==='refund').length,1);
});

test('verified renewal rejects another or unknown account token for an owned subscription',async()=>{
 const f=fixture();
 const firstOwner=await f.service.session('cleaner',{deviceId:'50000000-0000-4000-8000-000000000005'});
 const secondOwner=await f.service.session('cleaner',{deviceId:'60000000-0000-4000-8000-000000000006'});
 const first={environment:'Production',transactionId:'first',originalTransactionId:'original',productId:'sku',purchaseDate:150000,price:9900,currency:'USD',appAccountToken:firstOwner.account_token,type:'Auto-Renewable Subscription'};
 await f.service.recordVerified('cleaner',first,'first proof');
 await assert.rejects(f.service.recordVerified('cleaner',{...first,transactionId:'renewal-other',appAccountToken:secondOwner.account_token},'other proof'),/ownership conflict/);
 await assert.rejects(f.service.recordVerified('cleaner',{...first,transactionId:'renewal-unknown',appAccountToken:'00000000-0000-4000-8000-000000000007'},'unknown proof'),/ownership conflict/);
 assert.equal(Object.keys(f.root.sharedPartnerReferrals.cleaner.receipts).length,1);
});

test('returning session records activity without minting another installation',async()=>{
 let root={},clock=Date.parse('2026-10-10T12:00:00Z');
 const service=createSharedProductReferrals({getStore:async()=>root,saveStore:async s=>{root=s},clients:{},products:{cleaner:{}},now:()=>clock});
 const first=await service.session('cleaner',{deviceId:'30000000-0000-4000-8000-000000000003'});
 clock+=86400000;
 const again=await service.session('cleaner',{credential:first.token});
 assert.equal(again.account_token,first.account_token);
 const accounts=Object.values(root.sharedPartnerReferrals.cleaner.accounts);
 assert.equal(accounts.length,1);
 assert.deepEqual(Object.keys(accounts[0].activeDays).sort(),['2026-10-10','2026-10-11']);
});

test('Singular SDK device ID follows the authenticated anonymous account, not an unauthenticated update',async()=>{
 // The installed iOS SDK was observed returning a canonical version-5 UUID.
 const f=fixture(),sdid='40009df0-d618-5d81-9da1-cbb3337b8dec';
 const first=await f.service.session('cleaner',{deviceId:'70000000-0000-4000-8000-000000000007'});
 const refreshed=await f.service.session('cleaner',{credential:first.token,singularSdid:sdid});
 assert.equal(refreshed.account_token,first.account_token);
 const account=Object.values(f.root.sharedPartnerReferrals.cleaner.accounts)[0];
 assert.equal(account.singularSdid,sdid);
 await assert.rejects(f.service.session('cleaner',{credential:'anon_'+'x'.repeat(43),singularSdid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),/credential/);
 await assert.rejects(f.service.session('cleaner',{credential:first.token,singularSdid:'not-a-uuid'}),/Singular device identifier/);
 assert.equal(account.singularSdid,sdid);
});
