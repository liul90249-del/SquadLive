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
  const project=r=>({channel:r.channel,campaignId:depth>=1?r.campaignId||'':'',campaignName:depth>=1?r.campaignName||'':'',adGroupId:depth>=2?r.adGroupId||'':'',adGroupName:depth>=2?r.adGroupName||'':'',creativeId:depth>=3?r.creativeId||'':'',creativeName:depth>=3?r.creativeName||'':''});
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
