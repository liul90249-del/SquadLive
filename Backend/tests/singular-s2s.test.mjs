import test from 'node:test';
import assert from 'node:assert/strict';
import {createSingularS2S} from '../singular-s2s.mjs';

const base={sdid:'40009df0-d618-5d81-9da1-cbb3337b8dec',name:'subscription_renewed',transactionId:'tx-2',originalTransactionId:'tx-1',productId:'weekly',ip:'203.0.113.10',eventAt:1700000000000};

test('posts Apple-verified revenue as a form-encoded Singular V2 event',async()=>{
 let request;
 const client=createSingularS2S({sdkKey:'test-key',bundleId:'com.example.cleaner',fetchImpl:async(url,options)=>{
  request={url,options};return new Response(JSON.stringify({status:'ok'}),{status:200});
 }});
 await client.event({...base,amountMilliunits:9900,currency:'USD'});
 assert.equal(request.url,'https://s2s.singular.net/api/v2/evt');
 assert.equal(request.options.headers['content-type'],'application/x-www-form-urlencoded');
 const form=new URLSearchParams(request.options.body);
 assert.equal(form.get('sdid'),base.sdid);
 assert.equal(form.get('n'),'subscription_renewed');
 assert.equal(form.get('amt'),'9.9');
 assert.equal(form.get('cur'),'USD');
 assert.equal(form.get('att_authorization_status'),'0');
 assert.equal(form.get('ip'),base.ip);
 assert.equal(form.get('utime'),'1700000000');
 assert.equal(JSON.parse(form.get('e')).transaction_id,'tx-2');
});

test('trial-like events never create revenue and missing network context fails closed',async()=>{
 let form;
 const client=createSingularS2S({sdkKey:'test-key',bundleId:'com.example.cleaner',fetchImpl:async(_url,{body})=>{
  form=new URLSearchParams(body);return new Response(JSON.stringify({status:'ok'}),{status:200});
 }});
 await client.event({...base,name:'sng_start_trial',ip:undefined,country:'US'});
 assert.equal(form.has('amt'),false);
 assert.equal(form.get('country'),'US');
 assert.equal(form.get('use_ip'),'true');
 await assert.rejects(client.event({...base,ip:undefined,country:undefined}),/network context/);
 await assert.rejects(client.event({...base,amountMilliunits:0,currency:'USD'}),/revenue amount/);
});

test('HTTP 200 with Singular error body is a failure',async()=>{
 const client=createSingularS2S({sdkKey:'test-key',bundleId:'com.example.cleaner',fetchImpl:async()=>new Response(JSON.stringify({status:'error',reason:'missing argument: a'}),{status:200})});
 await assert.rejects(client.event(base),/missing argument/);
});
