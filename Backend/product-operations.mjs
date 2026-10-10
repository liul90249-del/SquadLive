// Admin-only operational metrics derived from verified product identities and
// App Store transactions. No client-reported prices or estimated revenue.
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
const day = value => typeof value === 'string' ? value.slice(0, 10) : '';
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const dayAfter = (date, offset) => {
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) ? new Date(time + offset * 86400000).toISOString().slice(0, 10) : '';
};

export async function readVerifiedProductReceipts(directory, product) {
  if (!directory) return [];
  const root = join(directory, 'partner-inbox', product, 'Production');
  let entries;
  try { entries = await readdir(root, {withFileTypes:true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
  const results = [];
  for (let index = 0; index < files.length; index += 64) {
    const batch = await Promise.all(files.slice(index, index + 64).map(async entry => JSON.parse(await readFile(join(root, entry.name), 'utf8'))));
    results.push(...batch.filter(item => item.environment === 'Production' && item.product === product && item.transaction_id));
  }
  return results;
}

export function productOperations(store, product, now = Date.now(), verifiedReceipts = null) {
  const state = store.sharedPartnerReferrals?.[product] || {};
  const accounts = Object.values(state.accounts || {});
  const sharedReceipts = Object.values(state.receipts || {});
  const verifiedKeys = new Set((verifiedReceipts || []).map(receipt => `${receipt.environment}:${receipt.transaction_id}`));
  const receipts = verifiedReceipts === null ? sharedReceipts : [
    ...verifiedReceipts.map(receipt => {
      const matching = state.receipts?.[`${receipt.environment}:${receipt.transaction_id}`] || {};
      return {
        ...matching,
        ...receipt,
        customer_id: matching.customer_id || state.accountTokens?.[String(receipt.account_token || '').toLowerCase()] || null,
        original_transaction_id: receipt.original_id,
        purchase_kind: receipt.purchase_kind,
        purchased_at: Math.floor(Number(receipt.purchased_at) / 1000),
        refunded_at: receipt.refunded_at || matching.refunded_at || null,
        revoked: Boolean(receipt.revoked || matching.revoked),
        status: matching.status || receipt.attribution_status || 'unattributed'
      };
    }),
    // Preserve older attributed receipts if they predate file-backed inbox storage.
    ...sharedReceipts.filter(receipt => !verifiedKeys.has(`${receipt.environment}:${receipt.transaction_id}`))
  ];
  const today = new Date(now).toISOString().slice(0, 10);
  const production = receipts.filter(item => item.environment === 'Production');
  const charged = production.filter(item => Number.isSafeInteger(item.price) && item.price > 0 && item.currency);
  const paid = charged.filter(item => !item.revoked);
  const refunded = charged.filter(item => item.revoked);
  const paidOrderCounts = new Map();
  for (const item of paid) if (item.customer_id) paidOrderCounts.set(item.customer_id, (paidOrderCounts.get(item.customer_id) || 0) + 1);
  const revenueByCurrency = (items) => items.reduce((totals, item) => {
    const currency = String(item.currency).toUpperCase();
    totals[currency] = (totals[currency] || 0) + item.price;
    return totals;
  }, {});
  const activityDays = (account) => Object.keys(account.activeDays || {}).filter(key => account.activeDays[key]);
  const isActive = (account, date) => Boolean(account.activeDays?.[date]);
  const retention = (offset) => {
    const cohort = accounts.filter(account => {
      const registered = day(account.createdAt);
      // Historical identities without complete launch tracking are excluded.
      return registered && registered === day(account.activityTrackedFrom) && dayAfter(registered, offset) <= today;
    });
    const returned = cohort.filter(account => isActive(account, dayAfter(day(account.createdAt), offset))).length;
    return {eligible: cohort.length, returned, rate: cohort.length ? Number((100 * returned / cohort.length).toFixed(1)) : null};
  };
  const orders = production.map(item => ({
    transactionId: item.transaction_id,
    originalTransactionId: item.original_transaction_id,
    accountId: item.customer_id || null,
    sku: item.sku,
    kind: item.purchase_kind,
    purchasedAt: iso(Number(item.purchased_at) * 1000),
    refundedAt: item.revoked && item.refunded_at ? iso(Number(item.refunded_at)) : null,
    priceMilliunits: Number.isSafeInteger(item.price) ? item.price : null,
    currency: item.currency || null,
    refunded: Boolean(item.revoked),
    status: item.status || 'unknown'
  })).sort((a, b) => String(b.purchasedAt).localeCompare(String(a.purchasedAt)));
  const observedPrices = {};
  for (const order of orders) {
    if (order.priceMilliunits === null || order.priceMilliunits <= 0 || !order.currency) continue;
    const key = `${order.sku}:${order.currency}`;
    const value = observedPrices[key] ||= {sku: order.sku, currency: order.currency, minimumMilliunits: order.priceMilliunits, maximumMilliunits: order.priceMilliunits, count: 0};
    value.minimumMilliunits = Math.min(value.minimumMilliunits, order.priceMilliunits);
    value.maximumMilliunits = Math.max(value.maximumMilliunits, order.priceMilliunits);
    value.count++;
  }
  const daily = Array.from({length: 30}, (_, index) => dayAfter(today, index - 29)).map(date => {
    const dailyPaid = charged.filter(item => iso(Number(item.purchased_at) * 1000)?.slice(0, 10) === date);
    const dailyRefunded = refunded.filter(item => item.refunded_at && iso(Number(item.refunded_at))?.slice(0, 10) === date);
    return {
      date,
      registrations: accounts.filter(account => day(account.createdAt) === date).length,
      activeUsers: accounts.filter(account => isActive(account, date)).length,
      payingUsers: new Set(dailyPaid.map(item => item.customer_id).filter(Boolean)).size,
      paidOrders: dailyPaid.length,
      refunds: dailyRefunded.length,
      grossMilliunitsByCurrency: revenueByCurrency(dailyPaid),
      refundedMilliunitsByCurrency: revenueByCurrency(dailyRefunded)
    };
  });
  return {
    product,
    totals: {
      registrations: accounts.length,
      registrationsToday: accounts.filter(account => day(account.createdAt) === today).length,
      activeToday: accounts.filter(account => isActive(account, today)).length,
      payingUsers: new Set(paid.map(item => item.customer_id).filter(Boolean)).size,
      paidOrders: charged.length,
      refunds: refunded.length,
      grossMilliunitsByCurrency: revenueByCurrency(charged),
      refundedMilliunitsByCurrency: revenueByCurrency(refunded),
      day1Retention: retention(1),
      day7Retention: retention(7)
    },
    observedPrices: Object.values(observedPrices).sort((a, b) => a.sku.localeCompare(b.sku)),
    daily,
    users: accounts.map(account => ({
      id: account.id,
      createdAt: account.createdAt,
      lastSeenAt: account.lastSeenAt || null,
      activeDays: activityDays(account).length,
      firstIPAddress: account.firstIPAddress || null,
      lastIPAddress: account.lastIPAddress || null,
      countryCode: account.networkCountryCode || null,
      country: account.networkCountry || null,
      networkOrganization: account.networkOrganization || null,
      possibleAppleNetwork: Boolean(account.possibleAppleNetwork),
      paidOrders: paidOrderCounts.get(account.id) || 0,
      bindingCode: state.bindings?.[account.id]?.code || null
    })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    orders
  };
}
