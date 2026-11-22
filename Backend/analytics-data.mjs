import { sign } from 'node:crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const READ_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

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

export function createAnalyticsDataClient({
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

  return { configured, query };
}
