/** Consumer-facing adapter for a trusted App backend. No service keys belong in Apps.
 * verifyIdentity must validate a server session / Apple identity and return a stable,
 * server-owned customerId and registeredAt. Never implement it using body.deviceId.
 * Mount at your authenticated App API; confirmation of Apple grants is NOT exposed here.
 */
export function createBenefitGateway({partnerClient,verifyIdentity,confirmBinding}) {
 if(typeof verifyIdentity!=='function')throw new Error('Verified identity provider required');
 return async function handle(req) {
  const send=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
  try {
   let identity;try{identity=await verifyIdentity(req)}catch{return send({error:'请先登录 App'},401)}
   if(!identity||typeof identity.customerId!=='string'||!identity.customerId||identity.customerId.length>200||!Number.isInteger(identity.registeredAt)||identity.registeredAt<=0)return send({error:'请先登录 App'},401);
   if(req.method==='GET')return send(await partnerClient.benefitStatus(identity.customerId));
   if(req.method!=='POST')return send({error:'Method not allowed'},405);
   const raw=await req.text();if(raw.length>16000)return send({error:'请求过大'},413);
   let b;try{b=JSON.parse(raw)}catch{return send({error:'请求格式错误'},400)}
   if(!b||typeof b!=='object'||!['preview','claim'].includes(b.action))return send({error:'操作无效'},400);
   const code=String(b.code||'').trim().toUpperCase();if(!/^PC[A-F0-9]{12}$/.test(code))return send({error:'邀请码格式错误'},400);
   if(b.action==='claim'&&(b.confirmed!==true||!/^[-a-f0-9]{36}$/i.test(b.plan_id||'')))return send({error:'请先预览并确认福利'},400);
   await partnerClient.identify(identity.customerId,identity.registeredAt);
   if(b.action==='claim' && confirmBinding)await confirmBinding(identity,code,true);
   return send(await (b.action==='preview'?partnerClient.previewBenefit(identity.customerId,code):partnerClient.claimBenefit(identity.customerId,code,b.plan_id)));
  }catch(e){return send({error:e.status&&e.status<500?e.message:'福利服务暂时不可用，请稍后重试'},[400,401,403,404,409,410,429].includes(e.status)?e.status:503)}
 };
}
