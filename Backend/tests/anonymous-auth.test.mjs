import test from 'node:test';import assert from 'node:assert/strict';
import {createAnonymousAuth} from '../anonymous-auth.mjs';
import {createPartnerAttribution} from '../partner-attribution.mjs';
const date=Date.now(),wallet={id:'wallet',createdAt:new Date(date-60_000).toISOString()};
function fixture(){const s={users:{wallet},appleTransactions:{}};const client={request:async()=>({valid:true}),identify:async()=>{},bind:async b=>({binding:{id:'b',product:'squadlive',customer_id:b.customer_id,bound_at:date/1000,expires_at:date/1000+86400}}),activate:async()=>{}};const p=createPartnerAttribution({getStore:async()=>s,saveStore:async()=>{},client,product:'squadlive',bundleId:'app',skus:{coins:'iap'},now:()=>date});const auth=createAnonymousAuth({getStore:async()=>s,saveStore:async()=>{},resolveWallet:async()=>wallet,account:u=>p.account(u)});return {s,p,auth,client}}
const request=t=>new Request('https://app.local',{headers:{authorization:'Bearer '+t}});
test('Anonymous credential is secret, durable and preserves first-use timestamp',async()=>{const f=fixture(),a=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});const id=await f.auth.verify(request(a.token));assert.equal(id.registeredAt,Math.floor(Date.parse(wallet.createdAt)/1000));const again=await f.auth.session({credential:a.token,deviceId:'ignored'});assert.equal(again.account_token,a.account_token);assert.ok(!JSON.stringify(f.s).includes(a.token));await assert.rejects(f.auth.verify(request('anon_'+'a'.repeat(43))));await assert.rejects(f.auth.session({credential:'invalid'}));});
test('One wallet cannot switch promoter identity by minting new anonymous credentials',async()=>{const f=fixture();const a=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});await f.p.bind(await f.auth.verify(request(a.token)),'PC123456789ABC',true);const b=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});await assert.rejects(f.p.bind(await f.auth.verify(request(b.token)),'PC123456789ABD',true));});
test('Anonymous credentials do not bypass old-account or prior-purchase rules',async()=>{const f=fixture();const a=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});const identity=await f.auth.verify(request(a.token));await assert.rejects(f.p.bind({...identity,registeredAt:Math.floor(date/1000)-8*86400},'PC123456789ABC',true));f.s.appleTransactions.old={userId:'wallet',environment:'Production'};await assert.rejects(f.p.bind(identity,'PC123456789ABC',true));});

test('A second credential cannot bind after any credential on the wallet paid',async()=>{
 const f=fixture();const a=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});
 const first=await f.auth.verify(request(a.token));
 f.s.partnerReceipts.paid={customer_id:first.customerId,environment:'Production',price:4990};
 const b=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});
 await assert.rejects(f.p.bind(await f.auth.verify(request(b.token)),'PC123456789ABC',true),/before your first purchase/);
 assert.equal(Object.keys(f.s.partnerBindings).length,0);
});
test('Missing, malformed and future first-use timestamps fail closed',async()=>{
 const f=fixture();const a=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});
 const identity=await f.auth.verify(request(a.token));
 for(const registeredAt of [undefined,NaN,0,Infinity,Math.floor(date/1000)+60]){
  await assert.rejects(f.p.bind({...identity,registeredAt},'PC123456789ABC',true),/first-use timestamp/);
 }
});

test('A wallet purchase arriving during remote binding requires review',async()=>{
 const f=fixture();const a=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});
 const b=await f.auth.session({deviceId:'12345678-1234-1234-1234-123456789abc'});
 const other=await f.auth.verify(request(b.token));const identity=await f.auth.verify(request(a.token));
 const remoteBind=f.client.bind;
 f.client.bind=async body=>{
  f.s.partnerReceipts.racing={customer_id:other.customerId,environment:'Production',price:4990};
  return remoteBind(body);
 };
 await assert.rejects(f.p.bind(identity,'PC123456789ABC',true),/manual review/);
 assert.equal(f.s.partnerBindings[identity.customerId].review_required,true);
});
