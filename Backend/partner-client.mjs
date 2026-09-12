/** Server-only integration. Never ship EVENT_KEYS inside an App. */
export class PartnerClient {
  constructor({origin,product,key}) { const u=new URL(origin);if(u.protocol!=='https:'&&u.hostname!=='127.0.0.1')throw new Error('HTTPS required');this.origin=u.origin;this.product=product;this.key=key; }
  async request(path,body){const response=await fetch(this.origin+path,{signal:AbortSignal.timeout(10000),redirect:'error',method:body?'POST':'GET',headers:{Authorization:'Bearer '+this.key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify({...body,product:this.product}):undefined});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});return result;}
  install({installation_id,code,occurred_at}){return this.request('/api/events',{type:'install',installation_id,code,occurred_at});}
  register({customer_id,code,registered_at,is_self_referral}){return this.request('/api/events',{type:'register',customer_id,code,registered_at,is_self_referral});}
  identify(customer_id,registered_at){return this.request('/api/attribution',{action:'identify',customer_id,registered_at});}
  bind({customer_id,code,touch_token,is_self_referral}){return this.request('/api/attribution',{action:'bind',customer_id,code,touch_token,is_self_referral});}
  attribution(customer_id){return this.request('/api/attribution?product='+encodeURIComponent(this.product)+'&customer_id='+encodeURIComponent(customer_id));}
  linkAccount(customer_id,link_token){return this.request('/api/attribution',{action:'link_account',customer_id,link_token});}
  retryPending(){return this.request('/api/attribution',{action:'retry'});}
  activate({customer_id,code,is_new_customer,is_self_referral}){return this.request('/api/events',{type:'activate',customer_id,code,is_new_customer,is_self_referral});}
  purchase({customer_id,transaction_id,sku,gross_usd_cents,net_usd_cents,purchase_kind,purchased_at}){return this.request('/api/events',{type:'purchase',customer_id,transaction_id,sku,gross_usd_cents,net_usd_cents,purchase_kind,purchased_at});}
  refund(transaction_id){return this.request('/api/events',{type:'refund',transaction_id});}
  previewBenefit(customer_id,code){return this.request('/api/benefits',{action:'preview',customer_id,code});}
  claimBenefit(customer_id,code,plan_id){return this.request('/api/benefits',{action:'claim',customer_id,code,plan_id,confirmed:true});}
  benefitStatus(customer_id){return this.request('/api/benefits?product='+encodeURIComponent(this.product)+'&customer_id='+encodeURIComponent(customer_id));}
  // Call only after independently verifying Apple transaction, customer, offer and actual grant.
  confirmBenefit({customer_id,claim_id,transaction_id,sku,receipt}){return this.request('/api/benefits',{action:'confirm',customer_id,claim_id,transaction_id,sku,receipt,environment:'Production'});}
  reportBenefitFailure(customer_id,claim_id,reason){return this.request('/api/benefits',{action:'failure',customer_id,claim_id,reason});}
  revokeBenefit(customer_id,claim_id,transaction_id,reason){return this.request('/api/benefits',{action:'revoke',customer_id,claim_id,transaction_id,reason});}
  pendingRewards(){return this.request('/api/rewards?product='+encodeURIComponent(this.product));}
  acknowledgeReward(id,receipt){return this.request('/api/rewards',{id,receipt});}
}
