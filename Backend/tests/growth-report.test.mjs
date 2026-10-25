import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGrowthReport,DAY} from '../marketing-core.mjs';
const start=Date.parse('2026-10-01T00:00:00Z');
const iso=n=>new Date(start+n*DAY).toISOString();
const fixture=()=>({now:start+40*DAY,product:'cleaner',imports:[],
  users:['a','b'].map(id=>({id,createdAt:iso(0),acquiredAt:iso(0),trackedFrom:iso(0),events:{cleanup_completed:start+1000},attribution:{channel:'applovin',campaignId:'c'}})),
  costs:[{date:'2026-10-01',channel:'applovin',campaignId:'c',currency:'USD',spendMilliunits:10000,impressions:100,clicks:10,installs:2}],
  orders:[{accountId:'a',transactionId:'trial',originalTransactionId:'a',kind:'subscription',purchasedAt:iso(.1),priceMilliunits:0,currency:'USD',isFreeTrial:true,expiresAt:iso(7.1)},
    {accountId:'a',transactionId:'paid',originalTransactionId:'a',kind:'subscription',purchasedAt:iso(7.1),priceMilliunits:10000,currency:'USD',refundedMilliunits:2000},
    {accountId:'b',transactionId:'intro',originalTransactionId:'b',kind:'subscription',purchasedAt:iso(.2),priceMilliunits:990,currency:'USD'},
    {accountId:'b',transactionId:'other-currency',originalTransactionId:'b',kind:'subscription',purchasedAt:iso(1),priceMilliunits:20000,currency:'GBP'}],
  subscriptions:{trackingStartedAt:start-1,people:[{id:'a',subscribedAt:start+.1*DAY,autoRenewStatus:0},{id:'b',subscribedAt:start+.2*DAY,autoRenewStatus:1}],cancellationEvents:[{id:'a',at:start+3*DAY}]}});
test('growth separates trial, actual charge and cancellation; revenue respects currency and refunds',()=>{
  const {rows:[r]}=buildGrowthReport(fixture());
  assert.equal(r.subD0,2);assert.equal(r.freeD0,1);assert.equal(r.paidD0,1);assert.equal(r.subRateD0,100);
  assert.equal(r.netD0,990);assert.equal(r.net,8990);assert.equal(r.ltv,4495);assert.equal(r.contribution,-1010);
  assert.equal(r.cancelD0,0);assert.equal(r.cancelD3,1);assert.equal(r.cancelRateD7,50);
  assert.equal(r.endedTrials,1);assert.equal(r.convertedTrials,1);assert.equal(r.trialPaidRate,100);
  assert.equal(r.roasD3,9.9);assert.equal(r.roasD7,89.9);assert.equal(r.adRevenue,null);assert.equal(r.forecastLtv,null);
});
test('unmatured windows, missing notification history, zero denominator and missing cost remain unavailable',()=>{
  const d=fixture();d.now=start+3*DAY;
  let r=buildGrowthReport(d).rows[0];assert.equal(r.cancelD3,null);assert.equal(r.roasD3,null);assert.equal(r.trialPaidRate,null);
  d.now=start+40*DAY;d.subscriptions.trackingStartedAt=start+DAY;
  assert.equal(buildGrowthReport(d).rows[0].cancelD7,null);
  d.costs=[];r=buildGrowthReport(d).rows[0];assert.equal(r.spend,null);assert.equal(r.roas,null);assert.equal(r.contribution,null);
  d.users=[];assert.equal(buildGrowthReport(d).total.subRateD0,null);
});
test('date grouping rolls up sources once, uses weighted totals and filters before aggregation',()=>{
  const d=fixture();d.users.push({...d.users[0],id:'c',attribution:{channel:'organic'}});
  let g=buildGrowthReport(d);assert.equal(g.rows.length,1);assert.equal(g.total.users,3);assert.ok(Math.abs(g.total.subRateD0-200/3)<1e-10);
  g=buildGrowthReport(d,{channel:'applovin'});assert.equal(g.total.users,2);assert.equal(g.total.subRateD0,100);
  g=buildGrowthReport(d,{growthDimension:'source'});assert.equal(g.rows.length,2);assert.equal(g.total.spend,null);
});
test('old tracking and unknown prices do not produce fabricated zeros; later refunds backfill the cohort',()=>{
  const d=fixture();d.users[0].trackedFrom=null;
  assert.equal(buildGrowthReport(d).rows[0].cleanupD0,null);
  d.orders[1].priceMilliunits=null;assert.equal(buildGrowthReport(d).rows[0].net,null);
  d.orders[1].priceMilliunits=10000;d.orders[1].refundedMilliunits=10000;
  assert.equal(buildGrowthReport(d).rows[0].net,990);
});

test('cost without linked users does not claim zero ROAS or a loss',()=>{
  const d=fixture();d.users=[];d.orders=[];
  const r=buildGrowthReport(d).rows[0];
  assert.equal(r.roas,null);assert.equal(r.roi,null);assert.equal(r.contribution,null);
});

test('cohort cancellations continue beyond D7 and renewals exclude the first trial charge',()=>{
  const d=fixture();
  d.subscriptions.cancellationEvents=[{id:'a',at:start+12*DAY},{id:'a',at:start+13*DAY},{id:'b',at:start+50*DAY}];
  let r=buildGrowthReport(d).rows[0];
  assert.equal(r.cancelD7,0);assert.equal(r.cancelToDate,1);assert.equal(r.cancelRateToDate,50);
  assert.equal(r.paidToDate,2);assert.equal(r.paidRateToDate,100);
  assert.equal(r.renewedToDate,1); // b has two charged transactions on one chain, across currencies.
  d.orders=d.orders.filter(o=>o.transactionId!=='other-currency');
  assert.equal(buildGrowthReport(d).rows[0].renewedToDate,0);
  d.orders.push({...d.orders[1],transactionId:'renewal',purchasedAt:iso(14.1)});
  d.orders.push({...d.orders[1]}); // duplicate transaction does not add a renewal
  r=buildGrowthReport(d).rows[0];assert.equal(r.renewedToDate,1);
  const total=buildGrowthReport(d).total;
  assert.equal(total.cancelToDate,1);assert.equal(total.cancelRateToDate,50);assert.equal(total.paidToDate,2);
  d.subscriptions.trackingStartedAt=start+DAY;
  assert.equal(buildGrowthReport(d).rows[0].cancelToDate,null);
  assert.equal(buildGrowthReport(d).total.cancelRateToDate,null);
});

test('date-level ad returns exclude organic, unknown and unmatched campaign revenue without dropping it from LTV',()=>{
  const d=fixture();
  for(const [id,attribution] of [['organic',{channel:'organic'}],['unknown',null],['other',{channel:'applovin',campaignId:'unmatched'}]]){
    d.users.push({...d.users[0],id,attribution});
    d.orders.push({accountId:id,transactionId:id,kind:'subscription',purchasedAt:iso(.3),priceMilliunits:100000,currency:'USD'});
  }
  const {rows:[r],total}=buildGrowthReport(d);
  assert.equal(r.net,308990);assert.equal(r.ltv,61798);
  assert.equal(r.matchedUsers,2);assert.equal(r.matchedNet,8990);
  assert.equal(r.roas,89.9);assert.equal(r.roasD7,89.9);assert.equal(r.contribution,-1010);assert.equal(r.roi,-10.100000000000001);
  assert.equal(total.roas,r.roas);assert.equal(total.roasD7,r.roasD7);
  d.costs.push({...d.costs[0],campaignId:'unmatched',currency:'GBP'});
  assert.equal(buildGrowthReport(d).rows[0].matchedNet,8990);
  d.costs.push({...d.costs[0],campaignId:'unmatched',spendMilliunits:20000});
  assert.equal(buildGrowthReport(d).rows[0].matchedNet,108990);
  assert.equal(buildGrowthReport(d).rows[0].spend,30000);
});

test('cleaner subscription-only revenue excludes other products and preserves unknown amounts',()=>{
  const d=fixture();
  d.orders.push({accountId:'a',transactionId:'non-sub',kind:'consumable',purchasedAt:iso(2),priceMilliunits:5000,currency:'USD'});
  let g=buildGrowthReport(d);
  assert.equal(g.rows[0].adRevenueApplicable,false);
  assert.equal(g.total.adRevenueApplicable,false);
  assert.equal(g.rows[0].totalRevenue,8990);
  assert.equal(g.total.totalRevenue,8990);
  assert.equal(g.rows[0].net,13990);
  assert.equal(g.rows[0].totalProfit,null);
  d.product='dailyme';g=buildGrowthReport(d);
  assert.equal(g.rows[0].totalRevenue,null);
  assert.equal(g.total.totalRevenue,null);
  assert.equal(g.rows[0].adRevenueApplicable,true);
  d.product='cleaner';d.orders.push({accountId:'a',kind:'subscription',purchasedAt:iso(3),priceMilliunits:null,currency:'USD'});
  g=buildGrowthReport(d);assert.equal(g.rows[0].totalRevenue,null);assert.equal(g.total.totalRevenue,null);
});

test('30 percent estimates use subscription net refunds and preserve missing inputs',()=>{
  const d=fixture();
  d.orders.push({accountId:'a',transactionId:'extra',kind:'consumable',purchasedAt:iso(2),priceMilliunits:5000,currency:'USD'});
  let g=buildGrowthReport(d);
  for(const row of [g.rows[0],g.total]){
    assert.equal(row.estimatedAppleFee,2697);
    assert.equal(row.estimatedProceeds,6293);
    assert.equal(row.estimatedProfit,6293-row.spend);
  }
  d.costs=[];g=buildGrowthReport(d);
  assert.equal(g.rows[0].estimatedProceeds,6293);
  assert.equal(g.rows[0].estimatedProfit,null);
  d.product='dailyme';g=buildGrowthReport(d);assert.equal(g.total.estimatedProceeds,null);
  d.product='cleaner';d.orders.push({accountId:'a',kind:'subscription',purchasedAt:iso(3),priceMilliunits:null,currency:'USD'});
  g=buildGrowthReport(d);assert.equal(g.total.estimatedAppleFee,null);assert.equal(g.total.estimatedProfit,null);
});
