import {reportingDate} from './marketing-time.mjs';
const keys=['utm_source','utm_medium','utm_campaign','utm_content','campaign_id','adset_id','adset_name','ad_id'];
export function buildWebReturnReport(data,orders,{start='',end='',currency='USD',channel='',campaignId='',adGroupId='',creativeId='',timezone='UTC',now=Date.now()}={}){
 const s=data||{clicks:[],bindings:[]},groups=new Map();
 const date=n=>reportingDate(n,timezone);
 const inRange=n=>(!start||date(n)>=start)&&(!end||date(n)<=end);
 const matches=c=>(!channel||c.utm_source?.toLowerCase()===channel.toLowerCase()||['facebook','meta'].includes(channel.toLowerCase())&&['facebook','fb','instagram','ig'].includes(c.utm_source?.toLowerCase()))&&(!campaignId||c.campaign_id===campaignId)&&(!adGroupId||c.adset_id===adGroupId)&&(!creativeId||c.ad_id===creativeId);
 const bucket=(campaign,time)=>{
  const day=date(time),id=JSON.stringify([day,...keys.map(k=>campaign[k]||'')]);
  if(!groups.has(id))groups.set(id,{date:day,campaign,downloadClicks:0,associatedAccounts:0,newAccounts:0,existingAccounts:0,payers:0,paidOrders:0,netMilliunits:0});
  return groups.get(id);
 };
 for(const c of s.clicks)if(c.createdAt<=now&&inRange(c.createdAt)&&matches(c.campaign))bucket(c.campaign,c.createdAt).downloadClicks++;
 for(const [account,b] of s.bindings.map(b=>[b.accountId,b])){
  if(!inRange(b.clickedAt)||b.boundAt>now||!matches(b.campaign))continue;
  const row=bucket(b.campaign,b.clickedAt);row.associatedAccounts++;row[b.audience==='new_account'?'newAccounts':'existingAccounts']++;
  const seen=new Set();let paid=false;
  for(const o of orders){
   const at=Date.parse(o.purchasedAt);
   if(o.accountId!==account||o.currency!==currency||!Number.isSafeInteger(o.priceMilliunits)||o.priceMilliunits<=0||!o.transactionId||seen.has(o.transactionId)||at<b.boundAt||at>now||!Number.isFinite(at))continue;
   seen.add(o.transactionId);row.paidOrders++;paid=true;
   const refund=(!o.refundedAt||Date.parse(o.refundedAt)<=now)?Math.max(0,Math.min(o.priceMilliunits,o.refundedMilliunits||0)):0;
   row.netMilliunits+=o.priceMilliunits-refund;
  }
  if(paid)row.payers++;
 }
 return {method:'web_return',currency,rows:[...groups.values()].sort((a,b)=>b.date.localeCompare(a.date)),installAttributionVerified:false};
}

