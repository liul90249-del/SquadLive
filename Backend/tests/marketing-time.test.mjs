import test from 'node:test';import assert from 'node:assert/strict';
import {reportingDate,platformDateFilters} from '../marketing-time.mjs';
import {webFunnelDataset} from '../web-funnel.mjs';
import {buildWebReturnReport} from '../web-return-report.mjs';
test('Beijing report date and today filter change together at UTC16:00',()=>{
 for(const [iso,day] of [['2026-11-01T15:59:59Z','2026-11-01'],['2026-11-01T16:00:00Z','2026-11-02'],['2026-11-02T00:00:00Z','2026-11-02']]){
  const now=Date.parse(iso);assert.equal(reportingDate(now),day);const f=platformDateFilters({now},{start:'2026-11-01',end:'2026-11-01',rangeDays:1});assert.equal(f.start,day);assert.equal(f.end,day);
 }
});
test('relative ranges cross year boundaries correctly; custom dates and other filters remain exact',()=>{
 const data={now:Date.parse('2026-12-31T16:00:00Z')};const f=platformDateFilters(data,{rangeDays:7,currency:'USD',channel:'facebook'});assert.equal(f.end,'2027-01-01');assert.equal(f.start,'2026-12-26');assert.equal(f.channel,'facebook');
 const custom=platformDateFilters(data,{rangeDays:null,start:'2026-11-02',end:'2026-11-03'});assert.equal(custom.start,'2026-11-02');assert.equal(custom.end,'2026-11-03');
});
test('website funnel and web-to-app association use the same Beijing day without rewriting timestamps',()=>{
 const a=Date.parse('2026-11-01T15:59:59Z'),b=a+1000,campaign={utm_source:'facebook',campaign_id:'test'};
 const root={cleanerWebFunnel:{events:{a:{at:a,name:'PageView',visit:'a',campaign},b:{at:b,name:'PageView',visit:'b',campaign}}}};
 const f=webFunnelDataset(root);assert.deepEqual(f.rows.map(r=>r.date),['2026-11-01','2026-11-02']);assert.equal(root.cleanerWebFunnel.events.b.at,b);
 const r=buildWebReturnReport({clicks:[{createdAt:a,campaign},{createdAt:b,campaign}],bindings:[]},[],{timezone:'Asia/Shanghai',start:'2026-11-02',end:'2026-11-02',now:b+1000});assert.equal(r.rows.length,1);assert.equal(r.rows[0].downloadClicks,1);assert.equal(r.rows[0].date,'2026-11-02');
});
