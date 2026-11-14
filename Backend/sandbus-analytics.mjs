import { sign } from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const READ_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const MAX_ROWS = 10000;
const EVENTS = [
  'sb_level_start', 'sb_first_transfer', 'sb_level_complete', 'sb_level_timeout',
  'sb_restart', 'sb_shaker_offered', 'sb_shaker_used', 'sb_shaker_settled',
];

export const SANDBUS_REPORT_DAYS = [7, 30, 90];

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function serviceAssertion(credentials, now) {
  const issued = Math.floor(now / 1000);
  const claims = {
    iss: credentials.client_email,
    scope: READ_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issued,
    exp: issued + 3600,
  };
  const payload = `${encodedJson({ alg: 'RS256', typ: 'JWT' })}.${encodedJson(claims)}`;
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), credentials.private_key).toString('base64url')}`;
}

function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid Analytics count');
  return number;
}

function normalizeReports(reports) {
  if (!Array.isArray(reports) || reports.length !== 3) throw new Error('Invalid Analytics reports');
  const [audience, gameplay, shaker] = reports;
  const audienceValues = audience.rows?.[0]?.metricValues;
  const players = audienceValues
    ? { active: count(audienceValues[0]?.value), new: count(audienceValues[1]?.value) }
    : { active: 0, new: 0 };
  const rows = new Map();
  for (const entry of gameplay.rows ?? []) {
    const [platform, build, level, event] = entry.dimensionValues.map(item => item.value);
    if (!EVENTS.includes(event) || !['iOS', 'Android'].includes(platform)) continue;
    const key = JSON.stringify([platform, build, level]);
    if (!rows.has(key)) rows.set(key, { platform, build, level, events: {}, meanShakerGain: null });
    rows.get(key).events[event] = count(entry.metricValues[0]?.value);
  }
  for (const entry of shaker.rows ?? []) {
    const key = JSON.stringify(entry.dimensionValues.map(item => item.value));
    const row = rows.get(key);
    if (!row || count(entry.metricValues[1]?.value) === 0) continue;
    const gain = Number(entry.metricValues[0]?.value);
    if (!Number.isFinite(gain) || gain < 0 || gain > 100) throw new Error('Invalid Shaker gain');
    row.meanShakerGain = gain;
  }
  return {
    players,
    rows: [...rows.values()].sort((a, b) =>
      a.level.localeCompare(b.level, undefined, { numeric: true })
      || a.platform.localeCompare(b.platform)
      || a.build.localeCompare(b.build, undefined, { numeric: true })),
    limited: reports.some(report => report.metadata?.subjectToThresholding
      || report.metadata?.dataLossFromOtherRow || report.rowCount > MAX_ROWS),
    timeZone: gameplay.metadata?.timeZone || audience.metadata?.timeZone || null,
  };
}

export function createSandBusAnalytics({
  propertyId,
  credentialsJson,
  fetcher = fetch,
  now = Date.now,
}) {
  let credentials;
  try { credentials = JSON.parse(credentialsJson || 'null'); }
  catch { /* An invalid deployment setting is treated as unconfigured. */ }
  const configured = /^\d+$/.test(propertyId || '')
    && credentials?.type === 'service_account'
    && typeof credentials.client_email === 'string'
    && typeof credentials.private_key === 'string';
  let cachedToken;
  let inFlightToken;

  async function token() {
    if (cachedToken?.validUntil > now()) return cachedToken.value;
    if (!inFlightToken) {
      inFlightToken = (async () => {
        const response = await fetcher(GOOGLE_TOKEN_URL, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: serviceAssertion(credentials, now()),
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Analytics authentication failed');
        const { access_token: value, expires_in: ttl } = await response.json();
        if (typeof value !== 'string' || !value || !Number.isFinite(ttl) || ttl <= 60) {
          throw new Error('Invalid Analytics access token');
        }
        cachedToken = { value, validUntil: now() + (ttl - 60) * 1000 };
        return value;
      })().finally(() => { inFlightToken = undefined; });
    }
    return inFlightToken;
  }

  async function query(method, body) {
    const bearer = await token();
    const response = await fetcher(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) cachedToken = undefined;
      throw new Error('Analytics report unavailable');
    }
    return response.json();
  }

  async function report(days) {
    if (!SANDBUS_REPORT_DAYS.includes(days)) throw new RangeError('Invalid date range');
    if (!configured) return { status: 'not_configured', days };
    const dateRanges = [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }];
    const groups = ['platform', 'appVersion', 'customEvent:sb_level'].map(name => ({ name }));
    const { reports } = await query('batchRunReports', { requests: [
        { dateRanges, metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }] },
        {
          dateRanges,
          dimensions: [...groups, { name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } },
          },
          limit: String(MAX_ROWS),
        },
        {
          dateRanges,
          dimensions: groups,
          metrics: [
            { name: 'averageCustomEvent:sb_gain_pct' },
            { name: 'countCustomEvent:sb_gain_pct' },
          ],
          dimensionFilter: {
            filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'sb_shaker_settled' } },
          },
          limit: String(MAX_ROWS),
        },
    ] });
    return { status: 'ready', days, ...normalizeReports(reports) };
  }

  report.realtime = async function realtime() {
    const minutes = 30;
    if (!configured) return { status: 'not_configured', minutes };
    const data = await query('runRealtimeReport', {
      dimensions: [{ name: 'platform' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } },
      },
    });
    const rows = [];
    for (const entry of data.rows ?? []) {
      const [platform, event] = entry.dimensionValues.map(item => item.value);
      if (!['iOS', 'Android'].includes(platform) || !EVENTS.includes(event)) continue;
      rows.push({ platform, event, count: count(entry.metricValues[0]?.value) });
    }
    return { status: 'ready', minutes, rows };
  };

  return report;
}
