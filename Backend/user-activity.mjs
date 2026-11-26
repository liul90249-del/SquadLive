const dayMs = 86_400_000;
const dateKey = (time) => new Date(time).toISOString().slice(0, 10);
const dayStart = (time) => Math.floor(time / dayMs) * dayMs;

export function recordForeground(user, { startMs, endMs }, now = Date.now()) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
      || endMs <= startMs || endMs - startMs > 45_000
      || endMs < now - 300_000 || endMs > now + 5_000) return [];

  const days = user.foregroundByDay ||= {};
  const earliest = dateKey(dayStart(now) - 6 * dayMs);
  for (const date of Object.keys(days)) {
    if (date < earliest) delete days[date];
  }
  const accepted = [];
  for (let start = startMs; start < Math.min(endMs, now);) {
    const end = Math.min(dayStart(start) + dayMs, endMs, now);
    const date = dateKey(start);
    const ranges = [...(days[date] || []), [start, end]].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [from, to] of ranges) {
      const last = merged.at(-1);
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    days[date] = merged;
    accepted.push(start);
    start = end;
  }
  return accepted;
}

export function userActivityReport(store, now = Date.now()) {
  const today = dayStart(now);
  const dates = Array.from({ length: 7 }, (_, i) => dateKey(today - i * dayMs));
  const first = today - 6 * dayMs;
  const daysByUser = new Map();
  const users = Object.values(store.users);
  const datesSet = new Set(dates);
  const emptyDay = () => ({ foregroundMs: null, liveMs: null, coinsSpent: 0 });
  function daily(userId, date) {
    let days = daysByUser.get(userId);
    if (!days) daysByUser.set(userId, days = new Map());
    if (!days.has(date)) days.set(date, emptyDay());
    return days.get(date);
  }

  for (const user of users) {
    for (const [date, ranges] of Object.entries(user.foregroundByDay || {})) {
      if (!datesSet.has(date)) continue;
      daily(user.id, date).foregroundMs = ranges.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
    }
  }
  for (const session of Object.values(store.liveSessions || {})) {
    const started = Date.parse(session.startedAt);
    const ended = Date.parse(session.endedAt);
    const duration = Number(session.durationSeconds) * 1000;
    if (!Number.isFinite(started) || !Number.isFinite(ended) || !(duration > 0)) continue;
    const finish = Math.min(started + duration, ended, now);
    for (let start = Math.max(first, started); start < finish;) {
      const end = Math.min(dayStart(start) + dayMs, finish);
      const day = daily(session.userId, dateKey(start));
      day.liveMs = (day.liveMs || 0) + end - start;
      start = end;
    }
  }
  for (const tx of Object.values(store.coinTransactions || {})) {
    const at = Date.parse(tx.createdAt);
    if (tx.type !== "coin_spend" || !(tx.coins < 0) || !(at >= first && at <= now)) continue;
    daily(tx.userId, dateKey(at)).coinsSpent -= tx.coins;
  }

  const periods = { today: dates.slice(0, 1), yesterday: dates.slice(1, 2), sevenDays: dates };
  function summarize(days, included) {
    let foregroundMs = null, liveMs = null, coinsSpent = 0;
    for (const date of included) {
      const day = days?.get(date);
      if (!day) continue;
      if (day.foregroundMs !== null) foregroundMs = (foregroundMs || 0) + day.foregroundMs;
      if (day.liveMs !== null) liveMs = (liveMs || 0) + day.liveMs;
      coinsSpent += day.coinsSpent;
    }
    return { foregroundMs, liveMs, coinsSpent };
  }

  const totals = Object.fromEntries(Object.keys(periods).map((key) => [
    key, { ...emptyDay(), foregroundUsers: 0 }
  ]));
  const retention = Object.fromEntries([1, 7].map((offset) => [offset, {
    registered: 0, returned: 0, cohortStart: dateKey(today - (offset + 7) * dayMs),
    cohortEnd: dateKey(today - (offset + 1) * dayMs)
  }]));
  const byUser = new Map();
  for (const user of users) {
    const days = daysByUser.get(user.id);
    const summary = Object.fromEntries(Object.entries(periods).map(([key, included]) => [
      key, summarize(days, included)
    ]));
    byUser.set(user.id, summary);
    for (const [key, row] of Object.entries(summary)) {
      const total = totals[key];
      if (row.foregroundMs !== null) {
        total.foregroundMs = (total.foregroundMs || 0) + row.foregroundMs;
        total.foregroundUsers += 1;
      }
      if (row.liveMs !== null) total.liveMs = (total.liveMs || 0) + row.liveMs;
      total.coinsSpent += row.coinsSpent;
    }
    const registered = Date.parse(user.createdAt);
    if (!Number.isFinite(registered)) continue;
    const registeredDay = dateKey(registered);
    for (const [offset, cohort] of Object.entries(retention)) {
      if (registeredDay < cohort.cohortStart || registeredDay > cohort.cohortEnd) continue;
      const active = store.dailyUsage?.[dateKey(dayStart(registered) + Number(offset) * dayMs)]?.activeUserIds;
      if (!active) continue;
      cohort.registered += 1;
      if (Object.hasOwn(active, user.id)) cohort.returned += 1;
    }
  }
  return { byUser, overview: { totals, retention, date: dates[0] } };
}
