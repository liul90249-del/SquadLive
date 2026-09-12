import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {mkdir,readFile,open,rename} from 'node:fs/promises';
import {join} from 'node:path';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(message,status=401)=>Object.assign(new Error(message),{status});
const matches=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function save(file,value){const temp=file+'.'+randomUUID()+'.tmp';const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync()}finally{await handle.close()}await rename(temp,file)}
/** Apple proof identifies app history, not possession of the customer's device.
 * These sessions stay unverified until device ownership and first use are proven. */
export function createAnonymousInstallation({directory,now=()=>Date.now()}){
 let queue=Promise.resolve();
 const location=(product,environment,id)=>{
  if(product!=='nutriscan'||!['Production','Sandbox'].includes(environment)||!/^\d{1,128}$/.test(id||''))throw fail('Invalid verified installation',400);
  if(!directory)throw fail('Persistent identity storage is not configured',503);
  return join(directory,'partner-identities',product,environment,hash(id)+'.json');
 };
 return {
  async registerVerifiedApp({product,environment,appTransactionId,credential}){
   if(typeof credential!=='string'||!/^ni_[a-f0-9]{64}$/.test(credential))throw fail('Private installation credential required',400);
   const file=location(product,environment,appTransactionId),digest=hash(credential);
   const operation=queue.then(async()=>{
    await mkdir(join(directory,'partner-identities',product,environment),{recursive:true});let account;
    try{account=JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
    if(account){
     if(account.disabled||!matches(account.credential_hash,digest))throw fail('Restore the original installation credential; identity cannot be replaced',409);
    }else{
     account={customer_id:'nutri_'+randomUUID(),product,environment,app_transaction_id:appTransactionId,credential_hash:digest,
      first_observed_at:now(),registered_at:null,identity_verified:false};
     await save(file,account);
    }
    return {customer_id:account.customer_id,environment,identity_status:account.identity_verified?'verified':'verification_pending',commission_eligible:false};
   });queue=operation.catch(()=>{});return operation;
  },
  async authenticate({product,environment,appTransactionId,credential}){
   if(typeof credential!=='string'||!/^ni_[a-f0-9]{64}$/.test(credential))throw fail('Private installation credential required');
   let account;try{account=JSON.parse(await readFile(location(product,environment,appTransactionId),'utf8'))}catch(error){if(error.code==='ENOENT')throw fail('Installation is not registered');throw error}
   if(account.disabled||!matches(account.credential_hash,hash(credential)))throw fail('Invalid installation credential');
   return {customerId:account.customer_id,product,environment,appTransactionId,registeredAt:account.registered_at,identityVerified:account.identity_verified===true};
  }
 };
}
