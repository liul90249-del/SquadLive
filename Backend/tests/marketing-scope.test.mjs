import test from 'node:test';
import assert from 'node:assert/strict';

const data={product:'cleaner',now:Date.parse('2026-10-27T15:00:00Z'),imports:[],orders:[],
 users:Array.from({length:39},(_,i)=>({id:'old-'+i,createdAt:'2026-10-20T00:00:00Z',acquiredAt:'2026-10-20T00:00:00Z',events:{},attribution:i<19?{channel:'organic'}:null})),
 costs:[{date:'2026-10-27',channel:'applovin',campaignId:'c1',currency:'USD',spendMilliunits:59049,impressions:308,clicks:240,installs:0}]};
function setup(saved){
 globalThis.document={createElement:()=>({}),body:{append(){},dataset:{}},addEventListener(){}};
 globalThis.localStorage={getItem:()=>JSON.stringify(saved)};
}
const section=(html,name)=>html.split(`class="insight-surface ${name}"`)[1].split('</section>\n  <section class="insight-surface')[0];
test('legacy 30-day preference defaults to today and never presents historical users as ad installs',async()=>{
 setup({rangeDays:30,start:'2026-09-28',end:'2026-10-27'});
 const {marketingHTML}=await import('../admin-marketing.mjs?scope-today');
 const html=marketingHTML(data),ads=section(html,'market-ad-summary'),users=section(html,'market-user-summary');
 assert.match(ads,/今天 · 2026-10-27/);assert.match(ads,/USD 59.05/);assert.match(ads,/广告归因安装/);assert.match(ads,/<strong>0<\/strong>/);assert.doesNotMatch(ads,/<strong>39<\/strong>|market-label\">后台新增用户/);
 assert.match(users,/后台新增用户/);assert.doesNotMatch(users,/<strong>39<\/strong>/);
 assert.match(html,/name="start" value="2026-10-27"/);
});
test('explicit historical range keeps 39 users separate from zero platform installs and shows cost coverage',async()=>{
 setup({scopeVersion:2,rangeDays:30});
 const {marketingHTML}=await import('../admin-marketing.mjs?scope-history');
 const html=marketingHTML(data),ads=section(html,'market-ad-summary'),users=section(html,'market-user-summary');
 assert.match(ads,/2026-09-28 至 2026-10-27/);assert.match(ads,/共 1 个统计日/);assert.doesNotMatch(ads,/<strong>39<\/strong>/);
 assert.match(users,/<strong>39<\/strong>/);assert.match(users,/自然量 19 人 · 来源未知 20 人/);
});

test('Cleaner shows Meta account-day totals even when the UTC import has zero spend', async () => {
 setup({scopeVersion:2,rangeDays:1,level:'creative'});
 const {marketingHTML}=await import('../admin-marketing.mjs?scope-meta');
 const now=Date.parse('2026-11-17T23:00:00Z');
 const timezone='Asia/Shanghai';
 const rows=[{date:'2026-11-18',timezone,currency:'USD',route:'unknown',campaignId:'123456',
  campaignName:'clean-01',adGroupId:'234567',adGroupName:'US',adId:'345678',adName:'clean-01-ad',spendMilliunits:37490,impressions:474,clicks:90,conversionsUnavailable:true}];
 const acquiredAt='2026-11-17T23:00:00Z';
 const users=[{id:'linked',createdAt:acquiredAt,acquiredAt,events:{},singularDeviceAttributed:true,
  attribution:{acquiredAt,channel:'facebook',campaignId:'123456',adGroupId:'234567',creativeId:'345678'}}];
 const html=marketingHTML({...data,users,now,meta:{timezone},metaReports:{rows},
  costs:[{date:'2026-11-17',channel:'applovin',currency:'USD',spendMilliunits:0,impressions:0,clicks:0,installs:0}]});
 const meta=section(html,'market-meta-summary'), imported=section(html,'market-ad-summary');
 assert.match(meta,/2026-11-18（Asia\/Shanghai）/);
 assert.match(meta,/<strong>USD 37\.49<\/strong>/);
 assert.match(meta,/<strong>474<\/strong>/);
 assert.match(meta,/<strong>90<\/strong>/);
 assert.match(meta,/<strong>—<\/strong>/);
 assert.match(imported,/2026-11-17（UTC）/);
 assert.match(imported,/<strong>USD 0\.00<\/strong>/);
 assert.doesNotMatch(imported,/37\.49/);
 assert.match(html,/Singular 已关联用户/);
 assert.match(html,/Meta \/ clean-01 \/ US \/ clean-01-ad<\/td><td>USD 37\.49<\/td><td>474<\/td><td>90<\/td><td>19\.0%<\/td><td>—<\/td><td>1<\/td>/);
});
