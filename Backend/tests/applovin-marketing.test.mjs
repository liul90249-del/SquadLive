import test from 'node:test';
import assert from 'node:assert/strict';
import {APPLOVIN_COLUMNS,applovinStatus,normalizeApplovinRows,fetchApplovinCosts,createApplovinSync} from '../applovin-marketing.mjs';
const config={key:'test-secret-never-display',currency:'USD',bundleId:'com.hecathehe.PhoneCleaner',enabled:true};
const now=Date.parse('2026-10-20T00:00:00Z');
const record=()=>({day:'2026-10-19',campaign_package_name:config.bundleId,campaign_ad_type:'ua',campaign_id_external:'stable-campaign',campaign:'Name',creative_set_id:'stable-set',creative_set:'Set',cost:'10.12345',impressions:'100',clicks:'10',conversions:'3'});
const csv=(rows)=>[APPLOVIN_COLUMNS.join(','),...rows.map(r=>APPLOVIN_COLUMNS.map(k=>r[k]).join(','))].join('\n');
const response=rows=>({ok:true,text:async()=>csv(rows)});
test('AppLovin normalization uses stable IDs, UTC, explicit currency and conversions',()=>{
  const rows=normalizeApplovinRows([record()],config,'2026-10-13','2026-10-19');
  assert.deepEqual(rows[0],['2026-10-19','UTC','applovin','stable-campaign','Name','stable-set','Set','','','USD','10.123','100','10','3']);
  assert.throws(()=>normalizeApplovinRows([{...record(),campaign_ad_type:'rt'}],config,'2026-10-13','2026-10-19'),/其他产品或再营销/);
  assert.throws(()=>normalizeApplovinRows([{...record(),campaign_package_name:'another-app'}],config,'2026-10-13','2026-10-19'),/其他产品/);
  assert.throws(()=>normalizeApplovinRows([record()],{...config,currency:''},'2026-10-13','2026-10-19'),/币种/);
});
test('request is advertiser UA, filtered to Cleaner, pagination and errors never leak key',async()=>{
  const offsets=[];
  await fetchApplovinCosts(config,{start:'2026-10-13',end:'2026-10-19',fetchImpl:async(url,options)=>{
    assert.equal(url.origin,'https://r.applovin.com');assert.equal(url.searchParams.get('report_type'),'advertiser');
    assert.equal(url.searchParams.get('filter_campaign_package_name'),config.bundleId);
    assert.equal(url.searchParams.get('filter_campaign_ad_type'),'ua');assert.equal(options.redirect,'error');
    offsets.push(url.searchParams.get('offset'));
    return response(offsets.length===1?Array.from({length:500},()=>record()):[]);
  }});
  assert.deepEqual(offsets,['0','500']);
  await assert.rejects(fetchApplovinCosts(config,{fetchImpl:async()=>{throw new Error(config.key);}}),e=>!e.message.includes(config.key)&&e.message.includes('请求失败'));
  assert.equal(JSON.stringify(applovinStatus(config)).includes(config.key),false);
});
test('sync replaces its own window idempotently and removes vanished rows after a complete response',async()=>{
  const store={};let calls=0,saves=0,rows=[record()];
  const sync=createApplovinSync({config,getStore:async()=>store,saveStore:async()=>{saves++;},clock:()=>now,
    fetchImpl:async()=>{calls++;return response(rows);}});
  await Promise.all([sync.run(),sync.run()]);
  assert.equal(calls,1);assert.equal(Object.keys(store.marketing.cleaner.costs).length,1);
  await sync.run();assert.equal(Object.keys(store.marketing.cleaner.costs).length,1);
  rows=[];await sync.run();assert.equal(Object.keys(store.marketing.cleaner.costs).length,0);
  assert.equal(store.marketing.cleaner.applovin.lastSuccess,now);assert.equal(saves,3);
});
test('failed or mixed-ownership sync retains costs and retries no more than hourly',async()=>{
  const store={marketing:{cleaner:{costs:{manual:{date:'2026-10-19',channel:'applovin',spendMilliunits:100}},imports:[]}}};
  let time=now,calls=0;
  const sync=createApplovinSync({config,getStore:async()=>store,saveStore:async()=>{},clock:()=>time,fetchImpl:async()=>{calls++;return response([record()]);}});
  await sync.tick();assert.equal(calls,1);assert.equal(store.marketing.cleaner.costs.manual.spendMilliunits,100);
  assert.match(store.marketing.cleaner.applovin.error,/手动导入/);
  await sync.tick();assert.equal(calls,1);
  time+=3600000;await sync.tick();assert.equal(calls,2);
});
test('scheduler runs once per UTC day, disabled configuration never sends credentials',async()=>{
  const store={};let time=now,calls=0;
  const args={getStore:async()=>store,saveStore:async()=>{},clock:()=>time,fetchImpl:async()=>{calls++;return response([]);}};
  await createApplovinSync({...args,config:{...config,enabled:false}}).tick();assert.equal(calls,0);
  const sync=createApplovinSync({...args,config});
  await sync.tick();await sync.tick();assert.equal(calls,1);
  time+=86400000;await sync.tick();assert.equal(calls,2);
});
test('bad response or persistence failure cannot replace existing cost data',async()=>{
  const store={marketing:{cleaner:{costs:{old:{channel:'applovin',date:'2026-10-19',source:'applovin-api',spendMilliunits:123}},imports:[]}}};
  let saves=0;
  const sync=createApplovinSync({config,getStore:async()=>store,clock:()=>now,fetchImpl:async()=>response([record()]),
    saveStore:async()=>{if(++saves===1)throw new Error('disk failed');}});
  await assert.rejects(sync.run(),/保存失败/);assert.equal(store.marketing.cleaner.costs.old.spendMilliunits,123);
  await assert.rejects(fetchApplovinCosts(config,{fetchImpl:async()=>({ok:true,text:async()=>'<html>unexpected</html>'})}),/列不匹配/);
});
test('real inactive-account empty CSV verifies connection without erasing existing spend',async()=>{
  const store={};const fetchImpl=async()=>({ok:true,text:async()=>''});
  const sync=createApplovinSync({config,getStore:async()=>store,saveStore:async()=>{},clock:()=>now,fetchImpl});
  await sync.run();assert.equal(store.marketing.cleaner.applovin.rows,0);
  assert.equal(store.marketing.cleaner.applovin.lastSuccess,now);
  store.marketing.cleaner.costs.old={channel:'applovin',date:'2026-10-19',source:'applovin-api',spendMilliunits:123};
  await assert.rejects(sync.run(),/已有成本保留/);
  assert.equal(store.marketing.cleaner.costs.old.spendMilliunits,123);
});

test('empty trailing page cannot overwrite a previously complete cost window',async()=>{
  const store={marketing:{cleaner:{costs:{old:{channel:'applovin',date:'2026-10-19',source:'applovin-api',spendMilliunits:999}},imports:[]}}};
  let calls=0;
  const sync=createApplovinSync({config,getStore:async()=>store,saveStore:async()=>{},clock:()=>now,
    fetchImpl:async()=>++calls===1?response(Array.from({length:500},(_,i)=>({...record(),creative_set_id:'set-'+i}))):{ok:true,text:async()=>''}});
  await assert.rejects(sync.run(),/分页响应不完整/);
  assert.equal(calls,2);
  assert.deepEqual(Object.keys(store.marketing.cleaner.costs),['old']);
  assert.equal(store.marketing.cleaner.costs.old.spendMilliunits,999);
  assert.equal(store.marketing.cleaner.applovin.lastSuccess,undefined);
});
test('a failed manual refresh after same-day success is retried after the hourly backoff',async()=>{
  let time=now,calls=0,fail=false;const store={};
  const sync=createApplovinSync({config,getStore:async()=>store,saveStore:async()=>{},clock:()=>time,
    fetchImpl:async()=>{calls++;if(fail)throw new Error('network');return response([]);}});
  await sync.tick();fail=true;time+=60000;
  await assert.rejects(sync.run(),/请求失败/);await sync.tick();assert.equal(calls,2);
  time+=3600000;fail=false;await sync.tick();assert.equal(calls,3);
  assert.equal((await sync.status()).error,null);
});
