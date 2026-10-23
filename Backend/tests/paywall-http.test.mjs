import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:net';

test('real HTTP policy routes authenticate, isolate drafts, serialize revisions and persist publication', {timeout:20000}, async()=>{
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const directory=await mkdtemp(join(tmpdir(),'cleaner-policy-http-'));
  const child=spawn(process.execPath,['server.js'],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,PORT:String(port),DATA_DIR:directory,ADMIN_TOKEN:'local-test-token-only-1234',IP_GEOLOCATION_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
  const url=`http://127.0.0.1:${port}`;const endpoint='/v1/admin/products/cleaner/paywall-policy';
  const auth={authorization:'Bearer local-test-token-only-1234','content-type':'application/json'};
  const post=body=>fetch(url+endpoint,{method:'POST',headers:auth,body:JSON.stringify(body)});
  try{
    for(let i=0;i<100&&!logs.includes('backend listening');i++)await new Promise(r=>setTimeout(r,50));
    assert.match(logs,/backend listening/);
    assert.equal((await fetch(url+endpoint)).status,401);
    const initial=await (await fetch(url+endpoint,{headers:auth})).json();assert.equal(initial.revision,0);
    const policy=initial.draft;policy.template='comparison';
    const results=await Promise.all([post({action:'save',revision:0,policy}),post({action:'save',revision:0,policy})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal((await (await fetch(url+'/v1/products/cleaner/paywall-policy')).json()).revision,0);
    const published=await post({action:'publish',revision:1});assert.equal(published.status,200);
    const live=await (await fetch(url+'/v1/products/cleaner/paywall-policy')).json();assert.equal(live.revision,2);assert.equal(live.policy.template,'comparison');
    const disk=JSON.parse(await readFile(join(directory,'store.json'),'utf8'));assert.equal(disk.cleanerPaywallPolicy.published.revision,2);
    policy.enabled=true;await post({action:'save',revision:2,policy});
    assert.equal((await post({action:'publish',revision:3})).status,422);
    assert.equal((await (await fetch(url+'/v1/products/cleaner/paywall-policy')).json()).revision,2);
    assert.equal((await post({action:'restore',revision:2,sourceRevision:2})).status,409);
    assert.equal((await post({action:'restore',revision:3,sourceRevision:999})).status,404);
    const restored=await post({action:'restore',revision:3,sourceRevision:2});assert.equal(restored.status,200);
    const draft=await restored.json();assert.equal(draft.revision,4);assert.equal(draft.draft.enabled,false);
    assert.equal((await (await fetch(url+'/v1/products/cleaner/paywall-policy')).json()).revision,2);
    const restoredDisk=JSON.parse(await readFile(join(directory,'store.json'),'utf8'));
    assert.equal(restoredDisk.cleanerPaywallPolicy.revision,4);
    assert.equal(restoredDisk.cleanerPaywallPolicy.published.revision,2);

  }finally{
    child.kill('SIGTERM');await once(child,'exit');await rm(directory,{recursive:true,force:true});
  }
});
