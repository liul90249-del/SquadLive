import {AppStoreServerAPIClient,Environment,GetTransactionHistoryVersion} from '@apple/app-store-server-library';

const unavailable=message=>Object.assign(new Error(message),{status:503});
/** No query filters: revoked and older transactions must participate in eligibility. */
export function createPurchaseHistory({client,verifier,bundleId,appId,environment,now=()=>Date.now(),maxPages=100}) {
 return {
  async check(appTransactionId){
   if(!client||!verifier)throw unavailable('Apple purchase history is not configured');
   if(typeof appTransactionId!=='string'||!/^\d{1,128}$/.test(appTransactionId))throw Object.assign(new Error('Verified app transaction identity required'),{status:400});
   let revision=null,hasPaid=false,unknownAmount=false,count=0;
   const seen=new Set();
   for(let pageNumber=0;pageNumber<maxPages;pageNumber++){
    let page;
    try{page=await client.getTransactionHistory(appTransactionId,revision,{},GetTransactionHistoryVersion.V2)}catch{throw unavailable('Apple purchase history is temporarily unavailable')}
    if(!page||page.bundleId!==bundleId||page.environment!==environment||
      (environment==='Production'&&page.appAppleId!==appId)||typeof page.hasMore!=='boolean'||!Array.isArray(page.signedTransactions))throw unavailable('Apple purchase history response is incomplete');
    for(const signed of page.signedTransactions){
     let transaction;try{transaction=await verifier.verifyAndDecodeTransaction(signed)}catch{throw unavailable('Apple purchase history signature verification failed')}
     if(transaction.bundleId!==bundleId||transaction.environment!==environment||transaction.appTransactionId!==appTransactionId||
       !Number.isSafeInteger(transaction.purchaseDate)||transaction.purchaseDate<=0||transaction.purchaseDate>now()+300000)throw unavailable('Apple purchase history identity mismatch');
     count++;
     // Refunds do not make a previously paid customer a new unpaid customer.
     if(!Number.isSafeInteger(transaction.price)||transaction.price<0)unknownAmount=true;
     else if(transaction.price>0)hasPaid=true;
    }
    if(!page.hasMore)return {complete:true,has_paid:hasPaid,amount_unknown:unknownAmount,eligible:environment==='Production'&&!hasPaid&&!unknownAmount,transaction_count:count,checked_at:now()};
    if(typeof page.revision!=='string'||!page.revision||seen.has(page.revision))throw unavailable('Apple purchase history pagination is incomplete');
    seen.add(page.revision);revision=page.revision;
   }
   throw unavailable('Apple purchase history exceeds verification limit');
  }
 };
}

/** Product-specific key; never fall back to another product's credential. */
export function historyClientFromEnvironment(env,{bundleId,environment}){
 if(!['Production','Sandbox'].includes(environment))throw new Error('Invalid Apple environment');
 const {NUTRISCAN_APPLE_IAP_PRIVATE_KEY:key,NUTRISCAN_APPLE_IAP_KEY_ID:keyId,NUTRISCAN_APPLE_IAP_ISSUER_ID:issuerId}=env;
 if(!key||!keyId||!issuerId)return null;
 return new AppStoreServerAPIClient(key,keyId,issuerId,bundleId,environment==='Production'?Environment.PRODUCTION:Environment.SANDBOX);
}
