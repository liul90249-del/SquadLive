import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createAppleIdentityVerifier} from '../apple-identity.mjs';
import {createBenefitAuth} from '../benefit-auth.mjs';
const {privateKey, publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
const jwk = {...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
const claims = {sub:'apple-user',aud:'app',iss:'https://appleid.apple.com',iat:1000,exp:2000};
const jwt = (changes={},header={alg:'RS256',kid:'test'}) => {
 const value = [header,{...claims,...changes}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 return value+'.'+sign('RSA-SHA256',Buffer.from(value),privateKey).toString('base64url');
};
const verify = createAppleIdentityVerifier({audience:'app',fetchKeys:async()=>[jwk],now:()=>1500});
test('Apple signature, audience, expiry and nonce are all required',async()=>{
 assert.equal((await verify(jwt({nonce:'n'}),'n')).sub,'apple-user');
 for(const changes of [{aud:'other'},{exp:1500},{exp:'2000'},{iat:1801},{iss:'evil'},{sub:''},{nonce:'wrong'}])
  await assert.rejects(verify(jwt(changes),'n'));
 await assert.rejects(verify(jwt({}, {alg:'HS256',kid:'test'})));
 const token=jwt();await assert.rejects(verify(token.slice(0,-20)+'A'.repeat(20)));
});
test('One-use challenge, server identity, expiry and changed account fail closed',async()=>{
 let time=1000000; let user={id:'server-user',appleSubject:'apple-user',createdAt:'2026-09-11T00:00:00Z'};
 const auth=createBenefitAuth({verifyApple:verify,resolveUser:async()=>user,now:()=>time});
 const {nonce}=auth.challenge();
 const session=await auth.login({nonce,identityToken:jwt({nonce}),customerId:'attacker'});
 await assert.rejects(auth.login({nonce,identityToken:jwt({nonce})}));
 const req=new Request('https://app.local',{headers:{authorization:'Bearer '+session.token}});
 assert.equal((await auth.verify(req)).customerId,'server-user');
 await assert.rejects(auth.verify(new Request('https://app.local',{headers:{'x-user-id':'server-user'}})));
 user={...user,appleSubject:'another'};await assert.rejects(auth.verify(req));
 user={...user,appleSubject:'apple-user'};time+=900000;await assert.rejects(auth.verify(req));
 const expired=auth.challenge();time+=300000;
 await assert.rejects(auth.login({nonce:expired.nonce,identityToken:jwt({nonce:expired.nonce})}));
});
test('Unlinked Apple identities cannot claim a device wallet',async()=>{
 const auth=createBenefitAuth({verifyApple:verify,resolveUser:async()=>null});
 const {nonce}=auth.challenge();await assert.rejects(auth.login({nonce,identityToken:jwt({nonce}),deviceId:'known-device'}));
});
