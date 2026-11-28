import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

test('legacy AI endpoint returns OpenAI, counts success and preserves provider diagnostics', { timeout: 20000 }, async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), 'squad-ai-http-'));
  const deviceId = '10000000-0000-4000-8000-000000000001';
  const credential = 'anon_' + 'a'.repeat(43);
  const wallet = { id: 'paying-wallet', deviceId, coins: 300, createdAt: '2026-01-01T00:00:00Z' };
  await writeFile(join(directory, 'store.json'), JSON.stringify({
    users: { [wallet.id]: wallet },
    coinTransactions: {
      old: { id: 'old', userId: wallet.id, type: 'coin_spend', coins: -15, createdAt: '2026-01-01T00:00:00Z' },
      other: { id: 'other', userId: 'different-wallet', type: 'coin_spend', coins: -25, createdAt: '2026-01-01T00:00:00Z' }
    },
    aiRoundAccounts: { [wallet.id]: { usage: {}, rounds: {}, firstPracticeDay: '2026-01-01' } },
    partnerAnonymousAccounts: { anon_fixture: { walletUserId: wallet.id, createdAt: wallet.createdAt } },
    partnerAnonymousCredentials: { [createHash('sha256').update(credential).digest('hex')]: 'anon_fixture' }
  }));
  const preload = join(directory, 'provider.mjs');
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (url !== 'https://api.openai.com/v1/chat/completions') throw Error('Unexpected outbound request');
    const body = JSON.parse(init.body);
    if (!body.messages[0].content.includes('profile nickname is "River"')) throw Error('Missing profile nickname');
    const last = body.messages.at(-1).content;
    const text = typeof last === 'string' ? last : last[0].text;
    if (text === 'First question after opening') {
      if (last[1]?.image_url?.url !== 'data:image/jpeg;base64,/9j/2Q==') throw Error('Missing authenticated JPEG');
    } else if (typeof last !== 'string') throw Error('Unexpected image on text-only request');
    if (text === '你看我戴着眼镜吗') {
      if (!body.messages[0].content.includes('Required response language code: zh-Hans')) throw Error('Ignored Chinese transcript');
      if (!body.messages[0].content.includes('eyewear observation: glasses likely')) throw Error('Missing eyewear observation');
    } else if (text === 'First question after opening') {
      if (!body.messages[0].content.includes('selected practice scenario: Creator Q&A')) throw Error('Missing opening scenario');
      if (!body.messages[0].content.includes('"sender":"Emma","giftName":"Rose Bouquet","chineseName":"玫瑰花束","liveSecond":17')) throw Error('Missing observed gift event');
      if (body.messages[0].content.includes('Unrecorded Gift')) throw Error('Invalid gift event was read as room context');
      if (!body.messages[0].content.includes('"likely objects or scene: mug 42%"')) throw Error('Missing current camera observation');
      if (!body.messages[0].content.includes('Simulated gifts are off.')) throw Error('Missing room gift preference');
      if (!body.messages[0].content.includes('If the host corrects the observation, follow their correction')) throw Error('Missing guidance for camera corrections');
    } else {
      if (!body.messages[0].content.includes('No reliable on-device summary is available')) throw Error('Invented a visual observation');
    }
    if (!body.messages[0].content.includes('Never insult')) throw Error('Missing conversation rules');
    if (!body.messages[0].content.includes('[null,"Ava (AI)"]')) throw Error('Missing speaker metadata');
    const history = [
      { role: 'user', content: 'Ivy: I am practicing a line.' },
      { role: 'assistant', content: 'Good start.' },
      { role: 'assistant', content: 'Keep going.' }
    ];
    if (JSON.stringify(body.messages.slice(1, -1)) !== JSON.stringify(history)) throw Error('Unexpected conversation history');
    return new Response(JSON.stringify({model: 'test-openai', choices:[{message:{content:'**Ivy:** ivy： Ivy: Hello, welcome back!'}}]}));
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
      body: JSON.stringify({
        text: 'Hello everyone', frameJPEG: '/9j/2Q==', deviceId: 'local-ai-test', userName: 'River', listener: { name: 'Ivy' }, inputLanguage: 'en',
        history: [
          { role: 'user', content: 'Ivy: I am practicing a line.' },
          { role: 'assistant', content: 'Ivy: Ivy: Good start.' },
          { role: 'assistant', content: 'Ava (AI): Keep going.', speaker: 'Ava (AI)' }
        ]
      })
    });
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.source, 'openai'); assert.equal(result.answer, 'Hello, welcome back!');
    const disk = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'));
    const conversation = Object.values(disk.aiConversations)[0];
    assert.equal(conversation.aiText, 'Hello, welcome back!');
    assert.equal(conversation.source, 'openai'); assert.equal(conversation.model, 'test-openai');
    assert.equal(conversation.interactionType, 'user'); assert.ok(conversation.latencyMs >= 0);
    assert.ok(!JSON.stringify(disk).includes('fake-key-for-local-test'));
    assert.ok(!JSON.stringify(disk).includes('/9j/2Q=='));
    const metrics = Object.values(disk.dailyUsage || {});
    assert.ok(metrics.some(day => day.aiSuccesses === 1 && day.aiFallbacks === 0));
    const base = `http://127.0.0.1:${port}`;
    const pricing = await fetch(base + '/v1/ai/round-policy');
    assert.equal(pricing.status, 200);
    assert.deepEqual(await pricing.json(), { introRounds: 10, freeRounds: 5, proRounds: 30, coinPrice: 10, timeZone: 'UTC' });
    const send = async (body, token = credential) => {
      const response = await fetch(base + '/v1/ai/deepseek', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          text: 'Hello everyone', frameJPEG: 'https://example.invalid/image.jpg', interactionType: 'user', deviceId, userName: 'River', listener: { name: 'Ivy' }, inputLanguage: 'en',
          history: [
            { role: 'user', content: 'Ivy: I am practicing a line.' },
            { role: 'assistant', content: 'Good start.' },
            { role: 'assistant', content: 'Keep going.', speaker: 'Ava (AI)' }
          ], ...body
        })
      });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await send({ roundId: randomUUID() }, 'invalid')).status, 401);
    assert.equal((await send({ roundId: randomUUID(), deviceId: 'another-device' })).status, 403);
    const liveSessionId = randomUUID();
    const started = await fetch(base + '/v1/live/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ deviceId, sessionId: liveSessionId, eventId: randomUUID(), type: 'live_started',
        streamerContext: { nickname: 'River', scenarioId: 'qa' } })
    });
    assert.equal(started.status, 200);
    for (let n = 0; n < 5; n++) {
      const included = await send(n === 0
        ? { roundId: randomUUID(), liveSessionId, userName: undefined, text: 'First question after opening',
          sceneContext: 'likely objects or scene: mug 42%', interactionType: 'user', frameJPEG: '/9j/2Q==', giftsEnabled: false,
          recentGifts: [
            { sender: 'Emma', giftName: 'Rose Bouquet', chineseName: '玫瑰花束', liveSecond: 17 },
            { sender: '', giftName: 'Unrecorded Gift', liveSecond: -1 }
          ] }
        : { roundId: randomUUID() });
      assert.equal(included.status, 200);
      assert.equal(included.data.remainingRounds, 4 - n);
      assert.equal(included.data.coinBalance, 300);
    }
    const roundId = randomUUID();
    const quote = await send({ roundId });
    assert.equal(quote.data.reason, 'authorize_round');
    assert.equal(quote.data.coinPrice, 10);
    assert.equal(quote.data.answer, '');
    assert.equal((await send({ roundId, unlockRound: true })).data.coinBalance, 300);
    for (let retry = 0; retry < 2; retry++) {
      const paid = await send({ roundId, unlockRound: true, authorizedCoinPrice: 10 });
      assert.equal(paid.data.answer, 'Hello, welcome back!');
      assert.equal(paid.data.coinBalance, 290);
    }
    const paidStore = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'));
    const charges = Object.values(paidStore.coinTransactions).filter(item => item.userId === wallet.id && item.note === 'AI reply unlock');
    assert.equal(charges.length, 1);
    assert.equal(charges[0].coins, -10);
    assert.equal(charges[0].note, 'AI reply unlock');
    assert.equal(paidStore.users[wallet.id].coins, 290);
    const automatic = { roundId: randomUUID(), automaticCoinPrice: 10 };
    for (let retry = 0; retry < 2; retry++) {
      const result = await send(automatic);
      assert.equal(result.data.chargedCoins, 10);
      assert.equal(result.data.coinBalance, 280);
    }
    const mismatch = await send({ roundId: randomUUID(), text: '你看我戴着眼镜吗',
      inputLanguage: 'en', automaticCoinPrice: 10, sceneContext: 'eyewear observation: glasses likely' });
    assert.equal(mismatch.data.reason, 'language_mismatch');
    assert.match(mismatch.data.answer, /[\u3400-\u9fff]/u);
    assert.equal(mismatch.data.coinBalance, 280);
    assert.ok(!JSON.stringify(JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'))).includes('/9j/2Q=='));
    const spendingURL = base + '/v1/wallet/spending';
    assert.equal((await fetch(spendingURL)).status, 401);
    const history = await fetch(spendingURL, { headers: { authorization: `Bearer ${credential}` } });
    assert.equal(history.status, 200);
    const items = await history.json();
    assert.equal(items.balance, 280);
    assert.deepEqual(items.entries.map(({kind, coins, balanceAfter}) => [kind, coins, balanceAfter]), [
      ['ai_reply', 10, 280], ['ai_reply', 10, 290], ['other', 15, undefined]
    ]);
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit'); await rm(directory, { recursive: true, force: true });
  }
});
