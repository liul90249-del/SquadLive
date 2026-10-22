// Persist verified Apple renewal evidence separately from charge/refund receipts.
import {mkdir, readFile, open, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const date = value => new Date(value).toISOString().slice(0,10);
const validTime = value => Number.isSafeInteger(value) && value > 0;
const blank = () => ({chains:{}, events:{}, sync:{}, trackingStartedAt:null});
// Inbox notifications and scheduled reconciliation may use separate instances.
// Serialize both against the same file so a sync update cannot erase an event.
const queues=new Map();
export async function readSubscriptionLifecycle(directory, product='cleaner', environment='Production') {
  if(!directory) return blank();
  try { return JSON.parse(await readFile(join(directory,'partner-inbox',product,environment,'lifecycle','state.json'),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return blank(); throw error; }
}
export function createSubscriptionLifecycle({directory, now=()=>Date.now()}) {
  function mutate(product,environment,update) {
    const root=join(directory,'partner-inbox',product,environment,'lifecycle');
    const task=(queues.get(root)||Promise.resolve()).then(async()=>{
      await mkdir(root,{recursive:true});
      const state=await readSubscriptionLifecycle(directory,product,environment);
      state.trackingStartedAt ||= now();
      const result=update(state);
      const file=join(root,'state.json'), temporary=file+'.'+randomUUID()+'.tmp';
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}
      await rename(temporary,file);
      return result;
    }); queues.set(root,task.catch(()=>{})); return task;
  }
  return {
    record(product,t,{renewal=null,notification=null,source='transaction',ownerToken=null}={}) {
      if(t.type!=='Auto-Renewable Subscription') return Promise.resolve();
      if(renewal && (renewal.originalTransactionId!==t.originalTransactionId || renewal.environment!==t.environment ||
        !validTime(renewal.signedDate) || ![0,1].includes(renewal.autoRenewStatus))) throw new Error('Invalid verified renewal identity');
      if(notification && (!notification.notificationUUID || !validTime(notification.signedDate))) throw new Error('Invalid subscription notification');
      return mutate(product,t.environment,state=>{
        const key=hash(t.originalTransactionId), old=state.chains[key];
        const first=validTime(t.originalPurchaseDate)?Math.min(t.originalPurchaseDate,t.purchaseDate):t.purchaseDate;
        const item=state.chains[key] ||= {originalId:t.originalTransactionId, firstSubscribedAt:first, autoRenewStatus:null, renewalSignedAt:0};
        item.firstSubscribedAt=Math.min(item.firstSubscribedAt,first);
        item.accountToken ||= ownerToken || t.appAccountToken?.toLowerCase() || null;
        if(!old || t.purchaseDate >= (item.latestPurchaseAt || 0)) {
          item.latestPurchaseAt=t.purchaseDate; item.sku=t.productId;
          if(validTime(t.expiresDate)) item.expiresAt=t.expiresDate;
        }
        if(renewal && renewal.signedDate >= item.renewalSignedAt) {
          item.autoRenewStatus=renewal.autoRenewStatus; item.renewalSignedAt=renewal.signedDate;
          item.checkedAt=now(); item.expirationIntent=renewal.expirationIntent ?? null;
          if(renewal.autoRenewStatus===0) item.everDisabled=true;
        }
        if(notification) {
          const eventKey=hash(notification.notificationUUID);
          state.events[eventKey] ||= {originalId:t.originalTransactionId,type:notification.notificationType,
            subtype:notification.subtype || null,occurredAt:notification.signedDate,receivedAt:now()};
          if(notification.notificationType==='DID_CHANGE_RENEWAL_STATUS' && notification.subtype==='AUTO_RENEW_DISABLED') item.everDisabled=true;
        }
        // A status poll knows the current state, not when the user cancelled.
        if(source==='reconciliation' && renewal?.autoRenewStatus===0 && !item.firstDisabledObservedAt) item.firstDisabledObservedAt=now();
      });
    },
    sync(product, patch) { return mutate(product,'Production',state=>Object.assign(state.sync,patch)); }
  };
}

export const nextSubscriptionCheck = now => Date.parse(date(now)+'T00:00:00Z')+86400000;
export async function reconcileSubscriptionStatuses({client,verifier,originals,bundleId,appId,record}) {
  let checked=0,failed=0;const completed=new Set();
  for(const original of originals){
    if(completed.has(original))continue;
    try{
      const response=await client.getAllSubscriptionStatuses(original);
      if(response.bundleId!==bundleId || response.environment!=='Production' || response.appAppleId!==appId)throw new Error('Status identity mismatch');
      const items=(response.data||[]).flatMap(group=>group.lastTransactions||[]);
      if(!items.some(item=>item.originalTransactionId===original))throw new Error('Missing requested subscription');
      for(const item of items){
        const t=await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo);
        const renewal=await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
        if(t.bundleId!==bundleId || t.environment!=='Production' || t.originalTransactionId!==item.originalTransactionId ||
          renewal.originalTransactionId!==t.originalTransactionId || renewal.environment!=='Production')throw new Error('Status transaction mismatch');
        await record(t,item.signedTransactionInfo,renewal);
        if(!completed.has(t.originalTransactionId)){completed.add(t.originalTransactionId);checked++;}
      }
    }catch{failed++;}
  }
  return {checked,failed};
}
// Catch up on restart, once per UTC date; retry failures after 15 minutes.
export function createDailySubscriptionCheck({read,run,save,now=()=>Date.now()}) {
  let running=false, retryAt=0;
  return async function tick() {
    if(running || now()<retryAt) return;
    running=true;
    try {
      const today=date(now()), state=await read();
      if(state.sync?.completedDay===today) return;
      await save({status:'running',attemptedAt:now()});
      const result=await run();
      if(result.unconfigured) { await save({status:'unconfigured',lastError:'缺少订阅状态核对凭据'}); retryAt=now()+900000; return; }
      if(result.failed) { await save({status:'partial',checked:result.checked,failed:result.failed,lastError:'部分订阅状态核对失败，将自动重试'}); retryAt=now()+900000; return; }
      await save({status:'complete',completedDay:today,completedAt:now(),checked:result.checked,failed:0,lastError:null});
    } catch { retryAt=now()+900000; await save({status:'failed',lastError:'订阅状态核对失败，将自动重试'}).catch(()=>{}); }
    finally {running=false;}
  };
}

export function subscriptionAnalytics(operations,state=blank(),accountTokens={},now=Date.now()) {
  const people=new Map(), originalPeople=new Map();
  const byOriginal=new Map(Object.values(state.chains).map(c=>[c.originalId,c]));
  const identify=(original,accountId)=>accountId || (byOriginal.get(original)?.accountToken && accountTokens[byOriginal.get(original).accountToken]) ||
    'unlinked-'+hash(byOriginal.get(original)?.accountToken || original).slice(0,16);
  function person(original,accountId) {
    const id=identify(original,accountId); originalPeople.set(original,id);
    if(!people.has(id)) people.set(id,{id,linked:!id.startsWith('unlinked-'),firstSubscribedAt:null,firstPaidAt:null,chains:[],everDisabled:false});
    return people.get(id);
  }
  const knownAccount=new Map(operations.orders.filter(o=>o.accountId).map(o=>[o.originalTransactionId,o.accountId]));
  for(const chain of byOriginal.values()) {
    const p=person(chain.originalId,knownAccount.get(chain.originalId)); p.chains.push(chain);
    p.firstSubscribedAt=Math.min(p.firstSubscribedAt ?? Infinity,chain.firstSubscribedAt); p.everDisabled ||= !!chain.everDisabled;
  }
  for(const order of operations.orders.filter(o=>o.kind==='subscription')) {
    const original=order.originalTransactionId || order.transactionId,p=person(original,order.accountId || knownAccount.get(original));
    const at=Date.parse(order.purchasedAt); if(!Number.isFinite(at)) continue;
    p.firstSubscribedAt=Math.min(p.firstSubscribedAt ?? Infinity,at);
    if(order.priceMilliunits>0) p.firstPaidAt=Math.min(p.firstPaidAt ?? Infinity,at);
  }
  const records=[...people.values()].map(p=>{
    const current=p.chains.slice().sort((a,b)=>(b.latestPurchaseAt||0)-(a.latestPurchaseAt||0))[0];
    return {id:p.id,linked:p.linked,subscribedAt:p.firstSubscribedAt,paidAt:p.firstPaidAt,everDisabled:p.everDisabled,
      autoRenewStatus:current?.autoRenewStatus ?? null,checkedAt:current?.checkedAt ?? null,expiresAt:current?.expiresAt ?? null};
  }).filter(p=>validTime(p.subscribedAt) && p.subscribedAt<=now);
  const events=Object.values(state.events).filter(e=>e.type==='DID_CHANGE_RENEWAL_STATUS' && e.subtype==='AUTO_RENEW_DISABLED' && e.occurredAt<=now)
    .map(e=>({id:originalPeople.get(e.originalId) || identify(e.originalId),at:e.occurredAt}));
  const users=operations.users, today=date(now);
  const first=[today,...users.map(u=>u.createdAt?.slice(0,10)),...records.map(p=>date(p.subscribedAt)),...events.map(e=>date(e.at))]
    .filter(d=>/^\d{4}-\d\d-\d\d$/.test(d||'') && d>='2000-01-01' && d<=today).sort()[0];
  const rate=(a,b)=>b?Math.round(1000*a/b)/10:null;
  const ids=items=>[...new Set(items.map(p=>p.id))];
  const activityByDay=new Map((operations.daily||[]).map(row=>[row.date,row.activeUsers]));
  const rows=[];
  for(let at=Date.parse(today+'T00:00:00Z'), stop=Date.parse(first+'T00:00:00Z');at>=stop;at-=86400000) {
    const d=date(at), registered=users.filter(u=>u.createdAt?.slice(0,10)===d), registeredIds=new Set(registered.map(u=>u.id));
    const cohort=records.filter(p=>date(p.subscribedAt)===d), signupConverted=records.filter(p=>registeredIds.has(p.id));
    const paid=signupConverted.filter(p=>p.paidAt!==null), cancelled=cohort.filter(p=>p.everDisabled);
    const unknown=cohort.filter(p=>p.autoRenewStatus===null).length;
    rows.push({date:d,openedUsers:activityByDay.get(d) ?? null,registrations:registered.length,
      cleanupUsers:ids(registered.filter(u=>u.hasCompletedCleanup===true)),cleanupUnknownUsers:registered.filter(u=>u.hasCompletedCleanup==null).length,
      newSubscribers:ids(cohort),cancellations:ids(events.filter(e=>date(e.at)===d)),
      firstPayers:ids(records.filter(p=>p.paidAt!==null && date(p.paidAt)===d)),cohortCancelled:ids(cancelled),
      cohortCurrentlyOff:ids(cohort.filter(p=>p.autoRenewStatus===0)),unknownRenewal:unknown,
      registeredSubscribed:signupConverted.length,registeredPaid:paid.length,
      subscriptionRate:rate(signupConverted.length,registered.length),paidConversionRate:rate(paid.length,registered.length),
      cancellationRate:unknown?null:rate(cancelled.length,cohort.length),
      trialToPaidRate:rate(cohort.filter(p=>p.paidAt!==null).length,cohort.length)});
  }
  return {timezone:'UTC',refreshTime:'08:00 Asia/Shanghai',nextCheckAt:nextSubscriptionCheck(now),sync:state.sync,
    trackingStartedAt:state.trackingStartedAt,cancellationEvents:events,unlinked:records.filter(p=>!p.linked).length,rows,
    people:[...records,...users.filter(u=>!people.has(u.id)).map(u=>({id:u.id,linked:true,subscribedAt:null,paidAt:null,autoRenewStatus:null}))],
    definitions:{openedUsers:'当日调用会话接口的去重安装身份，作为已记录打开人数（日活）；不是打开次数，也不是新注册人数。现有日活接口仅提供最近 30 天，较早日期显示“—”。',
      cleanupUsers:'该日新注册用户中，截至目前有过成功清理的去重人数；后来清理会回补到注册日。旧版本未采集时标为未知。',
      subscriptionRate:'该日注册用户中，截至目前订阅过的人数 / 该日注册人数（含免费试用）',
      paidConversionRate:'该日注册用户中，截至目前有过订阅扣款的人数 / 该日注册人数（后续退款不撤销首次付费）',
      cancellationRate:'该日首次订阅用户中，截至目前曾关闭自动续订的人数 / 该日首次订阅人数；含后来恢复续订者',
      eventCancellations:'按苹果关闭自动续订通知的签发日去重；历史漏通知无法通过当前状态还原确切取消日期',
      trialToPaidRate:'该日首次订阅用户中，截至目前有过扣款的人数 / 该日首次订阅人数（含直接付费）'}};
}
