import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAnonymousInstallation} from '../anonymous-installation.mjs';
const input={product:'nutriscan',environment:'Production',appTransactionId:'123',credential:'ni_'+'a'.repeat(64)};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'nutri-identity-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,api:createAnonymousInstallation({directory})}}
test('Private credentials persist without storing plaintext, and retry after restart preserves identity',async t=>{
 const f=await fixture(t);const first=await f.api.registerVerifiedApp(input),again=await createAnonymousInstallation(f).registerVerifiedApp(input);
 assert.equal(first.customer_id,again.customer_id);assert.equal(first.identity_status,'verification_pending');
 const identity=await f.api.authenticate(input);assert.equal(identity.registeredAt,null);assert.equal(identity.identityVerified,false);
 const root=join(f.directory,'partner-identities','nutriscan','Production');const text=await readFile(join(root,(await readdir(root))[0]),'utf8');assert.equal(text.includes(input.credential),false);
});
test('Replacement credentials and concurrent claims cannot reset an existing installation',async t=>{
 const f=await fixture(t);const outcomes=await Promise.allSettled(['a','b'].map(c=>f.api.registerVerifiedApp({...input,credential:'ni_'+c.repeat(64)})));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
 await assert.rejects(f.api.authenticate({...input,credential:'ni_'+'c'.repeat(64)}),{status:401});
});
test('Sandbox is isolated; invalid identity, credentials and missing storage fail closed',async t=>{
 const f=await fixture(t);const production=await f.api.registerVerifiedApp(input),sandbox=await f.api.registerVerifiedApp({...input,environment:'Sandbox'});assert.notEqual(production.customer_id,sandbox.customer_id);
 for(const patch of [{product:'squadlive'},{environment:'Xcode'},{appTransactionId:'../file'},{credential:'bad'}])await assert.rejects(f.api.registerVerifiedApp({...input,...patch}));
 await assert.rejects(createAnonymousInstallation({}).registerVerifiedApp(input),{status:503});
});
