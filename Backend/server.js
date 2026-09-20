import http from "node:http";
import {createTransactionInbox} from "./shared-transaction-inbox.mjs";
import { mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createAppleIdentityVerifier } from "./apple-identity.mjs";
import { createBenefitAuth } from "./benefit-auth.mjs";
import { createBenefitGateway } from "./benefit-gateway.mjs";
import { createAnonymousAuth } from "./anonymous-auth.mjs";
import { createPartnerAttribution } from "./partner-attribution.mjs";
import { PartnerClient } from "./partner-client.mjs";
import { isIP } from "node:net";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
const storePath = join(dataDir, "store.json");
const sharedInbox=createTransactionInbox({directory:process.env.DATA_DIR,certDirectory:join(__dirname,"certs")});
const homePagePath = join(__dirname, "index.html");
const adminPagePath = join(__dirname, "admin.html");
const supportPagePath = join(__dirname, "support.html");
const privacyPagePath = join(__dirname, "privacy.html");
const termsPagePath = join(__dirname, "terms.html");
const landingAssets = new Map([
  ["/assets/landing/squadlive-logo.png", { path: join(__dirname, "assets", "landing", "squadlive-logo.png"), contentType: "image/png" }],
  ["/assets/landing/live-1.jpg", { path: join(__dirname, "assets", "landing", "live-1.jpg"), contentType: "image/jpeg" }],
  ["/assets/landing/live-2.jpg", { path: join(__dirname, "assets", "landing", "live-2.jpg"), contentType: "image/jpeg" }],
  ["/assets/landing/live-3.jpg", { path: join(__dirname, "assets", "landing", "live-3.jpg"), contentType: "image/jpeg" }],
  ["/assets/landing/live-4.jpg", { path: join(__dirname, "assets", "landing", "live-4.jpg"), contentType: "image/jpeg" }]
]);
const appleBundleId = process.env.APPLE_BUNDLE_ID || "com.liuzhigang.AI-Live-Streaming";
const appleAppId = Number(process.env.APPLE_APP_ID || 0) || undefined;
const appleOnlineChecks = process.env.APPLE_IAP_ONLINE_CHECKS === "true";
const mockPurchasesEnabled = process.env.NODE_ENV !== "production" && process.env.ENABLE_MOCK_PURCHASES === "true";
const rewardTimeZone = process.env.REWARD_TIME_ZONE || "Asia/Shanghai";
const deepSeekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const aiMaxConcurrency = Math.max(1, Number(process.env.AI_MAX_CONCURRENCY || 40));
const aiQueueLimit = Math.max(aiMaxConcurrency, Number(process.env.AI_QUEUE_LIMIT || 300));
const instanceMemoryMB = Math.max(128, Number(process.env.INSTANCE_MEMORY_MB || 512));
const ipGeolocationEnabled = process.env.IP_GEOLOCATION_ENABLED !== "false";
const ipGeolocationBaseURL = process.env.IP_GEOLOCATION_BASE_URL || "https://ipwho.is";
const publicBaseURL = String(process.env.PUBLIC_BASE_URL || "https://squadlive.onrender.com").replace(/\/$/, "");
const processStartedAt = Date.now();
const deploymentRevision = "2026-09-20-multilingual-vision-v8";
const appleIssuer = "https://appleid.apple.com";
const appleAuthAudience = process.env.APPLE_AUTH_AUDIENCE || appleBundleId;

let storePromise;
let saveQueue = Promise.resolve();
let metricsSaveTimer;
let activeAIRequests = 0;
const pendingAIRequests = [];
const ipLookupCache = new Map();
const pendingIPLookups = new Map();
const runtimeMetrics = {
  maxActiveAIRequests: 0,
  queueRejected: 0,
  storeWriteFailures: 0,
  lastAIErrorAt: null,
  lastAIErrorReason: null
};

const viewerPacks = [
  { label: "5,000", viewers: 5000, cost: 15 },
  { label: "20,000", viewers: 20000, cost: 50 },
  { label: "45,000", viewers: 45000, cost: 100 },
  { label: "75,000", viewers: 75000, cost: 150 },
  { label: "150,000", viewers: 150000, cost: 250 },
  { label: "400,000", viewers: 400000, cost: 500 }
];

const liveViewerPacks = new Map([
  [5000, 15],
  [20000, 50],
  [45000, 120],
  [100000, 200],
  [200000, 350],
  [400000, 500]
]);

const coinPacks = [
  { id: "coins_1000", coins: 1000, priceCents: 199 },
  { id: "coins_5000", coins: 5000, priceCents: 699 },
  { id: "coins_12000", coins: 12000, priceCents: 1499 },
  { id: "coins_35000", coins: 35000, priceCents: 2999 }
];

const appStoreCoinAmounts = {
  "com.liuzhigang.squadlive.coins.330": 330,
  "com.liuzhigang.squadlive.coins.420": 420,
  "com.liuzhigang.squadlive.coins.525": 525,
  "com.liuzhigang.squadlive.coins.740": 740,
  "com.liuzhigang.squadlive.coins.1450": 1450,
  "com.liuzhigang.squadlive.coins.1800": 1800
};

const appStoreCoinPricesUSDCents = {
  "com.liuzhigang.squadlive.coins.330": 499,
  "com.liuzhigang.squadlive.coins.420": 599,
  "com.liuzhigang.squadlive.coins.525": 699,
  "com.liuzhigang.squadlive.coins.740": 899,
  "com.liuzhigang.squadlive.coins.1450": 1499,
  "com.liuzhigang.squadlive.coins.1800": 1999
};

const appStoreSubscriptionProducts = new Set([
  "com.liuzhigang.squadlive.pro.weekly",
  "com.liuzhigang.squadlive.pro.annual"
]);

let appleVerifierPromise;
const verifyAppleIdentityToken = createAppleIdentityVerifier({audience: appleAuthAudience});
const partnerClient = process.env.PARTNER_API_ORIGIN && process.env.PARTNER_EVENT_KEY
 ? new PartnerClient({origin:process.env.PARTNER_API_ORIGIN,product:'squadlive',key:process.env.PARTNER_EVENT_KEY}) : null;
const partnerAttribution = createPartnerAttribution({getStore,saveStore,client:partnerClient,product:'squadlive',bundleId:appleBundleId,
 skus:Object.fromEntries([...Object.keys(appStoreCoinAmounts).map(s=>[s,'iap']),...[...appStoreSubscriptionProducts].map(s=>[s,'subscription'])])});
const benefitAuth = createBenefitAuth({verifyApple:verifyAppleIdentityToken,resolveUser:async subject => {
 const store = await getStore(); return store.users[store.userIdsByAppleSubject[subject]];
},onAuthenticated:user=>partnerAttribution.account(user)});
const anonymousAuth = createAnonymousAuth({getStore,saveStore,resolveWallet:getOrCreateUser,account:user=>partnerAttribution.account(user)});
async function verifyPartnerIdentity(req) {
 if(req.headers.get('authorization')?.startsWith('Bearer anon_'))return anonymousAuth.verify(req);
 return benefitAuth.verify(req);
}
const benefitGateway = partnerClient ? createBenefitGateway({partnerClient,verifyIdentity:verifyPartnerIdentity,confirmBinding:(identity,code,confirmed)=>partnerAttribution.bind(identity,code,confirmed)}) : null;
async function verifiedPurchaseUser(store,req,payload,deviceId) {
 const token=String(payload.appAccountToken||'').toLowerCase();
 const id=store.partnerTokens?.[token];
 if(id){
  let identity;try{identity=await verifyPartnerIdentity(new Request('https://app.local',{headers:{authorization:req.headers.authorization||''}}))}catch{throw Object.assign(new Error('Installation authorization unavailable; reopen the app and retry'),{status:401})}
  if(identity.customerId!==id)throw Object.assign(new Error('Transaction belongs to another account'),{status:403});
  return store.users[store.partnerAnonymousAccounts?.[id]?.walletUserId || id];
 }
 if(token!==deviceId.toLowerCase())throw Object.assign(new Error('Transaction does not belong to this account'),{status:403});
 return getOrCreateUser(store,deviceId,req);
}

async function getAppleTransactionVerifiers() {
  appleVerifierPromise ||= Promise.all([
    readFile(join(__dirname, "certs", "AppleIncRootCertificate.cer")),
    readFile(join(__dirname, "certs", "AppleRootCA-G2.cer")),
    readFile(join(__dirname, "certs", "AppleRootCA-G3.cer"))
  ]).then((rootCertificates) => ({
    sandbox: new SignedDataVerifier(rootCertificates, appleOnlineChecks, Environment.SANDBOX, appleBundleId),
    production: appleAppId
      ? new SignedDataVerifier(rootCertificates, appleOnlineChecks, Environment.PRODUCTION, appleBundleId, appleAppId)
      : null
  }));
  return appleVerifierPromise;
}

async function verifyAppleTransaction(signedTransaction) {
  if (typeof signedTransaction !== "string" || signedTransaction.length < 100) {
    const error = new Error("Missing signed App Store transaction");
    error.status = 400;
    throw error;
  }

  const verifiers = await getAppleTransactionVerifiers();
  try {
    return await verifiers.sandbox.verifyAndDecodeTransaction(signedTransaction);
  } catch (sandboxError) {
    if (!verifiers.production) {
      const error = new Error("Production App Store verification requires APPLE_APP_ID");
      error.status = 503;
      throw error;
    }
    try {
      return await verifiers.production.verifyAndDecodeTransaction(signedTransaction);
    } catch (productionError) {
      console.error("App Store transaction verification failed", { sandboxError, productionError });
      const error = new Error("Invalid App Store transaction");
      error.status = 400;
      throw error;
    }
  }
}

async function verifyAppleNotification(signedPayload) {
  if (typeof signedPayload !== "string" || signedPayload.length < 100) {
    const error = new Error("Missing signed App Store notification");
    error.status = 400;
    throw error;
  }

  const verifiers = await getAppleTransactionVerifiers();
  try {
    const payload = await verifiers.sandbox.verifyAndDecodeNotification(signedPayload);
    return { payload, verifier: verifiers.sandbox };
  } catch (sandboxError) {
    if (!verifiers.production) {
      const error = new Error("Production App Store verification requires APPLE_APP_ID");
      error.status = 503;
      throw error;
    }
    try {
      const payload = await verifiers.production.verifyAndDecodeNotification(signedPayload);
      return { payload, verifier: verifiers.production };
    } catch (productionError) {
      console.error("App Store notification verification failed", { sandboxError, productionError });
      const error = new Error("Invalid App Store notification");
      error.status = 400;
      throw error;
    }
  }
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function rewardDayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: rewardTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  } catch {
    return todayKey(date);
  }
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(data);
}

async function readJSON(req) {
  const chunks = [];
  const maximumBytes = 8 * 1024 * 1024;
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    const error = new Error("Request body is too large");
    error.status = 413;
    throw error;
  }
  let receivedBytes = 0;
  for await (const chunk of req) {
    receivedBytes += chunk.length;
    if (receivedBytes > maximumBytes) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
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
  store.appleTransactions ||= {};
  store.appleNotifications ||= {};
  store.walletOperations ||= {};
  store.vipSubscriptions ||= {};
  store.aiConversations ||= {};
  store.liveSessions ||= {};
  store.liveEvents ||= {};
  store.dailyUsage ||= {};
  store.userIdsByDevice ||= {};
  store.userIdsByAppleSubject ||= {};
  store.settings ||= {};
  store.settings.initialCoins = Math.max(0, Math.min(1_000_000, Number(store.settings.initialCoins ?? 300)));
  for (const user of Object.values(store.users)) {
    user.coins = Math.max(0, Number(user.coins ?? 300));
    user.shareRewardDays ||= {};
    if (typeof user.firstLiveFreeEligible !== "boolean") user.firstLiveFreeEligible = false;
    user.liveSessionsStarted = Math.max(0, Number(user.liveSessionsStarted ?? 1));
    if (user.deviceId) store.userIdsByDevice[user.deviceId] = user.id;
  }
  let migratedCoinRevenue = 0;
  for (const transaction of Object.values(store.coinTransactions)) {
    if (normalizeCoinPurchaseRevenue(transaction)) migratedCoinRevenue += 1;
  }
  if (migratedCoinRevenue > 0) {
    await saveStore(store);
    console.log(`Normalized ${migratedCoinRevenue} coin purchase record(s) to fixed USD pricing.`);
  }
  return store;
}

function getStore() {
  storePromise ||= loadStore();
  return storePromise;
}

async function saveStore(store) {
  const serialized = JSON.stringify(store, null, 2);
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const persist = async () => {
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(temporaryPath, serialized);
    await rename(temporaryPath, storePath);
  };
  const queuedSave = saveQueue.then(persist, persist);
  saveQueue = queuedSave.catch((error) => {
    runtimeMetrics.storeWriteFailures += 1;
    console.error("Failed to persist store", error);
  });
  return queuedSave;
}

function dailyUsage(store, date = new Date()) {
  const day = todayKey(date);
  store.dailyUsage[day] ||= {
    requests: 0,
    newUsers: 0,
    http4xx: 0,
    http5xx: 0,
    aiRequests: 0,
    aiSuccesses: 0,
    aiFallbacks: 0,
    aiTimeouts: 0,
    aiUnavailable: 0,
    aiQueueRejected: 0,
    aiLatencyTotalMs: 0,
    aiLatencyMaxMs: 0,
    peakAIConcurrency: 0,
    activeUserIds: {},
    liveStartedUserIds: {},
    liveEngagedUserIds: {},
    liveSessionsEnded: 0,
    liveDurationTotalSeconds: 0,
    liveStartFailures: 0
  };
  return store.dailyUsage[day];
}

function recordDailyMetric(store, field, amount = 1) {
  const usage = dailyUsage(store);
  usage[field] = Number(usage[field] || 0) + amount;
  scheduleMetricsSave(store);
  return usage;
}

function recordDailyActiveUser(store, userId) {
  if (!userId) return;
  dailyUsage(store).activeUserIds[userId] = true;
  scheduleMetricsSave(store);
}

function scheduleMetricsSave(store) {
  if (metricsSaveTimer) return;
  metricsSaveTimer = setTimeout(() => {
    metricsSaveTimer = null;
    const days = Object.keys(store.dailyUsage).sort();
    for (const oldDay of days.slice(0, Math.max(0, days.length - 30))) {
      delete store.dailyUsage[oldDay];
    }
    saveStore(store).catch(() => {});
  }, 30_000);
  metricsSaveTimer.unref?.();
}

function runQueuedAIRequest(task) {
  if (pendingAIRequests.length >= aiQueueLimit) {
    runtimeMetrics.queueRejected += 1;
    const error = new Error("AI request queue is full. Please retry shortly.");
    error.status = 503;
    throw error;
  }

  return new Promise((resolve, reject) => {
    const run = async () => {
      activeAIRequests += 1;
      runtimeMetrics.maxActiveAIRequests = Math.max(runtimeMetrics.maxActiveAIRequests, activeAIRequests);
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      } finally {
        activeAIRequests -= 1;
        pendingAIRequests.shift()?.();
      }
    };

    if (activeAIRequests < aiMaxConcurrency) {
      run();
    } else {
      pendingAIRequests.push(run);
    }
  });
}

function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function normalizedIPAddress(value) {
  let candidate = String(value || "").trim();
  if (!candidate) return "";
  if (candidate.includes(",")) candidate = candidate.split(",")[0].trim();
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  if (candidate.startsWith("[") && candidate.includes("]")) candidate = candidate.slice(1, candidate.indexOf("]"));
  if (isIP(candidate)) return candidate;
  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return ipv4WithPort && isIP(ipv4WithPort[1]) ? ipv4WithPort[1] : "";
}

function clientIPAddress(req) {
  const candidates = [
    req.headers["cf-connecting-ip"],
    req.headers["true-client-ip"],
    req.headers["x-forwarded-for"],
    req.headers["x-real-ip"],
    req.socket?.remoteAddress
  ];
  for (const candidate of candidates) {
    const address = normalizedIPAddress(Array.isArray(candidate) ? candidate[0] : candidate);
    if (address) return address;
  }
  return "";
}

function requestCountryCode(req) {
  const value = req.headers["cf-ipcountry"]
    || req.headers["x-vercel-ip-country"]
    || req.headers["cloudfront-viewer-country"]
    || "";
  const code = String(Array.isArray(value) ? value[0] : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function isPrivateIPAddress(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address.startsWith("10.")
    || address.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || address.startsWith("fc")
    || address.startsWith("fd")
    || address.startsWith("fe80:");
}

function appleNetworkAssessment(network = {}) {
  const text = [network.organization, network.isp, network.domain, network.asn]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  const matched = /(^|\W)apple(\W|$)|apple inc|apple computer/.test(text);
  return {
    possibleAppleNetwork: matched,
    appleNetworkNote: matched
      ? "Network organization mentions Apple; this does not prove the user is an Apple reviewer."
      : ""
  };
}

function applyNetworkDetails(user, address, details) {
  if (!user || user.lastIPAddress !== address) return;
  const assessment = appleNetworkAssessment(details);
  user.networkCountryCode = details.countryCode || user.networkCountryCode || "";
  user.networkCountry = details.country || user.networkCountry || "";
  user.networkRegion = details.region || "";
  user.networkCity = details.city || "";
  user.networkTimezone = details.timezone || "";
  user.networkASN = details.asn || "";
  user.networkOrganization = details.organization || "";
  user.networkISP = details.isp || "";
  user.networkDomain = details.domain || "";
  user.possibleAppleNetwork = assessment.possibleAppleNetwork;
  user.appleNetworkNote = assessment.appleNetworkNote;
  user.networkLookupStatus = "complete";
  user.networkUpdatedAt = new Date().toISOString();
  const historyItem = user.ipHistory?.find((item) => item.ip === address);
  if (historyItem) {
    historyItem.countryCode = user.networkCountryCode;
    historyItem.country = user.networkCountry;
    historyItem.region = user.networkRegion;
    historyItem.city = user.networkCity;
    historyItem.asn = user.networkASN;
    historyItem.organization = user.networkOrganization;
    historyItem.isp = user.networkISP;
    historyItem.possibleAppleNetwork = user.possibleAppleNetwork;
  }
}

async function lookupIPAddress(address) {
  const cached = ipLookupCache.get(address);
  if (cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000) return cached.details;
  const endpoint = `${ipGeolocationBaseURL.replace(/\/$/, "")}/${encodeURIComponent(address)}`;
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", "user-agent": "SquadLive-Backend/1.0" },
    signal: AbortSignal.timeout(3500)
  });
  if (!response.ok) throw new Error(`IP lookup returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.success === false) throw new Error(payload.message || "IP lookup failed");
  const details = {
    countryCode: String(payload.country_code || payload.countryCode || "").toUpperCase(),
    country: String(payload.country || ""),
    region: String(payload.region || payload.regionName || ""),
    city: String(payload.city || ""),
    timezone: String(payload.timezone?.id || payload.timezone || ""),
    asn: String(payload.connection?.asn || payload.asn || ""),
    organization: String(payload.connection?.org || payload.org || payload.organization || ""),
    isp: String(payload.connection?.isp || payload.isp || ""),
    domain: String(payload.connection?.domain || payload.domain || "")
  };
  ipLookupCache.set(address, { cachedAt: Date.now(), details });
  return details;
}

function scheduleIPAddressLookup(store, user, address) {
  if (!ipGeolocationEnabled || !address || isPrivateIPAddress(address)) return;
  if (user.networkLookupStatus === "complete"
      && user.networkUpdatedAt
      && Date.now() - new Date(user.networkUpdatedAt).getTime() < 7 * 24 * 60 * 60 * 1000) return;
  if (pendingIPLookups.has(address)) {
    pendingIPLookups.get(address).then((details) => {
      applyNetworkDetails(user, address, details);
      return saveStore(store);
    }).catch(() => {});
    return;
  }
  user.networkLookupStatus = "pending";
  const lookup = lookupIPAddress(address);
  pendingIPLookups.set(address, lookup);
  lookup.then(async (details) => {
    applyNetworkDetails(user, address, details);
    await saveStore(store);
  }).catch(async (error) => {
    if (user.lastIPAddress === address) {
      user.networkLookupStatus = "failed";
      user.networkLookupError = String(error.message || "Lookup failed").slice(0, 160);
      user.networkUpdatedAt = new Date().toISOString();
      await saveStore(store);
    }
  }).finally(() => pendingIPLookups.delete(address));
}

function recordUserNetwork(store, user, req) {
  if (!user || !req) return;
  const address = clientIPAddress(req);
  if (!address) return;
  const now = new Date().toISOString();
  const countryCode = requestCountryCode(req);
  user.firstIPAddress ||= address;
  user.lastIPAddress = address;
  user.lastIPSeenAt = now;
  user.ipHistory ||= [];
  let item = user.ipHistory.find((entry) => entry.ip === address);
  if (!item) {
    item = { ip: address, firstSeenAt: now, lastSeenAt: now };
    user.ipHistory.unshift(item);
    user.ipHistory = user.ipHistory.slice(0, 10);
    user.networkLookupStatus = "pending";
    user.networkUpdatedAt = null;
  } else {
    item.lastSeenAt = now;
  }
  if (countryCode) {
    item.countryCode = countryCode;
    user.networkCountryCode = countryCode;
  }
  scheduleIPAddressLookup(store, user, address);
}

function getOrCreateUser(store, deviceId = "anonymous", req = null) {
  const existingId = store.userIdsByDevice[deviceId];
  const existing = existingId ? store.users[existingId] : null;
  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    recordUserNetwork(store, existing, req);
    recordDailyActiveUser(store, existing.id);
    return existing;
  }

  const initialCoins = Math.max(0, Math.min(1_000_000, Number(store.settings?.initialCoins ?? 300)));
  const user = {
    id: newId("user"),
    deviceId,
    coins: initialCoins,
    isPremium: false,
    firstLiveFreeEligible: true,
    liveSessionsStarted: 0,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    shareRewardDays: {}
  };
  store.users[user.id] = user;
  recordUserNetwork(store, user, req);
  store.userIdsByDevice[deviceId] = user.id;
  recordDailyMetric(store, "newUsers");
  recordDailyActiveUser(store, user.id);
  recordCoinTransaction(store, {
    userId: user.id,
    type: "signup_bonus",
    coins: initialCoins,
    amountCents: 0,
    source: "system",
    note: `Initial coins (${initialCoins})`
  });
  return user;
}

function canMergeUnlinkedDeviceUser(store, user) {
  if (!user || user.appleSubject) return false;
  if (Number(user.liveSessionsStarted || 0) > 0) return false;
  if (Object.values(store.walletOperations).some((operation) => operation.userId === user.id)) return false;
  if (Object.values(store.appleTransactions).some((transaction) => transaction.userId === user.id)) return false;
  const transactions = Object.values(store.coinTransactions).filter((transaction) => transaction.userId === user.id);
  return transactions.every((transaction) => transaction.type === "signup_bonus")
    && transactions.length <= 1;
}

function requireAdmin(req, res) {
  const configuredToken = String(process.env.ADMIN_TOKEN || "").trim();
  if (!configuredToken) { jsonResponse(res, 503, { error: "Admin access is not configured" }); return false; }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const configuredBuffer = Buffer.from(configuredToken);
  const tokenBuffer = Buffer.from(token);
  const isValid = configuredToken.length >= 16
    && configuredBuffer.length === tokenBuffer.length
    && timingSafeEqual(configuredBuffer, tokenBuffer);
  if (!isValid) {
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
    currency: String(input.currency || "").trim().toUpperCase(),
    source: input.source || "unknown",
    note: input.note || "",
    platformTransactionId: input.platformTransactionId || "",
    productId: input.productId || "",
    environment: input.environment || "",
    createdAt: new Date().toISOString()
  };
  normalizeCoinPurchaseRevenue(transaction);
  store.coinTransactions[transaction.id] = transaction;
  return transaction;
}

function coinPurchaseProductId(transaction) {
  const candidates = [transaction?.productId, transaction?.note];
  const directMatch = candidates.find((value) => appStoreCoinPricesUSDCents[String(value || "")]);
  if (directMatch) return String(directMatch);

  const coins = Math.abs(Number(transaction?.coins || 0));
  return Object.keys(appStoreCoinAmounts).find((productId) => coins > 0 && coins % appStoreCoinAmounts[productId] === 0) || "";
}

function normalizeCoinPurchaseRevenue(transaction) {
  if (!transaction || transaction.type !== "coin_purchase") return false;
  const productId = coinPurchaseProductId(transaction);
  const unitPriceCents = appStoreCoinPricesUSDCents[productId];
  const unitCoins = appStoreCoinAmounts[productId];
  if (!unitPriceCents || !unitCoins) return false;

  const quantity = Math.max(1, Math.round(Math.abs(Number(transaction.coins || unitCoins)) / unitCoins));
  const amountCents = unitPriceCents * quantity;
  const changed = transaction.amountCents !== amountCents
    || transaction.currency !== "USD"
    || transaction.productId !== productId;
  transaction.amountCents = amountCents;
  transaction.currency = "USD";
  transaction.productId = productId;
  return changed;
}

function applePriceToMinorUnits(price) {
  const milliunits = Number(price || 0);
  return Number.isFinite(milliunits) && milliunits > 0 ? Math.round(milliunits / 10) : 0;
}

function appleCurrency(payload, fallback = "") {
  return String(payload?.currency || fallback || "").trim().toUpperCase();
}

function walletOperationId(body) {
  const value = String(body.operationId || body.requestId || "").trim();
  return value.length >= 8 && value.length <= 120 ? value : null;
}

function walletUser(store, body, req = null) {
  const deviceId = String(body.deviceId || "").trim();
  if (!deviceId || deviceId.length > 200) return null;
  return getOrCreateUser(store, deviceId, req);
}

function walletOperationResponse(store, operationId, user) {
  const operation = store.walletOperations[operationId];
  return operation && operation.userId === user.id ? operation : null;
}

function audienceOperationMatches(operation, viewers, context, regularCost) {
  const expectedCost = operation?.firstLiveFree ? 0 : regularCost;
  return operation
    && ["coin_spend", "first_live_free", "live_session_start"].includes(operation.type)
    && Number(operation.viewers) === viewers
    && operation.context === context
    && Number(operation.regularCost) === regularCost
    && Number(operation.coins) === -expectedCost;
}

function recordWalletOperation(store, input) {
  const operation = {
    id: input.id,
    userId: input.userId,
    type: input.type,
    coins: Number(input.coins || 0),
    balanceAfter: Number(input.balanceAfter || 0),
    viewers: Number(input.viewers || 0),
    context: input.context || "",
    regularCost: Number(input.regularCost ?? Math.abs(Number(input.coins || 0))),
    firstLiveFree: Boolean(input.firstLiveFree),
    createdAt: new Date().toISOString(),
    note: input.note || ""
  };
  store.walletOperations[operation.id] = operation;
  return operation;
}

function spendWalletCoins(store, user, amount, operationId, note) {
  const existingOperation = walletOperationResponse(store, operationId, user);
  if (existingOperation) return { operation: existingOperation, duplicate: true };
  if (store.walletOperations[operationId] && store.walletOperations[operationId].userId !== user.id) {
    const error = new Error("Wallet operation belongs to another account");
    error.status = 409;
    throw error;
  }
  if (user.coins < amount) {
    const error = new Error("Not enough coins");
    error.status = 402;
    error.coins = user.coins;
    throw error;
  }
  user.coins -= amount;
  user.lastSeenAt = new Date().toISOString();
  const operation = recordWalletOperation(store, {
    id: operationId,
    userId: user.id,
    type: "coin_spend",
    coins: -amount,
    balanceAfter: user.coins,
    note
  });
  recordCoinTransaction(store, {
    userId: user.id,
    type: "coin_spend",
    coins: -amount,
    amountCents: 0,
    source: "wallet",
    note,
    platformTransactionId: operationId
  });
  return { operation, duplicate: false };
}

function recordVipSubscription(store, input) {
  const subscription = {
    id: newId("vip"),
    userId: input.userId,
    planId: input.planId || "unknown",
    status: input.status || "active",
    amountCents: Number(input.amountCents || 0),
    currency: String(input.currency || "").trim().toUpperCase(),
    platformTransactionId: input.platformTransactionId || "",
    startedAt: new Date().toISOString(),
    expiresAt: input.expiresAt || null
  };
  store.vipSubscriptions[subscription.id] = subscription;
  return subscription;
}

function refreshUserPremiumStatus(store, user) {
  const now = Date.now();
  user.isPremium = Object.values(store.vipSubscriptions).some((subscription) => {
    if (subscription.userId !== user.id) return false;
    if (subscription.status === "grace_period") {
      return Boolean(subscription.gracePeriodExpiresAt)
        && new Date(subscription.gracePeriodExpiresAt).getTime() > now;
    }
    if (subscription.status !== "active") return false;
    return !subscription.expiresAt || new Date(subscription.expiresAt).getTime() > now;
  });
}

function findUserForAppleSubscription(store, transaction, renewalInfo, originalTransactionId) {
  const accountToken = String(transaction?.appAccountToken || renewalInfo?.appAccountToken || "").toLowerCase();
  if (accountToken) {
    const stableID = store.partnerTokens?.[accountToken];
    const stableUser = store.users[store.partnerAnonymousAccounts?.[stableID]?.walletUserId || stableID];
    if (stableUser) return stableUser;
    const matchedDeviceId = Object.keys(store.userIdsByDevice)
      .find((deviceId) => deviceId.toLowerCase() === accountToken);
    const userId = matchedDeviceId ? store.userIdsByDevice[matchedDeviceId] : null;
    if (userId && store.users[userId]) return store.users[userId];
  }

  const existingSubscription = store.vipSubscriptions[originalTransactionId];
  if (existingSubscription?.userId && store.users[existingSubscription.userId]) {
    return store.users[existingSubscription.userId];
  }

  const existingTransaction = Object.values(store.appleTransactions)
    .find((item) => item.originalTransactionId === originalTransactionId && item.userId);
  return existingTransaction?.userId ? store.users[existingTransaction.userId] || null : null;
}

function subscriptionStateFromNotification(notificationType, subtype, transaction, renewalInfo) {
  const now = Date.now();
  const expirationTime = Number(transaction?.expiresDate || 0);
  const graceExpirationTime = Number(renewalInfo?.gracePeriodExpiresDate || 0);

  if (notificationType === "REFUND") return "refunded";
  if (notificationType === "REVOKE" || transaction?.revocationDate) return "revoked";
  if (notificationType === "EXPIRED" || notificationType === "GRACE_PERIOD_EXPIRED") return "expired";
  if (notificationType === "DID_FAIL_TO_RENEW") {
    if (subtype === "GRACE_PERIOD" && graceExpirationTime > now) return "grace_period";
    return "billing_retry";
  }
  if (graceExpirationTime > now) return "grace_period";
  if (!expirationTime || expirationTime > now) return "active";
  return "expired";
}

function isoFromAppleMillis(value) {
  const milliseconds = Number(value || 0);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

function recordAIConversation(store, input) {
  const conversation = {
    id: newId("chat"),
    userId: input.userId,
    userText: String(input.userText || "").trim().slice(0, 1200),
    aiText: String(input.aiText || "").trim().slice(0, 1200),
    listenerName: String(input.listenerName || "AI Friend").slice(0, 80),
    source: input.source || "unknown",
    interactionType: input.interactionType || "user",
    createdAt: new Date().toISOString()
  };
  store.aiConversations[conversation.id] = conversation;

  const conversationIds = Object.keys(store.aiConversations);
  for (const oldConversationId of conversationIds.slice(0, Math.max(0, conversationIds.length - 5000))) {
    delete store.aiConversations[oldConversationId];
  }
  return conversation;
}

function userPublic(user) {
  return {
    id: user.id,
    deviceId: user.deviceId,
    displayName: user.displayName || "",
    coins: user.coins,
    isPremium: Boolean(user.isPremium),
    accountLinked: Boolean(user.appleSubject),
    liveSessionsStarted: Math.max(0, Number(user.liveSessionsStarted || 0)),
    firstLiveFreeAvailable: Boolean(user.firstLiveFreeEligible && !user.firstLiveFreeUsedAt && Number(user.liveSessionsStarted || 0) === 0),
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt || user.createdAt
  };
}

function adminUserPublic(user) {
  return {
    ...userPublic(user),
    lastIPAddress: user.lastIPAddress || "",
    lastIPSeenAt: user.lastIPSeenAt || null,
    networkCountryCode: user.networkCountryCode || "",
    networkCountry: user.networkCountry || "",
    networkRegion: user.networkRegion || "",
    networkCity: user.networkCity || "",
    networkTimezone: user.networkTimezone || "",
    networkASN: user.networkASN || "",
    networkOrganization: user.networkOrganization || "",
    networkISP: user.networkISP || "",
    networkDomain: user.networkDomain || "",
    networkLookupStatus: user.networkLookupStatus || "not_started",
    networkUpdatedAt: user.networkUpdatedAt || null,
    possibleAppleNetwork: Boolean(user.possibleAppleNetwork),
    appleNetworkNote: user.appleNetworkNote || "",
    firstLiveFreeEligible: Boolean(user.firstLiveFreeEligible),
    firstLiveFreeUsedAt: user.firstLiveFreeUsedAt || null,
  };
}

function userLiveSummary(store, userId) {
  const allSessions = Object.values(store.liveSessions)
    .filter((session) => session.userId === userId)
    .sort((a, b) => String(b.startedAt || b.startFailedAt || b.createdAt || "").localeCompare(String(a.startedAt || a.startFailedAt || a.createdAt || "")));
  const sessions = allSessions.filter((session) => session.startedAt);
  const engagedSessions = sessions.filter((session) => session.userInteracted);
  const latest = sessions[0];
  const failedSessions = allSessions.filter((session) => session.startFailureReason);
  return {
    liveSessionCount: sessions.length,
    engagedLiveSessionCount: engagedSessions.length,
    liveEngagementPercent: sessions.length ? Number(((engagedSessions.length / sessions.length) * 100).toFixed(1)) : 0,
    lastLiveAt: latest?.startedAt || null,
    lastLiveDurationSeconds: Math.max(0, Number(latest?.durationSeconds || 0)),
    lastLiveUserInteracted: Boolean(latest?.userInteracted),
    lastLiveAIReplyDisplayed: Boolean(latest?.aiReplyDisplayed),
    liveStartFailureCount: failedSessions.reduce((sum, session) => sum + Math.max(1, Number(session.startFailureCount || 0)), 0),
    lastLiveStartFailureAt: failedSessions[0]?.startFailedAt || null,
    lastLiveStartFailureReason: failedSessions[0]?.startFailureReason || ""
  };
}

function isToday(iso) {
  return Boolean(iso && iso.slice(0, 10) === todayKey());
}

function isActiveRecently(iso) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() <= 5 * 60 * 1000;
}

function publicDailyUsage(store) {
  return Object.entries(store.dailyUsage)
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, 30)
    .map(([date, usage]) => ({
      date,
      requests: Number(usage.requests || 0),
      newUsers: Number(usage.newUsers || 0),
      http4xx: Number(usage.http4xx || 0),
      http5xx: Number(usage.http5xx || 0),
      activeUsers: Object.keys(usage.activeUserIds || {}).length,
      aiRequests: Number(usage.aiRequests || 0),
      aiSuccesses: Number(usage.aiSuccesses || 0),
      aiFallbacks: Number(usage.aiFallbacks || 0),
      aiTimeouts: Number(usage.aiTimeouts || 0),
      aiUnavailable: Number(usage.aiUnavailable || 0),
      aiQueueRejected: Number(usage.aiQueueRejected || 0),
      peakAIConcurrency: Number(usage.peakAIConcurrency || 0),
      liveStartedUsers: Object.keys(usage.liveStartedUserIds || {}).length,
      liveEngagedUsers: Object.keys(usage.liveEngagedUserIds || {}).length,
      liveSessionsEnded: Number(usage.liveSessionsEnded || 0),
      liveDurationTotalSeconds: Number(usage.liveDurationTotalSeconds || 0),
      liveStartFailures: Number(usage.liveStartFailures || 0),
      averageAILatencyMs: usage.aiRequests
        ? Math.round(Number(usage.aiLatencyTotalMs || 0) / Number(usage.aiRequests))
        : 0,
      maxAILatencyMs: Number(usage.aiLatencyMaxMs || 0)
    }));
}

async function resourceSnapshot() {
  const memory = process.memoryUsage();
  const memoryLimitBytes = instanceMemoryMB * 1024 * 1024;
  let disk = { usedBytes: 0, totalBytes: 0, percent: 0, storeBytes: 0 };

  try {
    const [filesystem, storeFile] = await Promise.all([
      statfs(dataDir),
      stat(storePath).catch(() => null)
    ]);
    const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    disk = {
      usedBytes,
      totalBytes,
      percent: totalBytes ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : 0,
      storeBytes: Number(storeFile?.size || 0)
    };
  } catch (error) {
    console.error("Unable to read disk metrics", error);
  }

  return {
    uptimeSeconds: Math.floor((Date.now() - processStartedAt) / 1000),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      limitBytes: memoryLimitBytes,
      percent: Number(((memory.rss / memoryLimitBytes) * 100).toFixed(1))
    },
    disk,
    aiConcurrency: {
      active: activeAIRequests,
      queued: pendingAIRequests.length,
      limit: aiMaxConcurrency,
      queueLimit: aiQueueLimit,
      peakSinceRestart: runtimeMetrics.maxActiveAIRequests,
      rejectedSinceRestart: runtimeMetrics.queueRejected
    },
    storeWriteFailures: runtimeMetrics.storeWriteFailures,
    lastAIErrorAt: runtimeMetrics.lastAIErrorAt,
    lastAIErrorReason: runtimeMetrics.lastAIErrorReason
  };
}

function monitoringWarnings(resources, todayUsage) {
  const warnings = [];
  const aiRequests = Number(todayUsage?.aiRequests || 0);
  const aiFailures = Number(todayUsage?.aiFallbacks || 0);
  const failureRate = aiRequests ? aiFailures / aiRequests : 0;

  if (resources.memory.percent >= 90) {
    warnings.push({ level: "critical", title: "内存接近耗尽", message: `当前内存占用 ${resources.memory.percent}%，建议立即升级实例。` });
  } else if (resources.memory.percent >= 75) {
    warnings.push({ level: "warning", title: "内存使用偏高", message: `当前内存占用 ${resources.memory.percent}%，建议持续观察并准备升级。` });
  }
  if (resources.disk.percent >= 90) {
    warnings.push({ level: "critical", title: "磁盘空间不足", message: `磁盘已使用 ${resources.disk.percent}%，请扩容或清理历史数据。` });
  } else if (resources.disk.percent >= 75) {
    warnings.push({ level: "warning", title: "磁盘使用偏高", message: `磁盘已使用 ${resources.disk.percent}%，建议准备扩容。` });
  }
  if (resources.aiConcurrency.queued >= Math.max(1, Math.floor(resources.aiConcurrency.queueLimit * 0.6))) {
    warnings.push({ level: "critical", title: "AI 请求排队严重", message: `当前有 ${resources.aiConcurrency.queued} 个 AI 请求等待处理。` });
  } else if (resources.aiConcurrency.active >= Math.floor(resources.aiConcurrency.limit * 0.8)) {
    warnings.push({ level: "warning", title: "AI 并发接近上限", message: `当前 AI 并发 ${resources.aiConcurrency.active}/${resources.aiConcurrency.limit}。` });
  }
  if (Number(todayUsage?.aiQueueRejected || 0) > 0 || resources.aiConcurrency.rejectedSinceRestart > 0) {
    warnings.push({ level: "critical", title: "出现并发失败", message: `今日已有 ${todayUsage?.aiQueueRejected || 0} 个 AI 请求因队列拥堵被拒绝。` });
  }
  if (aiRequests >= 10 && failureRate >= 0.2) {
    warnings.push({ level: "critical", title: "AI 服务不可用率过高", message: `今日 AI 失败或降级率为 ${(failureRate * 100).toFixed(1)}%。` });
  } else if (aiRequests >= 10 && failureRate >= 0.08) {
    warnings.push({ level: "warning", title: "AI 稳定性下降", message: `今日 AI 失败或降级率为 ${(failureRate * 100).toFixed(1)}%。` });
  }
  if (Number(todayUsage?.aiTimeouts || 0) >= 5) {
    warnings.push({ level: "warning", title: "AI 回复多次超时", message: `今日已发生 ${todayUsage.aiTimeouts} 次 AI 回复超时。` });
  }
  if (resources.storeWriteFailures > 0) {
    warnings.push({ level: "critical", title: "数据持久化失败", message: `本次运行已发生 ${resources.storeWriteFailures} 次磁盘写入失败。` });
  }
  if (!warnings.length) {
    warnings.push({ level: "healthy", title: "系统运行正常", message: "当前内存、磁盘、AI 并发和失败率均在安全范围内。" });
  }
  return warnings;
}

async function adminOverview(store) {
  const users = Object.values(store.users);
  const coinTransactions = Object.values(store.coinTransactions);
  const vipSubscriptions = Object.values(store.vipSubscriptions);
  const aiConversations = Object.values(store.aiConversations);
  const userAIConversations = aiConversations.filter((item) => item.interactionType !== "system_opening");
  const rewardSubmissions = Object.values(store.rewardSubmissions);
  const daily = publicDailyUsage(store);
  const resources = await resourceSnapshot();
  const todayUsage = daily.find((item) => item.date === todayKey()) || {};
  const rechargeTransactions = coinTransactions.filter((item) => item.type === "coin_purchase");
  const todayRechargeTransactions = rechargeTransactions.filter((item) => isToday(item.createdAt));
  const todayVipUserIds = new Set(
    vipSubscriptions
      .filter((item) => isToday(item.startedAt))
      .map((item) => item.userId)
      .filter(Boolean)
  );
  const liveSessions = Object.values(store.liveSessions || {});
  const startedLiveSessions = liveSessions.filter((session) => session.startedAt);
  const todayLiveSessions = startedLiveSessions.filter((session) => isToday(session.startedAt));
  const liveUserIds = new Set(startedLiveSessions.map((session) => session.userId).filter(Boolean));
  const engagedLiveUserIds = new Set(startedLiveSessions.filter((session) => session.userInteracted).map((session) => session.userId).filter(Boolean));
  const todayLiveUserIds = new Set(todayLiveSessions.map((session) => session.userId).filter(Boolean));
  const todayEngagedLiveUserIds = new Set(todayLiveSessions.filter((session) => session.userInteracted).map((session) => session.userId).filter(Boolean));
  const rechargeByCurrency = rechargeTransactions
    .reduce((totals, item) => {
      const currency = String(item.currency || "UNKNOWN").toUpperCase();
      totals[currency] = Number(totals[currency] || 0) + Number(item.amountCents || 0);
      return totals;
    }, {});
  return {
    totalUsers: users.length,
    activeUsers5m: users.filter((user) => isActiveRecently(user.lastSeenAt)).length,
    activeUsersToday: Number(todayUsage.activeUsers || 0),
    newUsersToday: users.filter((user) => isToday(user.createdAt)).length,
    premiumUsers: users.filter((user) => user.isPremium).length,
    premiumUsersToday: todayVipUserIds.size,
    rechargeCount: rechargeTransactions.length,
    rechargeCountToday: todayRechargeTransactions.length,
    rechargeAmountCents: rechargeTransactions.reduce((sum, item) => sum + item.amountCents, 0),
    rechargeAmountCentsToday: todayRechargeTransactions.reduce((sum, item) => sum + item.amountCents, 0),
    rechargeByCurrency,
    vipSubscriptionCount: vipSubscriptions.length,
    activeVipSubscriptionCount: vipSubscriptions.filter((item) => item.status === "active").length,
    rewardSubmissionCount: rewardSubmissions.length,
    rewardSubmissionsToday: rewardSubmissions.filter((item) => isToday(item.createdAt)).length,
    pendingRewardSubmissions: rewardSubmissions.filter((item) => item.status === "pending").length,
    pendingRewardSubmissionsToday: rewardSubmissions.filter((item) => item.status === "pending" && isToday(item.createdAt)).length,
    premiumConversionPercent: users.length
      ? Number(((users.filter((user) => user.isPremium).length / users.length) * 100).toFixed(1))
      : 0,
    aiConversationCount: userAIConversations.length,
    aiConversationsToday: userAIConversations.filter((item) => isToday(item.createdAt)).length,
    liveUserCount: liveUserIds.size,
    liveUsersToday: todayLiveUserIds.size,
    engagedLiveUserCount: engagedLiveUserIds.size,
    engagedLiveUsersToday: todayEngagedLiveUserIds.size,
    liveEngagementPercent: liveUserIds.size ? Number(((engagedLiveUserIds.size / liveUserIds.size) * 100).toFixed(1)) : 0,
    liveEngagementPercentToday: todayLiveUserIds.size ? Number(((todayEngagedLiveUserIds.size / todayLiveUserIds.size) * 100).toFixed(1)) : 0,
    liveStartFailureCount: Object.values(store.liveEvents || {}).filter((event) => event.type === "live_start_failed").length,
    liveStartFailuresToday: Object.values(store.liveEvents || {}).filter((event) => event.type === "live_start_failed" && isToday(event.createdAt)).length,
    settings: {
      initialCoins: Number(store.settings?.initialCoins ?? 300)
    },
    monitoring: {
      resources,
      today: todayUsage,
      warnings: monitoringWarnings(resources, todayUsage),
      dailyUsage: daily
    }
  };
}

function userDetail(store, userId) {
  const user = store.users[userId];
  if (!user) return null;
  return {
    user: {
      ...adminUserPublic(user),
      ...userLiveSummary(store, userId),
      firstIPAddress: user.firstIPAddress || "",
      ipHistory: Array.isArray(user.ipHistory) ? user.ipHistory.slice(0, 10) : []
    },
    coinTransactions: Object.values(store.coinTransactions)
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    vipSubscriptions: Object.values(store.vipSubscriptions)
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    rewardSubmissions: Object.values(store.rewardSubmissions)
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    aiConversations: Object.values(store.aiConversations)
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200)
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

function localAIReply(text, inputLanguage = "en") {
  const lower = String(text || "").toLowerCase();
  const language = String(inputLanguage || "en").toLowerCase();
  const localizedFallbacks = {
    "zh-hans": "我听到了。可以再具体说一点吗？",
    "zh-hant": "我聽到了。可以再具體說一點嗎？",
    ja: "聞いています。もう少し詳しく教えてもらえますか？",
    ko: "듣고 있어요. 조금 더 자세히 말해 주시겠어요?",
    es: "Te escucho. ¿Puedes contarme un poco más?",
    fr: "Je vous écoute. Pouvez-vous m’en dire un peu plus ?",
    de: "Ich höre dir zu. Kannst du etwas mehr erzählen?",
    pt: "Estou ouvindo. Pode contar um pouco mais?",
    ru: "Я слушаю. Расскажите немного подробнее.",
    ar: "أنا أستمع إليك. هل يمكنك أن تخبرني بالمزيد؟"
  };
  if (localizedFallbacks[language]) return localizedFallbacks[language];
  const usesChinese = language.startsWith("zh");
  if (lower.includes("voice") || lower.includes("sound") || lower.includes("好听")) {
    return usesChinese ? "你的声音很好听，让直播间感觉很温暖。" : "Your voice sounds warm and pleasant.";
  }
  if (lower.includes("look") || lower.includes("pretty") || lower.includes("beautiful") || lower.includes("好看")) {
    return usesChinese ? "你今天上镜很好看，状态也很自然。" : "You look great on camera today.";
  }
  if (lower.includes("stress") || lower.includes("worried") || lower.includes("anxious") || lower.includes("压力") || lower.includes("担心") || lower.includes("焦虑")) {
    return usesChinese ? "听得出来你有些压力，先处理现在能控制的一件事。" : "I hear the pressure. Start with one thing you can control.";
  }
  if (lower.includes("我爱你") || lower.includes("喜欢你") || lower.includes("i love you") || lower.includes("love you")) {
    return usesChinese ? "这句话很暖，我也很珍惜现在陪你聊天的时刻。" : "That is really sweet. I’m glad I get to share this moment with you.";
  }
  if (lower.includes("谢谢") || lower.includes("thank you") || lower.includes("thanks")) {
    return usesChinese ? "不用客气，我会继续认真陪你聊。" : "You’re welcome. I’m right here with you.";
  }
  if (lower.includes("很高兴认识你") || lower.includes("认识你很高兴") || lower.includes("nice to meet you") || lower.includes("glad to meet you")) {
    return usesChinese ? "我也很高兴认识你。你今天最想聊点什么？" : "It’s really nice to meet you too. What would you like to talk about today?";
  }
  if (lower.includes("summer") || lower.includes("夏天")) {
    return usesChinese ? "夏天总有一种特别的能量，你最喜欢它的哪一部分？" : "Summer has such a distinct energy. What do you enjoy most about it?";
  }
  if (lower.trim() === "good" || lower.includes("i'm good") || lower.includes("i am good") || lower.includes("很好")) {
    return usesChinese ? "听起来状态不错，今天是什么让你感觉这么好？" : "I’m glad to hear that. What made today feel good?";
  }
  if (lower.includes("还是") || lower.includes("选择") || lower.includes("坚持") || lower.includes("放弃") || lower.includes("换一个") || lower.includes("choos") || lower.includes("between") || lower.includes("decision") || lower.includes("quit")) {
    return usesChinese
      ? "先比较两个方向未来三个月的收益、成本和最坏结果。你现在更在意稳定，还是成长？"
      : "Compare each option's next-three-month upside, cost, and worst case. Do you value stability or growth more right now?";
  }
  if (/[?？]/u.test(lower) || lower.includes("怎么") || lower.includes("为什么") || lower.includes("怎么办") || lower.includes("how") || lower.includes("why") || lower.includes("what")) {
    return usesChinese
      ? "我们把问题拆小一点：你已经尝试过什么，最卡住你的具体一步是什么？"
      : "Let's narrow it down: what have you tried, and which exact step is blocking you?";
  }
  const variants = usesChinese
    ? [
        "这件事值得认真聊聊。你现在最希望先解决哪一部分？",
        "我明白你的重点了。对你来说，理想的结果应该是什么样？",
        "我们可以继续往下梳理，刚才这件事最让你在意的是什么？"
      ]
    : [
        "That sounds worth unpacking. Which part would you like to solve first?",
        "I understand your point. What would a good outcome look like for you?",
        "Let’s stay with that. What matters most to you in this situation?"
      ];
  const index = Array.from(String(text || "")).reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 0) % variants.length;
  return variants[index];
}

function deepSeekSystemPrompt(body) {
  const directions = Array.isArray(body.activeDirections) ? body.activeDirections : [];
  const tones = Array.isArray(body.toneTopics) ? body.toneTopics.join(", ") : "General";
  const vibes = Array.isArray(body.vibeMoods) ? body.vibeMoods.join(", ") : "Warm";
  const vibeBehavior = vibeBehaviorGuide(body.vibeMoods);
  const roleMode = body.roleMode || "Supportive";
  const listenerName = body.listener?.name || "Sarah";
  const listenerGender = body.listener?.gender || "unspecified";
  const replyStyle = body.listener?.replyStyle || "warm, natural, and supportive";
  const sceneContext = String(body.sceneContext || "").trim().slice(0, 500);
  const requestedLanguage = String(body.inputLanguage || "en").trim().slice(0, 24);
  const inputLanguage = /^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/u.test(requestedLanguage) ? requestedLanguage : "en";
  return `
You are ${listenerName}, a virtual friend in SquadLive.
Act like an attentive, emotionally intelligent member of the live audience. Stay focused on what the streamer says, how the conversation develops, and any safe visual context provided below.
Companion gender: ${listenerGender}.
Reply style: ${replyStyle}.
Role mode: ${roleMode}.
Current visual context: ${sceneContext || "The latest frame is still being analyzed. Do not claim that you cannot see the stream; ask the streamer to hold an item closer if visual detail matters."}
Required response language code: ${inputLanguage}. Reply entirely in this language. Do not switch languages because of device settings, previous messages, names, or visual labels.
Reply directly to the streamer based on what they just said.
Tone topics: ${tones}.
Vibe: ${vibes}.
Vibe behavior: ${vibeBehavior}
Vibe behavior overrides role mode and active directions whenever they conflict.
Active directions: ${directions.join(", ") || "general, compliment"}.
${activeDirectionGuide(directions)}
Always reply in the language identified by the required response language code. Do not switch languages because of device settings, earlier messages, names, or visual labels.
Answer the actual question or intent first. If the speech transcript is incomplete, garbled, or ambiguous, ask one brief clarification instead of guessing.
Unless Haters vibe is active, include a compliment only when it is relevant to what the streamer just said or to reliable visual context. Do not force a compliment into every reply.
Do not sound scripted. Do not repeat the same compliment style. Usually use 1-2 short sentences, but do not force an unnatural cutoff. When the topic genuinely benefits from detail, a deeper reply may use 3-4 concise sentences. Avoid long, repetitive paragraphs.
Do not merely repeat or paraphrase the user's words. React to their meaning and move the conversation forward.
Use visual context only when it directly helps with the streamer's latest message. Treat visual labels as uncertain, say "it looks like" when needed, never invent details, and never infer sensitive traits, health, identity, or private information. Never say that you cannot see the stream.
If the user says it is nice to meet you, warmly say it is nice to meet them too and ask one natural follow-up question.
`.trim();
}

function activeDirectionGuide(directions) {
  const guidance = {
    general: "Stay conversational and directly answer their point.",
    agree: "Agree when appropriate and keep the energy supportive.",
    disagree: "Offer gentle pushback without becoming argumentative.",
    compliment: "Give a specific, natural compliment when it fits.",
    beauty: "Notice styling, expression, or camera presence in a respectful way.",
    fashion: "React to styling or visual presentation when relevant.",
    health: "Keep the response calming, grounding, and reassuring.",
    lifestyle: "Respond with familiarity and care to daily-life updates.",
    travel: "Engage naturally with places, plans, or experiences they mention."
  };

  return directions
    .map((direction) => guidance[String(direction).toLowerCase()])
    .filter(Boolean)
    .join(" ");
}

function vibeBehaviorGuide(vibes) {
  const activeVibes = Array.isArray(vibes) ? vibes.map((value) => String(value)) : [];
  if (activeVibes.includes("Haters")) {
    return "Be skeptical, blunt, and lightly snarky. Challenge weak claims and tease the streamer without threats, slurs, discrimination, or attacks on protected traits. Do not add automatic compliments.";
  }

  const guidance = {
    Hype: "React like an excited superfan with energetic encouragement and celebration.",
    Happy: "Sound cheerful, warm, optimistic, and genuinely delighted by the conversation.",
    Flirty: "Use playful, respectful flirting and light camera chemistry without becoming explicit or possessive.",
    Funny: "Prioritize playful jokes, witty reactions, callbacks, and comedic timing.",
    Curious: "Ask specific follow-up questions and explore details instead of giving generic praise."
  };

  const selectedGuidance = activeVibes.map((vibe) => guidance[vibe]).filter(Boolean);
  return selectedGuidance.length > 0 ? selectedGuidance.join(" ") : "Stay warm and conversational.";
}

function conversationHistory(body) {
  if (!Array.isArray(body.history)) return [];

  return body.history
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-8)
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 800) }))
    .filter((item) => item.content.length > 0);
}

function conciseReply(answer, userText, replyDepth = 0.62) {
  const text = String(answer || "").trim();
  const prefersDepth = Number(replyDepth || 0) > 0.72;
  const maxLength = /[\u3400-\u9fff]/u.test(String(userText || ""))
    ? (prefersDepth ? 160 : 110)
    : (prefersDepth ? 360 : 240);
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;

  const shortened = characters.slice(0, maxLength).join("");
  const punctuation = ["。", "！", "？", ".", "!", "?"];
  const sentenceEnd = Math.max(...punctuation.map((mark) => shortened.lastIndexOf(mark)));
  if (sentenceEnd >= Math.floor(maxLength * 0.45)) {
    return shortened.slice(0, sentenceEnd + 1).trim();
  }
  return `${shortened.trim()}…`;
}

async function callDeepSeek(body) {
  const fallback = (reason, providerStatus = null) => ({
    answer: localAIReply(body.text, body.inputLanguage),
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
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: deepSeekModel,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: deepSeekSystemPrompt(body) },
          ...conversationHistory(body),
          { role: "user", content: String(body.text || "") }
        ],
        temperature: 0.74,
        max_tokens: body.replyDepth > 0.72 ? 140 : 96
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

    return { answer: conciseReply(answer, body.text, body.replyDepth), source: "deepseek", reason: null, providerStatus: response.status };
  } catch (error) {
    console.error("DeepSeek network error", error);
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    return fallback(isTimeout ? "timeout" : "network_error");
  }
}

async function route(req, res) {
  if (req.method === "OPTIONS") return jsonResponse(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);

  const inboxRoute=/^\/v1\/partners\/([a-z]+)\/(transactions|notifications|app-transactions)$/.exec(url.pathname);
  if(req.method==='POST'&&inboxRoute){
    const body=await readJSON(req);
    return jsonResponse(res,200,await sharedInbox.receive(inboxRoute[1],inboxRoute[2],inboxRoute[2]==='notifications'?body.signedPayload:inboxRoute[2]==='app-transactions'?body.signed_app_transaction:body.signed_transaction));
  }
  if (req.method === "GET" && landingAssets.has(url.pathname)) {
    const asset = landingAssets.get(url.pathname);
    const data = await readFile(asset.path);
    res.writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=604800, immutable"
    });
    return res.end(data);
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return jsonResponse(res, 200, {
      ok: true,
      service: "squadlive-backend",
      revision: deploymentRevision,
      activeAIRequests,
      queuedAIRequests: pendingAIRequests.length,
      payments: {
        appStoreVerificationConfigured: Boolean(appleAppId),
        appStoreOnlineChecks: appleOnlineChecks,
        notificationsEndpoint: `${publicBaseURL}/v1/storekit/notifications`,
        notificationVerificationConfigured: Boolean(appleAppId || process.env.NODE_ENV !== "production"),
        productionReady: process.env.NODE_ENV !== "production" || Boolean(appleAppId)
      }
    });
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(homePagePath, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "GET" && url.pathname === "/admin") {
    const html = await readFile(adminPagePath, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "GET" && (url.pathname === "/support" || url.pathname === "/support/")) {
    const html = await readFile(supportPagePath, "utf8");
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

  if(req.method==='POST' && url.pathname==='/v1/partner/session') {
    if(!partnerClient)return jsonResponse(res,503,{error:'Referral service is not configured'});
    return jsonResponse(res,200,await anonymousAuth.session(await readJSON(req),req));
  }
  if(req.method==='GET' && ['/apple-app-site-association','/.well-known/apple-app-site-association'].includes(url.pathname)) {
    return jsonResponse(res,200,{applinks:{details:[{appIDs:['D9QJA58T8W.'+appleBundleId],components:[{'/':'/invite'}]}]}});
  }
  if(req.method==='GET' && url.pathname==='/invite') {
    const code=url.searchParams.get('code')||'';
    if(!/^PC[A-F0-9]{12}$/.test(code))return jsonResponse(res,400,{error:'Invalid referral link'});
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>SquadLive invitation</title><main style="font:18px system-ui;max-width:600px;margin:60px auto;padding:24px"><h1>Open SquadLive</h1><p>Opening this referral link associates eligible new users with the person who shared it. Existing referrals remain unchanged. No reward is granted until verified.</p><p><a href="https://apps.apple.com/app/id6792211208">Download on the App Store</a></p><p>After installing, return to the original sharing page and tap Open SquadLive. If needed, enter this code in the app: <b>'+code+'</b>.</p></main>');
  }
  if (url.pathname === '/v1/partner/attribution') {
    if(!partnerClient)return jsonResponse(res,503,{error:'Referral service is not configured'});
    let identity;try{identity=await verifyPartnerIdentity(new Request('https://app.local',{headers:{authorization:req.headers.authorization||''}}))}catch{return jsonResponse(res,401,{error:'Installation authorization required'})}
    if(req.method==='GET')return jsonResponse(res,200,await partnerAttribution.status(identity));
    if(req.method!=='POST')return jsonResponse(res,405,{error:'Method not allowed'});
    const body=await readJSON(req),code=String(body.code||'').trim().toUpperCase();
    if(body.action==='preview')return jsonResponse(res,200,await partnerAttribution.preview(identity,code));
    if(body.action==='bind')return jsonResponse(res,200,await partnerAttribution.bind(identity,code,body.confirmed));
    return jsonResponse(res,400,{error:'Invalid action'});
  }

  if (url.pathname.startsWith('/v1/benefits')) {
    res.setHeader('Cache-Control','no-store');
    if (!benefitGateway) return jsonResponse(res,503,{error:'Invite benefits are not available yet'});
    if (req.method === 'POST' && url.pathname === '/v1/benefits/challenge') {
      try { return jsonResponse(res,200,benefitAuth.challenge()); }
      catch { return jsonResponse(res,429,{error:'Please try again later'}); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/benefits/session') {
      try { return jsonResponse(res,200,await benefitAuth.login(await readJSON(req))); }
      catch { return jsonResponse(res,401,{error:'Sign in with the Apple account linked in Settings'}); }
    }
    if (url.pathname !== '/v1/benefits') return jsonResponse(res,404,{error:'Not found'});
    if (!['GET','POST'].includes(req.method)) return jsonResponse(res,405,{error:'Method not allowed'});
    const body = req.method === 'POST' ? JSON.stringify(await readJSON(req)) : undefined;
    const result = await benefitGateway(new Request('https://app.local/v1/benefits',{method:req.method,headers:{authorization:req.headers.authorization || '', 'content-type':'application/json'},body}));
    return jsonResponse(res,result.status,await result.json());
  }

  const store = await getStore();

  if (req.method === "POST" && url.pathname === "/v1/auth/apple") {
    const body = await readJSON(req);
    const deviceId = String(body.deviceId || "").trim();
    if (!deviceId || deviceId.length > 200) return jsonResponse(res, 400, { error: "Invalid device account" });
    let identity;
    try {
      identity = await verifyAppleIdentityToken(body.identityToken);
    } catch (error) {
      return jsonResponse(res, 401, { error: error.message || "Invalid Apple identity" });
    }
    const subject = identity.sub;
    const linkedUserId = store.userIdsByAppleSubject[subject];
    const linkedUser = linkedUserId ? store.users[linkedUserId] : null;
    const existingDeviceUserId = store.userIdsByDevice[deviceId];
    const existingDeviceUser = existingDeviceUserId ? store.users[existingDeviceUserId] : null;
    const currentUser = existingDeviceUser || linkedUser || getOrCreateUser(store, deviceId, req);
    if (currentUser.appleSubject && currentUser.appleSubject !== subject) {
      return jsonResponse(res,409,{error:'This wallet is linked to a different Apple account'});
    }
    if (linkedUser && linkedUser.id !== currentUser.id) {
      if (canMergeUnlinkedDeviceUser(store, currentUser)) {
        delete store.users[currentUser.id];
        store.userIdsByDevice[deviceId] = linkedUser.id;
        linkedUser.lastSeenAt = new Date().toISOString();
        recordUserNetwork(store, linkedUser, req);
        await saveStore(store);
        return jsonResponse(res, 200, { user: userPublic(linkedUser), linked: true, migrated: true });
      }
      return jsonResponse(res, 409, {
        error: "This device already has a different wallet. Contact support before linking accounts.",
        existingDeviceUser: userPublic(currentUser),
        appleUser: userPublic(linkedUser)
      });
    }
    currentUser.appleSubject = subject;
    currentUser.appleEmail = typeof identity.email === "string" ? identity.email.slice(0, 320) : currentUser.appleEmail || "";
    if (body.displayName && !currentUser.displayName) currentUser.displayName = String(body.displayName).trim().slice(0, 80);
    store.userIdsByAppleSubject[subject] = currentUser.id;
    store.userIdsByDevice[deviceId] = currentUser.id;
    await saveStore(store);
    return jsonResponse(res, 200, { user: userPublic(currentUser), linked: Boolean(linkedUser), migrated: false });
  }

  if (req.method === "POST" && url.pathname === "/v1/users/bootstrap") {
    const body = await readJSON(req);
    const user = getOrCreateUser(store, body.deviceId || "anonymous", req);
    await saveStore(store);
    return jsonResponse(res, 200, { user: userPublic(user) });
  }

  const userMatch = url.pathname.match(/^\/v1\/users\/([^/]+)$/);
  if (req.method === "GET" && userMatch) {
    const user = store.users[userMatch[1]];
    return user ? jsonResponse(res, 200, { user: userPublic(user) }) : jsonResponse(res, 404, { error: "User not found" });
  }

  if (req.method === "POST" && url.pathname === "/v1/ai/deepseek") {
    const body = await readJSON(req);
    const requestStartedAt = Date.now();
    recordDailyMetric(store, "aiRequests");
    let user = body.userId ? store.users[body.userId] : null;
    if (!user && body.deviceId) {
      user = getOrCreateUser(store, String(body.deviceId).slice(0, 200), req);
    }
    if (user) {
      user.lastSeenAt = new Date().toISOString();
      recordUserNetwork(store, user, req);
      if (typeof body.userName === "string" && body.userName.trim()) {
        user.displayName = body.userName.trim().slice(0, 80);
      }
    }
    recordDailyActiveUser(store, user?.id);

    let result;
    try {
      result = await runQueuedAIRequest(() => callDeepSeek(body));
    } catch (error) {
      if (error.status === 503) recordDailyMetric(store, "aiQueueRejected");
      throw error;
    }

    const latencyMs = Date.now() - requestStartedAt;
    const usage = dailyUsage(store);
    usage.aiLatencyTotalMs += latencyMs;
    usage.aiLatencyMaxMs = Math.max(Number(usage.aiLatencyMaxMs || 0), latencyMs);
    usage.peakAIConcurrency = Math.max(Number(usage.peakAIConcurrency || 0), runtimeMetrics.maxActiveAIRequests);
    if (result.source === "deepseek") {
      usage.aiSuccesses += 1;
    } else {
      usage.aiFallbacks += 1;
      if (result.reason === "timeout") usage.aiTimeouts += 1;
      if (["missing_key", "provider_error", "empty_response", "network_error"].includes(result.reason)) {
        usage.aiUnavailable += 1;
      }
      runtimeMetrics.lastAIErrorAt = new Date().toISOString();
      runtimeMetrics.lastAIErrorReason = result.reason || "unknown";
    }
    scheduleMetricsSave(store);
    if (user) {
      recordAIConversation(store, {
        userId: user.id,
        userText: body.text,
        aiText: result.answer,
        listenerName: body.listener?.name,
        source: result.source,
        interactionType: body.interactionType === "system_opening" ? "system_opening" : "user"
      });
      await saveStore(store);
    }
    return jsonResponse(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/v1/live/events") {
    const body = await readJSON(req);
    const user = walletUser(store, body, req);
    if (!user) return jsonResponse(res, 400, { error: "Invalid device account" });
    const eventId = String(body.eventId || "").slice(0, 100);
    const sessionId = String(body.sessionId || "").slice(0, 100);
    const type = String(body.type || "");
    const supportedTypes = new Set(["live_started", "live_start_failed", "user_spoke", "user_typed", "ai_reply_displayed", "live_ended"]);
    if (!eventId || !sessionId || !supportedTypes.has(type)) {
      return jsonResponse(res, 400, { error: "Invalid live event" });
    }
    if (store.liveEvents[eventId]) {
      return jsonResponse(res, 200, { received: true, duplicate: true });
    }
    const existingSession = store.liveSessions[sessionId];
    if (existingSession && existingSession.userId !== user.id) {
      return jsonResponse(res, 409, { error: "Live session belongs to another account" });
    }
    const now = new Date().toISOString();
    const session = existingSession || {
      id: sessionId,
      userId: user.id,
      createdAt: now,
      startedAt: null,
      durationSeconds: 0,
      userInteracted: false,
      aiReplyDisplayed: false
    };
    store.liveSessions[sessionId] = session;
    if (type === "live_started") {
      session.startedAt ||= now;
      dailyUsage(store).liveStartedUserIds[user.id] = true;
      if (user.firstLiveFreeEligible === true && !user.firstLiveFreeUsedAt && Number(user.liveSessionsStarted || 0) === 0) {
        user.liveSessionsStarted = 1;
        user.firstLiveFreeUsedAt = now;
        recordCoinTransaction(store, {
          userId: user.id,
          type: "first_live_free",
          coins: 0,
          amountCents: 0,
          source: "promotion",
          note: "First live started while audience commit was unavailable",
          platformTransactionId: sessionId
        });
      }
    }
    if (type === "live_start_failed") {
      session.startFailedAt = now;
      session.startFailureReason = String(body.reason || "unknown").trim().slice(0, 240);
      session.startFailureCount = Math.max(0, Number(session.startFailureCount || 0)) + 1;
      dailyUsage(store).liveStartFailures = Number(dailyUsage(store).liveStartFailures || 0) + 1;
    }
    if (type === "user_spoke" || type === "user_typed") {
      session.userInteracted = true;
      session.firstInteractionAt ||= now;
      session.firstInteractionType ||= type;
      dailyUsage(store).liveEngagedUserIds[user.id] = true;
    }
    if (type === "ai_reply_displayed") {
      session.aiReplyDisplayed = true;
      session.firstAIReplyAt ||= now;
    }
    if (type === "live_ended") {
      const previousDuration = Math.max(0, Number(session.durationSeconds || 0));
      const durationSeconds = Math.max(previousDuration, Math.min(86_400, Number(body.durationSeconds || 0)));
      session.durationSeconds = durationSeconds;
      session.endedAt = now;
      const usage = dailyUsage(store);
      if (!session.endCountedAt) {
        usage.liveSessionsEnded = Number(usage.liveSessionsEnded || 0) + 1;
        usage.liveDurationTotalSeconds = Number(usage.liveDurationTotalSeconds || 0) + durationSeconds;
        session.endCountedAt = now;
      }
    }
    store.liveEvents[eventId] = { id: eventId, sessionId, userId: user.id, type, createdAt: now };
    const liveEventIds = Object.keys(store.liveEvents);
    for (const oldEventId of liveEventIds.slice(0, Math.max(0, liveEventIds.length - 20_000))) {
      delete store.liveEvents[oldEventId];
    }
    user.lastSeenAt = now;
    recordDailyActiveUser(store, user.id);
    await saveStore(store);
    return jsonResponse(res, 200, { received: true, duplicate: false });
  }

  if (req.method === "POST" && url.pathname === "/v1/activity/ping") {
    const body = await readJSON(req);
    const user = store.users[body.userId];
    if (!user) return jsonResponse(res, 404, { error: "User not found" });
    user.lastSeenAt = new Date().toISOString();
    recordDailyActiveUser(store, user.id);
    await saveStore(store);
    return jsonResponse(res, 200, { user: userPublic(user) });
  }

  if (req.method === "POST" && url.pathname === "/v1/wallet/balance") {
    const body = await readJSON(req);
    const user = walletUser(store, body, req);
    if (!user) return jsonResponse(res, 400, { error: "Invalid device account" });
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
    const user = walletUser(store, body, req);
    if (!user) return jsonResponse(res, 400, { error: "Invalid device account" });
    const operationId = walletOperationId(body);
    if (!operationId) return jsonResponse(res, 400, { error: "Invalid wallet operation ID" });
    const viewers = Math.max(0, Number(body.viewers || 0));
    const context = body.context === "live" ? "live" : "lobby";
    const regularCost = context === "live" ? liveViewerPacks.get(viewers) : viewerCost(viewers);
    if (typeof regularCost !== "number" || regularCost < 0 || (context === "live" && regularCost === 0)) {
      return jsonResponse(res, 400, { error: "Unsupported viewer package" });
    }

    const existingOperation = walletOperationResponse(store, operationId, user);
    if (existingOperation) {
      if (!audienceOperationMatches(existingOperation, viewers, context, regularCost)) {
        return jsonResponse(res, 409, { error: "Wallet operation parameters do not match the original request" });
      }
      return jsonResponse(res, 200, {
        user: userPublic(user),
        viewers: existingOperation.viewers || viewers,
        cost: Math.abs(existingOperation.coins),
        regularCost: existingOperation.regularCost ?? regularCost,
        firstLiveFree: Boolean(existingOperation.firstLiveFree),
        duplicate: true,
        operationId
      });
    }
    if (store.walletOperations[operationId] && store.walletOperations[operationId].userId !== user.id) {
      return jsonResponse(res, 409, { error: "Wallet operation belongs to another account" });
    }

    const firstLiveFree = context === "lobby"
      && user.firstLiveFreeEligible === true
      && !user.firstLiveFreeUsedAt
      && Number(user.liveSessionsStarted || 0) === 0;
    const cost = firstLiveFree ? 0 : regularCost;
    let result;
    try {
      if (cost > 0) {
        result = spendWalletCoins(store, user, cost, operationId, `${context}:${viewers} viewers`);
        Object.assign(result.operation, { viewers, context, regularCost, firstLiveFree: false });
      } else {
        result = {
          operation: recordWalletOperation(store, {
            id: operationId,
            userId: user.id,
            type: firstLiveFree ? "first_live_free" : "live_session_start",
            coins: 0,
            balanceAfter: user.coins,
            viewers,
            context,
            regularCost,
            firstLiveFree,
            note: firstLiveFree
              ? `First live free: waived ${regularCost} coins for ${viewers} viewers`
              : `${context}:${viewers} viewers`
          }),
          duplicate: false
        };
      }
    } catch (error) {
      if (error.status === 402) {
        return jsonResponse(res, 402, { error: error.message, cost, regularCost, coins: error.coins });
      }
      throw error;
    }
    if (context === "lobby" && !result.duplicate) {
      user.liveSessionsStarted = Math.max(0, Number(user.liveSessionsStarted || 0)) + 1;
      if (firstLiveFree) {
        user.firstLiveFreeUsedAt = new Date().toISOString();
        recordCoinTransaction(store, {
          userId: user.id,
          type: "first_live_free",
          coins: 0,
          amountCents: 0,
          source: "promotion",
          note: `Waived ${regularCost} coins for ${viewers} viewers`,
          platformTransactionId: operationId
        });
      }
    }
    await saveStore(store);
    return jsonResponse(res, 200, {
      user: userPublic(user),
      viewers,
      cost,
      regularCost,
      firstLiveFree,
      duplicate: result.duplicate,
      operationId
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/storekit/notifications") {
    const body = await readJSON(req);
    const { payload: notification, verifier } = await verifyAppleNotification(body.signedPayload);
    const notificationUUID = String(notification.notificationUUID || "");
    if (!notificationUUID) return jsonResponse(res, 400, { error: "Missing notification UUID" });
    if (store.appleNotifications[notificationUUID]) {
      return jsonResponse(res, 200, { received: true, duplicate: true });
    }

    const data = notification.data || {};
    if (data.bundleId && data.bundleId !== appleBundleId) {
      return jsonResponse(res, 400, { error: "Notification bundle ID does not match" });
    }

    let transaction = null;
    let renewalInfo = null;
    if (data.signedTransactionInfo) {
      transaction = await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo);
    }
    if (data.signedRenewalInfo) {
      renewalInfo = await verifier.verifyAndDecodeRenewalInfo(data.signedRenewalInfo);
    }

    const notificationType = String(notification.notificationType || "");
    const subtype = String(notification.subtype || "");
    const transactionId = String(transaction?.transactionId || "");
    const originalTransactionId = String(transaction?.originalTransactionId || renewalInfo?.originalTransactionId || "");
    const productId = String(transaction?.productId || renewalInfo?.productId || "");
    if (productId && !appStoreSubscriptionProducts.has(productId) && !appStoreCoinAmounts[productId]) {
      return jsonResponse(res, 400, { error: "Unsupported App Store subscription" });
    }

    if(transaction)await partnerAttribution.recordVerified(transaction,data.signedTransactionInfo,{refund:notificationType==='REFUND'||notificationType==='REVOKE'});
    const status = subscriptionStateFromNotification(notificationType, subtype, transaction, renewalInfo);
    const expiresAt = isoFromAppleMillis(transaction?.expiresDate);
    const gracePeriodExpiresAt = isoFromAppleMillis(renewalInfo?.gracePeriodExpiresDate);
    const eventSignedDate = Number(notification.signedDate || 0);
    const user = findUserForAppleSubscription(store, transaction, renewalInfo, originalTransactionId);
    store.appleNotifications[notificationUUID] = {
      notificationUUID,
      notificationType,
      subtype,
      transactionId,
      originalTransactionId,
      productId,
      environment: data.environment || transaction?.environment || renewalInfo?.environment || "",
      signedDate: eventSignedDate,
      receivedAt: new Date().toISOString(),
      userId: user?.id || null,
      status: user ? "processed" : "unlinked"
    };

    if (user && originalTransactionId && appStoreSubscriptionProducts.has(productId)) {
      const currentSubscription = store.vipSubscriptions[originalTransactionId];
      const currentSignedDate = Number(currentSubscription?.lastEventSignedDate || 0);
      if (!currentSubscription || eventSignedDate >= currentSignedDate) {
        store.vipSubscriptions[originalTransactionId] = {
          id: originalTransactionId,
          userId: user.id,
          planId: productId,
          status,
          amountCents: transaction?.price ? applePriceToMinorUnits(transaction.price) : Number(currentSubscription?.amountCents || 0),
          currency: appleCurrency(transaction, currentSubscription?.currency),
          platformTransactionId: transactionId || currentSubscription?.platformTransactionId || "",
          originalTransactionId,
          startedAt: isoFromAppleMillis(transaction?.originalPurchaseDate) || currentSubscription?.startedAt || new Date().toISOString(),
          expiresAt: expiresAt || currentSubscription?.expiresAt || null,
          gracePeriodExpiresAt: gracePeriodExpiresAt || null,
          autoRenewStatus: renewalInfo?.autoRenewStatus ?? currentSubscription?.autoRenewStatus ?? null,
          environment: data.environment || transaction?.environment || renewalInfo?.environment || currentSubscription?.environment || "",
          lastEventSignedDate: eventSignedDate,
          updatedAt: new Date().toISOString()
        };
        refreshUserPremiumStatus(store, user);
        user.lastSeenAt = new Date().toISOString();
      }
    }

    await saveStore(store);
    return jsonResponse(res, 200, { received: true, notificationType, transactionId });
  }

  if (req.method === "POST" && url.pathname === "/v1/storekit/coins/claim") {
    const body = await readJSON(req);
    const deviceId = String(body.deviceId || "").trim();
    const normalizedAccountToken = deviceId.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
      return jsonResponse(res, 400, { error: "Invalid device account token" });
    }

    const payload = await verifyAppleTransaction(body.signedTransaction);
    const transactionId = String(payload.transactionId || "");
    const productId = String(payload.productId || "");
    const baseCoinAmount = appStoreCoinAmounts[productId];
    if (!transactionId || !baseCoinAmount || payload.type !== "Consumable") {
      return jsonResponse(res, 400, { error: "Unsupported App Store product" });
    }
    if (payload.revocationDate) {
      return jsonResponse(res, 409, { error: "This App Store transaction was revoked" });
    }
    const user = await verifiedPurchaseUser(store,req,payload,deviceId);
    await partnerAttribution.recordClaim(payload,body.signedTransaction);
    const existingClaim = store.appleTransactions[transactionId];
    if (existingClaim) {
      if (existingClaim.userId !== user.id) {
        return jsonResponse(res, 409, { error: "Transaction has already been claimed" });
      }
      return jsonResponse(res, 200, {
        user: userPublic(user),
        creditedCoins: existingClaim.coins,
        balance: user.coins,
        duplicate: true,
        transactionId
      });
    }

    const quantity = Number(payload.quantity || 1);
    if (!Number.isInteger(quantity) || quantity !== 1) {
      return jsonResponse(res, 400, { error: "Consumable purchases must contain exactly one item" });
    }
    const creditedCoins = baseCoinAmount;
    user.coins += creditedCoins;
    user.lastSeenAt = new Date().toISOString();
    store.appleTransactions[transactionId] = {
      transactionId,
      originalTransactionId: payload.originalTransactionId || transactionId,
      userId: user.id,
      productId,
      coins: creditedCoins,
      environment: payload.environment || "",
      purchaseDate: payload.purchaseDate ? new Date(payload.purchaseDate).toISOString() : null,
      claimedAt: new Date().toISOString()
    };
    recordCoinTransaction(store, {
      userId: user.id,
      type: "coin_purchase",
      coins: creditedCoins,
      amountCents: appStoreCoinPricesUSDCents[productId] * quantity,
      currency: "USD",
      source: "app_store_verified",
      note: productId,
      platformTransactionId: transactionId,
      productId,
      environment: payload.environment || ""
    });
    await saveStore(store);
    return jsonResponse(res, 200, {
      user: userPublic(user),
      creditedCoins,
      balance: user.coins,
      duplicate: false,
      transactionId
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/storekit/subscriptions/claim") {
    const body = await readJSON(req);
    const deviceId = String(body.deviceId || "").trim();
    const normalizedAccountToken = deviceId.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
      return jsonResponse(res, 400, { error: "Invalid device account token" });
    }

    const payload = await verifyAppleTransaction(body.signedTransaction);
    const transactionId = String(payload.transactionId || "");
    const originalTransactionId = String(payload.originalTransactionId || transactionId);
    const productId = String(payload.productId || "");
    if (!transactionId || !originalTransactionId || !appStoreSubscriptionProducts.has(productId) || payload.type !== "Auto-Renewable Subscription") {
      return jsonResponse(res, 400, { error: "Unsupported App Store subscription" });
    }
    const user = await verifiedPurchaseUser(store,req,payload,deviceId);
    await partnerAttribution.recordClaim(payload,body.signedTransaction);
    const existingClaim = store.appleTransactions[transactionId];
    if (existingClaim && existingClaim.userId !== user.id) {
      return jsonResponse(res, 409, { error: "Transaction has already been claimed" });
    }

    const expirationDate = payload.expiresDate ? new Date(payload.expiresDate) : null;
    const isActive = !payload.revocationDate && (!expirationDate || expirationDate > new Date());
    store.appleTransactions[transactionId] ||= {
      transactionId,
      originalTransactionId,
      userId: user.id,
      productId,
      kind: "subscription",
      environment: payload.environment || "",
      purchaseDate: payload.purchaseDate ? new Date(payload.purchaseDate).toISOString() : null,
      claimedAt: new Date().toISOString()
    };
    const currentSubscription = store.vipSubscriptions[originalTransactionId];
    const currentExpiration = currentSubscription?.expiresAt ? new Date(currentSubscription.expiresAt).getTime() : 0;
    const incomingExpiration = expirationDate?.getTime() || 0;
    const currentSignedDate = Number(currentSubscription?.lastEventSignedDate || 0);
    const incomingSignedDate = Number(payload.signedDate || 0);
    const shouldReplaceSubscription = !currentSubscription
      || Boolean(payload.revocationDate)
      || incomingSignedDate >= currentSignedDate
      || incomingExpiration >= currentExpiration;
    if (shouldReplaceSubscription) {
      store.vipSubscriptions[originalTransactionId] = {
        id: originalTransactionId,
        userId: user.id,
        planId: productId,
        status: payload.revocationDate ? "revoked" : (isActive ? "active" : "expired"),
        amountCents: applePriceToMinorUnits(payload.price),
        currency: appleCurrency(payload),
        platformTransactionId: transactionId,
        originalTransactionId,
        startedAt: payload.originalPurchaseDate ? new Date(payload.originalPurchaseDate).toISOString() : new Date().toISOString(),
        expiresAt: expirationDate?.toISOString() || null,
        gracePeriodExpiresAt: null,
        autoRenewStatus: null,
        environment: payload.environment || "",
        lastEventSignedDate: incomingSignedDate,
        updatedAt: new Date().toISOString()
      };
    }
    refreshUserPremiumStatus(store, user);
    user.lastSeenAt = new Date().toISOString();
    await saveStore(store);
    return jsonResponse(res, 200, {
      user: userPublic(user),
      subscription: store.vipSubscriptions[originalTransactionId],
      duplicate: Boolean(existingClaim),
      transactionId
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/coins/purchase") {
    if (!mockPurchasesEnabled) return jsonResponse(res, 404, { error: "Not found" });
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
      currency: "USD",
      source: "iap_mock",
      note: pack.id
    });
    await saveStore(store);
    return jsonResponse(res, 200, { user, pack, note: "Mock purchase. Replace with App Store receipt validation." });
  }

  if (req.method === "POST" && url.pathname === "/v1/vip/subscribe") {
    if (!mockPurchasesEnabled) return jsonResponse(res, 404, { error: "Not found" });
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
    const user = walletUser(store, body, req);
    if (!user) return jsonResponse(res, 400, { error: "Invalid device account" });
    const operationId = walletOperationId(body);
    if (!operationId) return jsonResponse(res, 400, { error: "Invalid wallet operation ID" });
    const existingOperation = store.walletOperations[operationId];
    if (existingOperation && existingOperation.userId !== user.id) {
      return jsonResponse(res, 409, { error: "Wallet operation belongs to another account" });
    }
    if (existingOperation) {
      const existingSubmission = Object.values(store.rewardSubmissions)
        .find((item) => item.operationId === operationId && item.userId === user.id);
      return jsonResponse(res, 200, {
        user: userPublic(user),
        submission: existingSubmission || null,
        duplicate: true
      });
    }
    const day = rewardDayKey();
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
      operationId,
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
    recordWalletOperation(store, {
      id: operationId,
      userId: user.id,
      type: "share_submission",
      coins: baseRewardGranted ? 100 : 0,
      balanceAfter: user.coins,
      note: submission.id
    });
    await saveStore(store);
    return jsonResponse(res, 200, { user: userPublic(user), submission, duplicate: false });
  }

  const reviewMatch = url.pathname.match(/^\/v1\/rewards\/([^/]+)\/review$/);
  if (req.method === "POST" && reviewMatch) {
    if (!requireAdmin(req, res)) return;
    const body = await readJSON(req);
    const submission = store.rewardSubmissions[reviewMatch[1]];
    if (!submission) return jsonResponse(res, 404, { error: "Submission not found" });
    const user = store.users[submission.userId];
    const bonus = Math.max(0, Math.min(10000, Number(body.bonusCoins || 0)));
    const shouldGrantReviewBonus = body.status === "approved"
      && submission.status !== "approved"
      && !submission.reviewRewardGrantedAt;
    submission.status = body.status === "approved" ? "approved" : "rejected";
    if (!submission.reviewRewardGrantedAt) {
      submission.reviewBonusCoins = submission.status === "approved" ? bonus : 0;
    }
    submission.reviewedAt = new Date().toISOString();
    if (user && shouldGrantReviewBonus && bonus > 0) {
      user.coins += bonus;
      submission.reviewRewardGrantedAt = new Date().toISOString();
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

    if (req.method === 'GET' && url.pathname === '/v1/admin/partner-attribution') {
      const receipts=Object.values(store.partnerReceipts||{}).map(({signed_transaction,account_token,...record})=>record);
      return jsonResponse(res,200,{bindings:store.partnerBindings||{},receipts:receipts.sort((a,b)=>b.created_at-a.created_at).slice(0,500)});
    }
    if (req.method === "GET" && url.pathname === "/v1/admin/overview") {
      return jsonResponse(res, 200, { overview: await adminOverview(store) });
    }

    if (req.method === "GET" && url.pathname === "/v1/admin/settings") {
      return jsonResponse(res, 200, {
        settings: {
          initialCoins: Number(store.settings?.initialCoins ?? 300)
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/admin/settings") {
      const body = await readJSON(req);
      const initialCoins = Number(body.initialCoins);
      if (!Number.isInteger(initialCoins) || initialCoins < 0 || initialCoins > 1_000_000) {
        return jsonResponse(res, 400, { error: "Initial coins must be an integer from 0 to 1,000,000" });
      }
      store.settings.initialCoins = initialCoins;
      await saveStore(store);
      return jsonResponse(res, 200, { settings: { initialCoins } });
    }

    if (req.method === "GET" && url.pathname === "/v1/admin/users") {
      const query = (url.searchParams.get("query") || "").trim().toLowerCase();
      const users = Object.values(store.users)
        .map((user) => ({
          ...adminUserPublic(user),
          ...userLiveSummary(store, user.id),
          aiConversationCount: Object.values(store.aiConversations).filter((item) => item.userId === user.id && item.interactionType !== "system_opening").length
        }))
        .filter((user) => {
          if (!query) return true;
          return user.id.toLowerCase().includes(query)
            || user.deviceId.toLowerCase().includes(query)
            || user.displayName.toLowerCase().includes(query);
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonResponse(res, 200, { users });
    }

    const adminUserMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)$/);
    if (req.method === "POST" && adminUserMatch) {
      const user = store.users[adminUserMatch[1]];
      if (!user) return jsonResponse(res, 404, { error: "User not found" });
      const body = await readJSON(req);
      const coinDelta = Number(body.coinDelta);
      const note = String(body.note || "Manual operations adjustment").trim().slice(0, 240);
      if (!Number.isInteger(coinDelta) || coinDelta === 0 || Math.abs(coinDelta) > 1_000_000) {
        return jsonResponse(res, 400, { error: "Coin adjustment must be a non-zero integer within ±1,000,000" });
      }
      if (user.coins + coinDelta < 0) {
        return jsonResponse(res, 400, { error: "Adjustment would make the balance negative" });
      }
      user.coins += coinDelta;
      user.lastSeenAt = new Date().toISOString();
      const transaction = recordCoinTransaction(store, {
        userId: user.id,
        type: "admin_adjustment",
        coins: coinDelta,
        amountCents: 0,
        source: "admin",
        note
      });
      await saveStore(store);
      return jsonResponse(res, 200, { user: userPublic(user), transaction });
    }
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
  res.once("finish", () => {
    getStore().then((store) => {
      const usage = dailyUsage(store);
      usage.requests += 1;
      if (res.statusCode >= 500) usage.http5xx += 1;
      else if (res.statusCode >= 400) usage.http4xx += 1;
      scheduleMetricsSave(store);
    }).catch((error) => console.error("Unable to record request metrics", error));
  });

  route(req, res).catch((error) => {
    console.error(error);
    jsonResponse(res, error.status || 500, { error: error.message || "Server error" });
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 30_000;

server.listen(port, () => {
  console.log(`SquadLive backend listening on http://localhost:${port}`);
});

const partnerRetryTimer = setInterval(()=>partnerAttribution.drain().catch(()=>console.error('Partner delivery retry failed')),30000);
partnerRetryTimer.unref();
let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(partnerRetryTimer);
  console.log(`Received ${signal}; flushing data before shutdown.`);
  if (metricsSaveTimer) {
    clearTimeout(metricsSaveTimer);
    metricsSaveTimer = null;
  }
  try {
    const store = await getStore();
    await saveStore(store);
    await saveQueue;
  } catch (error) {
    console.error("Final persistence failed", error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
