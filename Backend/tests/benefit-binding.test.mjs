import test from 'node:test';
import assert from 'node:assert/strict';
import {createBenefitGateway} from '../benefit-gateway.mjs';

test('Benefit claim locks the same verified attribution before requesting delivery',async()=>{
 const calls=[],identity={customerId:'verified-user',registeredAt:1700000000};
 const handle=createBenefitGateway({verifyIdentity:async()=>identity,partnerClient:{identify:async()=>{},claimBenefit:async()=>{calls.push('claim');return {ok:true}}},confirmBinding:async(i,c,confirmed)=>{assert.equal(i,identity);assert.equal(c,'PC123456789ABC');assert.equal(confirmed,true);calls.push('bind')}});
 const response=await handle(new Request('https://app.local',{method:'POST',body:JSON.stringify({action:'claim',code:'PC123456789ABC',plan_id:'12345678-1234-1234-1234-123456789abc',confirmed:true,customerId:'forged-user'})}));
 assert.equal(response.status,200);assert.deepEqual(calls,['bind','claim']);
});
test('A conflicting attribution prevents the benefit claim',async()=>{
 let claimed=false;
 const handle=createBenefitGateway({verifyIdentity:async()=>({customerId:'u',registeredAt:1700000000}),partnerClient:{identify:async()=>{},claimBenefit:async()=>{claimed=true}},confirmBinding:async()=>{throw Object.assign(Error('Already bound'),{status:409})}});
 const response=await handle(new Request('https://app.local',{method:'POST',body:JSON.stringify({action:'claim',code:'PC123456789ABC',plan_id:'12345678-1234-1234-1234-123456789abc',confirmed:true})}));
 assert.equal(response.status,409);assert.equal(claimed,false);
});
