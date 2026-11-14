import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createSandBusAnalytics } from '../sandbus-analytics.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentialsJson = JSON.stringify({
  type: 'service_account',
  client_email: 'read-only@example.invalid',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

test('unconfigured deployment and invalid range never contact Google', async () => {
  const report = createSandBusAnalytics({ fetcher: () => assert.fail('unexpected request') });
  assert.deepEqual(await report(7), { status: 'not_configured', days: 7 });
  assert.deepEqual(await report.realtime(), { status: 'not_configured', minutes: 30 });
  await assert.rejects(report(8), RangeError);
});

test('requests a read-only token and reports real event counts and average gain by level, build and platform', async () => {
  let tokenRequests = 0;
  let reportRequests = 0;
  const row = (platform, build, level, name, count, average = 0, samples = 0) => ({
    dimensionValues: [platform, build, level, name].map(value => ({ value })),
    metricValues: [count, average, samples].map(value => ({ value: String(value) })),
  });
  const report = createSandBusAnalytics({
    propertyId: '563966794', credentialsJson,
    async fetcher(url, options) {
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenRequests++;
        const payload = options.body.get('assertion').split('.')[1];
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        assert.equal(claims.scope, 'https://www.googleapis.com/auth/analytics.readonly');
        return Response.json({ access_token: 'test-token', expires_in: 3600 });
      }
      reportRequests++;
      assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/563966794:batchRunReports');
      assert.equal(options.headers.authorization, 'Bearer test-token');
      const { requests } = JSON.parse(options.body);
      assert.deepEqual(requests[0].dateRanges, [{ startDate: '6daysAgo', endDate: 'today' }]);
      assert.ok(requests[1].dimensions.some(({ name }) => name === 'customEvent:sb_level'));
      return Response.json({ reports: [
        { rows: [{ metricValues: [{ value: '4' }, { value: '2' }] }] },
        {
          metadata: { timeZone: 'Asia/Shanghai' },
          rows: [
            row('iOS', '1.0', '30', 'sb_shaker_used', 3),
            row('iOS', '1.0', '30', 'sb_shaker_settled', 2, 13.5, 2),
            row('iOS', '1.0', '30', 'sb_level_timeout', 1),
            row('Android', '1.0', '3', 'sb_level_complete', 2),
            row('Web', '1.0', '3', 'sb_level_complete', 1),
          ],
        },
      ] });
    },
  });
  const results = await Promise.all([report(7), report(7)]);
  assert.equal(tokenRequests, 1);
  assert.equal(reportRequests, 2);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0].players, { active: 4, new: 2 });
  assert.deepEqual(results[0].rows.map(({ level }) => level), ['3', '30']);
  assert.equal(results[0].rows[0].meanShakerGain, null);
  assert.equal(results[0].rows[1].meanShakerGain, 13.5);
  assert.equal(results[0].rows[1].events.sb_level_timeout, 1);
});

test('Google errors are errors and do not become an empty report', async () => {
  const report = createSandBusAnalytics({
    propertyId: '563966794', credentialsJson,
    fetcher: async () => new Response('', { status: 403 }),
  });
  await assert.rejects(report(7), /authentication failed/);
});

test('realtime reports request recent gameplay events and keep both mobile platforms', async () => {
  const row = (platform, event, count) => ({
    dimensionValues: [{ value: platform }, { value: event }],
    metricValues: [{ value: String(count) }],
  });
  const report = createSandBusAnalytics({
    propertyId: '563966794', credentialsJson,
    async fetcher(url, options) {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'test-token', expires_in: 3600 });
      }
      assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/563966794:runRealtimeReport');
      assert.equal(options.headers.authorization, 'Bearer test-token');
      const request = JSON.parse(options.body);
      assert.deepEqual(request.dimensions, [{ name: 'platform' }, { name: 'eventName' }]);
      assert.deepEqual(request.metrics, [{ name: 'eventCount' }]);
      assert.ok(request.dimensionFilter.filter.inListFilter.values.includes('sb_first_transfer'));
      return Response.json({ rows: [
        row('iOS', 'sb_first_transfer', 2),
        row('Android', 'sb_first_transfer', 3),
        row('Web', 'sb_first_transfer', 6),
        row('Android', 'session_start', 7),
      ] });
    },
  });
  assert.deepEqual(await report.realtime(), {
    status: 'ready', minutes: 30, rows: [
      { platform: 'iOS', event: 'sb_first_transfer', count: 2 },
      { platform: 'Android', event: 'sb_first_transfer', count: 3 },
    ],
  });
});
