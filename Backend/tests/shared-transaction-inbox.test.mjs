import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createTransactionInbox} from '../shared-transaction-inbox.mjs';
const proof={bundleId:'com.liuzhigang.NutriScan',productId:'com.liuzhigang.nutriscan.pro.monthlya',type:'Auto-Renewable Subscription',environment:'Production',transactionId:'id/../escape',originalTransactionId:'original',purchaseDate:Date.now()-1000,price:4990,currency:'USD'};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'shared-inbox-'));t.after(()=>rm(directory,{recursive:true,force:true}));const options={directory,certDirectory:fileURLToPath(new URL('../certs/',import.meta.url))};return {options,service:createTransactionInbox(options)}}
test('NutriScan persists separately, filenames cannot traverse, duplicates survive restart',async t=>{const f=await fixture(t);const r=await f.service.recordVerified('nutriscan',proof,'signed');assert.equal(r.commission_eligible,false);assert.equal((await createTransactionInbox(f.options).recordVerified('nutriscan',proof,'signed')).duplicate,true);assert.equal((await readdir(join(f.options.directory,'partner-inbox','nutriscan','Production'))).filter(name=>name.endsWith('.json')).length,1);assert.deepEqual(await readdir(f.options.directory),['partner-inbox']);});
test('Refund stays revoked after old receipt replay; sandbox is isolated',async t=>{const f=await fixture(t);await f.service.recordVerified('nutriscan',proof,'refund',{refund:true});assert.equal((await f.service.recordVerified('nutriscan',proof,'old')).revoked,true);assert.equal((await f.service.recordVerified('nutriscan',{...proof,environment:'Sandbox'},'sandbox')).revoked,false)});
test('Foreign products, changed owner or amount, and invalid dates are rejected',async t=>{const f=await fixture(t);await f.service.recordVerified('nutriscan',proof,'signed');for(const patch of [{bundleId:'com.liuzhigang.AI-Live-Streaming'},{productId:'coins'},{appAccountToken:'someone'},{price:100},{purchaseDate:0}])await assert.rejects(f.service.recordVerified('nutriscan',{...proof,...patch},'wrong'));await assert.rejects(f.service.recordVerified('../squadlive',proof,'wrong'));});
test('Missing persistent storage and forged Apple signatures fail closed',async t=>{const f=await fixture(t);await assert.rejects(createTransactionInbox({...f.options,directory:undefined}).recordVerified('nutriscan',proof,'signed'),/storage/);await assert.rejects(f.service.receive('nutriscan','transactions','x'.repeat(150)),/signature/);assert.equal((await readdir(f.options.directory)).length,0);});

const receiptPath=(f,tx)=>join(f.options.directory,'partner-inbox','nutriscan',tx.environment,createHash('sha256').update(tx.transactionId).digest('hex')+'.json');
test('Subscription owner survives restart, renewal without token, and rejects another owner',async t=>{
 const f=await fixture(t),first={...proof,appAccountToken:'owner-a'};
 await f.service.recordVerified('nutriscan',first,'first');
 const restarted=createTransactionInbox(f.options),renewal={...proof,transactionId:'renewal'};
 await restarted.recordVerified('nutriscan',renewal,'renewal');
 assert.equal(JSON.parse(await readFile(receiptPath(f,renewal),'utf8')).subscription_owner_token,'owner-a');
 await assert.rejects(restarted.recordVerified('nutriscan',{...renewal,transactionId:'hijack',appAccountToken:'owner-b'},'wrong'),/Subscription ownership/);
 await assert.rejects(readFile(receiptPath(f,{...renewal,transactionId:'hijack'})),{code:'ENOENT'});
 await restarted.recordVerified('nutriscan',{...first,transactionId:'sandbox',environment:'Sandbox',appAccountToken:'owner-b'},'sandbox');
});
test('An unowned subscription cannot be assigned by a later renewal',async t=>{
 const f=await fixture(t);await f.service.recordVerified('nutriscan',proof,'first');
 await assert.rejects(f.service.recordVerified('nutriscan',{...proof,transactionId:'later',appAccountToken:'new-owner'},'later'),/Subscription ownership/);
});
test('Concurrent renewals cannot claim the same subscription for different owners',async t=>{
 const f=await fixture(t);
 const results=await Promise.allSettled(['a','b'].map(owner=>f.service.recordVerified('nutriscan',{...proof,transactionId:owner,appAccountToken:owner},owner)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
});
test('Legacy receipts reserve ownership and conflicting legacy chains fail closed',async t=>{
 const f=await fixture(t),root=join(f.options.directory,'partner-inbox','nutriscan','Production');await mkdir(root,{recursive:true});
 await writeFile(join(root,'legacy.json'),JSON.stringify({original_id:proof.originalTransactionId,account_token:'legacy-owner'}));
 await assert.rejects(f.service.recordVerified('nutriscan',{...proof,appAccountToken:'other'},'wrong'),/Subscription ownership/);
 await f.service.recordVerified('nutriscan',{...proof,appAccountToken:'legacy-owner'},'valid');
 await writeFile(join(root,'conflict1.json'),JSON.stringify({original_id:'conflict',account_token:'one'}));
 await writeFile(join(root,'conflict2.json'),JSON.stringify({original_id:'conflict',account_token:'two'}));
 await assert.rejects(f.service.recordVerified('nutriscan',{...proof,transactionId:'conflict',originalTransactionId:'conflict',appAccountToken:'one'},'wrong'),/Subscription ownership/);
});
const appProof={bundleId:proof.bundleId,appAppleId:6786940107,receiptType:'Production',appTransactionId:'12345678',originalPurchaseDate:Date.now()-30*86400000};
test('Verified app history preserves original date and first receipt time across restart without enabling commission',async t=>{
 const f=await fixture(t);const ack=await f.service.recordVerifiedApp('nutriscan',appProof,'app-signed');
 assert.equal(ack.commission_eligible,false);
 const file=join(f.options.directory,'partner-inbox','nutriscan','Production','app-transactions',createHash('sha256').update(appProof.appTransactionId).digest('hex')+'.json');
 const first=JSON.parse(await readFile(file,'utf8'));
 await createTransactionInbox({...f.options,now:()=>Date.now()+1000}).recordVerifiedApp('nutriscan',appProof,'refreshed');
 const next=JSON.parse(await readFile(file,'utf8'));
 assert.equal(next.original_purchase_date,appProof.originalPurchaseDate);assert.equal(next.first_received_at,first.first_received_at);
 assert.equal(next.attribution_status,'identity_verification_pending');assert.equal(next.commission_eligible,false);
 await assert.rejects(f.service.recordVerifiedApp('nutriscan',{...appProof,originalPurchaseDate:Date.now()},'reset'),/history conflict/);
});
test('App evidence rejects fake signatures, another app, missing identity and future dates',async t=>{
 const f=await fixture(t);
 for(const patch of [{bundleId:'wrong'},{appAppleId:1},{appTransactionId:'../file'},{originalPurchaseDate:0},{originalPurchaseDate:Date.now()+86400000},{receiptType:'Xcode'}])await assert.rejects(f.service.recordVerifiedApp('nutriscan',{...appProof,...patch},'wrong'));
 await assert.rejects(f.service.receive('nutriscan','app-transactions','x'.repeat(150)),/signature/);
 assert.deepEqual(await readdir(f.options.directory),[]);
});
test('Apple history is stored durably and a paid history can never be reset by replay',async t=>{
 const f=await fixture(t);let paid=true;
 const create=()=>createTransactionInbox({...f.options,historyFactory:()=>({check:async()=>({complete:true,has_paid:paid,amount_unknown:false,eligible:!paid,checked_at:Date.now()})})});
 const service=create();assert.equal((await service.refreshVerifiedAppHistory('nutriscan',appProof,'signed',{})).history_status,'previously_paid');
 paid=false;assert.equal((await create().refreshVerifiedAppHistory('nutriscan',appProof,'replay',{})).history_status,'previously_paid');
 const file=join(f.options.directory,'partner-inbox','nutriscan','Production','app-transactions',createHash('sha256').update(appProof.appTransactionId).digest('hex')+'.json');
 const value=JSON.parse(await readFile(file,'utf8'));assert.equal(value.purchase_history.has_paid,true);assert.equal(value.purchase_history.eligible,false);assert.equal(value.commission_eligible,false);
});
test('History lookup failure preserves evidence but never acknowledges successful qualification',async t=>{
 const f=await fixture(t),service=createTransactionInbox({...f.options,historyFactory:()=>({check:async()=>{throw Error('offline')}})});
 await assert.rejects(service.refreshVerifiedAppHistory('nutriscan',appProof,'signed',{}),/offline/);
 const root=join(f.options.directory,'partner-inbox','nutriscan','Production','app-transactions');
 const saved=JSON.parse(await readFile(join(root,(await readdir(root))[0]),'utf8'));assert.equal(saved.purchase_history,null);assert.equal(saved.commission_eligible,false);
});
