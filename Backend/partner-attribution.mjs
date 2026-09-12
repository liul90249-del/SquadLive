import {createHash,randomUUID} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
// Only call recordVerified after Apple's SignedDataVerifier succeeds.
// Durable records share the existing single-process store and its serialized writes.
export function createPartnerAttribution({getStore,saveStore,client,product,bundleId,skus,now=()=>Date.now()}) {
 let draining=false;
 const init=s=>{s.partnerTokens||={};s.partnerReceipts||={};s.partnerBindings||={};return s};
 return {
  async account(user) {
   const s=init(await getStore());
   if(!user.appleSubject&&!user.anonymous)throw fail('Verified Apple account required',401);
   user.partnerAccountToken ||= randomUUID();
   const old=s.partnerTokens[user.partnerAccountToken];
   if(old&&old!==user.id)throw fail('Account token conflict');
   s.partnerTokens[user.partnerAccountToken]=user.id;
   await saveStore(s);return {account_token:user.partnerAccountToken};
  },
  async status(identity) {
   const s=init(await getStore());
   return {binding:s.partnerBindings[identity.customerId]||null,
    pending_transactions:Object.values(s.partnerReceipts).filter(r=>r.customer_id===identity.customerId&&!['sent','refunded','free','sandbox'].includes(r.status)).length};
  },
  async preview(identity,code) {
   if(!/^PC[A-F0-9]{12}$/.test(code))throw fail('Invalid invitation code',400);
   await client.request('/api/code?product='+encodeURIComponent(product)+'&code='+encodeURIComponent(code));
   const s=init(await getStore());const old=s.partnerBindings[identity.customerId];
   if(old?.review_required)throw fail('Attribution requires administrator review');
   if(old&&old.code!==code)throw fail('Your account already has a different referral source');
   return {code,product,already_bound:!!old,requires_confirmation:true};
  },
  async bind(identity,code,confirmed) {
   if(confirmed!==true)throw fail('Please confirm your referral code first',400);
   await this.preview(identity,code);
   const s=init(await getStore()),old=s.partnerBindings[identity.customerId];
   const walletId=identity.walletUserId||identity.customerId;
   s.partnerWalletOwners||={};
   const reserved=s.partnerWalletOwners[walletId];
   if((reserved&&reserved!==identity.customerId)||(walletId!==identity.customerId&&s.partnerBindings[walletId]))throw fail('This installation already has a referral identity; restore its private credential');
   if(!old && now()/1000-identity.registeredAt>7*86400)throw fail('New-account binding window expired');
   if(!old){
    const prior=Object.values(s.partnerReceipts).some(r=>r.customer_id===identity.customerId&&r.environment==='Production'&&r.price!==0);
    const legacy=Object.values(s.appleTransactions||{}).some(r=>r.userId===walletId&&r.environment==='Production');
    if(prior||legacy)throw fail('A referral must be bound before your first purchase');
   }
   // Reserve before remote calls so concurrent anonymous identities cannot bind one wallet twice.
   s.partnerWalletOwners[walletId]=identity.customerId;await saveStore(s);
   await client.identify(identity.customerId,identity.registeredAt);
   const result=await client.bind({customer_id:identity.customerId,code,is_self_referral:false});
   // Canonical server binding controls ownership and the start/end timestamps.
   const b=result.binding;
   if(!b||b.customer_id!==identity.customerId||b.product!==product)throw fail('Invalid attribution response',502);
   s.partnerBindings[identity.customerId]={code,binding_id:b.id,partner_id:b.partner_id,bound_at:b.bound_at,expires_at:b.expires_at,commission_bps:b.commission_bps};
   if(!old && Object.values(s.partnerReceipts).some(r=>r.customer_id===identity.customerId&&r.environment==='Production'&&r.price!==0)){s.partnerBindings[identity.customerId].review_required=true;await saveStore(s);throw fail('Purchase occurred during binding; manual review required')}
   await saveStore(s);
   await client.activate({customer_id:identity.customerId,code,is_new_customer:true,is_self_referral:false});
   return this.status(identity);
  },
  async recordVerified(t,signedTransaction,{refund=false}={}) {
   if(t.bundleId!==bundleId||!skus[t.productId]||!['Production','Sandbox'].includes(t.environment)||!t.transactionId||!t.originalTransactionId||!Number.isSafeInteger(t.purchaseDate)||t.purchaseDate<=0||t.purchaseDate>now()+300000)throw fail('Invalid verified transaction metadata',400);
   const expectedType=skus[t.productId]==='subscription'?'Auto-Renewable Subscription':'Consumable';
   if(t.type!==expectedType)throw fail('Transaction type does not match product',400);
   const s=init(await getStore()),key=t.environment+':'+t.transactionId;
   const accountToken=String(t.appAccountToken||'').toLowerCase();
   const customer=s.partnerTokens[accountToken]||null,existing=s.partnerReceipts[key];
   const owner=Object.values(s.partnerReceipts).find(r=>r.environment===t.environment&&r.original_transaction_id===t.originalTransactionId&&r.customer_id);
   if(existing&&(existing.sku!==t.productId||existing.original_transaction_id!==t.originalTransactionId||existing.customer_id!==customer))throw fail('Transaction ownership conflict');
   if(owner&&customer&&owner.customer_id!==customer)throw fail('Subscription ownership conflict');
   const r=existing||{transaction_id:t.transactionId,original_transaction_id:t.originalTransactionId,customer_id:customer,account_token:accountToken,sku:t.productId,environment:t.environment,purchased_at:Math.floor(t.purchaseDate/1000),price:t.price??null,currency:t.currency??null,kind:skus[t.productId],created_at:now(),attempts:0};
   if(existing&&(r.price!==(t.price??null)||r.currency!==(t.currency??null)))throw fail('Transaction amount conflict');
   r.proof_hash=sha(signedTransaction);r.signed_transaction=signedTransaction;
   r.revoked ||= refund||!!t.revocationDate;
   if(r.environment!=='Production')r.status='sandbox';
   else if(r.revoked)r.status=r.status==='refunded'?'refunded':'refund_pending';
   else if(!['sent','unattributed','outside_window','ownership_review','amount_review'].includes(r.status)){
    const b=customer&&s.partnerBindings[customer];
    if(t.inAppOwnershipType==='FAMILY_SHARED')r.status='ownership_review';
    else if(r.price===0)r.status='free';
    else if(!customer||!b||b.review_required)r.status='unattributed';
    else if(r.purchased_at<b.bound_at||r.purchased_at>b.expires_at)r.status='outside_window';
    else if(r.currency!=='USD'||!Number.isSafeInteger(r.price)||r.price<=0||r.price%10!==0||r.price/10>100000000)r.status='amount_review';
    else r.status='pending';
   }
   s.partnerReceipts[key]=r;await saveStore(s);return {status:r.status,transaction_id:r.transaction_id};
  },
  async drain() {
   if(draining||!client)return;draining=true;
   try {
    const s=init(await getStore());
    for(const r of Object.values(s.partnerReceipts).filter(r=>['pending','refund_pending'].includes(r.status)&&(r.retry_at||0)<=now()).slice(0,50)){
     const sending=r.status;
     try {
      if(sending==='refund_pending')await client.refund(r.transaction_id);
      else {
       const u=s.partnerAnonymousAccounts?.[r.customer_id]||s.users[r.customer_id],b=s.partnerBindings[r.customer_id];
       if(!u||!b||b.review_required)throw fail('Awaiting verified attribution');
       await client.identify(u.id,Math.floor(Date.parse(u.createdAt)/1000));
       await client.activate({customer_id:u.id,code:b.code,is_new_customer:true,is_self_referral:false});
       const result=await client.purchase({customer_id:u.id,transaction_id:r.transaction_id,sku:r.sku,gross_usd_cents:r.price/10,purchase_kind:r.kind,purchased_at:r.purchased_at});
       if(!result.ok)throw fail('Partner purchase is pending review');
      }
      // A refund arriving during a purchase callback must never be overwritten.
      if(r.status===sending)r.status=sending==='refund_pending'?'refunded':'sent';
      r.last_error=null;
     }catch(e){r.attempts++;r.last_error=String(e.message||'Partner delivery failed').slice(0,200);r.retry_at=now()+Math.min(3600000,10000*2**Math.min(r.attempts,8));}
     await saveStore(s);
    }
   }finally{draining=false}
  }
 };
}
