import {policyState} from '../cleaner-paywall-policy.mjs';
import {marketingDataset} from '../marketing-core.mjs';
import {prepareMarketingImport} from '../marketing-import.mjs';
// Local-only visual comparison. No proxy, credentials, live data or writes.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {productOperations} from '../product-operations.mjs';
import {subscriptionAnalytics} from '../subscription-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const now = Date.parse('2026-10-19T08:00:00Z');
const iso = offset => new Date(now + offset * 86400000).toISOString();
const products = ['cleaner','catswipe','dailyme','nutriscan','subguard','sparkle'];
const accounts = Object.fromEntries(Array.from({length:48}, (_,i) => {
  const date = iso(-(i % 14));
  return [`demo-${String(i+1).padStart(3,'0')}`, {
    id:`demo-${String(i+1).padStart(3,'0')}`, deviceId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,createdAt:date, activityTrackedFrom:date,
    funnelTrackedFrom:i%5===0?null:date, funnelEvents:i%5===0?{}:Object.fromEntries(["first_activation","onboarding_complete","photo_permission_granted","paywall_open","purchase_attempt","cleanup_completed"].slice(0,2+i%5).map((k,j)=>[k,Date.parse(date)+j*1000])),
    cleanupTrackedFrom:i%4===0?null:date,hasCompletedCleanup:i%4===1,firstCleanupAt:i%4===1?Date.parse(iso(-i%3)):null,
    lastSeenAt:iso(-(i % 3)), activeDays:Object.fromEntries([0,1,2,7].filter(n=>n<=i%14).map(n=>[iso(-(i%14)+n).slice(0,10),true])),
    lastIPAddress:`192.0.2.${i+1}`, networkCountryCode:i%2?'US':'GB',
    networkCountry:i%2?'美国':'英国', networkOrganization:'示例网络'
  }];
}));
const receipts = Object.fromEntries(Array.from({length:12}, (_,i) => [`demo-order-${i+1}`, {
  transaction_id:`demo-order-${String(i+1).padStart(3,'0')}`, original_transaction_id:`demo-original-${i+1}`,
  customer_id:`demo-${String(i+1).padStart(3,'0')}`, sku:i%4?'cleaner.weekly':'cleaner.yearly.standard',
  environment:'Production', purchased_at:Date.parse(iso(-(i%7)))/1000,
  price:i%4?9900:39990, currency:i%3?'USD':'GBP', purchase_kind:'subscription',
  status:i===2?'refunded':'sent', revoked:i===2, refunded_at:i===2?now:null,
  singular_purchase:{status:i===5?'uncertain':'sent'}, singular_refund:i===2?{status:'sent'}:null
}]));
for(const i of [7,8,9,10,11]){const user=accounts[`demo-${String(i+1).padStart(3,'0')}`];receipts[`demo-trial-${i}`]={transaction_id:`demo-trial-${i}`,original_transaction_id:`demo-original-${i+1}`,customer_id:user.id,sku:'cleaner.weekly',environment:'Production',purchased_at:Date.parse(user.createdAt)/1000,price:0,currency:'USD',purchase_kind:'subscription',offer_discount_type:'FREE_TRIAL',expires_at:Date.parse(user.createdAt)+7*86400000};}
// Synthetic exposure fixtures only; never imported into live customer data.
Object.values(accounts).forEach((u,i)=>{
  if(i%6===0)return;
  const first=Object.values(receipts).filter(r=>r.customer_id===u.id).sort((a,b)=>a.purchased_at-b.purchased_at)[0];
  const start=first?first.purchased_at*1000:Date.parse(u.createdAt);
  const metadata={presentationId:`demo-presentation-${i}`,revision:1,tier:i%2?'intro099':'free7',template:['storage','compact','comparison'][i%3],surface:'main',entryPoint:'return_visit',productId:first?.sku||'cleaner.weekly'};
  u.paywallEvents=[{...metadata,id:`open-${i}`,name:'paywall_open',at:start},
    ...(i%4!==0?[{...metadata,id:`click-${i}`,name:'purchase_attempt',at:start}]:[])];
});
function marketingFixture(product){
  if(product!=='cleaner')return {};
  const costs={},attributions={};
  for(let n=0;n<42;n++)for(let campaign=1;campaign<=2;campaign++){
    const r={date:iso(-n).slice(0,10),currency:'USD',channel:'applovin',campaignId:`campaign-${campaign}`,campaignName:campaign===1?'美国 · 清理空间':'美国 · 照片整理',adGroupId:`group-${campaign}`,adGroupName:campaign===1?'空间不足演示素材组':'相似照片对比素材组',creativeId:'',creativeName:'',spendMilliunits:2500+campaign*500,impressions:300+campaign*100,clicks:30,installs:5};costs[`${n}-${campaign}`]=r;
  }
  Object.values(accounts).forEach((u,i)=>{if(i%5===0)return;const campaign=i%2+1;attributions[u.id]={accountId:u.id,acquiredAt:u.createdAt,channel:i%7===0?'organic':'applovin',campaignId:i%7===0?'':`campaign-${campaign}`,campaignName:i%7===0?'':campaign===1?'美国 · 清理空间':'美国 · 照片整理',adGroupId:i%7===0?'':`group-${campaign}`,creativeId:'',source:'Synthetic fixture'};});
  return {costs,attributions,imports:[{kind:'costs',at:now-3600000,count:84,replaced:0},{kind:'attribution',at:now-3000000,count:38,replaced:0}]};
}
function report(product) {
  // CatSwipe has no subscriptions/IAP; show an accurate empty order state.
  const state = {accounts, receipts:product==='catswipe'?{}:receipts, bindings:{}};
  const operations=productOperations({sharedPartnerReferrals:{[product]:state}}, product, now);
  const lifecycle={chains:{},events:{},trackingStartedAt:Date.parse(iso(-60)),sync:{status:'complete',completedAt:now-8*3600000,completedDay:iso(0).slice(0,10),checked:12,failed:0}};
  Object.values(receipts).forEach((r,i)=>{
    lifecycle.chains[i]={originalId:r.original_transaction_id,firstSubscribedAt:Date.parse(iso(-i*4)),latestPurchaseAt:r.purchased_at*1000,
      sku:r.sku,autoRenewStatus:i===3?null:i%3===0?0:1,everDisabled:i%3===0,checkedAt:i===3?null:now,expiresAt:now+86400000};
    if(i%3===0)lifecycle.events[i]={originalId:r.original_transaction_id,type:'DID_CHANGE_RENEWAL_STATUS',subtype:'AUTO_RENEW_DISABLED',occurredAt:Date.parse(iso(-i%4))};
  });
  return {...operations,marketing:marketingDataset({sharedPartnerReferrals:{[product]:state},marketing:{[product]:marketingFixture(product)}},product,operations,now),subscriptions:product==='cleaner'?subscriptionAnalytics(operations,lifecycle,{},now):null,
    paywallPolicy:product==='cleaner'?policyState({}):null,connected:true, subscriptionCatalog:product==='cleaner'?{status:'unconfigured',actual:null,checkedAt:null}:null};
}
const users = Object.values(accounts).slice(0,12).map((a,i)=>({
  ...a, deviceId:`demo-device-${i+1}`, displayName:`演示用户 ${i+1}`, coins:300+i*40,
  isPremium:i%3===0, liveSessionCount:i*2, engagedLiveSessionCount:i,
  aiConversationCount:i*7, networkCity:'示例城市'
}));
const overview = {
  totalUsers:48,newUsersToday:4,activeUsers5m:3,activeUsersToday:16,premiumUsers:8,
  premiumConversionPercent:16.7,premiumUsersToday:2,rechargeCount:12,rechargeCountToday:2,
  rechargeAmountCents:8488,rechargeAmountCentsToday:998,liveUserCount:28,liveUsersToday:8,
  liveEngagementPercent:64.3,liveEngagementPercentToday:62.5,liveStartFailureCount:1,liveStartFailuresToday:0,
  aiConversationCount:243,aiConversationsToday:36,rewardSubmissionCount:6,rewardSubmissionsToday:1,
  pendingRewardSubmissions:2,pendingRewardSubmissionsToday:1,
  monitoring:{resources:{memory:{percent:24,rssBytes:128*1024**2,limitBytes:512*1024**2},
    disk:{percent:12,storeBytes:204800,totalBytes:10*1024**3},aiConcurrency:{active:0,limit:8,queued:0,rejectedSinceRestart:0},
    uptimeSeconds:190000,storeWriteFailures:0}, today:{aiRequests:36,aiSuccesses:35,averageAILatencyMs:920,maxAILatencyMs:1800,requests:380},
    warnings:[{level:'healthy',title:'演示状态：服务运行正常',message:'这里的用户、收入与运行指标全部为演示数据。'}],
    dailyUsage:Array.from({length:7},(_,i)=>({date:iso(-i).slice(0,10),newUsers:4+i,activeUsers:16+i,requests:380+i*21,aiRequests:36+i,
      aiSuccesses:35+i,averageAILatencyMs:920+i*10,aiTimeouts:i%3===0?1:0,aiUnavailable:0,peakAIConcurrency:2,aiQueueRejected:0}))}
};
let requests = 0;
const server = http.createServer(async(req,res)=>{
  const url = new URL(req.url,'http://127.0.0.1');
  const json = (value,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(req.method==='POST'&&/^\/v1\/admin\/products\/([a-z]+)\/marketing-import$/.test(url.pathname)){
    try{let raw='';for await(const part of req){raw+=part;if(raw.length>800000)throw new Error('文件过大');}const b=JSON.parse(raw);if(b.confirm)return json({error:'演示预览不保存业务数据'},403);const product=url.pathname.split('/')[4];const result=prepareMarketingImport({sharedPartnerReferrals:{[product]:{accounts}},marketing:{[product]:marketingFixture(product)}},product,b.kind,b.csv,now);return json({...result,records:result.records.slice(0,5),saved:false});}catch(e){return json({error:e.message},400);}
  }
  if(req.method!=='GET') return json({error:'演示预览为只读，未保存任何修改。'},403);
  try {
    if(url.pathname==='/__preview/requests') return json({requests});
    if(url.pathname==='/admin' || url.pathname==='/') {
      const product = ['squadlive',...products].includes(url.searchParams.get('product'))?url.searchParams.get('product'):'cleaner';
      let html=await readFile(resolve(root,'admin.html'),'utf8');
      html=html.replace('<body>', '<body data-demo="true"><div class="demo-banner" role="status">界面对比预览 · 全部为演示数据 · 不连接线上后台 · 不保存业务修改</div>');
      html=html.replace('  <script>\n    const state', `  <script>localStorage.setItem('squadlive.adminProduct',${JSON.stringify(product)});</script>\n  <script>\n    const state`);
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(html);
    }
    const files={'/admin-appearance.css':['admin-appearance.css','text/css'], '/admin-appearance.js':['admin-appearance.js','text/javascript'],
      '/assets/landing/squadlive-logo.png':['assets/landing/squadlive-logo.png','image/png']};
    for (const product of products) files[`/assets/products/${product}.png`] = [`assets/products/${product}.png`, 'image/png'];
    for (const file of ['admin-paywall.mjs','admin-insights.css','admin-insights.mjs','admin-insights-core.mjs','admin-subscriptions.mjs','admin-subscriptions.css','admin-marketing.mjs','admin-marketing.css','marketing-core.mjs']) files[`/${file}`] = [file, file.endsWith('.css') ? 'text/css' : 'text/javascript'];
    if(files[url.pathname]) {const [file,type]=files[url.pathname];res.writeHead(200,{'content-type':type});return res.end(await readFile(resolve(root,file)));}
    if(url.pathname.startsWith('/v1/admin/')) requests++;
    const match=/^\/v1\/admin\/products\/([a-z]+)\/operations$/.exec(url.pathname);
    if(match && products.includes(match[1])) return json(report(match[1]));
    if(url.pathname==='/v1/admin/overview') return json({overview});
    if(url.pathname==='/v1/admin/users') {const q=(url.searchParams.get('query')||'').toLowerCase();return json({users:users.filter(u=>[u.id,u.deviceId,u.displayName].some(v=>v.toLowerCase().includes(q)))});}
    if(url.pathname.startsWith('/v1/admin/users/')) {
      const user=users.find(u=>u.id===url.pathname.split('/').at(-1));
      return user?json({user,coinTransactions:[],vipSubscriptions:[],aiConversations:[]}):json({error:'未找到演示用户'},404);
    }
    if(url.pathname==='/v1/admin/recharges') return json({transactions:[{userId:users[0].id,coins:1000,amountCents:499,currency:'USD',note:'demo.coins',createdAt:iso(0)}]});
    if(url.pathname==='/v1/admin/vip-subscriptions') return json({subscriptions:[{userId:users[0].id,planId:'demo.weekly',status:'active',amountCents:990,currency:'USD',platformTransactionId:'demo-transaction-001',startedAt:iso(-1)}]});
    if(url.pathname==='/v1/admin/reward-submissions') return json({submissions:[{id:'demo-reward-001',userId:users[0].id,platform:'示例平台',status:'pending',baseRewardCoins:30,proofLink:null,createdAt:iso(0)}]});
    if(url.pathname==='/v1/admin/settings') return json({settings:{initialCoins:300}});
    return json({error:'此预览入口未提供该内容。'},404);
  } catch(error) {return json({error:error.message},500);}
});
server.listen(Number(process.env.PREVIEW_PORT||8896),'127.0.0.1',()=>console.log('Admin comparison: http://127.0.0.1:8896/admin?style=pearl&product=cleaner (read-only synthetic data)'));
