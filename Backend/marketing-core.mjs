// Shared, pure reporting logic. All money uses integer milliunits, never FX guesses.
export const DAY = 86400000;
export const FUNNEL_EVENTS = ['first_activation','onboarding_complete','photo_permission_granted','paywall_open','purchase_attempt','purchase_cancelled','purchase_failed','products_load_failed','cleanup_completed'];
export const dateOf = ms => new Date(ms).toISOString().slice(0,10);
const ms = value => typeof value === 'number' ? value : Date.parse(value);
const sum = (rows,key) => rows.reduce((n,r)=>n+r[key],0);
const rate = (n,d) => d>0 ? n/d*100 : null;
export const sourceKey = r => JSON.stringify([r.channel,r.campaignId||'',r.adGroupId||'',r.creativeId||'']);

export function marketingDataset(store,product,operations,now=Date.now()) {
  const state=store.marketing?.[product]||{}, accounts=store.sharedPartnerReferrals?.[product]?.accounts||{};
  return {
    now, product, costs:Object.values(state.costs||{}),
    imports:(state.imports||[]).slice(-12).reverse(),
    users:operations.users.map(u=>{
      const account=accounts[u.id]||{}, a=state.attributions?.[u.id];
      return {id:u.id,createdAt:u.createdAt,acquiredAt:a?.acquiredAt||u.createdAt,
        attribution:a||null,events:account.funnelEvents||{},trackedFrom:account.funnelTrackedFrom||null,
        hasCompletedCleanup:u.hasCompletedCleanup,firstCleanupAt:u.firstCleanupAt};
    }),
    orders:operations.orders.map(o=>({...o,
      isFreeTrial:o.isFreeTrial===true,expiresAt:o.expiresAt||null})),
    tracking:'client-first-events-v1'
  };
}

export function buildMarketingReport(data,{start='',end='',channel='',campaignId='',adGroupId='',creativeId='',currency='USD',level='campaign'}={}) {
  const now=data.now, sourceMatches=r=>(!channel||r.channel===channel)&&(!campaignId||r.campaignId===campaignId)&&(!adGroupId||r.adGroupId===adGroupId)&&(!creativeId||r.creativeId===creativeId);
  const inRange=d=>(!start||d>=start)&&(!end||d<=end);
  const users=data.users.filter(u=>inRange(dateOf(ms(u.acquiredAt)))&&sourceMatches(u.attribution||{channel:'unknown'}));
  const costs=data.costs.filter(c=>c.currency===currency&&inRange(c.date)&&sourceMatches(c));
  const depth={channel:0,campaign:1,adGroup:2,creative:3}[level]??1;
  const project=r=>level==='date'?{channel:'all'}:({channel:r.channel,campaignId:depth>=1?r.campaignId||'':'',campaignName:depth>=1?r.campaignName||'':'',adGroupId:depth>=2?r.adGroupId||'':'',adGroupName:depth>=2?r.adGroupName||'':'',creativeId:depth>=3?r.creativeId||'':'',creativeName:depth>=3?r.creativeName||'':''});
  const costMap=new Map();
  for(const c of costs){const key=`${c.date}|${sourceKey(project(c))}`;if(!costMap.has(key))costMap.set(key,{date:c.date,...project(c),currency,spendMilliunits:0,impressions:0,clicks:0,installs:0});const row=costMap.get(key);for(const k of ['spendMilliunits','impressions','clicks','installs'])row[k]+=c[k];}

  const orderMap=new Map();
  for(const o of data.orders) {
    if(!o.accountId)continue;
    if(!orderMap.has(o.accountId))orderMap.set(o.accountId,[]);
    orderMap.get(o.accountId).push(o);
  }
  for(const orders of orderMap.values())orders.sort((a,b)=>ms(a.purchasedAt)-ms(b.purchasedAt));
  const paid=u=>(orderMap.get(u.id)||[]).filter(o=>o.priceMilliunits>0&&ms(o.purchasedAt)<=now);
  const trials=u=>(orderMap.get(u.id)||[]).filter(o=>o.isFreeTrial&&ms(o.purchasedAt)<=now);
  const amount=(u,days=null)=>{
    const from=ms(u.acquiredAt),until=days===null?now:Math.min(now,Date.parse(dateOf(from)+'T00:00:00Z')+days*DAY-1);
    const orders=paid(u).filter(o=>o.currency===currency&&ms(o.purchasedAt)>=from&&ms(o.purchasedAt)<=until);
    return orders.reduce((out,o)=>{
      out.gross+=o.priceMilliunits;
      if(o.refundedAt&&ms(o.refundedAt)<=now)out.refunds+=o.refundedMilliunits||0;
      else if(o.refundedMilliunits>0)out.refunds+=o.refundedMilliunits;
      return out;
    },{gross:0,refunds:0});
  };
  const userIds=new Set(users.map(u=>u.id));
  const quality={
    unknownAttribution:users.filter(u=>!u.attribution||u.attribution.channel==='unknown').length,
    funnelUnknown:users.filter(u=>!u.trackedFrom).length,
    funnelPartial:users.filter(u=>u.trackedFrom&&ms(u.trackedFrom)>ms(u.createdAt)+DAY).length,
    unlinkedOrders:data.orders.filter(o=>!o.accountId&&inRange(dateOf(ms(o.purchasedAt)))).length,
    unknownAmounts:data.orders.filter(o=>userIds.has(o.accountId)&&(o.priceMilliunits===null||!o.currency)).length,
    attributionDeliveryIssues:data.orders.filter(o=>userIds.has(o.accountId)&&[o.singularPurchaseStatus,o.singularRefundStatus].some(s=>['uncertain','rejected','attempting'].includes(s))).length,
    mixedCurrencyOrders:data.orders.filter(o=>userIds.has(o.accountId)&&o.priceMilliunits>0&&o.currency!==currency).length
  };
  const cohortMap=new Map();
  function bucket(date,s) {
    const key=`${date}|${sourceKey(s)}`;
    if(!cohortMap.has(key))cohortMap.set(key,{date,...s,users:[],cost:costMap.get(key)||null});
    return cohortMap.get(key);
  }
  for(const c of costMap.values())bucket(c.date,c);
  for(const u of users)bucket(dateOf(ms(u.acquiredAt)),project(u.attribution||{channel:'unknown'})).users.push(u);
  const cohorts=[...cohortMap.values()].map(b=>{
    const totals=b.users.map(u=>amount(u)).reduce((a,b)=>({gross:a.gross+b.gross,refunds:a.refunds+b.refunds}),{gross:0,refunds:0});
    const maturity=days=>now>=Date.parse(b.date+'T00:00:00Z')+days*DAY;
    const windows=Object.fromEntries([7,14,30].map(days=>{
      const v=b.users.map(u=>amount(u,days)).reduce((n,r)=>n+r.gross-r.refunds,0);
      return [days,{mature:maturity(days),net:v,roas:maturity(days)&&b.cost?.spendMilliunits>0&&b.users.length>0?v/b.cost.spendMilliunits*100:null}];
    }));
    const firstPayers=b.users.filter(u=>paid(u).length>0&&ms(paid(u)[0].purchasedAt)>=ms(u.acquiredAt)).length;
    const trialUsers=b.users.filter(u=>trials(u).length).length;
    return {...b,users:undefined,acquiredUsers:b.users.length,firstPayers,trialUsers,...totals,
      net:totals.gross-totals.refunds,windows,
      costPerPayer:b.cost&&firstPayers?b.cost.spendMilliunits/firstPayers:null};
  }).sort((a,b)=>b.date.localeCompare(a.date)||a.channel.localeCompare(b.channel));
  const acquisitionTotals={users:users.length,paid:users.filter(u=>paid(u).length>0&&ms(paid(u)[0].purchasedAt)>=ms(u.acquiredAt)).length,trial:users.filter(u=>trials(u).length).length};
  const trialPeople=users.filter(u=>trials(u).length);
  // Use Apple's actual trial end, not an assumed seven days. Missing end is unknown.
  const endedTrials=trialPeople.filter(u=>trials(u).some(t=>t.expiresAt&&ms(t.expiresAt)<=now));
  const converted=endedTrials.filter(u=>trials(u).some(t=>t.expiresAt&&ms(t.expiresAt)<=now&&paid(u).some(o=>o.originalTransactionId===t.originalTransactionId&&ms(o.purchasedAt)>=ms(t.expiresAt))));
  const events=FUNNEL_EVENTS.map(key=>{
    const known=users.filter(u=>u.trackedFrom);
    const count=known.filter(u=>Number.isFinite(u.events[key])&&u.events[key]<=now&&u.events[key]>=ms(u.acquiredAt)).length;
    return {key,count:known.length?count:null,denominator:known.length,unknown:users.length-known.length,rate:rate(count,known.length)};
  });
  const groups=new Map();
  for(const b of cohorts) {
    const key=sourceKey(b);
    if(!groups.has(key))groups.set(key,{channel:b.channel,campaignId:b.campaignId,adGroupId:b.adGroupId,creativeId:b.creativeId,campaignName:b.campaignName,adGroupName:b.adGroupName,creativeName:b.creativeName,users:0,trial:0,paid:0,net:0,spend:0,impressions:0,clicks:0,installs:0,costRows:0,missingCostCohorts:0});
    const g=groups.get(key);g.users+=b.acquiredUsers;g.trial+=b.trialUsers;g.paid+=b.firstPayers;g.net+=b.net;
    if(b.cost){g.costRows++;g.spend+=b.cost.spendMilliunits;g.impressions+=b.cost.impressions;g.clicks+=b.cost.clicks;g.installs+=b.cost.installs;}
    else if(b.channel!=='organic')g.missingCostCohorts++;
  }
  return {currency,start,end,cohorts,groups:[...groups.values()],quality,events,
    totals:{...acquisitionTotals,spend:costs.length?sum(costs,'spendMilliunits'):null,
      impressions:costs.length?sum(costs,'impressions'):null,clicks:costs.length?sum(costs,'clicks'):null,installs:costs.length?sum(costs,'installs'):null,
      gross:sum(cohorts,'gross'),refunds:sum(cohorts,'refunds'),net:sum(cohorts,'net')},
    trial:{started:trialPeople.length,ended:endedTrials.length,converted:converted.length,rate:rate(converted.length,endedTrials.length),
      unknownEnd:trialPeople.filter(u=>!trials(u).some(t=>t.expiresAt)).length,
      pending:trialPeople.filter(u=>trials(u).some(t=>t.expiresAt)&&!endedTrials.includes(u)).length},
    imports:data.imports,now};
}

// Connection state must distinguish a scheduled job from fresh, successful data.
export function marketingSyncHealth(connection, now=Date.now()) {
  if(!connection?.configured)return {label:'等待服务器配置',warning:true};
  if(connection.error)return {label:'最近同步失败 · 原数据保留',warning:true};
  if(!connection.enabled)return {label:'自动同步关闭',warning:true};
  if(!connection.lastSuccess)return {label:'已启用 · 等待首次同步',warning:true};
  if(now-connection.lastSuccess>36*60*60*1000)return {label:'同步数据已过期 · 请核对',warning:true};
  return {label:'自动同步正常',warning:false};
}

// Growth columns use acquisition cohorts; D0 is acquisition's UTC calendar day.
// Unknown historical cancellation timing is never reconstructed from current status.
export function buildGrowthReport(data, filters={}) {
  const level=filters.growthDimension==='source'?(filters.level||'campaign'):'date';
  const report=buildMarketingReport(data,{...filters,level});
  const currency=filters.currency||'USD', now=data.now;
  const orderMap=new Map(), people=new Map((data.subscriptions?.people||[]).map(p=>[p.id,p]));
  for(const o of data.orders||[]){
    if(!o.accountId||ms(o.purchasedAt)>now)continue;
    if(!orderMap.has(o.accountId))orderMap.set(o.accountId,[]);
    orderMap.get(o.accountId).push(o);
  }
  for(const orders of orderMap.values())orders.sort((a,b)=>ms(a.purchasedAt)-ms(b.purchasedAt));
  const match=u=>{
    const a=u.attribution||{channel:'unknown'};
    return ['channel','campaignId','adGroupId','creativeId'].every(k=>!filters[k]||a[k]===filters[k]);
  };
  const validUsers=[...new Map(data.users.filter(match).map(u=>[u.id,u])).values()];
  const rows=report.cohorts.map(c=>{
    const start=Date.parse(c.date+'T00:00:00Z'), end=start+DAY;
    const members=validUsers.filter(u=>dateOf(ms(u.acquiredAt))===c.date && (level==='date'||
      ['channel',...(level==='channel'?[]:['campaignId']),...(['adGroup','creative'].includes(level)?['adGroupId']:[]),...(level==='creative'?['creativeId']:[])].every(k=>(u.attribution?.[k]||(k==='channel'?'unknown':''))===(c[k]||''))));
    const paidOrders=u=>(orderMap.get(u.id)||[]).filter(o=>o.priceMilliunits>0);
    const subscriptions=u=>(orderMap.get(u.id)||[]).filter(o=>o.kind==='subscription');
    const firstSub=u=>{
      const observed=subscriptions(u)[0];
      const values=[people.get(u.id)?.subscribedAt,observed?ms(observed.purchasedAt):null].filter(v=>Number.isFinite(v));
      return values.length?Math.min(...values):null;
    };
    const d0Subs=members.filter(u=>{const t=firstSub(u);return t!==null&&t>=ms(u.acquiredAt)&&t>=start&&t<end;});
    const amount=(days=null)=>{
      const until=days===null?now:Math.min(now,start+days*DAY-1);
      const orders=members.flatMap(u=>paidOrders(u).filter(o=>o.currency===currency&&ms(o.purchasedAt)>=ms(u.acquiredAt)&&ms(o.purchasedAt)<=until));
      const incomplete=members.some(u=>(orderMap.get(u.id)||[]).some(o=>ms(o.purchasedAt)>=ms(u.acquiredAt)&&ms(o.purchasedAt)<=until&&(o.priceMilliunits==null||!o.currency)));
      const gross=orders.reduce((n,o)=>n+o.priceMilliunits,0),refunds=orders.reduce((n,o)=>n+(o.refundedMilliunits||0),0);
      return {gross:incomplete?null:gross,refunds:incomplete?null:refunds,net:incomplete?null:gross-refunds};
    };
    const current=amount(),day0=amount(1),cost=c.cost?.spendMilliunits??null;
    const record={date:c.date,channel:c.channel,campaignId:c.campaignId,adGroupId:c.adGroupId,creativeId:c.creativeId,
      spend:cost,impressions:c.cost?.impressions??null,clicks:c.cost?.clicks??null,installs:c.cost?.installs??null,
      users:members.length,subD0:d0Subs.length,
      freeD0:d0Subs.filter(u=>subscriptions(u).some(o=>o.isFreeTrial&&ms(o.purchasedAt)>=ms(u.acquiredAt)&&ms(o.purchasedAt)<end)).length,
      paidD0:members.filter(u=>{const first=paidOrders(u)[0];return first&&ms(first.purchasedAt)>=ms(u.acquiredAt)&&ms(first.purchasedAt)<end;}).length,
      grossD0:day0.gross,refundD0:day0.refunds,netD0:day0.net,
      gross:current.gross,refund:current.refunds,net:current.net,
      observed:now<end,unknownSource:members.filter(u=>!u.attribution||u.attribution.channel==='unknown').length,
      adRevenue:null,totalRevenue:null,totalProfit:null,forecastLtv:null,forecastRoas:null};
    const tracked=members.filter(u=>u.trackedFrom&&ms(u.trackedFrom)<=end);
    record.cleanupD0=tracked.length===members.length?members.filter(u=>Number.isFinite(u.events?.cleanup_completed)&&u.events.cleanup_completed>=ms(u.acquiredAt)&&u.events.cleanup_completed<end).length:null;
    const cancelEvents=data.subscriptions?.cancellationEvents;
    const trackingStart=ms(data.subscriptions?.trackingStartedAt);
    for(const d of [0,3,7]){
      const cutoff=start+(d+1)*DAY;
      const unknown=d0Subs.some(u=>people.get(u.id)?.autoRenewStatus==null);
      const covered=Array.isArray(cancelEvents)&&Number.isFinite(trackingStart)&&trackingStart<=start&&!unknown;
      const ids=new Set(d0Subs.map(u=>u.id));
      record['cancelD'+d]=covered&&now>=cutoff?new Set(cancelEvents.filter(e=>ids.has(e.id)&&e.at>=firstSub(members.find(u=>u.id===e.id))&&e.at<cutoff&&e.at<=now).map(e=>e.id)).size:null;
      record['cancelRateD'+d]=rate(record['cancelD'+d],record.subD0);
      if(record['cancelD'+d]===null)record['cancelRateD'+d]=null;
    }
    const ended=members.filter(u=>subscriptions(u).some(o=>o.isFreeTrial&&ms(o.purchasedAt)>=ms(u.acquiredAt)&&o.expiresAt&&ms(o.expiresAt)<=now));
    record.endedTrials=ended.length;
    record.convertedTrials=ended.filter(u=>subscriptions(u).some(t=>t.isFreeTrial&&ms(t.purchasedAt)>=ms(u.acquiredAt)&&t.expiresAt&&ms(t.expiresAt)<=now&&paidOrders(u).some(p=>p.originalTransactionId===t.originalTransactionId&&ms(p.purchasedAt)>=ms(t.expiresAt)))).length;
    for(const d of [0,3,7,8,14,30]){
      const a=amount(d+1);record['netD'+d]=a.net;
      record['roasD'+d]=now>=start+(d+1)*DAY&&cost>0&&members.length&&a.net!==null?a.net/cost*100:null;
    }
    return growthRates(record);
  });
  // Totals recompute ratios from matching summed numerators and denominators.
  const additive=['spend','impressions','clicks','installs','users','subD0','freeD0','paidD0','cleanupD0','grossD0','refundD0','netD0','gross','refund','net','endedTrials','convertedTrials','cancelD0','cancelD3','cancelD7','unknownSource'];
  const total={date:'合计',channel:'all',observed:rows.some(r=>r.observed)};
  for(const k of additive)total[k]=rows.length&&rows.every(r=>r[k]!==null)?rows.reduce((n,r)=>n+r[k],0):null;
  for(const d of [0,3,7,8,14,30]){
    total['netD'+d]=rows.length&&rows.every(r=>r['netD'+d]!==null)?rows.reduce((n,r)=>n+r['netD'+d],0):null;
    total['roasD'+d]=rows.length&&rows.every(r=>r['roasD'+d]!==null)&&total.spend>0?total['netD'+d]/total.spend*100:null;
  }
  for(const d of [0,3,7])total['cancelRateD'+d]=total['cancelD'+d]!==null?rate(total['cancelD'+d],total.subD0):null;
  return {rows,total:growthRates(total),currency,now};
}
function growthRates(r){
  const divide=(n,d,m=1)=>n!=null&&d>0?n/d*m:null;
  return {...r,ctr:divide(r.clicks,r.impressions,100),cpi:divide(r.spend,r.installs),subRateD0:divide(r.subD0,r.users,100),
    costPerSubD0:divide(r.spend,r.subD0),paidRateD0:divide(r.paidD0,r.users,100),trialPaidRate:divide(r.convertedTrials,r.endedTrials,100),
    ltv:divide(r.net,r.users),roas:r.users>0?divide(r.net,r.spend,100):null,contribution:r.users>0&&r.net!=null&&r.spend!=null?r.net-r.spend:null,
    roi:r.users>0&&r.net!=null&&r.spend>0?(r.net-r.spend)/r.spend*100:null};
}
