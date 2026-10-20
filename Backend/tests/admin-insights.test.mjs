import test from 'node:test';
import assert from 'node:assert/strict';
import {period,aggregate,delta,filterUsers,filterOrders,pageRows} from '../admin-insights-core.mjs';
const daily=Array.from({length:14},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,registrations:i<7?2:3,activeUsers:10,grossMilliunitsByCurrency:{USD:10000,GBP:5000}}));
test('period comparison requires complete preceding interval; active average and currencies stay distinct',()=>{
 const p=period(daily,'2026-10-08','2026-10-14');
 assert.equal(p.comparable,true); assert.equal(aggregate(p.current,'registrations'),21);
 assert.equal(aggregate(p.current,'activeUsers'),10);
 assert.equal(aggregate(p.current,'gross','USD'),70000);
 assert.equal(aggregate(p.current,'gross','GBP'),35000);
 assert.equal(delta(21,14,p.comparable),'+50.0% 较上期');
 assert.equal(period(daily,'2026-10-01','2026-10-14').comparable,false);
 assert.equal(period(daily.filter(r=>r.date!=='2026-10-02'),'2026-10-08','2026-10-14').comparable,false);
 assert.equal(delta(3,0,true),'上期为 0 · 本期新增');
 assert.equal(period(daily,'2026-10-14','2026-10-01'),null);
});
test('refund drilldown uses refund date instead of purchase date and does not treat family revoke as refund',()=>{
 const orders=[{transactionId:'refund',currency:'USD',priceMilliunits:10000,refunded:true,purchasedAt:'2026-09-01',refundedAt:'2026-10-12'},
 {transactionId:'family',currency:'USD',refunded:false,revocationType:'FAMILY_REVOKE',purchasedAt:'2026-10-12'},
 {transactionId:'unknown-time',currency:'GBP',refunded:true,refundedAt:null}];
 assert.deepEqual(filterOrders(orders,{status:'refund',start:'2026-10-08',end:'2026-10-14',dateField:'refundedAt'}).map(o=>o.transactionId),['refund']);
 assert.equal(filterOrders(orders,{status:'refund'}).length,2);
 assert.equal(filterOrders(orders,{status:'charged'}).length,1);
});
test('user search combines status/date and pagination clamps after filtering',()=>{
 const users=Array.from({length:21},(_,i)=>({id:`demo-${i}`,createdAt:`2026-10-${i<10?'10':'11'}T23:30:00Z`,country:i%2?'US':'GB',paidOrders:i%2}));
 const filtered=filterUsers(users,{query:'US',status:'paid',start:'2026-10-11',end:'2026-10-11'});
 assert.equal(filtered.length,5);
 assert.equal(pageRows(filtered,3).page,1);
 assert.equal(pageRows(users,3).rows.length,1);
 assert.equal(pageRows([],5).pages,1);
});

test('user and SKU drilldown matches exact identifiers, not prefixes',()=>{
 const orders=[{accountId:'demo-1',sku:'weekly'}, {accountId:'demo-10',sku:'weekly2'}];
 assert.equal(filterOrders(orders,{accountId:'demo-1'}).length,1);
 assert.equal(filterOrders(orders,{sku:'weekly'}).length,1);
});


test('support email Device ID finds the existing account without exposing credentials',()=>{
  const users=[{id:'anon-user-a',deviceId:'10000000-0000-4000-8000-000000000010',createdAt:'2026-10-20',paidOrders:0},{id:'anon-user-b',deviceId:'other',createdAt:'2026-10-20',paidOrders:0}];
  assert.deepEqual(filterUsers(users,{query:'10000000-0000-4000-8000-000000000010'}).map(u=>u.id),['anon-user-a']);
  assert.deepEqual(filterUsers(users,{query:'ANON-USER-A'}).map(u=>u.id),['anon-user-a']);
});
