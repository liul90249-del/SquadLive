import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

test('legacy AI endpoint returns OpenAI, counts success and preserves provider diagnostics', { timeout: 20000 }, async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), 'squad-ai-http-'));
  const preload = join(directory, 'provider.mjs');
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (url !== 'https://api.openai.com/v1/chat/completions') throw Error('Unexpected outbound request');
    const body = JSON.parse(init.body);
    if (!body.messages[0].content.includes('Never insult')) throw Error('Missing conversation rules');
    return new Response(JSON.stringify({model: 'test-openai', choices:[{message:{content:'Hello, welcome back!'}}]}));
  };`);
  const child = spawn(process.execPath, ['--import', preload, 'server.js'], {
    cwd: new URL('../', import.meta.url), env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: directory,
      IP_GEOLOCATION_ENABLED: 'false', OPENAI_API_KEY: 'fake-key-for-local-test' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
  try {
    for (let i = 0; i < 100 && !logs.includes('backend listening'); i++) await new Promise(r => setTimeout(r, 50));
    assert.match(logs, /backend listening/);
    const response = await fetch(`http://127.0.0.1:${port}/v1/ai/deepseek`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello everyone', deviceId: 'local-ai-test', listener: { name: 'Ivy' }, inputLanguage: 'en' })
    });
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.source, 'openai'); assert.equal(result.answer, 'Hello, welcome back!');
    const disk = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'));
    const conversation = Object.values(disk.aiConversations)[0];
    assert.equal(conversation.source, 'openai'); assert.equal(conversation.model, 'test-openai');
    assert.equal(conversation.interactionType, 'user'); assert.ok(conversation.latencyMs >= 0);
    assert.ok(!JSON.stringify(disk).includes('fake-key-for-local-test'));
    const metrics = Object.values(disk.dailyUsage || {});
    assert.ok(metrics.some(day => day.aiSuccesses === 1 && day.aiFallbacks === 0));
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit'); await rm(directory, { recursive: true, force: true });
  }
});
