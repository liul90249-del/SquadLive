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
  assert.deepEqual(user.foregroundByDay, {
    "2026-11-25": [[midnight - 10_000, midnight]],
    "2026-11-26": [[midnight, now]]
  });
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
    { userId: "u", startedAt: at, endedAt: "2026-11-26T11:02:00Z", durationSeconds: 120 },
    { userId: "v", startedAt: at, endedAt: "2026-11-26T11:01:00Z", durationSeconds: 60 },
    { userId: "v", startedAt: at, durationSeconds: 0 },
    { userId: "v", startFailedAt: at, durationSeconds: 0 }
  ];
  const dailyUsage = { "2026-11-25": { activeUserIds: { u: true } }, "2026-11-26": { activeUserIds: { w: true } } };
  const { byUser, overview } = userActivityReport({ users, coinTransactions, liveSessions, dailyUsage }, now);
  assert.equal(byUser.get("u").today.coinsSpent, 30);
  assert.equal(byUser.get("u").yesterday.liveMs, 30_000);
  assert.equal(byUser.get("v").today.liveCount, 2);
  assert.equal(byUser.get("v").today.timedLiveCount, 1);
  assert.equal(byUser.get("v").today.averageLiveMs, 60_000);
  assert.equal(byUser.get("w").today.liveCount, 0);
  assert.equal(byUser.get("w").today.shortestLiveMs, null);
  assert.deepEqual(overview.totals.sevenDays, {
    liveCount: 4, timedLiveCount: 3, liveMs: 210_000, longestLiveMs: 120_000,
    shortestLiveMs: 30_000, averageLiveMs: 70_000, coinsSpent: 30
  });
  assert.equal(overview.totals.daily.length, 7);
  assert.equal(overview.totals.daily[1].liveCount, 1);
  assert.equal(overview.totals.daily.at(-1).coinsSpent, 0);
  assert.deepEqual([overview.retention[1].returned, overview.retention[1].registered], [0, 1]);
  assert.deepEqual([overview.retention[7].returned, overview.retention[7].registered], [1, 1]);
});

test("five starts with one valid 126-second end report expose partial duration, even if events arrived out of order", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const users = { u: { id: "u" } };
  const liveSessions = Array.from({ length: 5 }, () => ({
    userId: "u", startedAt: "2026-11-26T11:00:01Z"
  }));
  liveSessions[0].endedAt = "2026-11-26T11:00:00Z";
  liveSessions[0].durationSeconds = 126;
  const report = userActivityReport({ users, liveSessions }, now);
  const { liveCount, timedLiveCount, liveMs, longestLiveMs, shortestLiveMs, averageLiveMs } = report.byUser.get("u").today;
  assert.deepEqual([liveCount, timedLiveCount], [5, 1]);
  assert.deepEqual([liveMs, longestLiveMs, shortestLiveMs, averageLiveMs], Array(4).fill(126_000));
});
