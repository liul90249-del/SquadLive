import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandBusPlayers, sandBusPlayersReport } from '../sandbus-players.mjs';
const now = Date.parse('2026-11-22T08:00:00Z');
const credential = 'sb_' + 'a'.repeat(64);
const event = (id, name = 'sb_level_start') => ({ id: id.repeat(32), name, at: now, level: 3 });
const payload = events => ({ credential, consent: true, platform: 'iOS', version: '1.0.84', events });

test('consented installations retain private identity, dedupe retries and concurrent batches, and isolate users', async () => {
  const root = {};
  const collector = createSandBusPlayers({ getStore: async () => root, saveStore: async () => {},
    now: () => now, onSession: (_, account) => { account.lastIPAddress = '8.8.8.8'; account.networkCountry = 'United States'; } });
  const [first, second] = await Promise.all([collector.collect(payload([event('a')])), collector.collect(payload([event('a'), event('b', 'sb_level_complete')]))]);
  assert.equal(first.user_id, second.user_id);
  await collector.collect({ ...payload([event('c')]), credential: 'sb_' + 'b'.repeat(64), platform: 'Android' });
  const report = sandBusPlayersReport(root, { now });
  assert.equal(report.total, 2);
  assert.equal(report.events.find(e => e.name === 'sb_level_start').count, 2);
  assert.equal(report.countries[0].count, 2);
  assert.equal(report.users[0].sharedIPUsers, 2);
  assert.equal(sandBusPlayersReport(root, { now, search: '8.8.8.8' }).matched, 2);
  assert.equal(sandBusPlayersReport(root, { now, user: first.user_id }).detail.events.length, 2);
  assert.ok(!JSON.stringify(root).includes(credential));
  assert.ok(!JSON.stringify(report).includes('credentials'));
});

test('invalid events, missing consent, and write failure never add users or events', async () => {
  const root = {};
  const collector = createSandBusPlayers({ getStore: async () => root, saveStore: async () => { throw Error('disk failed'); }, now: () => now });
  await assert.rejects(collector.collect({ ...payload([event('a')]), consent: false }), /consent/);
  await assert.rejects(collector.collect(payload([{ ...event('a'), level: 31 }])), /level/);
  await assert.rejects(collector.collect(payload([{ ...event('a'), at: now - 8 * 86400000 }])), /time/);
  await assert.rejects(collector.collect(payload([event('a')])), /disk failed/);
  assert.equal(root.sandBusPlayers, undefined);
  assert.throws(() => sandBusPlayersReport(root, { days: 1 }), /range/);
});

test('report and details use chosen time range without inventing old users from aggregate metrics', async () => {
  const root = { sandBusPlayers: { accounts: { one: {
    id: 'one', createdAt: new Date(now - 30 * 86400000).toISOString(), lastSeenAt: new Date(now).toISOString(),
    platform: 'iOS', version: '1.0.84', events: [{ ...event('a'), at: now - 8 * 86400000 }, event('b')],
  } } } };
  assert.equal(sandBusPlayersReport(root, { days: 7, now }).users[0].eventCount, 1);
  assert.equal(sandBusPlayersReport(root, { days: 30, now }).users[0].eventCount, 2);
  assert.throws(() => sandBusPlayersReport(root, { user: 'missing', now }), /not found/);
});
