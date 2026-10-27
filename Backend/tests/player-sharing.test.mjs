import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedProductReferrals} from '../shared-product-referrals.mjs';
function setup(){
 const root={},calls=[],rewardId='a1000000-0000-4000-8000-000000000001';
 const client={identify:async(...x)=>calls.push(['identify',...x]),createPlayerShare:async id=>(calls.push(['link',id]),{code:'PS012345ABCDEF',url:'https://partner.cleann.top/r/PS012345ABCDEF?product=sparkle',commission_bps:0}),pendingRewards:async id=>(calls.push(['rewards',id]),{rewards:[{id:rewardId,product:'sparkle',kind:'diamonds',units:10}]}),acknowledgeReward:async(...x)=>(calls.push(['ack',...x]),{ok:true})};
 const service=createSharedProductReferrals({getStore:async()=>root,saveStore:async()=>{},clients:{sparkle:client},products:{sparkle:{skus:new Map()}},now:()=>200000});
 return {service,root,client,calls,rewardId};
}
test('player link and rewards use authenticated App identity only',async()=>{
 const f=setup(),s=await f.service.session('sparkle',{deviceId:'10000000-0000-4000-8000-000000000001'}),auth='Bearer '+s.token;
 assert.equal((await f.service.shareLink('sparkle',auth)).code,'PS012345ABCDEF');
 assert.deepEqual(f.calls[0],['identify',s.user_id,200]);assert.deepEqual(f.calls[1],['link',s.user_id]);
 assert.deepEqual(await f.service.rewards('sparkle',auth),{rewards:[{id:f.rewardId,kind:'diamonds',units:10}]});
 assert.deepEqual(f.calls[2],['rewards',s.user_id]);
 await f.service.acknowledgeReward('sparkle',auth,f.rewardId);await f.service.acknowledgeReward('sparkle',auth,f.rewardId);
 assert.deepEqual(f.calls[3],f.calls[4]);assert.equal(f.calls[3][3],s.user_id);assert.match(f.calls[3][2],/^sparkle:[a-f0-9]{64}$/);
});
test('missing credentials and cross-product calls cannot reach rewards or links',async()=>{
 const f=setup();await assert.rejects(f.service.shareLink('sparkle',''),{status:401});
 await assert.rejects(f.service.rewards('sparkle','Bearer forged'),{status:401});
 await assert.rejects(f.service.acknowledgeReward('sparkle','',f.rewardId),{status:401});
 await assert.rejects(f.service.shareLink('cleaner',''),{status:404});assert.equal(f.calls.length,0);
});
test('upstream identity, product and grant failures fail closed',async()=>{
 const f=setup(),s=await f.service.session('sparkle',{deviceId:'10000000-0000-4000-8000-000000000002'}),auth='Bearer '+s.token;
 for(const result of [{code:'PS012345ABCDEF',url:'https://evil.example/r/PS012345ABCDEF',commission_bps:0},{code:'PS012345ABCDEF',url:'https://partner.cleann.top/r/PS012345ABCDEF?product=sparkle',commission_bps:3000}]){
  f.client.createPlayerShare=async()=>result;await assert.rejects(f.service.shareLink('sparkle',auth),{status:502});
 }
 for(const reward of [{id:f.rewardId,product:'cleaner',kind:'diamonds',units:10},{id:f.rewardId,product:'sparkle',kind:'diamonds',units:-10},{id:'bad',product:'sparkle',kind:'diamonds',units:10}]){
  f.client.pendingRewards=async()=>({rewards:[reward]});await assert.rejects(f.service.rewards('sparkle',auth),{status:502});
 }
 await assert.rejects(f.service.acknowledgeReward('sparkle',auth,'bad'),{status:400});
});
