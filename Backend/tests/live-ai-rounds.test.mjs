import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveAIRounds, liveAIRoundPolicy } from "../live-ai-rounds.mjs";

const date = Date.parse("2026-11-26T12:00:00Z");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (n, patch) => ({ roundId: id(n), text: `Question ${n}`, listener: { name: "Sophia" }, ...patch });
const generated = { answer: "Provider reply", source: "openai", model: "test" };

function fixture({ firstDay = false, pro = false, coins = 30 } = {}) {
  const user = { id: "user-test", coins, pro, createdAt: "2026-11-01T10:00:00Z" };
  const store = { walletOperations: {}, aiRoundAccounts: firstDay ? {} : {
    [user.id]: { usage: {}, rounds: {}, firstPracticeDay: "2026-11-01" }
  } };
  let time = date, attempts = 0;
  let provider = async () => generated;
  const reply = createLiveAIRounds({
    complete: async () => { attempts++; return provider(); },
    spend: (state, account, amount, operationId) => {
      assert.equal(state.walletOperations[operationId], undefined);
      state.walletOperations[operationId] = { amount };
      account.coins -= amount;
    },
    save: async () => {},
    isPremium: (_, account) => account.pro,
    now: () => time
  });
  return {
    call: (n, patch) => reply(store, user, request(n, patch)),
    user, store, attempts: () => attempts,
    nextDay: () => { time += 86_400_000; },
    provider: fn => { provider = fn; }
  };
}

test("intro, returning and PRO allowances match policy and reset at UTC midnight", async () => {
  for (const [options, allowance] of [
    [{ firstDay: true }, 10], [{}, 5], [{ firstDay: true, pro: true }, 30]
  ]) {
    const x = fixture(options);
    for (let n = 1; n <= allowance; n++) {
      const result = await x.call(n);
      assert.equal(result.remainingRounds, allowance - n);
      assert.equal(result.coinBalance, 30);
    }
    const locked = await x.call(100);
    assert.equal(locked.reason, "authorize_round");
    assert.equal(locked.coinPrice, liveAIRoundPolicy.coinPrice);
    assert.equal(locked.answer, "");
    assert.equal(x.attempts(), allowance);
    x.nextDay();
    assert.equal((await x.call(101)).remainingRounds, options.pro ? 29 : 4);
  }
});

test("unlock requires the quoted price, charges exactly once, and refuses a reused message ID", async () => {
  const x = fixture();
  for (let n = 1; n <= 5; n++) await x.call(n);
  await assert.rejects(x.call(6, { unlockRound: true, authorizedCoinPrice: 10 }), { status: 409 });
  await x.call(6);
  const wrong = await x.call(6, { unlockRound: true, authorizedCoinPrice: 3 });
  assert.equal(wrong.reason, "authorize_round");
  assert.equal(x.user.coins, 30);
  const approved = { unlockRound: true, authorizedCoinPrice: 10 };
  for (let i = 0; i < 2; i++) {
    const unlocked = await x.call(6, approved);
    assert.equal(unlocked.answer, generated.answer);
    assert.equal(unlocked.coinBalance, 20);
  }
  await assert.rejects(x.call(6, { ...approved, text: "Different prompt" }), { status: 409 });
  assert.equal(x.attempts(), 6);
  assert.equal(Object.keys(x.store.walletOperations).length, 1);
});

test("unavailable AI and insufficient coins are free; the same quote can unlock with verified PRO", async () => {
  const x = fixture({ coins: 0 });
  x.provider(async () => ({ source: "fallback", answer: "Free practice" }));
  assert.equal((await x.call(1)).remainingRounds, 5);
  x.provider(async () => generated);
  for (let n = 1; n <= 5; n++) await x.call(n);
  await x.call(6);
  const approved = { unlockRound: true, authorizedCoinPrice: 10 };
  assert.equal((await x.call(6, approved)).reason, "insufficient_round_coins");
  x.user.coins = 10;
  x.provider(async () => ({ source: "fallback", answer: "Free practice" }));
  assert.equal((await x.call(6, approved)).source, "fallback");
  assert.equal(x.user.coins, 10);
  x.provider(async () => generated);
  x.user.pro = true;
  const unlocked = await x.call(6, { unlockRound: true });
  assert.equal(unlocked.remainingRounds, 24);
  assert.equal(unlocked.coinBalance, 10);
  assert.deepEqual(x.store.walletOperations, {});
});

test("concurrent requests cannot double-use an allowance", async () => {
  const x = fixture();
  let finish;
  x.provider(() => new Promise(resolve => { finish = resolve; }));
  const pending = x.call(1);
  assert.throws(() => x.call(2), { status: 503 });
  finish(generated);
  assert.equal((await pending).remainingRounds, 4);
  assert.equal(x.attempts(), 1);
});
