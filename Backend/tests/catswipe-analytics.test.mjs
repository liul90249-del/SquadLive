import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createCatSwipeAnalytics } from '../catswipe-analytics.mjs';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentialsJson = JSON.stringify({ type: 'service_account', client_email: 'reader@example.com',
 private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const row = (dimensions, metrics) => ({ dimensionValues: dimensions.map(value => ({ value })),
 metricValues: metrics.map(value => ({ value: String(value) })) });

test('CatSwipe reports all events, unique trigger users, regions and versions through five bounded reports', async () => {
 const report = createCatSwipeAnalytics({ propertyId: '12345', credentialsJson,
  fetcher: async (url, options) => {
   if (url.includes('oauth2')) return Response.json({ access_token: 'test', expires_in: 3600 });
   const { requests } = JSON.parse(options.body);
   assert.equal(requests.length, 5);
   assert.equal(requests[2].dimensionFilter, undefined);
   assert.deepEqual(requests[2].metrics, [{ name: 'eventCount' }, { name: 'totalUsers' }]);
   assert.equal(requests[3].limit, '500');
   return Response.json({ reports: [
    { rows: [row([], [28, 10, 40])] },
    { metadata: { timeZone: 'Etc/GMT-8' }, rows: [row(['20261122'], [5, 3, 6])] },
    { rows: [row(['sound_play'], [20, 4]), row(['settings_open'], [6, 3])] },
    { rows: [row(['China', 'Shanghai'], [8, 2])] },
    { rows: [row(['iOS', '1.0.10', 'mobile'], [28, 40])] },
   ] });
  },
 });
 const data = await report(7);
 assert.equal(data.audience.activeUsers, 28);
 assert.equal(data.audience.sessions, 40);
 assert.equal(data.daily[0].date, '2026-11-22');
 assert.equal(data.eventRows[0].totalUsers, 4);
 assert.equal(data.events.settings_open, 6);
 assert.equal(data.regions[0].city, 'Shanghai');
 assert.equal(data.versions[0].version, '1.0.10');
});

test('unconfigured and failed CatSwipe reads cannot appear as zero-valued successful reports', async () => {
 const unavailable = createCatSwipeAnalytics({});
 assert.equal((await unavailable(7)).status, 'not_configured');
 await assert.rejects(() => unavailable(2), RangeError);
 const report = createCatSwipeAnalytics({ propertyId: '12345', credentialsJson,
  fetcher: async () => new Response('denied', { status: 403 }) });
 await assert.rejects(() => report(7));
});
