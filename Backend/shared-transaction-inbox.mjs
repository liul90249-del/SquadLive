import {mkdir,readFile,open,rename,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Environment,SignedDataVerifier} from '@apple/app-store-server-library';
import {createPurchaseHistory,historyClientFromEnvironment} from './apple-purchase-history.mjs';
import {createDeviceAttest} from './app-attest.mjs';
import {createAnonymousInstallation} from './anonymous-installation.mjs';
import {reserveSubscriptionOwner} from './subscription-owner.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const inboxProducts=Object.freeze({nutriscan:{bundle:'com.liuzhigang.NutriScan',appId:6786940107,skus:new Set(['com.liuzhigang.nutriscan.pro.annuala','com.liuzhigang.nutriscan.pro.monthlya','com.liuzhigang.nutriscan.pro.annualpromoa'])}});
async function atomic(file,value){
 const temporary=file+'.'+randomUUID()+'.tmp';const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync()}finally{await handle.close()}
 await rename(temporary,file);
}
const hash=s=>createHash('sha256').update(s).digest('hex');
export function createTransactionInbox({directory,certDirectory,now=()=>Date.now(),env=process.env,historyFactory}){
 let active=0,queue=Promise.resolve();const verifiers=new Map();
 const installations=createAnonymousInstallation({directory,now});
 const deviceAttest=createDeviceAttest({directory,now});
 async function configure(product){
  const config=inboxProducts[product];if(!config)throw fail('Product is not connected',404);
  if(!verifiers.has(product))verifiers.set(product,Promise.all(['AppleIncRootCertificate.cer','AppleRootCA-G2.cer','AppleRootCA-G3.cer'].map(p=>readFile(join(certDirectory,p)))).then(roots=>[
   new SignedDataVerifier(roots,true,Environment.PRODUCTION,config.bundle,config.appId),new SignedDataVerifier(roots,true,Environment.SANDBOX,config.bundle)
  ]));
  return verifiers.get(product);
 }
 async function record(product,t,proof,{refund=false,notificationId=null}={}){
  const config=inboxProducts[product];
  if(!config||t.bundleId!==config.bundle||!config.skus.has(t.productId)||t.type!=='Auto-Renewable Subscription'||!['Sandbox','Production'].includes(t.environment)||typeof t.transactionId!=='string'||!t.transactionId||typeof t.originalTransactionId!=='string'||!t.originalTransactionId||!Number.isSafeInteger(t.purchaseDate)||t.purchaseDate<=0||t.purchaseDate>now()+300000)throw fail('Invalid verified transaction metadata');
  if(!directory)throw fail('Persistent transaction storage is not configured',503);
  const op=queue.then(async()=>{
   const root=join(directory,'partner-inbox',product,t.environment);await mkdir(root,{recursive:true});
   const capacity=await statfs(root);if(Number(capacity.bavail)*Number(capacity.bsize)<64*1024*1024)throw fail('Transaction storage capacity is low',503);
   const file=join(root,hash(t.transactionId)+'.json');let old;
   try{old=JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
   const incoming={product,environment:t.environment,transaction_id:t.transactionId,original_id:t.originalTransactionId,sku:t.productId,account_token:t.appAccountToken?.toLowerCase()||null,purchased_at:t.purchaseDate,price:t.price??null,currency:t.currency??null};
   if(old&&Object.keys(incoming).some(k=>old[k]!==incoming[k]))throw fail('Transaction ownership or amount conflict',409);
   const subscriptionOwner=await reserveSubscriptionOwner(root,incoming,atomic);
   const receipt={...incoming,subscription_owner_token:subscriptionOwner,revoked:!!(old?.revoked||refund||t.revocationDate),signed_transaction:old?.revoked?old.signed_transaction:proof,notification_id:notificationId||old?.notification_id||null,received_at:old?.received_at||now(),updated_at:now(),attribution_status:'not_bound',commission_eligible:false};
   await atomic(file,receipt);
   return {received:true,duplicate:!!old,transaction_id:t.transactionId,environment:t.environment,revoked:receipt.revoked,attribution_status:'not_bound',commission_eligible:false};
  });queue=op.catch(()=>{});return op;
 }
 async function recordApp(product,t,proof){
  const config=inboxProducts[product];
  if(!config||t.bundleId!==config.bundle||!['Sandbox','Production'].includes(t.receiptType)||
    (t.receiptType==='Production'&&t.appAppleId!==config.appId)||
    typeof t.appTransactionId!=='string'||!/^\d{1,128}$/.test(t.appTransactionId)||
    !Number.isSafeInteger(t.originalPurchaseDate)||t.originalPurchaseDate<=0||t.originalPurchaseDate>now()+300000)
    throw fail('Invalid verified app transaction metadata');
  if(!directory)throw fail('Persistent transaction storage is not configured',503);
  const op=queue.then(async()=>{
   const root=join(directory,'partner-inbox',product,t.receiptType,'app-transactions');await mkdir(root,{recursive:true});
   const capacity=await statfs(root);if(Number(capacity.bavail)*Number(capacity.bsize)<64*1024*1024)throw fail('Transaction storage capacity is low',503);
   const file=join(root,hash(t.appTransactionId)+'.json');let old;
   try{old=JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
   if(old&&(old.app_transaction_id!==t.appTransactionId||old.original_purchase_date!==t.originalPurchaseDate))throw fail('App transaction history conflict',409);
   await atomic(file,{app_transaction_id:t.appTransactionId,product,environment:t.receiptType,
    original_purchase_date:t.originalPurchaseDate,first_received_at:old?.first_received_at||now(),
    updated_at:now(),signed_app_transaction:proof,purchase_history:old?.purchase_history||null,attribution_status:'identity_verification_pending',commission_eligible:false});
   // This is verified purchase-date evidence, not authentication or first use.
   return {received:true,transaction_id:t.appTransactionId,environment:t.receiptType,commission_eligible:false};
  });queue=op.catch(()=>{});return op;
 }
 async function refreshAppHistory(product,t,proof,verifier){
  await recordApp(product,t,proof);
  const config=inboxProducts[product];
  const history=historyFactory?historyFactory({product,environment:t.receiptType,verifier}):createPurchaseHistory({
   client:historyClientFromEnvironment(env,{bundleId:config.bundle,environment:t.receiptType}),
   verifier,bundleId:config.bundle,appId:config.appId,environment:t.receiptType,now});
  const result=await history.check(t.appTransactionId);
  if(!result||result.complete!==true||typeof result.has_paid!=='boolean'||typeof result.amount_unknown!=='boolean'||
    !Number.isSafeInteger(result.checked_at))throw fail('Apple purchase history is incomplete',503);
  const op=queue.then(async()=>{
   const file=join(directory,'partner-inbox',product,t.receiptType,'app-transactions',hash(t.appTransactionId)+'.json');
   const evidence=JSON.parse(await readFile(file,'utf8'));
   // Once verified as paid, a later empty or out-of-order response cannot undo it.
   const paid=evidence.purchase_history?.has_paid===true||result.has_paid;
   evidence.purchase_history={...result,has_paid:paid,eligible:!paid&&result.amount_unknown===false&&result.eligible===true&&t.receiptType==='Production'};
   await atomic(file,evidence);
   return {received:true,transaction_id:t.appTransactionId,environment:t.receiptType,
    history_status:paid?'previously_paid':result.amount_unknown?'review_required':'checked',commission_eligible:false};
  });queue=op.catch(()=>{});return op;
 }
 async function receive(product,kind,proof,credential){
  if(!['transactions','notifications','app-transactions'].includes(kind))throw fail('Unsupported payload type',404);
  if(credential!==undefined&&(typeof credential!=='string'||!/^ni_[a-f0-9]{64}$/.test(credential)))throw fail('Invalid private installation credential');
  if(typeof proof!=='string'||proof.length<100||proof.length>131072)throw fail('Invalid signed payload');
  if(active>=2)throw fail('Verification is busy; retry later',429);active++;
  try{
   const all=await configure(product);let payload,verifier;
   for(const v of all){try{payload=await (kind==='notifications'?v.verifyAndDecodeNotification(proof):kind==='app-transactions'?v.verifyAndDecodeAppTransaction(proof):v.verifyAndDecodeTransaction(proof));verifier=v;break}catch{}}
   if(!payload)throw fail('Apple signature verification failed');
   if(kind==='transactions')return await record(product,payload,proof);
   if(kind==='app-transactions'){
    const result=await refreshAppHistory(product,payload,proof,verifier);
    if(credential!==undefined){
     const installation=await installations.registerVerifiedApp({product,environment:payload.receiptType,appTransactionId:payload.appTransactionId,credential});
     return {...result,installation};
    }
    return result;
   }
   const id=payload.notificationUUID;if(!id)throw fail('Missing notification identifier');
   if(payload.notificationType==='TEST'){
    if(!directory)throw fail('Persistent transaction storage is not configured',503);
    const root=join(directory,'partner-inbox',product,'notifications');await mkdir(root,{recursive:true});
    const file=join(root,hash(id)+'.json');await atomic(file,{id,type:'TEST',received_at:now()});
    return {received:true,notification_type:'TEST'};
   }
   const signed=payload.data?.signedTransactionInfo;if(!signed)throw fail('Missing signed transaction');
   let t;try{t=await verifier.verifyAndDecodeTransaction(signed)}catch{throw fail('Apple transaction signature verification failed')}
   return await record(product,t,signed,{refund:['REFUND','REVOKE'].includes(payload.notificationType),notificationId:id});
  }finally{active--}
 }
 async function device(body,credential){
  if(!body||typeof body!=='object'||Array.isArray(body))throw fail('Invalid device request');
  const identity=await installations.authenticate({product:'nutriscan',environment:body.environment,appTransactionId:body.app_transaction_id,credential});
  if(body.action==='status')return deviceAttest.status(identity);
  if(body.action==='challenge')return deviceAttest.challenge(identity,body.kind);
  if(body.action==='verify')return deviceAttest.verify(identity,body);
  throw fail('Unknown device verification action');
 }
 return {device,recordVerified:record,recordVerifiedApp:recordApp,refreshVerifiedAppHistory:refreshAppHistory,receive};
}
