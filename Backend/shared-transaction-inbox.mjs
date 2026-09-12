import {mkdir,readFile,open,rename,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Environment,SignedDataVerifier} from '@apple/app-store-server-library';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const inboxProducts=Object.freeze({nutriscan:{bundle:'com.liuzhigang.NutriScan',appId:6786940107,skus:new Set(['com.liuzhigang.nutriscan.pro.annuala','com.liuzhigang.nutriscan.pro.monthlya','com.liuzhigang.nutriscan.pro.annualpromoa'])}});
async function atomic(file,value){
 const temporary=file+'.'+randomUUID()+'.tmp';const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync()}finally{await handle.close()}
 await rename(temporary,file);
}
const hash=s=>createHash('sha256').update(s).digest('hex');
export function createTransactionInbox({directory,certDirectory,now=()=>Date.now()}){
 let active=0,queue=Promise.resolve();const verifiers=new Map();
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
   const receipt={...incoming,revoked:!!(old?.revoked||refund||t.revocationDate),signed_transaction:old?.revoked?old.signed_transaction:proof,notification_id:notificationId||old?.notification_id||null,received_at:old?.received_at||now(),updated_at:now(),attribution_status:'not_bound',commission_eligible:false};
   await atomic(file,receipt);
   return {received:true,duplicate:!!old,transaction_id:t.transactionId,environment:t.environment,revoked:receipt.revoked,attribution_status:'not_bound',commission_eligible:false};
  });queue=op.catch(()=>{});return op;
 }
 async function receive(product,kind,proof){
  if(typeof proof!=='string'||proof.length<100||proof.length>131072)throw fail('Invalid signed payload');
  if(active>=2)throw fail('Verification is busy; retry later',429);active++;
  try{
   const all=await configure(product);let payload,verifier;
   for(const v of all){try{payload=await (kind==='notifications'?v.verifyAndDecodeNotification(proof):v.verifyAndDecodeTransaction(proof));verifier=v;break}catch{}}
   if(!payload)throw fail('Apple signature verification failed');
   if(kind==='transactions')return record(product,payload,proof);
   const id=payload.notificationUUID;if(!id)throw fail('Missing notification identifier');
   if(payload.notificationType==='TEST'){
    if(!directory)throw fail('Persistent transaction storage is not configured',503);
    const root=join(directory,'partner-inbox',product,'notifications');await mkdir(root,{recursive:true});
    const file=join(root,hash(id)+'.json');await atomic(file,{id,type:'TEST',received_at:now()});
    return {received:true,notification_type:'TEST'};
   }
   const signed=payload.data?.signedTransactionInfo;if(!signed)throw fail('Missing signed transaction');
   let t;try{t=await verifier.verifyAndDecodeTransaction(signed)}catch{throw fail('Apple transaction signature verification failed')}
   return record(product,t,signed,{refund:['REFUND','REVOKE'].includes(payload.notificationType),notificationId:id});
  }finally{active--}
 }
 return {recordVerified:record,receive};
}
