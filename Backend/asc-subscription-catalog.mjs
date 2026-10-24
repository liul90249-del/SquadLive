import {createSign} from 'node:crypto';

const expectedProductId = 'com.hecathehe.PhoneCleaner.weekly';
const target = Object.freeze({territory: 'USA', currency: 'USD', price: '9.99', period: 'ONE_WEEK', trialDays: 7});
const baseURL = 'https://api.appstoreconnect.apple.com';

export function tokenFor({keyId, issuerId, privateKey}, now) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({alg: 'ES256', kid: keyId, typ: 'JWT'});
  const issuedAt = Math.floor(now / 1000);
  const payload = encode({iss: issuerId, iat: issuedAt, exp: issuedAt + 600, aud: 'appstoreconnect-v1'});
  const input = `${header}.${payload}`;
  const signature = createSign('SHA256').update(input).end().sign({
    key: privateKey.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `${input}.${signature}`;
}

function activeDate(attributes, today) {
  return (!attributes.startDate || attributes.startDate <= today)
    && (!attributes.endDate || attributes.endDate >= today);
}

function relationshipId(item, name) {
  return item.relationships?.[name]?.data?.id || null;
}

export async function pages(path, token, fetcher) {
  let url = new URL(path, baseURL);
  const data = [];
  const included = [];
  for (let page = 0; page < 10; page++) {
    if (url.origin !== baseURL || !url.pathname.startsWith('/v1/')) throw new Error('Invalid catalog pagination URL');
    const response = await fetcher(url, {
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`App Store Connect returned HTTP ${response.status}`);
    const body = await response.json();
    if (!body.data || (typeof body.data !== 'object')) throw new Error('Invalid App Store Connect response');
    data.push(...(Array.isArray(body.data) ? body.data : [body.data]));
    included.push(...(body.included || []));
    if (!body.links?.next) return {data, included};
    url = new URL(body.links.next, baseURL);
  }
  throw new Error('App Store Connect catalog has too many pages');
}

export function interpretCleanerCatalog(subscription, priceList, offerList, now = Date.now()) {
  const checkedAt = new Date(now).toISOString();
  const productId = subscription?.attributes?.productId;
  const period = subscription?.attributes?.subscriptionPeriod;
  if (productId !== expectedProductId) throw new Error('Configured subscription ID belongs to another product');
  const today = checkedAt.slice(0, 10);
  const included = new Map((priceList.included || []).map(item => [`${item.type}:${item.id}`, item]));
  const candidates = (priceList.data || []).filter(item =>
    relationshipId(item, 'territory') === target.territory
      && !item.attributes?.preserved && activeDate(item.attributes || {}, today));
  candidates.sort((a, b) => String(b.attributes?.startDate || '').localeCompare(String(a.attributes?.startDate || '')));
  const current = candidates[0];
  const pointId = current && relationshipId(current, 'subscriptionPricePoint');
  const pricePoint = pointId && included.get(`subscriptionPricePoints:${pointId}`);
  const territory = included.get(`territories:${target.territory}`);
  const customerPrice = pricePoint?.attributes?.customerPrice || null;
  const currency = territory?.attributes?.currency || null;
  const currentOffers = (offerList.data || []).filter(item =>
    relationshipId(item, 'territory') === target.territory && activeDate(item.attributes || {}, today));
  const hasTrial = currentOffers.some(item => item.attributes?.offerMode === 'FREE_TRIAL'
    && item.attributes?.duration === 'ONE_WEEK' && item.attributes?.numberOfPeriods === 1);
  const complete = Boolean(customerPrice && currency);
  const matchesTarget = complete && period === target.period && currency === target.currency
    && Number(customerPrice) === Number(target.price) && hasTrial;
  return {
    status: complete ? (matchesTarget ? 'matched' : 'mismatch') : 'incomplete',
    checkedAt, target,
    actual: {productId, period, currency, price: customerPrice, sevenDayTrial: hasTrial},
    matchesTarget: complete ? matchesTarget : null
  };
}

export function createCleanerCatalogReader({keyId, issuerId, privateKey, subscriptionId, fetcher = fetch, now = Date.now}) {
  if (!keyId || !issuerId || !privateKey || !subscriptionId) {
    return async () => ({status: 'unconfigured', checkedAt: null, target, actual: null, matchesTarget: null});
  }
  let cached;
  let inFlight;
  return async () => {
    if (cached && now() - cached.at < (cached.value.status === 'error' ? 60_000 : 600_000)) return cached.value;
    inFlight ||= (async () => {
      let result;
      try {
        const timestamp = now();
        const token = tokenFor({keyId, issuerId, privateKey}, timestamp);
        const id = encodeURIComponent(subscriptionId);
        const query = '?filter%5Bterritory%5D=USA&include=territory,subscriptionPricePoint&limit=200';
        const [subscriptionResponse, priceList, offerList] = await Promise.all([
          pages(`/v1/subscriptions/${id}`, token, fetcher),
          pages(`/v1/subscriptions/${id}/prices${query}`, token, fetcher),
          pages(`/v1/subscriptions/${id}/introductoryOffers?filter%5Bterritory%5D=USA&include=territory&limit=200`, token, fetcher)
        ]);
        result = interpretCleanerCatalog(subscriptionResponse.data[0], priceList, offerList, timestamp);
      } catch (error) {
        result = {status: 'error', checkedAt: new Date(now()).toISOString(), target, actual: null,
          matchesTarget: null, reason: String(error.message).slice(0, 160)};
      }
      cached = {at: now(), value: result};
      return result;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}
