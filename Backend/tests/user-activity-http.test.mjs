import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("live counts and wallet spending agree in the admin list and profile", { timeout: 15000 }, async () => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));

  const directory = await mkdtemp(join(tmpdir(), "squadlive-activity-test-"));
  const admin = "local-activity-test-admin";
  const credential = "anon_" + "a".repeat(43);
  const deviceId = "10000000-0000-4000-8000-000000000001";
  const user = { id: "user_fixture", deviceId, coins: 300, createdAt: new Date(Date.now() - 60_000).toISOString() };
  await writeFile(join(directory, "store.json"), JSON.stringify({
    users: { [user.id]: user },
    partnerAnonymousAccounts: { anon_fixture: { walletUserId: user.id, createdAt: user.createdAt } },
    partnerAnonymousCredentials: { [createHash("sha256").update(credential).digest("hex")]: "anon_fixture" }
  }));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: directory, ADMIN_TOKEN: admin, IP_GEOLOCATION_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", data => logs += data);
  child.stderr.on("data", data => logs += data);

  function call(path, body, token) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  try {
    for (let i = 0; i < 100 && !logs.includes("backend listening"); i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.match(logs, /backend listening/);
    const endMs = Date.now() - 100;
    const interval = { startMs: endMs - 20_000, endMs };
    assert.equal((await call("/v1/activity/foreground", interval)).status, 401);
    for (const body of [interval, interval]) {
      assert.equal((await call("/v1/activity/foreground", body, credential)).status, 200);
    }
    const spend = { deviceId, operationId: "activity-test-spend", context: "live", viewers: 5000 };
    const spent = await call("/v1/audience/commit", spend);
    assert.equal(spent.status, 200);
    assert.equal((await spent.json()).cost, 15);
    for (const type of ["live_started", "live_start_failed"]) {
      const event = { deviceId, type, sessionId: type, eventId: type };
      assert.equal((await call("/v1/live/events", event)).status, 200);
      assert.equal((await call("/v1/live/events", event)).status, 200);
    }
    assert.equal((await call("/v1/admin/users")).status, 401);
    const list = await (await call("/v1/admin/users?query=no-match", null, admin)).json();
    assert.deepEqual(list.users, []);
    assert.equal(list.activity.totals.sevenDays.liveCount, 1);
    assert.equal(list.activity.totals.sevenDays.coinsSpent, 15);
    const profile = await (await call("/v1/admin/users/" + user.id, null, admin)).json();
    assert.deepEqual(profile.user.activity.sevenDays, list.activity.totals.sevenDays);
    assert.equal(profile.user.activity.sevenDays.averageLiveMs, null);
    assert.equal(profile.user.activity.daily.length, 7);
    const yesterday = new Date(Date.now() - 86_400_000);
    yesterday.setUTCHours(12, 0, 0, 0);
    const yesterdayStart = yesterday.getTime();
    const delayedSession = { deviceId, sessionId: "offline-live" };
    const endEvent = { ...delayedSession, type: "live_ended", eventId: "offline-end", occurredAtMs: yesterdayStart + 126_000, durationSeconds: 126 };
    assert.equal((await call("/v1/live/events", endEvent)).status, 200);
    assert.equal((await call("/v1/live/events", endEvent)).status, 200);
    const startEvent = { ...delayedSession, type: "live_started", eventId: "offline-start", occurredAtMs: yesterdayStart };
    assert.equal((await call("/v1/live/events", startEvent)).status, 200);
    const after = await (await call("/v1/admin/users/" + user.id, null, admin)).json();
    assert.equal(after.user.activity.yesterday.liveCount, 1);
    assert.equal(after.user.activity.yesterday.timedLiveCount, 1);
    assert.equal(after.user.activity.yesterday.averageLiveMs, 126_000);

  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  }
});
