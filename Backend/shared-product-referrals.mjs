import {createHash,randomBytes,randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

export function createSharedProductReferrals({getStore,saveStore,clients,products,now=()=>Date.now()}) {
 const state=(root,product)=>{
  root.sharedPartnerReferrals||={};
  return root.sharedPartnerReferrals[product]||=(
   {accounts:{},credentials:{},devices:{},accountTokens:{},bindings:{},receipts:{}}
  );
 };
 const clientFor=product=>clients[product]||null;
 const productFor=product=>products[product]||null;

 async function session(product,{credential,deviceId}) {
  if(!productFor(product))throw fail('Product is not connected',404);
  const root=await getStore(),s=state(root,product);let account,token;
  if(credential!==undefined&&credential!==null&&credential!==''){
   if(typeof credential!=='string'||!/^anon_[A-Za-z0-9_-]{43}$/.test(credential))throw fail('Installation credential is invalid',401);
   account=s.accounts[s.credentials[hash(credential)]];token=credential;
   if(!account||account.disabled)throw fail('Installation credential is unavailable',401);
  }else{
   if(typeof deviceId!=='string'||!/^[-a-f0-9]{36}$/i.test(deviceId))throw fail('Invalid installation');
   const existing=s.devices[deviceId.toLowerCase()];
   if(existing){
    account=s.accounts[existing.accountId];
    // The raw credential is deliberately never persisted, so the app must retain it.
    if(account)throw fail('Restore the private installation credential for this device',409);
   }
   token='anon_'+randomBytes(32).toString('base64url');
   account={id:'anon_'+randomUUID(),deviceId:deviceId.toLowerCase(),createdAt:new Date(now()).toISOString(),accountToken:randomUUID()};
   s.accounts[account.id]=account;s.credentials[hash(token)]=account.id;
   s.devices[account.deviceId]={accountId:account.id,createdAt:account.createdAt};
   s.accountTokens[account.accountToken.toLowerCase()]=account.id;
  }
  await saveStore(root);
  return {token,account_token:account.accountToken,expires_in:31536000};
 }

 async function verify(product,authorization){
  const token=String(authorization||'').replace(/^Bearer /,'');
  if(!/^anon_[A-Za-z0-9_-]{43}$/.test(token))throw fail('Installation credential required',401);
  const root=await getStore(),s=state(root,product),account=s.accounts[s.credentials[hash(token)]];
  if(!account||account.disabled)throw fail('Installation credential unavailable',401);
  return {root,s,account,token};
 }

 async function status(product,authorization){
  const {s,account}=await verify(product,authorization);
  return {binding:s.bindings[account.id]||null,pending_transactions:Object.values(s.receipts).filter(r=>r.customer_id===account.id&&r.status==='delivery_pending').length};
 }

 async function preview(product,authorization,code){
  const client=clientFor(product);if(!client)throw fail('Referral service is not configured',503);
  const normalized=String(code||'').trim().toUpperCase();
  if(!/^(PC|PS)[A-F0-9]{12}$/.test(normalized))throw fail('Invalid invitation code');
  const {s,account}=await verify(product,authorization);
  await client.request('/api/code?product='+encodeURIComponent(product)+'&code='+encodeURIComponent(normalized));
  const old=s.bindings[account.id];
  if(old&&old.code!==normalized)throw fail('This installation already has a different referral source',409);
  return {code:normalized,product,already_bound:!!old,requires_confirmation:true};
 }

 async function bind(product,authorization,code,confirmed){
  if(confirmed!==true)throw fail('Please confirm your referral code first');
  const normalized=String(code||'').trim().toUpperCase();
  await preview(product,authorization,normalized);
  const {root,s,account}=await verify(product,authorization),client=clientFor(product),old=s.bindings[account.id];
  const registeredAt=Math.floor(Date.parse(account.createdAt)/1000);
  if(!old&&now()/1000-registeredAt>7*86400)throw fail('New-installation binding window expired',409);
  if(!old&&Object.values(s.receipts).some(r=>r.customer_id===account.id))throw fail('A referral must be bound before the first purchase',409);
  await client.install({installation_id:account.id,code:normalized,occurred_at:registeredAt});
  await client.register({customer_id:account.id,code:normalized,registered_at:registeredAt,is_self_referral:false});
  const result=await client.attribution(account.id),binding=result.binding;
  if(!binding||binding.customer_id!==account.id||binding.product!==product)throw fail('Invalid attribution response',502);
  s.bindings[account.id]={code:normalized,binding_id:binding.id,partner_id:binding.partner_id,bound_at:binding.bound_at,expires_at:binding.expires_at,commission_bps:binding.commission_bps};
  await saveStore(root);
  await client.activate({customer_id:account.id,code:normalized,is_new_customer:true,is_self_referral:false});
  return status(product,authorization);
 }

 async function recordVerified(product,t,signedTransaction,{refund=false}={}){
  const config=productFor(product);if(!config)throw fail('Product is not connected',404);
  const root=await getStore(),s=state(root,product),key=t.environment+':'+t.transactionId;
  const accountToken=String(t.appAccountToken||'').toLowerCase(),customer=s.accountTokens[accountToken]||null;
  let receipt=s.receipts[key];
  if(receipt&&(receipt.sku!==t.productId||receipt.original_transaction_id!==t.originalTransactionId))throw fail('Transaction conflict',409);
  receipt||={transaction_id:t.transactionId,original_transaction_id:t.originalTransactionId,customer_id:customer,account_token:accountToken,sku:t.productId,environment:t.environment,purchased_at:Math.floor(t.purchaseDate/1000),price:t.price??null,currency:t.currency??null,purchase_kind:config.skus.get(t.productId)?.kind||'iap',created_at:now(),attempts:0};
  if(receipt.customer_id&&customer&&receipt.customer_id!==customer)throw fail('Transaction ownership conflict',409);
  receipt.customer_id||=customer;receipt.revoked||=refund||!!t.revocationDate;receipt.proof_hash=hash(signedTransaction);
  if(t.environment!=='Production')receipt.status='sandbox';
  else if(receipt.revoked)receipt.status=receipt.status==='refunded'?'refunded':'refund_pending';
  else {
   const binding=receipt.customer_id&&s.bindings[receipt.customer_id];
   if(t.inAppOwnershipType==='FAMILY_SHARED')receipt.status='ownership_review';
   else if(!receipt.customer_id||!binding)receipt.status='unattributed';
   else if(receipt.purchased_at<binding.bound_at||receipt.purchased_at>binding.expires_at)receipt.status='outside_window';
   else if(receipt.currency!=='USD'||!Number.isSafeInteger(receipt.price)||receipt.price<=0||receipt.price%10!==0)receipt.status='amount_review';
   else receipt.status='delivery_pending';
  }
  s.receipts[key]=receipt;await saveStore(root);await drain(product);
  return {attribution_status:receipt.status,commission_eligible:receipt.status==='sent',customer_id:receipt.customer_id};
 }

 async function drain(product){
  const client=clientFor(product);if(!client)return;
  const root=await getStore(),s=state(root,product);
  for(const receipt of Object.values(s.receipts).filter(r=>['delivery_pending','refund_pending'].includes(r.status)&&(r.retry_at||0)<=now()).slice(0,25)){
   const sending=receipt.status;
   try{
    if(sending==='refund_pending')await client.refund(receipt.transaction_id);
    else {
     const binding=s.bindings[receipt.customer_id],account=s.accounts[receipt.customer_id];
     if(!binding||!account)throw fail('Verified attribution is unavailable',409);
     const result=await client.purchase({customer_id:account.id,transaction_id:receipt.transaction_id,sku:receipt.sku,gross_usd_cents:receipt.price/10,purchase_kind:receipt.purchase_kind,purchased_at:receipt.purchased_at});
     if(!result.ok)throw fail('Partner purchase is pending review',502);
    }
    receipt.status=sending==='refund_pending'?'refunded':'sent';receipt.last_error=null;
   }catch(error){receipt.attempts+=1;receipt.last_error=String(error.message||'Delivery failed').slice(0,200);receipt.retry_at=now()+Math.min(3600000,10000*2**Math.min(receipt.attempts,8));}
   await saveStore(root);
  }
 }

 return {session,status,preview,bind,recordVerified,drain};
}
