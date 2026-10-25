import test from 'node:test';
import assert from 'node:assert/strict';
import {productOperations} from '../product-operations.mjs';
test('admin sandbox diagnostics do not enter production orders, prices or revenue',()=>{
 const store={sharedPartnerReferrals:{cleaner:{receipts:{'Sandbox:one':{
 transaction_id:'one',environment:'Sandbox',customer_id:'user',sku:'weekly',
 price:9990,currency:'USD',purchased_at:1792910000,created_at:1792910000000,
 status:'sandbox',account_token:'private',proof_hash:'private'
 }}}}};
 const result=productOperations(store,'cleaner');
 assert.equal(result.testOrders.length,1);
 assert.equal(result.testOrders[0].accountId,'user');
 assert.equal(result.testOrders[0].singularPurchaseStatus,null);
 assert.equal(result.orders.length,0);
 assert.equal(result.totals.paidOrders,0);
 assert.deepEqual(result.totals.grossMilliunitsByCurrency,{});
 assert.deepEqual(result.observedPrices,[]);
 assert.ok(!JSON.stringify(result.testOrders).includes('private'));
});
