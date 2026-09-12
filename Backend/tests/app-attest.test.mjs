import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';import cbor from 'cbor';
import {createDeviceAttest,validateAssertion,validateAttestation} from '../app-attest.mjs';
const identity={customerId:'nutri_11111111-1111-1111-1111-111111111111',product:'nutriscan',environment:'Production',appTransactionId:'123'};
const keyId=Buffer.alloc(32,1).toString('base64'),proof=Buffer.from('test-attestation').toString('base64');
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'nutri-device-'));t.after(()=>rm(directory,{recursive:true,force:true}));let time=1800000000000;const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const options={directory,now:()=>time,attest:()=>({keyId,environment:'production',publicKey:publicKey.export({type:'spki',format:'pem'})})};return {options,api:createDeviceAttest(options),privateKey,advance:()=>{time+=121000}}}
function assertion(privateKey,payload,count){const auth=Buffer.alloc(37);createHash('sha256').update('D9QJA58T8W.com.liuzhigang.NutriScan').digest().copy(auth);auth.writeUInt32BE(count,33);const nonce=createHash('sha256').update(Buffer.concat([auth,createHash('sha256').update(payload).digest()])).digest();return cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,privateKey)}).toString('base64')}
async function enroll(f){const c=await f.api.challenge(identity,'attest');await f.api.verify(identity,{kind:'attest',key_id:keyId,challenge:c.challenge,proof});}
test('Device assertion uses real signature verification; counter survives restart and rejects replay',async t=>{
 const f=await fixture(t);await enroll(f);const c=await f.api.challenge(identity,'assert');const signed=assertion(f.privateKey,c.payload,1);
 const request={kind:'assert',key_id:keyId,challenge:c.challenge,proof:signed};assert.equal((await f.api.verify(identity,request)).device_verified,true);
 await assert.rejects(f.api.verify(identity,request),/already used/);
 const restarted=createDeviceAttest(f.options),next=await restarted.challenge(identity,'assert');
 await assert.rejects(restarted.verify(identity,{...request,challenge:next.challenge,proof:assertion(f.privateKey,next.payload,1)}),/verification failed/);
});
test('Expired challenges, altered payload and another account cannot reuse a device key',async t=>{
 const f=await fixture(t);const old=await f.api.challenge(identity,'attest');f.advance();await assert.rejects(f.api.verify(identity,{kind:'attest',key_id:keyId,challenge:old.challenge,proof}),/expired/);
 await enroll(f);const c=await f.api.challenge(identity,'assert');await assert.rejects(f.api.verify(identity,{kind:'assert',key_id:keyId,challenge:c.challenge,proof:assertion(f.privateKey,c.payload+'tampered',1)}),/verification failed/);
 const other={...identity,customerId:'nutri_22222222-2222-2222-2222-222222222222'};const cross=await f.api.challenge(other,'attest');await assert.rejects(f.api.verify(other,{kind:'attest',key_id:keyId,challenge:cross.challenge,proof}),/another installation/);
});
test('Lost attestation response can retry identical proof; first use and commission stay ungranted',async t=>{
 const f=await fixture(t);const c=await f.api.challenge(identity,'attest');const request={kind:'attest',key_id:keyId,challenge:c.challenge,proof};await f.api.verify(identity,request);
 assert.deepEqual(await createDeviceAttest(f.options).verify(identity,request),{device_attested:true,commission_eligible:false});assert.equal((await f.api.status(identity)).commission_eligible,false);
});
test('Forged attestation, development attestations and malformed assertion fail closed',async t=>{
 assert.throws(()=>validateAttestation({attestation:Buffer.from('fake')}));assert.throws(()=>validateAssertion({assertion:cbor.encode({authenticatorData:Buffer.alloc(1),signature:Buffer.alloc(1)})}));
 const f=await fixture(t),api=createDeviceAttest({...f.options,attest:()=>({keyId,publicKey:'x',environment:'development'})});const c=await api.challenge(identity,'attest');await assert.rejects(api.verify(identity,{kind:'attest',key_id:keyId,challenge:c.challenge,proof}),/Invalid attested/);
 await assert.rejects(api.challenge({...identity,product:'squadlive'},'attest'));
});
