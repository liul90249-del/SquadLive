import test from 'node:test';import assert from 'node:assert/strict';
import {dataHealth,dataFreshnessHTML} from '../admin-health.mjs';
import {readPreference,savePreference} from '../admin-preferences.mjs';
import {marketingDataset,growthDrilldown,buildGrowthReport} from '../marketing-core.mjs';
test('refresh timestamps never pretend a new session or order arrived',()=>{
 const now=Date.parse('2026-10-27T01:00:00Z');
 const data={generatedAt:now,users:[{lastSeenAt:'2026-10-26T01:00:00Z'}],orders:[],marketing:{users:[]}};
 let h=dataHealth(data,now);assert.equal(h.lastSessionAt,now-86400000);assert.equal(h.lastOrderAt,null);assert.equal(h.stale,false);
 h=dataHealth(data,now+121000);assert.equal(h.stale,true);
 const html=dataFreshnessHTML(data,now);assert.match(html,/最近会话发生/);assert.match(html,/暂无记录/);assert.match(html,/页面刷新成功不代表/);
 assert.equal(dataHealth({users:[],orders:[]},now).stale,false);
});
test('preferences are separated by product; corrupt or unavailable storage is safe',()=>{
 const map=new Map(),storage={setItem:(k,v)=>map.set(k,v),getItem:k=>map.get(k)};
 savePreference('cleaner','view',{historyDays:365},storage);assert.deepEqual(readPreference('dailyme','view',storage),{});assert.equal(readPreference('cleaner','view',storage).historyDays,365);
 map.set('admin.preferences.v1.cleaner.view','broken');assert.deepEqual(readPreference('cleaner','view',storage),{});
 const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 assert.doesNotThrow(()=>savePreference('cleaner','view',{},blocked));assert.deepEqual(readPreference('cleaner','view',blocked),{});
});
test('source diagnostics distinguish missing, ambiguous and ready identity links without leaking identifiers',()=>{
 const accounts={a:{id:'a'},b:{id:'b',singularSdid:'duplicate'},c:{id:'c',singularSdid:'DUPLICATE'},d:{id:'d',singularSdid:'unique'}};
 const operations={users:Object.keys(accounts).map(id=>({id,createdAt:'2026-10-20T00:00:00Z'})),orders:[]};
 const d=marketingDataset({sharedPartnerReferrals:{cleaner:{accounts}}},'cleaner',operations);
 assert.deepEqual(d.users.map(u=>u.identityLinkStatus),['missing','ambiguous','ambiguous','ready']);assert.ok(d.users.every(u=>u.singularSdid===undefined));
});
test('growth drilldown matches weighted counts and net income using acquired dates, sources and currency',()=>{
 const d={product:'cleaner',now:Date.parse('2026-10-27T01:00:00Z'),costs:[],users:[
 {id:'a',createdAt:'2026-10-20T01:00:00Z',acquiredAt:'2026-10-20T01:00:00Z',events:{},attribution:{channel:'organic'}},
 {id:'b',createdAt:'2026-10-21T01:00:00Z',acquiredAt:'2026-10-21T01:00:00Z',events:{}}],
 orders:[{accountId:'a',transactionId:'paid',kind:'subscription',purchasedAt:'2026-10-20T02:00:00Z',currency:'USD',priceMilliunits:990,refundedMilliunits:100},
 {accountId:'a',transactionId:'gbp',kind:'subscription',purchasedAt:'2026-10-21T02:00:00Z',currency:'GBP',priceMilliunits:1000}]};
 const filters={start:'2026-10-20',end:'2026-10-27',currency:'USD'},g=buildGrowthReport(d,filters),row=g.rows.find(r=>r.date==='2026-10-20');
 for(const key of ['users','subD0','paidToDate'])assert.equal(growthDrilldown(d,filters,row,key).users.length,row[key]);
 const detail=growthDrilldown(d,filters,row,'net');assert.equal(detail.orders.reduce((sum,o)=>sum+o.priceMilliunits-o.refundedMilliunits,0),row.net);
 assert.equal(growthDrilldown(d,{...filters,channel:'applovin'},g.total,'users').users.length,0);
 assert.equal(growthDrilldown(d,filters,g.rows[0],'users').users.length,0);
});
