import assert from "node:assert/strict";
import test from "node:test";
import { recordForeground, userActivityReport } from "../user-activity.mjs";

test("foreground retries and overlap are counted once and split at UTC midnight", () => {
  const user = { id: "u" };
  const midnight = Date.parse("2026-11-26T00:00:00Z");
  const now = midnight + 30_000;
  const first = { startMs: midnight - 10_000, endMs: midnight + 20_000 };
  assert.equal(recordForeground(user, first, now).length, 2);
  recordForeground(user, first, now);
  recordForeground(user, { startMs: midnight + 10_000, endMs: now }, now);
  assert.deepEqual(recordForeground(user, { startMs: now - 120_000, endMs: now }, now), []);
  assert.deepEqual(recordForeground(user, { startMs: now, endMs: now + 20_000 }, now), []);
  const report = userActivityReport({ users: { u: user } }, now);
  assert.equal(report.byUser.get("u").today.foregroundMs, 30_000);
  assert.equal(report.byUser.get("u").yesterday.foregroundMs, 10_000);
  assert.equal(report.overview.totals.sevenDays.foregroundUsers, 1);
  assert.equal(report.overview.totals.sevenDays.foregroundMs, 40_000);
});

test("retention uses closed UTC days, and totals use completed lives and actual spending", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const users = {
    u: { id: "u", createdAt: "2026-11-18T08:00:00Z" },
    v: { id: "v", createdAt: "2026-11-24T07:00:00Z" },
    w: { id: "w", createdAt: "2026-11-25T07:00:00Z" }
  };
  const at = "2026-11-26T11:00:00Z";
  const coinTransactions = [
    { userId: "u", type: "coin_spend", coins: -30, createdAt: at },
    { userId: "u", type: "admin_adjustment", coins: -50, createdAt: at },
    { userId: "u", type: "coin_purchase", coins: 500, createdAt: at },
    { userId: "u", type: "coin_spend", coins: -80, createdAt: "2026-11-19T23:59:59Z" }
  ];
  const liveSessions = [
    { userId: "u", startedAt: "2026-11-25T23:59:50Z", endedAt: "2026-11-26T00:00:20Z", durationSeconds: 30 },
    { userId: "v", startedAt: at, durationSeconds: 0 }
  ];
  const dailyUsage = { "2026-11-25": { activeUserIds: { u: true } }, "2026-11-26": { activeUserIds: { w: true } } };
  const { byUser, overview } = userActivityReport({ users, coinTransactions, liveSessions, dailyUsage }, now);
  assert.deepEqual(byUser.get("u").today, { foregroundMs: null, liveMs: 20_000, coinsSpent: 30 });
  assert.equal(byUser.get("u").yesterday.liveMs, 10_000);
  assert.equal(byUser.get("v").today.liveMs, null);
  assert.equal(overview.totals.sevenDays.coinsSpent, 30);
  assert.deepEqual([overview.retention[1].returned, overview.retention[1].registered], [0, 1]);
  assert.deepEqual([overview.retention[7].returned, overview.retention[7].registered], [1, 1]);
});
