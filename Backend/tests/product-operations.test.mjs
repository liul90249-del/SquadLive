import test from 'node:test';
import assert from 'node:assert/strict';
import {productOperations, readVerifiedProductReceipts} from '../product-operations.mjs';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('operational metrics use verified production charges, refunds, and tracked sessions', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const store = {sharedPartnerReferrals:{cleaner:{
    accounts:{
      a:{id:'a',createdAt:'2026-10-09T09:00:00.000Z',activityTrackedFrom:'2026-10-09T09:00:00.000Z',activeDays:{'2026-10-09':true,'2026-10-10':true,'2026-10-11':true},lastIPAddress:'8.8.8.8',networkCountryCode:'US'},
      b:{id:'b',createdAt:'2026-10-01T09:00:00.000Z',activityTrackedFrom:'2026-10-08T09:00:00.000Z',activeDays:{'2026-10-11':true}}
    },
    receipts:{
      paid:{transaction_id:'t1',original_transaction_id:'o1',customer_id:'a',sku:'weekly',environment:'Production',purchased_at:Math.floor(Date.parse('2026-10-11T08:00:00Z')/1000),price:4990,currency:'USD',purchase_kind:'subscription',status:'sent',singular_purchase:{status:'uncertain'}},
      refunded:{transaction_id:'t2',original_transaction_id:'o2',customer_id:'b',sku:'weekly',environment:'Production',purchased_at:Math.floor(Date.parse('2026-10-10T08:00:00Z')/1000),refunded_at:Date.parse('2026-10-11T09:00:00Z'),price:4990,currency:'USD',purchase_kind:'subscription',status:'refunded',revoked:true},
      trial:{transaction_id:'t3',customer_id:'a',sku:'weekly',environment:'Production',price:0,currency:'USD'},
      sandbox:{transaction_id:'t4',customer_id:'a',sku:'weekly',environment:'Sandbox',price:4990,currency:'USD'}
    },bindings:{}
  }}};
  const report = productOperations(store,'cleaner',now);
  assert.equal(report.totals.registrations,2);
  assert.equal(report.totals.activeToday,2);
  assert.equal(report.totals.payingUsers,1);
  assert.equal(report.totals.paidOrders,2);
  assert.equal(report.totals.refunds,1);
  assert.equal(report.totals.singularNeedsReview,1);
  assert.equal(report.orders.find(item => item.transactionId === 't1').singularPurchaseStatus,'uncertain');
  assert.deepEqual(report.totals.grossMilliunitsByCurrency,{USD:9980});
  assert.deepEqual(report.totals.refundedMilliunitsByCurrency,{USD:4990});
  assert.equal(report.daily.find(item => item.date === '2026-10-10').refunds,0);
  assert.equal(report.daily.find(item => item.date === '2026-10-11').refunds,1);
  assert.deepEqual(report.daily.find(item => item.date === '2026-10-11').refundedMilliunitsByCurrency,{USD:4990});
  assert.equal(report.orders.find(item => item.transactionId === 't2').refundedAt,'2026-10-11T09:00:00.000Z');
  assert.deepEqual(report.totals.day1Retention,{eligible:1,returned:1,rate:100});
  assert.deepEqual(report.totals.day7Retention,{eligible:0,returned:0,rate:null});
  assert.equal(report.orders.length,3);
  assert.equal(report.users.find(user => user.id === 'a').lastIPAddress,'8.8.8.8');
});

test('verified Apple inbox remains visible when partner forwarding has no receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-operations-'));
  try {
    const root = join(directory, 'partner-inbox', 'cleaner', 'Production');
    await mkdir(root, {recursive:true});
    await writeFile(join(root, 'transaction.json'), JSON.stringify({
      product:'cleaner',environment:'Production',transaction_id:'verified-1',original_id:'original-1',
      sku:'weekly',purchase_kind:'subscription',account_token:'token-1',
      purchased_at:Date.parse('2026-10-11T08:00:00Z'),price:6990,currency:'USD',revoked:false,
      signed_transaction:'private-proof'
    }));
    const verified = await readVerifiedProductReceipts(directory, 'cleaner');
    const store = {sharedPartnerReferrals:{cleaner:{accounts:{a:{id:'a',createdAt:'2026-10-11T01:00:00Z'}},accountTokens:{'token-1':'a'}}}};
    const report = productOperations(store,'cleaner',Date.parse('2026-10-11T12:00:00Z'),verified);
    assert.equal(report.totals.paidOrders,1);
    assert.equal(report.totals.payingUsers,1);
    assert.equal(report.orders[0].accountId,'a');
    assert.equal(report.orders[0].priceMilliunits,6990);
    assert.equal(JSON.stringify(report).includes('private-proof'),false);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('partial refunds use verified Apple percentage and family revocations carry no refund revenue', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const purchasedAt = Date.parse('2026-10-10T08:00:00Z');
  const refundedAt = Date.parse('2026-10-11T09:00:00Z');
  const verified = [
    {product:'cleaner',environment:'Production',transaction_id:'half-refund',original_id:'half-refund',sku:'weekly',purchase_kind:'subscription',
      account_token:'half-owner',purchased_at:purchasedAt,price:9990,currency:'USD',revoked:true,refunded_at:refundedAt,
      revocation_type:'REFUND_PRORATED',revocation_percentage:null},
    {product:'cleaner',environment:'Production',transaction_id:'family-revoke',original_id:'family-revoke',sku:'weekly',purchase_kind:'subscription',
      account_token:'family-owner',purchased_at:purchasedAt,price:9990,currency:'USD',revoked:true,refunded_at:refundedAt,
      revocation_type:'FAMILY_REVOKE'}
  ];
  const store = {sharedPartnerReferrals:{cleaner:{
    accounts:{half:{id:'half'},family:{id:'family'}},accountTokens:{'half-owner':'half','family-owner':'family'},
    receipts:{'Production:half-refund':{revocation_percentage:50000}}
  }}};
  const report = productOperations(store,'cleaner',now,verified);
  assert.equal(report.totals.paidOrders,2);
  assert.equal(report.totals.payingUsers,2);
  assert.equal(report.totals.refunds,1);
  assert.deepEqual(report.totals.grossMilliunitsByCurrency,{USD:19980});
  assert.deepEqual(report.totals.refundedMilliunitsByCurrency,{USD:4995});
  assert.deepEqual(report.daily.find(item => item.date === '2026-10-11').refundedMilliunitsByCurrency,{USD:4995});
  assert.equal(report.orders.find(item => item.transactionId === 'half-refund').refundedMilliunits,4995);
  assert.equal(report.orders.find(item => item.transactionId === 'family-revoke').refunded,false);
});


test('admin support lookup exposes installation ID, not credentials, and distinguishes untracked cleanup',()=>{
 const accounts={old:{id:'old',deviceId:'old-device',createdAt:'2026-10-20',accountToken:'private-account-token'},tracked:{id:'tracked',deviceId:'tracked-device',createdAt:'2026-10-20',cleanupTrackedFrom:'2026-10-20',hasCompletedCleanup:false},cleaned:{id:'cleaned',deviceId:'cleaned-device',createdAt:'2026-10-20',hasCompletedCleanup:true,firstCleanupAt:Date.parse('2026-10-20T01:00:00Z')}};
 const report=productOperations({sharedPartnerReferrals:{cleaner:{accounts,credentials:{'private-hash':'old'}}}},'cleaner',Date.parse('2026-10-20T02:00:00Z'));
 assert.equal(report.users.find(u=>u.id==='old').deviceId,'old-device');
 assert.equal(report.users.find(u=>u.id==='old').hasCompletedCleanup,null);
 assert.equal(report.users.find(u=>u.id==='tracked').hasCompletedCleanup,false);
 assert.equal(report.users.find(u=>u.id==='cleaned').hasCompletedCleanup,true);
 assert.equal(JSON.stringify(report).includes('private-account-token'),false);
 assert.equal(JSON.stringify(report).includes('private-hash'),false);
});

test('historical day ranges stay bounded, expose snapshot time and keep totals independent',()=>{
  const now=Date.parse('2026-10-27T04:00:00Z');
  const store={sharedPartnerReferrals:{cleaner:{accounts:{a:{id:'a',createdAt:'2026-01-02T00:00:00Z',activeDays:{'2026-01-02':true}}}}}};
  const short=productOperations(store,'cleaner',now);
  const long=productOperations(store,'cleaner',now,null,365);
  assert.equal(short.daily.length,30);assert.ok(long.daily.length>30&&long.daily.length<=365);assert.equal(long.daily[0].date,'2026-01-02');
  assert.equal(long.generatedAt,now);assert.equal(long.daily.at(-1).date,'2026-10-27');
  assert.equal(long.daily.find(r=>r.date==='2026-01-02').registrations,1);
  assert.deepEqual(long.totals,short.totals);
  assert.equal(productOperations(store,'cleaner',now,null,999999).daily.length,30);
});
