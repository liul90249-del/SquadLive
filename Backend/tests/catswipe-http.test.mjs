import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

test('CatSwipe normal HTTP entry points persist users, IP and idempotent events without partner credentials', async () => {
 const socket = createServer();
 socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
 const port = socket.address().port; socket.close(); await once(socket, 'close');
 const directory = await mkdtemp(join(tmpdir(), 'catswipe-http-'));
 const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), DATA_DIR: directory, ADMIN_TOKEN: 'catswipe-local-test',
   RENDER: 'false', PARTNER_EVENT_KEYS: '{}', IP_GEOLOCATION_ENABLED: 'false', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
 });
 let logs = ''; server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
 const request = (path, body, token) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: body ? 'POST' : 'GET', headers: {
   'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}),
 });
 try {
  for (let i = 0; i < 100 && !logs.includes('backend listening'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(logs, /backend listening/);
  const body = { deviceId: '12345678-1234-4234-8234-123456789abc', credential: 'anon_' + 'z'.repeat(43),
   createInstallation: true, clientInfo: { appVersion: '1.0.11', deviceModel: 'iPhone', environment: 'simulator' } };
  const first = await request('/v1/partners/catswipe/session', body);
  assert.equal(first.status, 200);
  const identity = await first.json();
  const replay = await request('/v1/partners/catswipe/session', body);
  assert.equal((await replay.json()).user_id, identity.user_id);
  const events = [{ id: '12345678-1234-4234-8234-123456789abd', name: 'game_start', occurredAt: Date.now(), parameters: { mode: 'mouse' } }];
  for (let i = 0; i < 2; i++) {
   const response = await request('/v1/partners/catswipe/events', { events }, identity.token);
   assert.equal(response.status, 200);
  }
  assert.equal((await request('/v1/admin/products/catswipe/operations')).status, 401);
  const response = await request('/v1/admin/products/catswipe/operations?days=90&gameplayDays=7', null, 'catswipe-local-test');
  assert.equal(response.status, 200);
  const operations = await response.json();
  assert.equal(operations.users.length, 1);
  assert.equal(operations.users[0].clientInfo.appVersion, '1.0.11');
  assert.equal(operations.users[0].lastIPAddress, '127.0.0.1');
  assert.equal(operations.gameplay.counts.game_start, 1);
  assert.equal(operations.users[0].gameplayCounts.game_start, 1);
  assert.equal(operations.gameplay.recent[0].userId, identity.user_id);
  assert.ok(!JSON.stringify(operations).includes(identity.token));
  const asset = await request('/catswipe-admin.mjs'); assert.equal(asset.status, 200);
 } finally {
  server.kill('SIGTERM'); await once(server, 'exit'); await rm(directory, { recursive: true, force: true });
 }
});
