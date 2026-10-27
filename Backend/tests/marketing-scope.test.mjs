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
