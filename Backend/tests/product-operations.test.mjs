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
