import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
const storePath = join(dataDir, "store.json");
const adminPagePath = join(__dirname, "admin.html");
const privacyPagePath = join(__dirname, "privacy.html");
const termsPagePath = join(__dirname, "terms.html");

const viewerPacks = [
  { label: "5,000", viewers: 5000, cost: 15 },
  { label: "20,000", viewers: 20000, cost: 50 },
  { label: "45,000", viewers: 45000, cost: 100 },
  { label: "75,000", viewers: 75000, cost: 150 },
  { label: "150,000", viewers: 150000, cost: 250 },
  { label: "400,000", viewers: 400000, cost: 500 }
];

const coinPacks = [
  { id: "coins_1000", coins: 1000, priceCents: 199 },
  { id: "coins_5000", coins: 5000, priceCents: 699 },
  { id: "coins_12000", coins: 12000, priceCents: 1499 },
  { id: "coins_35000", coins: 35000, priceCents: 2999 }
];

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(data);
}

async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

async function loadStore() {
  const store = existsSync(storePath)
    ? JSON.parse(await readFile(storePath, "utf8"))
    : {};
  store.users ||= {};
  store.rewardSubmissions ||= {};
  store.coinTransactions ||= {};
  store.vipSubscriptions ||= {};
  return store;
}

async function saveStore(store) {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2));
}

function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function getOrCreateUser(store, deviceId = "anonymous") {
  const existing = Object.values(store.users).find((user) => user.deviceId === deviceId);
  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    return existing;
  }

  const user = {
    id: newId("user"),
    deviceId,
    coins: 100,
    isPremium: false,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    shareRewardDays: {}
  };
  store.users[user.id] = user;
  recordCoinTransaction(store, {
    userId: user.id,
    type: "signup_bonus",
    coins: 100,
    amountCents: 0,
    source: "system",
    note: "Initial coins"
  });
  return user;
}

function requireAdmin(req, res) {
  const configuredToken = process.env.ADMIN_TOKEN || "change-this-admin-token";
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (token !== configuredToken) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function recordCoinTransaction(store, input) {
  const transaction = {
    id: newId("coin"),
    userId: input.userId,
    type: input.type,
    coins: Number(input.coins || 0),
    amountCents: Number(input.amountCents || 0),
    source: input.source || "unknown",
    note: input.note || "",
    createdAt: new Date().toISOString()
  };
  store.coinTransactions[transaction.id] = transaction;
  return transaction;
}

function recordVipSubscription(store, input) {
  const subscription = {
    id: newId("vip"),
    userId: input.userId,
    planId: input.planId || "unknown",
    status: input.status || "active",
    amountCents: Number(input.amountCents || 0),
    platformTransactionId: input.platformTransactionId || "",
    startedAt: new Date().toISOString(),
    expiresAt: input.expiresAt || null
  };
  store.vipSubscriptions[subscription.id] = subscription;
  return subscription;
}

function userPublic(user) {
  return {
    id: user.id,
    deviceId: user.deviceId,
    coins: user.coins,
    isPremium: Boolean(user.isPremium),
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt || user.createdAt
  };
}

function isToday(iso) {
  return Boolean(iso && iso.slice(0, 10) === todayKey());
}

function isActiveRecently(iso) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() <= 5 * 60 * 1000;
}

function adminOverview(store) {
  const users = Object.values(store.users);
  const coinTransactions = Object.values(store.coinTransactions);
  const vipSubscriptions = Object.values(store.vipSubscriptions);
  return {
    totalUsers: users.length,
    activeUsers5m: users.filter((user) => isActiveRecently(user.lastSeenAt)).length,
    newUsersToday: users.filter((user) => isToday(user.createdAt)).length,
    premiumUsers: users.filter((user) => user.isPremium).length,
    rechargeCount: coinTransactions.filter((item) => item.type === "coin_purchase").length,
    rechargeAmountCents: coinTransactions
      .filter((item) => item.type === "coin_purchase")
      .reduce((sum, item) => sum + item.amountCents, 0),
    vipSubscriptionCount: vipSubscriptions.length,
    activeVipSubscriptionCount: vipSubscriptions.filter((item) => item.status === "active").length,
    pendingRewardSubmissions: Object.values(store.rewardSubmissions).filter((item) => item.status === "pending").length
  };
}

function userDetail(store, userId) {
  const user = store.users[userId];
  if (!user) return null;
  return {
    user: userPublic(user),
    coinTransactions: Object.values(store.coinTransactions)
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    vipSubscriptions: Object.values(store.vipSubscriptions)
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    rewardSubmissions: Object.values(store.rewardSubmissions)
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  };
}

function viewerCost(viewers) {
  const freeViewers = 500;
  if (viewers <= freeViewers) return 0;
  const anchors = [{ viewers: freeViewers, cost: 0 }, ...viewerPacks];
  for (let index = 1; index < anchors.length; index += 1) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    if (viewers <= upper.viewers) {
      const progress = (viewers - lower.viewers) / (upper.viewers - lower.viewers);
      return Math.ceil(lower.cost + (upper.cost - lower.cost) * progress);
    }
  }
  const highest = anchors[anchors.length - 1];
  return Math.ceil(highest.cost + ((viewers - highest.viewers) * highest.cost) / highest.viewers);
}

function localAIReply(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("voice") || lower.includes("sound") || lower.includes("好听")) {
    return "Your voice sounds really pleasant and easy to listen to. It makes the room feel warmer.";
  }
  if (lower.includes("look") || lower.includes("pretty") || lower.includes("beautiful") || lower.includes("好看")) {
    return "You look really good on camera. Your expression and energy make the room feel alive.";
  }
  if (lower.includes("stress") || lower.includes("worried") || lower.includes("anxious")) {
    return "I can hear the pressure in that. Take one breath and start with the part you can control right now.";
  }
  return "I am listening closely. Your voice feels calm and natural, and you look good on camera right now.";
}

function deepSeekSystemPrompt(body) {
  const directions = Array.isArray(body.activeDirections) ? body.activeDirections : [];
  const tones = Array.isArray(body.toneTopics) ? body.toneTopics.join(", ") : "General";
  const vibes = Array.isArray(body.vibeMoods) ? body.vibeMoods.join(", ") : "Warm";
  const listenerName = body.listener?.name || "Sarah";
  return `
You are ${listenerName}, a virtual friend in SquadLive.
Reply directly to the streamer based on what they just said.
Tone topics: ${tones}.
Vibe: ${vibes}.
Active directions: ${directions.join(", ") || "general, compliment"}.
Naturally include a short compliment when appropriate: their voice sounds pleasant, they look good, their smile is nice, their camera presence is warm, or their energy is attractive.
Do not sound scripted. Do not repeat the same compliment style. Keep the response to 1-2 short sentences unless depth is high.
`.trim();
}

async function callDeepSeek(body) {
  const fallback = (reason, providerStatus = null) => ({
    answer: localAIReply(body.text),
    source: "fallback",
    reason,
    providerStatus
  });

  if (!process.env.DEEPSEEK_API_KEY) return fallback("missing_key");

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.DEEPSEEK_API_KEY.trim()}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: deepSeekSystemPrompt(body) },
          { role: "user", content: String(body.text || "") }
        ],
        temperature: 0.74,
        max_tokens: body.replyDepth > 0.72 ? 180 : 120
      })
    });

    if (!response.ok) {
      const providerMessage = (await response.text()).slice(0, 500);
      console.error("DeepSeek request failed", { status: response.status, message: providerMessage });
      return fallback("provider_error", response.status);
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      console.error("DeepSeek returned an empty response");
      return fallback("empty_response", response.status);
    }

    return { answer, source: "deepseek", reason: null, providerStatus: response.status };
  } catch (error) {
    console.error("DeepSeek network error", error);
    return fallback("network_error");
  }
}

async function route(req, res) {
  if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const store = await loadStore();

  if (req.method === "GET" && url.pathname === "/health") {
    return jsonResponse(res, 200, { ok: true, service: "squadlive-backend" });
  }

  if (req.method === "GET" && url.pathname === "/admin") {
    const html = await readFile(adminPagePath, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "GET" && url.pathname === "/privacy") {
    const html = await readFile(privacyPagePath, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "GET" && url.pathname === "/terms") {
    const html = await readFile(termsPagePath, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "POST" && url.pathname === "/v1/users/bootstrap") {
    const body = await readJSON(req);
    const user = getOrCreateUser(store, body.deviceId || "anonymous");
    await saveStore(store);
    return jsonResponse(res, 200, { user });
  }

  const userMatch = url.pathname.match(/^\/v1\/users\/([^/]+)$/);
  if (req.method === "GET" && userMatch) {
    const user = store.users[userMatch[1]];
    return user ? jsonResponse(res, 200, { user }) : jsonResponse(res, 404, { error: "User not found" });
  }

  if (req.method === "POST" && url.pathname === "/v1/ai/deepseek") {
    const body = await readJSON(req);
    if (body.userId && store.users[body.userId]) {
      store.users[body.userId].lastSeenAt = new Date().toISOString();
      await saveStore(store);
    }
    const result = await callDeepSeek(body);
    return jsonResponse(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/v1/activity/ping") {
    const body = await readJSON(req);
    const user = store.users[body.userId];
    if (!user) return jsonResponse(res, 404, { error: "User not found" });
    user.lastSeenAt = new Date().toISOString();
    await saveStore(store);
    return jsonResponse(res, 200, { user: userPublic(user) });
  }

  if (req.method === "POST" && url.pathname === "/v1/audience/quote") {
    const body = await readJSON(req);
    const viewers = Math.max(0, Number(body.viewers || 0));
    return jsonResponse(res, 200, { viewers, cost: viewerCost(viewers) });
  }

  if (req.method === "POST" && url.pathname === "/v1/audience/commit") {
    const body = await readJSON(req);
    const user = store.users[body.userId];
    if (!user) return jsonResponse(res, 404, { error: "User not found" });
    const viewers = Math.max(0, Number(body.viewers || 0));
    const cost = viewerCost(viewers);
    if (user.coins < cost) return jsonResponse(res, 402, { error: "Not enough coins", cost, coins: user.coins });
    user.coins -= cost;
    user.lastSeenAt = new Date().toISOString();
    recordCoinTransaction(store, {
      userId: user.id,
      type: "audience_purchase",
      coins: -cost,
      amountCents: 0,
      source: "coins",
      note: `${viewers} viewers`
    });
    await saveStore(store);
    return jsonResponse(res, 200, { user, viewers, cost });
  }

  if (req.method === "POST" && url.pathname === "/v1/coins/purchase") {
    const body = await readJSON(req);
    const user = store.users[body.userId];
    if (!user) return jsonResponse(res, 404, { error: "User not found" });
    const pack = coinPacks.find((item) => item.id === body.packId);
    if (!pack) return jsonResponse(res, 400, { error: "Invalid coin pack" });
    user.coins += pack.coins;
    user.lastSeenAt = new Date().toISOString();
    recordCoinTransaction(store, {
      userId: user.id,
      type: "coin_purchase",
      coins: pack.coins,
      amountCents: pack.priceCents,
      source: "iap_mock",
      note: pack.id
    });
    await saveStore(store);
    return jsonResponse(res, 200, { user, pack, note: "Mock purchase. Replace with App Store receipt validation." });
  }

  if (req.method === "POST" && url.pathname === "/v1/vip/subscribe") {
    const body = await readJSON(req);
    const user = store.users[body.userId];
    if (!user) return jsonResponse(res, 404, { error: "User not found" });
    user.isPremium = true;
    user.lastSeenAt = new Date().toISOString();
    const subscription = recordVipSubscription(store, {
      userId: user.id,
      planId: body.planId || "weekly",
      status: "active",
      amountCents: body.amountCents || 999,
      platformTransactionId: body.platformTransactionId || ""
    });
    await saveStore(store);
    return jsonResponse(res, 200, { user, subscription, note: "Mock subscription. Replace with App Store receipt validation." });
  }

  if (req.method === "POST" && url.pathname === "/v1/rewards/share-submissions") {
    const body = await readJSON(req);
    const user = store.users[body.userId];
    if (!user) return jsonResponse(res, 404, { error: "User not found" });
    const day = todayKey();
    const baseRewardGranted = user.shareRewardDays[day] !== true;
    if (baseRewardGranted) {
      user.coins += 100;
      user.shareRewardDays[day] = true;
      recordCoinTransaction(store, {
        userId: user.id,
        type: "share_base_reward",
        coins: 100,
        amountCents: 0,
        source: "reward",
        note: `${body.platform || "unknown"} daily share reward`
      });
    }
    const submission = {
      id: newId("reward"),
      userId: user.id,
      platform: body.platform || "unknown",
      proofLink: body.proofLink || "",
      screenshotBase64: body.screenshotBase64 || null,
      status: "pending",
      baseRewardCoins: baseRewardGranted ? 100 : 0,
      maxReviewBonusCoins: 10000,
      createdAt: new Date().toISOString()
    };
    store.rewardSubmissions[submission.id] = submission;
    await saveStore(store);
    return jsonResponse(res, 200, { user, submission });
  }

  const reviewMatch = url.pathname.match(/^\/v1\/rewards\/([^/]+)\/review$/);
  if (req.method === "POST" && reviewMatch) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token !== process.env.ADMIN_TOKEN) return jsonResponse(res, 401, { error: "Unauthorized" });
    const body = await readJSON(req);
    const submission = store.rewardSubmissions[reviewMatch[1]];
    if (!submission) return jsonResponse(res, 404, { error: "Submission not found" });
    const user = store.users[submission.userId];
    const bonus = Math.max(0, Math.min(10000, Number(body.bonusCoins || 0)));
    submission.status = body.status === "approved" ? "approved" : "rejected";
    submission.reviewBonusCoins = submission.status === "approved" ? bonus : 0;
    submission.reviewedAt = new Date().toISOString();
    if (user && submission.status === "approved") user.coins += bonus;
    if (user && submission.status === "approved" && bonus > 0) {
      recordCoinTransaction(store, {
        userId: user.id,
        type: "share_review_bonus",
        coins: bonus,
        amountCents: 0,
        source: "reward_review",
        note: submission.id
      });
    }
    await saveStore(store);
    return jsonResponse(res, 200, { user, submission });
  }

  if (url.pathname.startsWith("/v1/admin/")) {
    if (!requireAdmin(req, res)) return;

    if (req.method === "GET" && url.pathname === "/v1/admin/overview") {
      return jsonResponse(res, 200, { overview: adminOverview(store) });
    }

    if (req.method === "GET" && url.pathname === "/v1/admin/users") {
      const query = (url.searchParams.get("query") || "").trim().toLowerCase();
      const users = Object.values(store.users)
        .map(userPublic)
        .filter((user) => {
          if (!query) return true;
          return user.id.toLowerCase().includes(query) || user.deviceId.toLowerCase().includes(query);
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse(res, 200, { users });
    }

    const adminUserMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)$/);
    if (req.method === "GET" && adminUserMatch) {
      const detail = userDetail(store, adminUserMatch[1]);
      return detail ? jsonResponse(res, 200, detail) : jsonResponse(res, 404, { error: "User not found" });
    }

    if (req.method === "GET" && url.pathname === "/v1/admin/recharges") {
      const transactions = Object.values(store.coinTransactions)
        .filter((item) => item.type === "coin_purchase")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse(res, 200, { transactions });
    }

    if (req.method === "GET" && url.pathname === "/v1/admin/vip-subscriptions") {
      const subscriptions = Object.values(store.vipSubscriptions)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return jsonResponse(res, 200, { subscriptions });
    }

    if (req.method === "GET" && url.pathname === "/v1/admin/reward-submissions") {
      const submissions = Object.values(store.rewardSubmissions)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse(res, 200, { submissions });
    }
  }

  return jsonResponse(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    jsonResponse(res, error.status || 500, { error: error.message || "Server error" });
  });
});

server.listen(port, () => {
  console.log(`SquadLive backend listening on http://localhost:${port}`);
});
