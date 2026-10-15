import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDeepSeekCompletion } from '../deepseek-completion.mjs';
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Hello!' } }] }), {status:200});
const base = {apiKey:'test-key',payload:{model:'test'},wait:async()=>{}};
test('returns actual provider text without retry on success', async()=>{
 let calls=0;
 const r=await requestDeepSeekCompletion({...base,fetchImpl:async()=>{calls++;return ok();}});
 assert.equal(r.content,'Hello!');assert.equal(r.reason,null);assert.equal(calls,1);
});
test('retries a transient 503 and returns the recovered answer', async()=>{
 let calls=0;
 const r=await requestDeepSeekCompletion({...base,fetchImpl:async()=>++calls===1?new Response('busy',{status:503}):ok()});
 assert.equal(r.content,'Hello!');assert.equal(calls,2);
});
test('persistent overload stops after two calls with honest failure reason',async()=>{
 let calls=0;
 const r=await requestDeepSeekCompletion({...base,fetchImpl:async()=>{calls++;return new Response('busy',{status:503});}});
 assert.equal(calls,2);assert.equal(r.providerStatus,503);assert.equal(r.reason,'provider_error');assert.equal(r.content,undefined);
});
test('does not retry invalid keys, exhausted balance, or rate limiting',async()=>{
 for(const status of [401,402,429]){
  let calls=0;const r=await requestDeepSeekCompletion({...base,fetchImpl:async()=>{calls++;return new Response('denied',{status});}});
  assert.equal(calls,1);assert.equal(r.providerStatus,status);
 }
});
test('retries a timeout once and preserves timeout classification',async()=>{
 let calls=0;
 const r=await requestDeepSeekCompletion({...base,fetchImpl:async()=>{calls++;throw new DOMException('timeout','TimeoutError');}});
 assert.equal(calls,2);assert.equal(r.reason,'timeout');
});
test('missing keys and empty responses never claim success',async()=>{
 const r=await requestDeepSeekCompletion({...base,apiKey:'',fetchImpl:async()=>{throw Error('must not call');}});
 assert.equal(r.reason,'missing_key');
 const e=await requestDeepSeekCompletion({...base,fetchImpl:async()=>new Response('{"choices":[]}',{status:200})});
 assert.equal(e.reason,'empty_response');assert.equal(e.content,undefined);
});
