import { createHash } from "node:crypto";

const dayMs = 86_400_000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
export const liveAIRoundPolicy = Object.freeze({
  introRounds: 10, freeRounds: 5, proRounds: 30, coinPrice: 10, timeZone: "UTC"
});

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createLiveAIRounds({ complete, spend, save, isPremium, now = Date.now }) {
  const inFlight = new Map();

  function remaining(account, user, day, store) {
    const allowance = isPremium(store, user) ? liveAIRoundPolicy.proRounds
      : !account.firstPracticeDay || account.firstPracticeDay === day
        ? liveAIRoundPolicy.introRounds : liveAIRoundPolicy.freeRounds;
    return Math.max(0, allowance - Number(account.usage[day] || 0));
  }

  async function resolve(store, user, body, id) {
    const time = now();
    const day = dayKey(time);
    const earliestDay = dayKey(time - 7 * dayMs);
    const accounts = store.aiRoundAccounts ||= {};
    if (!accounts[user.id]) {
      const previousPractice = Object.values(store.aiConversations || {}).find(item =>
        item.userId === user.id && item.interactionType !== "system_opening"
        && ["openai", "deepseek"].includes(item.source) && item.createdAt);
      accounts[user.id] = { usage: {}, rounds: {}, firstPracticeDay: previousPractice?.createdAt.slice(0, 10) ?? null };
    }
    const account = accounts[user.id];
    const signature = createHash("sha256").update(JSON.stringify([body.text, body.listener?.name])).digest("hex");
    const operationId = `squadlive-ai:${user.id}:${id}`;
    for (const [key, entry] of Object.entries(account.rounds)) {
      if (entry.day < earliestDay) delete account.rounds[key];
    }
    for (const key of Object.keys(account.usage)) if (key < earliestDay) delete account.usage[key];
    const previous = account.rounds[id];
    if (previous && previous.signature !== signature) throw failure(409, "Reply identifier belongs to another message");

    function response(result) {
      return { ...result, coinBalance: user.coins, remainingRounds: remaining(account, user, day, store) };
    }
    function locked(reason) {
      return response({ answer: "", source: "locked", reason, coinPrice: liveAIRoundPolicy.coinPrice, lockedReplyReady: false });
    }
    if (previous?.result) {
      // Persist before replying again in case a prior save failed after mutating the wallet.
      await save(store);
      return response(previous.result);
    }
    if (store.walletOperations?.[operationId]) throw failure(409, "This reply was previously unlocked");

    if (!previous && body.unlockRound === true) throw failure(409, "Open the reply quote again before unlocking");
    let hasAllowance = remaining(account, user, day, store) > 0;
    const autoPayApproved = body.automaticCoinPrice === liveAIRoundPolicy.coinPrice;
    const payApproved = autoPayApproved || (previous?.quoted === true && body.unlockRound === true
      && body.authorizedCoinPrice === liveAIRoundPolicy.coinPrice);
    if (!hasAllowance && !payApproved) {
      if (!previous) {
        // Quotes never invoke the AI provider. Bound their storage independently of delivered replies.
        const openQuotes = Object.keys(account.rounds).filter((key) => account.rounds[key].quoted && !account.rounds[key].result);
        for (const key of openQuotes.slice(0, Math.max(0, openQuotes.length - 63))) delete account.rounds[key];
        account.rounds[id] = { signature, day, quoted: true };
        await save(store);
      }
      return locked("authorize_round");
    }
    if (!hasAllowance && user.coins < liveAIRoundPolicy.coinPrice) return locked("insufficient_round_coins");

    const result = await complete(store, user, body);
    if (!["openai", "deepseek"].includes(result.source) || !result.answer?.trim()) {
      await save(store);
      return response(result);
    }
    // Membership and the wallet can change while waiting for the provider.
    hasAllowance = remaining(account, user, day, store) > 0;
    let chargedCoins = 0;
    if (hasAllowance) {
      account.usage[day] = Number(account.usage[day] || 0) + 1;
    } else if (payApproved && user.coins >= liveAIRoundPolicy.coinPrice) {
      spend(store, user, liveAIRoundPolicy.coinPrice, operationId, "AI reply unlock");
      chargedCoins = liveAIRoundPolicy.coinPrice;
    } else {
      account.rounds[id] = { signature, day, quoted: true };
      await save(store);
      return locked(payApproved ? "insufficient_round_coins" : "authorize_round");
    }
    account.firstPracticeDay ||= day;
    account.rounds[id] = { signature, day, result: { answer: result.answer, source: result.source, model: result.model, chargedCoins } };
    await save(store);
    return response(account.rounds[id].result);
  }

  return function reply(store, user, body) {
    const id = typeof body.roundId === "string" ? body.roundId.toLowerCase() : "";
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
        || typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000) {
      throw failure(400, "Invalid AI reply request");
    }
    if (inFlight.has(user.id)) throw failure(503, "An AI reply is already being processed");
    const request = resolve(store, user, body, id);
    inFlight.set(user.id, request);
    return request.finally(() => inFlight.delete(user.id));
  };
}
