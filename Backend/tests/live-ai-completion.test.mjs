import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLiveCompletion } from '../live-ai-completion.mjs';

const messages = [{ role: 'user', content: 'Hello everyone' }];
const success = text => new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: text } }] }));
const env = { OPENAI_API_KEY: 'openai-test', DEEPSEEK_API_KEY: 'deepseek-test' };

test('OpenAI success uses no DeepSeek request, bounded tokens and no storage', async () => {
  const calls = [];
  const result = await requestLiveCompletion({ env, messages, fetchImpl: async (url, init) => {
    calls.push(url); const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_completion_tokens, 160); assert.deepEqual(body.messages, messages);
    return success('Welcome!');
  } });
  assert.equal(result.source, 'openai'); assert.equal(result.content, 'Welcome!'); assert.equal(calls.length, 1);
});

test('quota, invalid credentials, rate limits and overload fall back once with truthful attribution', async () => {
  for (const status of [401, 402, 403, 429, 503]) {
    const calls = [];
    const result = await requestLiveCompletion({ env, messages, fetchImpl: async url => {
      calls.push(url); return calls.length === 1 ? new Response('unavailable', { status }) : success('Backup answer');
    } });
    assert.equal(result.source, 'deepseek'); assert.equal(calls.length, 2);
    assert.match(calls[0], /api.openai.com/); assert.match(calls[1], /api.deepseek.com/);
    assert.equal(result.attempts[0].providerStatus, status);
  }
});

test('timeout, invalid JSON and empty content all use backup', async () => {
  for (const failure of [() => { throw new DOMException('timeout', 'TimeoutError'); },
    () => new Response('{'), () => new Response('{"choices":[]}')]) {
    let count = 0;
    const result = await requestLiveCompletion({ env, messages, fetchImpl: async () => ++count === 1 ? failure() : success('Backup') });
    assert.equal(result.source, 'deepseek'); assert.equal(count, 2);
  }
});

test('missing OpenAI key can use existing DeepSeek configuration', async () => {
  let count = 0;
  const result = await requestLiveCompletion({ env: { DEEPSEEK_API_KEY: 'test' }, messages,
    fetchImpl: async url => { count++; assert.match(url, /api.deepseek.com/); return success('Hello'); } });
  assert.equal(result.source, 'deepseek'); assert.equal(count, 1);
});

test('both providers unavailable never claim an AI success or leak credentials', async () => {
  let count = 0;
  const result = await requestLiveCompletion({ env, messages, fetchImpl: async () => {
    count++; return new Response('secret provider error body', { status: 503 });
  } });
  assert.equal(result.source, 'fallback'); assert.equal(result.content, undefined); assert.equal(count, 2);
  assert.equal(JSON.stringify(result).includes('secret provider'), false);
  assert.equal(JSON.stringify(result).includes('openai-test'), false);
});

test('no configured credentials never calls the network', async () => {
  const result = await requestLiveCompletion({ env: {}, messages, fetchImpl: async () => { throw Error('must not call'); } });
  assert.equal(result.reason, 'missing_key'); assert.equal(result.source, 'fallback');
});
