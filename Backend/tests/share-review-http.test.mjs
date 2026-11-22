import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';

test('review evidence, final decisions, exactly-once bonuses and product IP details persist through real HTTP routes', {timeout:30000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'squad-review-test-'));
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const token='local-admin-review-test-token';
  const credential='anon_'+'a'.repeat(43);
  const screenshot='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const user={id:'user_test',deviceId:'fixture',coins:400,createdAt:new Date().toISOString()};
  const seed={users:{user_test:user},rewardSubmissions:{},sharedPartnerReferrals:{}};
  for(const id of ['approve','reject','zero','invalid'])seed.rewardSubmissions[id]={id,userId:user.id,status:'pending',platform:'TikTok',proofLink:'https://example.com/post',screenshotBase64:screenshot,baseRewardCoins:100,createdAt:new Date().toISOString()};
  for(const product of ['cleaner','dailyme','nutriscan','subguard','sparkle','catswipe']){
    seed.sharedPartnerReferrals[product]={accounts:{account:{id:'account',deviceId:'10000000-0000-4000-8000-000000000001',createdAt:new Date().toISOString(),lastIPAddress:'8.8.8.8',networkCountryCode:'US',networkCountry:'United States',networkLookupStatus:'complete',networkUpdatedAt:new Date().toISOString(),ipHistory:[{ip:'8.8.8.8'}]}},credentials:{[createHash('sha256').update(credential).digest('hex')]:'account'},devices:{},accountTokens:{},receipts:{}};
  }
  await writeFile(join(directory,'store.json'),JSON.stringify(seed));
  const preload=join(directory,'lookup.mjs');
  await writeFile(preload,`globalThis.fetch=async url=>{if(!String(url).startsWith('https://ipwho.is/'))throw Error('Unexpected outbound request');await new Promise(r=>setTimeout(r,30));return new Response(JSON.stringify({success:true,country:'United Kingdom',country_code:'GB',region:'England',city:'London',connection:{org:'Example Network',asn:1234,isp:'Example ISP'}}));};`);
  const child=spawn(process.execPath,['--import',preload,'server.js'],{
    cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,PORT:String(port),DATA_DIR:directory,ADMIN_TOKEN:token,RENDER:'true',PARTNER_API_ORIGIN:'https://example.invalid',PARTNER_EVENT_KEYS:JSON.stringify({dailyme:'fixture'})},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
  const call=async(path,body,auth=true)=>{
    const res=await fetch(`http://127.0.0.1:${port}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-forwarded-for':'1.1.1.1',...(auth?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:res.status,body:await res.json()};
  };
  try{
    for(let i=0;i<150&&!logs.includes('backend listening');i++)await new Promise(r=>setTimeout(r,30));
    assert.match(logs,/backend listening/);
    assert.equal((await call('/v1/admin/reward-submissions',null,false)).status,401);
    assert.equal((await call('/v1/rewards/approve/review',{status:'approved',bonusCoins:500},false)).status,401);
    const summary=await call('/v1/admin/reward-submissions?summary=1');
    assert.equal(summary.body.submissions[0].hasScreenshot,true);assert.ok(!JSON.stringify(summary.body).includes(screenshot));
    assert.equal((await call('/v1/admin/reward-submissions/approve')).body.submission.screenshotBase64,screenshot);
    for(const body of [{status:'anything'},{status:'approved',bonusCoins:1.5},{status:'approved',bonusCoins:'bad'},{status:'approved',bonusCoins:10001},{status:'rejected',bonusCoins:1}])assert.equal((await call('/v1/rewards/invalid/review',body)).status,400);
    const responses=await Promise.all(Array.from({length:6},()=>call('/v1/rewards/approve/review',{status:'approved',bonusCoins:500,note:'Verified screenshot'})));
    assert.ok(responses.every(r=>r.status===200));assert.equal(responses.filter(r=>!r.body.duplicate).length,1);
    assert.equal((await call('/v1/rewards/approve/review',{status:'rejected'})).status,409);
    assert.equal((await call('/v1/rewards/approve/review',{status:'approved',bonusCoins:600})).status,409);
    assert.equal((await call('/v1/rewards/reject/review',{status:'rejected',note:'No matching post'})).status,200);
    assert.equal((await call('/v1/rewards/reject/review',{status:'approved'})).status,409);
    assert.equal((await call('/v1/rewards/zero/review',{status:'approved'})).status,200);
    assert.equal((await call('/v1/rewards/zero/review',{status:'approved',bonusCoins:100})).status,409);
    for(const product of ['cleaner','dailyme','nutriscan','subguard','sparkle','catswipe']){
      const report=await call(`/v1/admin/products/${product}/operations`);
      assert.equal(report.status,200);const account=report.body.users[0];
      assert.equal(account.lastIPAddress,'8.8.8.8');assert.equal(account.countryCode,'US');assert.equal(account.sameIPUserCount,1);assert.equal(account.ipHistory.length,1);
    }
    const session=await call('/v1/partners/dailyme/session',{credential});assert.equal(session.status,200);
    let report=await call('/v1/admin/products/dailyme/operations');
    assert.equal(report.body.users[0].lastIPAddress,'1.1.1.1');assert.notEqual(report.body.users[0].countryCode,'US');
    await new Promise(r=>setTimeout(r,80));
    report=await call('/v1/admin/products/dailyme/operations');
    assert.equal(report.body.users[0].countryCode,'GB');assert.equal(report.body.users[0].networkASN,'1234');
    const refresh=await call('/v1/admin/products/cleaner/users/account/network',{});
    assert.equal(refresh.status,200);assert.equal(refresh.body.user.countryCode,'GB');
    const saved=JSON.parse(await readFile(join(directory,'store.json'),'utf8'));
    assert.equal(saved.users.user_test.coins,900);
    assert.equal(Object.values(saved.coinTransactions).filter(t=>t.type==='share_review_bonus').length,1);
    assert.equal(saved.rewardSubmissions.approve.reviewNote,'Verified screenshot');
    assert.equal(saved.rewardSubmissions.reject.reviewNote,'No matching post');
  }finally{child.kill('SIGTERM');await once(child,'exit');await rm(directory,{recursive:true,force:true});}
});
