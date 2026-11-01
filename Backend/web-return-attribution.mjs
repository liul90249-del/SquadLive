import {createHash, randomBytes} from 'node:crypto';

const DAY=86400000, TTL=7*DAY;
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const WEB_RETURN_ORIGIN='https://squadlive.onrender.com';
export const WEB_RETURN_PATH='/open/cleaner';
export const WEB_RETURN_ORIGINS=new Set(['https://www.cleann.top','https://cleann.top','https://smart-cleaner-acquisition.liufeng19970513.chatgpt.site']);
const keys=['utm_source','utm_medium','utm_campaign','utm_content','campaign_id','adset_id','adset_name','ad_id'];
export function cleanWebReturnCampaign(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid campaign');
 const result={};
 for(const key of keys){const value=input[key];if(typeof value==='string'&&value.trim()&&value.length<=160&&!/[\u0000-\u001f{}]/.test(value))result[key]=value.trim();}
 if(!result.utm_source||!result.campaign_id)throw fail('Campaign source and ID required');
 return result;
}

// A separate, first-party association. Never updates MMP installs or partner revenue.
export function createWebReturnAttribution({getStore,saveStore,now=()=>Date.now(),random=()=>randomBytes(32).toString('base64url')}){
 let queue=Promise.resolve();
 const serial=work=>{const task=queue.then(work);queue=task.catch(()=>{});return task;};
 const state=root=>root.cleanerWebReturn||={clicks:{},bindings:{}};
 return {
  issue(body,origin){return serial(async()=>{
   if(!WEB_RETURN_ORIGINS.has(origin))throw fail('Website origin is not allowed',403);
   if(body?.consent!==true)throw fail('Measurement permission required',403);
   const campaign=cleanWebReturnCampaign(body.campaign),root=await getStore(),s=state(root),time=now();
   // Expired unclaimed records cannot bind; preserve a bounded 90-day audit history.
   for(const [id,click] of Object.entries(s.clicks))if(click.createdAt<time-90*DAY)delete s.clicks[id];
   if(Object.keys(s.clicks).length>=50000)throw fail('Source measurement temporarily unavailable',503);
   const token=random();if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail('Token generation failed',503);
   const id=hash(token);if(s.clicks[id])throw fail('Token generation failed',503);
   const click={createdAt:time,expiresAt:time+TTL,campaign,flow:body.flow==='onboarding'?'onboarding':'landing'};
   s.clicks[id]=click;
   try{await saveStore(root);}catch(error){delete s.clicks[id];throw error;}
   return {openUrl:`${WEB_RETURN_ORIGIN}${WEB_RETURN_PATH}#web-return=${token}`,expiresAt:click.expiresAt};
  });},
  claim(body,authorization){return serial(async()=>{
   const credential=String(authorization||'').replace(/^Bearer /,'');
   if(!/^anon_[A-Za-z0-9_-]{43}$/.test(credential))throw fail('Installation credential required',401);
   if(typeof body?.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.token))throw fail('Invalid source link');
   const root=await getStore(),accounts=root.sharedPartnerReferrals?.cleaner,account=accounts?.accounts?.[accounts.credentials?.[hash(credential)]];
   if(!account||account.disabled)throw fail('Installation credential unavailable',401);
   const s=state(root),id=hash(body.token),click=s.clicks[id],previous=s.bindings[account.id];
   if(!click)throw fail('Source link unavailable',404);
   if(click.accountId&&click.accountId!==account.id)throw fail('Source link was already used',409);
   if(previous){if(previous.clickId!==id)throw fail('A source is already associated',409);return {associated:true,method:'web_return',audience:previous.audience};}
   if(click.expiresAt<now())throw fail('Source link has expired',410);
   const created=Date.parse(account.createdAt);
   if(!Number.isFinite(created)||created>now()+300000)throw fail('Account timestamp unavailable',409);
   const binding={clickId:id,campaign:click.campaign,clickedAt:click.createdAt,boundAt:now(),audience:created>=click.createdAt?'new_account':'existing_account',method:'web_return'};
   s.bindings[account.id]=binding;click.accountId=account.id;
   try{await saveStore(root);}catch(error){delete s.bindings[account.id];delete click.accountId;throw error;}
   return {associated:true,method:'web_return',audience:binding.audience};
  });}
 };
}

export function webReturnDataset(root){
 const s=root.cleanerWebReturn||{clicks:{},bindings:{}};
 return {clicks:Object.values(s.clicks).map(c=>({createdAt:c.createdAt,campaign:c.campaign})),bindings:Object.entries(s.bindings).map(([accountId,b])=>({accountId,campaign:b.campaign,clickedAt:b.clickedAt,boundAt:b.boundAt,audience:b.audience}))};
}

export const cleanerAssociationFile={applinks:{details:[{appID:'D9QJA58T8W.com.hecathehe.PhoneCleaner',paths:[WEB_RETURN_PATH]}]}};
export const webReturnFallbackHTML='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Open Smart Cleaner</title><style>body{font:17px -apple-system,system-ui;color:#14213b;max-width:420px;margin:12vh auto;padding:24px;line-height:1.6}a{display:block;border-radius:16px;background:#0783ff;color:white;text-decoration:none;padding:16px;text-align:center;margin:24px 0}small{color:#6c778b}</style><main><h1>Open Smart Cleaner</h1><p id="help">Install the latest version, then return to your original guide page and tap “Open Smart Cleaner”.</p><a id="store" href="https://apps.apple.com/us/app/id6761738282">Download on the App Store</a><small id="note">This page does not start a subscription.</small></main><script>if((navigator.language||"").startsWith("zh")){document.documentElement.lang="zh-CN";document.querySelector("h1").textContent="打开 Smart Cleaner";document.querySelector("#help").textContent="安装最新版本后，请回到原来的引导网页，点击“打开 Smart Cleaner”。如果已安装，请使用 Safari 重试。";document.querySelector("#store").textContent="前往 App Store";document.querySelector("#note").textContent="本页不会开启订阅。"}</script></html>';
