import {randomBytes,randomUUID,createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(message,status=401)=>Object.assign(new Error(message),{status});
export function createAnonymousAuth({getStore,saveStore,resolveWallet,account}) {
 const init=s=>{s.partnerAnonymousAccounts||={};s.partnerAnonymousCredentials||={};return s};
 return {
  async session({credential,deviceId},req) {
   const s=init(await getStore());let user,token;
   if(credential!==undefined){
    if(typeof credential!=='string'||!/^anon_[A-Za-z0-9_-]{43}$/.test(credential))throw fail('Installation credential is invalid');
    user=s.partnerAnonymousAccounts[s.partnerAnonymousCredentials[hash(credential)]];
    if(!user||user.disabled)throw fail('Installation credential is unavailable');
    token=credential;
   }else{
    if(typeof deviceId!=='string'||!/^[-a-f0-9]{36}$/i.test(deviceId))throw fail('Invalid installation',400);
    const wallet=await resolveWallet(s,deviceId,req);
    // Keep the real first-use date. Issuing credentials must not reset eligibility.
    user={id:'anon_'+randomUUID(),anonymous:true,walletUserId:wallet.id,createdAt:wallet.createdAt};
    token='anon_'+randomBytes(32).toString('base64url');
    s.partnerAnonymousAccounts[user.id]=user;s.partnerAnonymousCredentials[hash(token)]=user.id;
   }
   const result=await account(user);await saveStore(s);
   return {token,account_token:result.account_token,expires_in:86400};
  },
  async verify(req){
   const token=req.headers.get('authorization')?.replace(/^Bearer /,'');
   if(!token||!/^anon_[A-Za-z0-9_-]{43}$/.test(token))throw fail('Installation credential required');
   const s=init(await getStore()),u=s.partnerAnonymousAccounts[s.partnerAnonymousCredentials[hash(token)]];
   if(!u||u.disabled)throw fail('Installation credential unavailable');
   return {customerId:u.id,registeredAt:Math.floor(Date.parse(u.createdAt)/1000),walletUserId:u.walletUserId};
  }
 };
}
