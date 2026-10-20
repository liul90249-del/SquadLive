// Pure presentation selectors: retain the API's UTC days and currency units.
export const dateOf = value => typeof value === 'string' ? value.slice(0, 10) : '';
export const shiftDay = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
export function period(daily, start, end) {
  if (!start || !end || start > end) return null;
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  const previousEnd = shiftDay(start, -1), previousStart = shiftDay(start, -days);
  const current = daily.filter(row => row.date >= start && row.date <= end);
  const previous = daily.filter(row => row.date >= previousStart && row.date <= previousEnd);
  return {current, previous, days, previousStart, previousEnd,
    comparable: new Set(previous.map(row => row.date)).size === days && new Set(current.map(row => row.date)).size === days};
}
export function aggregate(rows, key, currency = '') {
  const total = rows.reduce((sum, row) => sum + Number(key === 'gross' ? row.grossMilliunitsByCurrency?.[currency] || 0 : row[key] || 0), 0);
  return key === 'activeUsers' ? (rows.length ? total / rows.length : 0) : total;
}
export function delta(current, previous, comparable) {
  if (!comparable) return '上期数据不足';
  if (!previous) return current ? '上期为 0 · 本期新增' : '与上期持平';
  const change = (current - previous) / previous * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}% 较上期`;
}
export function filterUsers(users, {query = '', status = 'all', start = '', end = '', sort = 'newest'} = {}) {
  const q = query.trim().toLowerCase();
  return users.filter(u => (!q || [u.id,u.deviceId,u.country,u.countryCode,u.lastIPAddress,u.bindingCode].some(v => String(v || '').toLowerCase().includes(q))) &&
    (status === 'all' || (status === 'paid' ? u.paidOrders > 0 : !u.paidOrders)) &&
    (!start || dateOf(u.createdAt) >= start) && (!end || dateOf(u.createdAt) <= end))
    .sort((a,b) => sort === 'orders' ? b.paidOrders - a.paidOrders : String(sort === 'active' ? b.lastSeenAt : b.createdAt).localeCompare(String(sort === 'active' ? a.lastSeenAt : a.createdAt)));
}
export function needsReview(order) {
  return ['uncertain','rejected','attempting'].includes(order.singularPurchaseStatus) || ['uncertain','rejected','attempting'].includes(order.singularRefundStatus);
}
export function filterOrders(orders, {query = '', status = 'all', currency = '', start = '', end = '', dateField = 'purchasedAt', accountId = '', sku = ''} = {}) {
  const q = query.trim().toLowerCase();
  return orders.filter(o => (!accountId || o.accountId === accountId) && (!sku || o.sku === sku) && (!q || [o.transactionId,o.accountId,o.sku].some(v => String(v || '').toLowerCase().includes(q))) &&
    (!currency || o.currency === currency) &&
    (status === 'all' || (status === 'refund' ? o.refunded : status === 'review' ? needsReview(o) : o.priceMilliunits > 0 && !!o.currency)) &&
    (!start || dateOf(o[dateField]) >= start) && (!end || (!!dateOf(o[dateField]) && dateOf(o[dateField]) <= end)));
}
export function pageRows(rows, page, size = 10) {
  const pages = Math.max(1,Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1,page),pages);
  return {rows:rows.slice((current-1)*size,current*size),page:current,pages,total:rows.length};
}
