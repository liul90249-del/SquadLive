import {isIP} from 'node:net';

const endpoint='https://s2s.singular.net/api/v2/evt';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSingularS2S({sdkKey,bundleId,fetchImpl=fetch,url=endpoint}) {
 if(!sdkKey||!bundleId)throw new Error('Singular S2S is not configured');
 return {
  async event({sdid,name,transactionId,originalTransactionId,productId,amountMilliunits,currency,ip,country,eventAt}) {
   if(!uuid.test(sdid||''))throw new Error('Singular device ID is missing or invalid');
   if(!/^[\x20-\x7e]{1,32}$/.test(name||''))throw new Error('Singular event name is invalid');
   if(typeof transactionId!=='string'||!transactionId)throw new Error('Apple transaction ID is missing');
   const form=new URLSearchParams({
    a:sdkKey,p:'iOS',i:bundleId,sdid:sdid.toLowerCase(),n:name,
    att_authorization_status:'0',
    e:JSON.stringify({transaction_id:transactionId,original_transaction_id:originalTransactionId,product_id:productId,source:'apple_verified_s2s'})
   });
   if(ip&&isIP(ip))form.set('ip',ip);
   else if(/^[A-Z]{2}$/.test(country||'')){form.set('use_ip','true');form.set('country',country)}
   else throw new Error('Device network context is missing');
   if(Number.isSafeInteger(eventAt)&&eventAt>0)form.set('utime',String(Math.floor(eventAt/1000)));
   if(amountMilliunits!==undefined){
    if(!Number.isSafeInteger(amountMilliunits)||amountMilliunits===0||!/^[A-Z]{3}$/.test(currency||''))throw new Error('Apple revenue amount or currency is invalid');
    form.set('amt',String(amountMilliunits/1000));
    form.set('cur',currency);
    form.set('is_revenue_event','true');
   }
   const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:form,signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error(`Singular S2S HTTP ${response.status}`);
   const result=await response.json();
   if(result?.status!=='ok')throw new Error(`Singular S2S rejected event: ${String(result?.reason||'unknown reason').slice(0,160)}`);
   return {accepted:true};
  }
 };
}
