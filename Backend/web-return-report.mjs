const keys=['utm_source','utm_medium','utm_campaign','utm_content','campaign_id','adset_id','adset_name','ad_id'];
export function buildWebReturnReport(data,orders,{start='',end='',currency='USD',now=Date.now()}={}){
 const s=data||{clicks:[],bindings:[]},groups=new Map();
 const date=n=>new Date(n).toISOString().slice(0,10);
 const inRange=n=>(!start||date(n)>=start)&&(!end||date(n)<=end);
 const bucket=(campaign,time)=>{
  const day=date(time),id=JSON.stringify([day,...keys.map(k=>campaign[k]||'')]);
  if(!groups.has(id))groups.set(id,{date:day,campaign,downloadClicks:0,associatedAccounts:0,newAccounts:0,existingAccounts:0,payers:0,paidOrders:0,netMilliunits:0});
  return groups.get(id);
 };
 for(const c of s.clicks)if(c.createdAt<=now&&inRange(c.createdAt))bucket(c.campaign,c.createdAt).downloadClicks++;
 for(const [account,b] of s.bindings.map(b=>[b.accountId,b])){
  if(!inRange(b.clickedAt)||b.boundAt>now)continue;
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

