// Shared, pure reporting logic. All money uses integer milliunits, never FX guesses.
export const DAY = 86400000;
export const RETURN_WINDOWS = [7,14,30,60,90,180,365,540,730];
export const GROWTH_DAYS = [0,3,7,8,14,30,60,90,180,365,540,730];
export const FUNNEL_EVENTS = ['first_activation','onboarding_complete','photo_permission_granted','paywall_open','purchase_attempt','purchase_cancelled','purchase_failed','products_load_failed','cleanup_completed'];
export const dateOf = ms => new Date(ms).toISOString().slice(0,10);
const ms = value => typeof value === 'number' ? value : Date.parse(value);
const sum = (rows,key) => rows.reduce((n,r)=>n+r[key],0);
const rate = (n,d) => d>0 ? n/d*100 : null;
export const sourceKey = r => JSON.stringify([r.channel,r.campaignId||'',r.adGroupId||'',r.creativeId||'']);

export function marketingDataset(store,product,operations,now=Date.now()) {
  const state=store.marketing?.[product]||{}, accounts=store.sharedPartnerReferrals?.[product]?.accounts||{};
  const links=new Map();
  for(const account of Object.values(accounts)){const id=String(account.singularSdid||'').toLowerCase();if(id)links.set(id,(links.get(id)||0)+1);}
  return {
    now, product, costs:Object.values(state.costs||{}),
    imports:(state.imports||[]).slice(-12).reverse(),
    users:operations.users.map(u=>{
      const account=accounts[u.id]||{}, a=state.attributions?.[u.id];
      return {id:u.id,createdAt:u.createdAt,acquiredAt:a?.acquiredAt||u.createdAt,
        attribution:a||null,events:account.funnelEvents||{},trackedFrom:account.funnelTrackedFrom||null,
        lastSeenAt:u.lastSeenAt||null,
        identityLinkStatus:!account.singularSdid?'missing':links.get(String(account.singularSdid).toLowerCase())>1?'ambiguous':'ready',
        activityTrackedFrom:account.activityTrackedFrom||null,
        paywallEvents:account.paywallEvents||[],paywallHistoryTruncated:account.paywallHistoryTruncated===true,
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
    const matchedUsers=b.users.filter(u=>u.attribution&&!['organic','unknown'].includes(u.attribution.channel)&&costs.some(c=>c.date===b.date&&c.channel===u.attribution.channel&&['campaignId','adGroupId','creativeId'].every(k=>!c[k]||c[k]===u.attribution[k])));
    const maturity=days=>now>=Date.parse(b.date+'T00:00:00Z')+days*DAY;
    const windows=Object.fromEntries(RETURN_WINDOWS.map(days=>{
      const v=b.users.map(u=>amount(u,days)).reduce((n,r)=>n+r.gross-r.refunds,0);
      const matchedNet=matchedUsers.map(u=>amount(u,days)).reduce((n,r)=>n+r.gross-r.refunds,0);
      return [days,{mature:maturity(days),net:v,matchedNet:matchedUsers.length?matchedNet:null,roas:maturity(days)&&b.cost?.spendMilliunits>0&&matchedUsers.length>0?matchedNet/b.cost.spendMilliunits*100:null}];
    }));
    const firstPayers=b.users.filter(u=>paid(u).length>0&&ms(paid(u)[0].purchasedAt)>=ms(u.acquiredAt)).length;
    const matchedPayers=matchedUsers.filter(u=>paid(u).length>0&&ms(paid(u)[0].purchasedAt)>=ms(u.acquiredAt)).length;
    const trialUsers=b.users.filter(u=>trials(u).length).length;
    return {...b,users:undefined,acquiredUsers:b.users.length,matchedUsers:matchedUsers.length,matchedPayers,firstPayers,trialUsers,...totals,
      net:totals.gross-totals.refunds,windows,
      costPerPayer:b.cost&&matchedPayers?b.cost.spendMilliunits/matchedPayers:null};
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
    if(!groups.has(key))groups.set(key,{channel:b.channel,campaignId:b.campaignId,adGroupId:b.adGroupId,creativeId:b.creativeId,campaignName:b.campaignName,adGroupName:b.adGroupName,creativeName:b.creativeName,users:0,trial:0,paid:0,matchedPayers:0,net:0,spend:0,impressions:0,clicks:0,installs:0,costRows:0,missingCostCohorts:0});
    const g=groups.get(key);g.users+=b.acquiredUsers;g.trial+=b.trialUsers;g.paid+=b.firstPayers;g.matchedPayers+=b.matchedPayers;g.net+=b.net;
    if(b.cost){g.costRows++;g.spend+=b.cost.spendMilliunits;g.impressions+=b.cost.impressions;g.clicks+=b.cost.clicks;g.installs+=b.cost.installs;}
    else if(b.channel!=='organic')g.missingCostCohorts++;
  }
  return {currency,start,end,cohorts,groups:[...groups.values()],quality,events,
    paywall:buildPaywallReport(users,data.orders,{now,currency}),
    totals:{...acquisitionTotals,spend:costs.length?sum(costs,'spendMilliunits'):null,
      impressions:costs.length?sum(costs,'impressions'):null,clicks:costs.length?sum(costs,'clicks'):null,installs:costs.length?sum(costs,'installs'):null,
      gross:sum(cohorts,'gross'),refunds:sum(cohorts,'refunds'),net:sum(cohorts,'net')},
    trial:{started:trialPeople.length,ended:endedTrials.length,converted:converted.length,rate:rate(converted.length,endedTrials.length),
      unknownEnd:trialPeople.filter(u=>!trials(u).some(t=>t.expiresAt)).length,
      pending:trialPeople.filter(u=>trials(u).some(t=>t.expiresAt)&&!endedTrials.includes(u)).length},
    imports:data.imports,now};
}

// Observational attribution, not a randomized experiment. Assign an initial
// subscription to its latest same-product click within 24 hours. Renewals and
// existing subscribers are excluded; unmatched orders remain unassigned.
export function buildPaywallReport(users, orders, {now,currency='USD'}) {
  const groups=new Map();let unassigned=0;
  const key=e=>JSON.stringify([e.revision,e.tier,e.template,e.surface]);
  const group=e=>{
    const k=key(e);
    if(!groups.has(k))groups.set(k,{revision:e.revision,tier:e.tier,template:e.template,surface:e.surface,
      viewers:new Set(),clickers:new Set(),payers:new Set(),trials:new Set(),net:0});
    return groups.get(k);
  };
  const userIDs=new Set(users.map(u=>u.id));
  const byUser=new Map();
  for(const o of orders) {
    if(!userIDs.has(o.accountId)||!Number.isFinite(ms(o.purchasedAt))||ms(o.purchasedAt)>now)continue;
    if(!byUser.has(o.accountId))byUser.set(o.accountId,[]);
    byUser.get(o.accountId).push(o);
  }
  for(const u of users) {
    const events=(u.paywallEvents||[]).filter(e=>e.at>=ms(u.acquiredAt)&&e.at<=now);
    const opens=events.filter(e=>e.name==='paywall_open');
    const attempts=events.filter(e=>e.name==='purchase_attempt'&&opens.some(o=>o.presentationId===e.presentationId&&key(o)===key(e)&&o.at<=e.at));
    for(const e of opens)group(e).viewers.add(u.id);
    for(const e of attempts)group(e).clickers.add(u.id);
    // The earliest observed subscription is the only acquisition conversion.
    // Missing older history is explicitly a limitation of this report.
    const first=(byUser.get(u.id)||[]).filter(o=>o.isFreeTrial||o.priceMilliunits>0)
      .sort((a,b)=>ms(a.purchasedAt)-ms(b.purchasedAt)||String(a.transactionId).localeCompare(String(b.transactionId)))[0];
    if(!first||ms(first.purchasedAt)<ms(u.acquiredAt))continue;
    const candidates=attempts.filter(e=>e.productId===first.sku&&e.at<=ms(first.purchasedAt)&&ms(first.purchasedAt)-e.at<=DAY)
      .sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
    if(!candidates.length){unassigned++;continue;}
    const g=group(candidates[0]);
    if(first.isFreeTrial)g.trials.add(u.id);
    const firstCharge=first.priceMilliunits>0?first:first.isFreeTrial&&first.originalTransactionId&&first.expiresAt?
      (byUser.get(u.id)||[]).filter(o=>o.originalTransactionId===first.originalTransactionId&&o.priceMilliunits>0&&ms(o.purchasedAt)>=ms(first.expiresAt))
        .sort((a,b)=>ms(a.purchasedAt)-ms(b.purchasedAt))[0]:null;
    if(firstCharge){
      g.payers.add(u.id);
      if(firstCharge.currency===currency)g.net+=firstCharge.priceMilliunits-(firstCharge.refundedMilliunits||0);
    }
  }
  return {currency,unassigned,missing:users.filter(u=>!(u.paywallEvents||[]).length).length,
    incomplete:users.filter(u=>u.paywallHistoryTruncated).length,
    rows:[...groups.values()].map(g=>({...g,viewers:g.viewers.size,clickers:g.clickers.size,payers:g.payers.size,trials:g.trials.size,
      clickRate:rate(g.clickers.size,g.viewers.size),paidRate:rate(g.payers.size,g.viewers.size)}))
      .sort((a,b)=>b.revision-a.revision||a.tier.localeCompare(b.tier)||a.template.localeCompare(b.template))};
}

// Connection state must distinguish a scheduled job from fresh, successful data.
export function marketingSyncHealth(connection, now=Date.now()) {
  if(!connection?.configured)return {label:'等待服务器配置',warning:true};
  if(connection.error)return {label:'最近同步失败 · 原数据保留',warning:true};
  if(!connection.enabled)return {label:'自动同步关闭',warning:true};
  if(!connection.lastSuccess)return {label:'已启用 · 等待首次同步',warning:true};
  if(now-connection.lastSuccess>(connection.intervalMinutes||15)*2*60000)return {label:'同步数据已过期 · 请核对',warning:true};
  if(connection.rows===0)return {label:'已核对 · 暂无成本记录',warning:true};
  if(connection.reportMode!=='realtime'||connection.end!==dateOf(now))return {label:'尚未同步当天数据',warning:true};
  return {label:'自动同步正常 · 含当天',warning:false};
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
  // Calendar rows belong to date summary only; never invent a source/campaign.
  const cohorts=[...report.cohorts];
  if(level==='date' && /^\d{4}-\d{2}-\d{2}$/.test(filters.start||'') && /^\d{4}-\d{2}-\d{2}$/.test(filters.end||'')) {
    const from=Date.parse(filters.start+'T00:00:00Z');
    const until=Math.min(Date.parse(filters.end+'T00:00:00Z'),Date.parse(dateOf(now)+'T00:00:00Z'));
    const dates=new Set(cohorts.map(c=>c.date));
    if(Number.isFinite(from)&&Number.isFinite(until)&&until>=from&&(until-from)/DAY<10000) {
      for(let day=until;day>=from;day-=DAY) {
        const date=dateOf(day);
        if(!dates.has(date))cohorts.push({date,channel:'all',cost:null,calendarOnly:true});
      }
      cohorts.sort((a,b)=>b.date.localeCompare(a.date));
    }
  }
  const rows=cohorts.map(c=>{
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
    const amount=(days=null, selected=members, subscriptionOnly=false)=>{
      const until=days===null?now:Math.min(now,start+days*DAY-1);
      const orders=selected.flatMap(u=>paidOrders(u).filter(o=>(!subscriptionOnly||o.kind==='subscription')&&o.currency===currency&&ms(o.purchasedAt)>=ms(u.acquiredAt)&&ms(o.purchasedAt)<=until));
      const incomplete=selected.some(u=>(orderMap.get(u.id)||[]).some(o=>(!subscriptionOnly||o.kind==='subscription')&&ms(o.purchasedAt)>=ms(u.acquiredAt)&&ms(o.purchasedAt)<=until&&(o.priceMilliunits==null||!o.currency)));
      const gross=orders.reduce((n,o)=>n+o.priceMilliunits,0),refunds=orders.reduce((n,o)=>n+(o.refundedMilliunits||0),0);
      return {gross:incomplete?null:gross,refunds:incomplete?null:refunds,net:incomplete?null:gross-refunds};
    };
    // Match paid attribution to an observed cost row at that row's granularity.
    // Date aggregation must not turn organic or unknown revenue into ad returns.
    const matchedMembers=members.filter(u=>u.attribution && !['unknown','organic'].includes(u.attribution.channel) &&
      data.costs.some(cost=>cost.date===c.date && cost.currency===currency && cost.channel===u.attribution.channel &&
        ['campaignId','adGroupId','creativeId'].every(k=>!cost[k]||cost[k]===u.attribution[k])));
    const current=amount(),day0=amount(1),matched=amount(null,matchedMembers),cost=c.cost?.spendMilliunits??null;
    const record={calendarOnly:c.calendarOnly===true,date:c.date,channel:c.channel,campaignId:c.campaignId,adGroupId:c.adGroupId,creativeId:c.creativeId,
      spend:cost,impressions:c.cost?.impressions??null,clicks:c.cost?.clicks??null,installs:c.cost?.installs??null,
      users:members.length,matchedUsers:matchedMembers.length,matchedNet:matchedMembers.length?matched.net:null,subD0:d0Subs.length,
      freeD0:d0Subs.filter(u=>subscriptions(u).some(o=>o.isFreeTrial&&ms(o.purchasedAt)>=ms(u.acquiredAt)&&ms(o.purchasedAt)<end)).length,
      paidD0:members.filter(u=>{const first=paidOrders(u)[0];return first&&ms(first.purchasedAt)>=ms(u.acquiredAt)&&ms(first.purchasedAt)<end;}).length,
      grossD0:day0.gross,refundD0:day0.refunds,netD0:day0.net,
      gross:current.gross,refund:current.refunds,net:current.net,
      observed:now<end,unknownSource:members.filter(u=>!u.attribution||u.attribution.channel==='unknown').length,
      adRevenue:null,adRevenueApplicable:data.product!=='cleaner',totalRevenue:data.product==='cleaner'?amount(null,members,true).net:null,totalProfit:null,forecastLtv:null,forecastRoas:null};
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
    const cumulativeCovered=Array.isArray(cancelEvents)&&Number.isFinite(trackingStart)&&trackingStart<=start&&
      !d0Subs.some(u=>people.get(u.id)?.autoRenewStatus==null);
    const d0Ids=new Set(d0Subs.map(u=>u.id));
    record.cancelToDate=cumulativeCovered?new Set(cancelEvents.filter(e=>d0Ids.has(e.id)&&e.at>=firstSub(members.find(u=>u.id===e.id))&&e.at<=now).map(e=>e.id)).size:null;
    record.paidToDate=members.filter(u=>{const first=paidOrders(u)[0];return first&&ms(first.purchasedAt)>=ms(u.acquiredAt);}).length;
    // A second distinct charged transaction on the same subscription chain is a renewal.
    // A trial's first charge and purchases on another chain are not renewals.
    record.renewedToDate=members.filter(u=>{
      const chains=new Map();
      for(const o of paidOrders(u)){
        if(o.kind!=='subscription'||!o.originalTransactionId||!o.transactionId||ms(o.purchasedAt)<ms(u.acquiredAt))continue;
        if(!chains.has(o.originalTransactionId))chains.set(o.originalTransactionId,new Set());
        chains.get(o.originalTransactionId).add(o.transactionId);
      }
      return [...chains.values()].some(ids=>ids.size>=2);
    }).length;
    const ended=members.filter(u=>subscriptions(u).some(o=>o.isFreeTrial&&ms(o.purchasedAt)>=ms(u.acquiredAt)&&o.expiresAt&&ms(o.expiresAt)<=now));
    record.endedTrials=ended.length;
    record.convertedTrials=ended.filter(u=>subscriptions(u).some(t=>t.isFreeTrial&&ms(t.purchasedAt)>=ms(u.acquiredAt)&&t.expiresAt&&ms(t.expiresAt)<=now&&paidOrders(u).some(p=>p.originalTransactionId===t.originalTransactionId&&ms(p.purchasedAt)>=ms(t.expiresAt)))).length;
    for(const d of GROWTH_DAYS){
      const a=amount(d+1);record['netD'+d]=a.net;
      const matchedWindow=amount(d+1,matchedMembers);record['matchedNetD'+d]=matchedMembers.length?matchedWindow.net:null;
      record['roasD'+d]=now>=start+(d+1)*DAY&&cost>0&&matchedMembers.length&&matchedWindow.net!==null?matchedWindow.net/cost*100:null;
    }
    return growthRates(record);
  });
  // Calendar placeholders must not make known aggregate costs/coverage unknown.
  const totalRows=rows.filter(r=>!r.calendarOnly);
  // Totals recompute ratios from matching summed numerators and denominators.
  const additive=['spend','impressions','clicks','installs','users','subD0','freeD0','paidD0','cleanupD0','grossD0','refundD0','netD0','gross','refund','net','endedTrials','convertedTrials','cancelD0','cancelD3','cancelD7','cancelToDate','paidToDate','renewedToDate','unknownSource','matchedUsers','matchedNet','totalRevenue'];
  const total={date:'合计',channel:'all',adRevenueApplicable:data.product!=='cleaner',observed:totalRows.some(r=>r.observed)};
  for(const k of additive)total[k]=totalRows.length&&totalRows.every(r=>r[k]!==null)?totalRows.reduce((n,r)=>n+r[k],0):null;
  for(const d of GROWTH_DAYS){
    total['netD'+d]=totalRows.length&&totalRows.every(r=>r['netD'+d]!==null)?totalRows.reduce((n,r)=>n+r['netD'+d],0):null;
    total['matchedNetD'+d]=totalRows.length&&totalRows.every(r=>r['matchedNetD'+d]!==null)?totalRows.reduce((n,r)=>n+r['matchedNetD'+d],0):null;
    total['roasD'+d]=totalRows.length&&totalRows.every(r=>r['roasD'+d]!==null)&&total.spend>0?total['matchedNetD'+d]/total.spend*100:null;
  }
  for(const d of [0,3,7])total['cancelRateD'+d]=total['cancelD'+d]!==null?rate(total['cancelD'+d],total.subD0):null;
  return {rows,total:growthRates(total),currency,now};
}
function growthRates(r){
  const divide=(n,d,m=1)=>n!=null&&d>0?n/d*m:null;
  const estimatedAppleFee=r.adRevenueApplicable===false&&r.totalRevenue!=null?Math.round(r.totalRevenue*0.30):null;
  const estimatedProceeds=estimatedAppleFee!=null?r.totalRevenue-estimatedAppleFee:null;
  const estimatedProfit=estimatedProceeds!=null&&r.spend!=null?estimatedProceeds-r.spend:null;
  return {...r,estimatedAppleFee,estimatedProceeds,estimatedProfit,cancelRateToDate:divide(r.cancelToDate,r.subD0,100),paidRateToDate:divide(r.paidToDate,r.users,100),ctr:divide(r.clicks,r.impressions,100),cpi:divide(r.spend,r.installs),subRateD0:divide(r.subD0,r.users,100),
    costPerSubD0:divide(r.spend,r.subD0),paidRateD0:divide(r.paidD0,r.users,100),trialPaidRate:divide(r.convertedTrials,r.endedTrials,100),
    ltv:divide(r.net,r.users),roas:r.matchedUsers>0?divide(r.matchedNet,r.spend,100):null,contribution:r.matchedUsers>0&&r.matchedNet!=null&&r.spend!=null?r.matchedNet-r.spend:null,
    roi:r.matchedUsers>0&&r.matchedNet!=null&&r.spend>0?(r.matchedNet-r.spend)/r.spend*100:null};
}

// Read-only traceability for the exact acquisition row shown in the growth table.
export function growthDrilldown(data,filters,row,key) {
  const byDate=filters.growthDimension!=='source',level=filters.level||'campaign';
  const dimensions=['channel',...(level==='channel'?[]:['campaignId']),...(['adGroup','creative'].includes(level)?['adGroupId']:[]),...(level==='creative'?['creativeId']:[])];
  const members=data.users.filter(u=>{
    const a=u.attribution||{channel:'unknown'};
    return (!row.date||row.date==='合计'||dateOf(ms(u.acquiredAt))===row.date)&&
      (!filters.start||dateOf(ms(u.acquiredAt))>=filters.start)&&(!filters.end||dateOf(ms(u.acquiredAt))<=filters.end)&&
      ['channel','campaignId','adGroupId','creativeId'].every(k=>!filters[k]||a[k]===filters[k])&&
      (byDate||row.date==='合计'||dimensions.every(k=>(a[k]||'')===(row[k]||'')));
  });
  const people=new Map((data.subscriptions?.people||[]).map(p=>[p.id,p]));
  const ordersFor=u=>(data.orders||[]).filter(o=>o.accountId===u.id&&ms(o.purchasedAt)<=data.now).sort((a,b)=>ms(a.purchasedAt)-ms(b.purchasedAt));
  const selected=members.filter(u=>{
    if(key==='subD0'){
      const first=ordersFor(u).find(o=>o.kind==='subscription');
      const values=[people.get(u.id)?.subscribedAt,first?ms(first.purchasedAt):null].filter(Number.isFinite);
      const t=values.length?Math.min(...values):null;
      return t!==null&&t>=ms(u.acquiredAt)&&dateOf(t)===dateOf(ms(u.acquiredAt));
    }
    if(key==='paidToDate'){const first=ordersFor(u).find(o=>o.priceMilliunits>0);return first&&ms(first.purchasedAt)>=ms(u.acquiredAt);}
    return true;
  });
  const orders=selected.flatMap(u=>ordersFor(u).filter(o=>(o.priceMilliunits>0||o.priceMilliunits==null)&&
    o.currency===(filters.currency||'USD')&&ms(o.purchasedAt)>=ms(u.acquiredAt)));
  return {users:selected,orders};
}
