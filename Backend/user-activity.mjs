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

function emptyDay() {
  return { liveCount: 0, timedLiveCount: 0, liveMs: null, longestLiveMs: null, shortestLiveMs: null, coinsSpent: 0 };
}

function addDay(total, day) {
  total.liveCount += day.liveCount;
  total.timedLiveCount += day.timedLiveCount;
  total.coinsSpent += day.coinsSpent;
  if (day.liveMs === null) return;
  total.liveMs = (total.liveMs || 0) + day.liveMs;
  total.longestLiveMs = Math.max(total.longestLiveMs ?? 0, day.longestLiveMs);
  total.shortestLiveMs = Math.min(total.shortestLiveMs ?? Infinity, day.shortestLiveMs);
}

function withAverage(day) {
  return { ...day, averageLiveMs: day.timedLiveCount ? day.liveMs / day.timedLiveCount : null };
}

function summarizeWeek(dates, days) {
  const sevenDays = emptyDay();
  const daily = dates.map(date => {
    const day = days?.get(date) || emptyDay();
    addDay(sevenDays, day);
    return { date, ...withAverage(day) };
  });
  return { today: daily[0], yesterday: daily[1], sevenDays: withAverage(sevenDays), daily };
}

export function userActivityReport(store, now = Date.now()) {
  const today = dayStart(now);
  const dates = Array.from({ length: 7 }, (_, i) => dateKey(today - i * dayMs));
  const first = today - 6 * dayMs;
  const daysByUser = new Map();
  const users = Object.values(store.users);
  function daily(userId, date) {
    let days = daysByUser.get(userId);
    if (!days) daysByUser.set(userId, days = new Map());
    if (!days.has(date)) days.set(date, emptyDay());
    return days.get(date);
  }

  for (const session of Object.values(store.liveSessions || {})) {
    const started = Date.parse(session.startedAt);
    if (!(started >= first && started <= now)) continue;
    const day = daily(session.userId, dateKey(started));
    day.liveCount += 1;
    const ended = Date.parse(session.endedAt);
    const duration = Math.min(Number(session.durationSeconds) * 1000, ended - started);
    if (!(ended <= now && duration > 0)) continue;
    day.timedLiveCount += 1;
    day.liveMs = (day.liveMs || 0) + duration;
    day.longestLiveMs = Math.max(day.longestLiveMs ?? 0, duration);
    day.shortestLiveMs = Math.min(day.shortestLiveMs ?? Infinity, duration);
  }
  for (const tx of Object.values(store.coinTransactions || {})) {
    const at = Date.parse(tx.createdAt);
    if (tx.type !== "coin_spend" || !(tx.coins < 0) || !(at >= first && at <= now)) continue;
    daily(tx.userId, dateKey(at)).coinsSpent -= tx.coins;
  }

  const totalsByDay = new Map(dates.map(date => [date, emptyDay()]));
  const retention = Object.fromEntries([1, 7].map((offset) => [offset, {
    registered: 0, returned: 0, cohortStart: dateKey(today - (offset + 7) * dayMs),
    cohortEnd: dateKey(today - (offset + 1) * dayMs)
  }]));
  const byUser = new Map();
  for (const user of users) {
    const days = daysByUser.get(user.id);
    byUser.set(user.id, summarizeWeek(dates, days));
    for (const [date, day] of days || []) addDay(totalsByDay.get(date), day);

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
  return { byUser, overview: { totals: summarizeWeek(dates, totalsByDay), retention, date: dates[0] } };
}
