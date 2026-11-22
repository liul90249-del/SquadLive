const DAY = 86400000;
export const CATSWIPE_EVENTS = new Set([
  'app_open', 'game_start', 'game_pause', 'game_end', 'mode_select',
  'cat_sounds_open', 'sound_play', 'settings_open', 'rate_us_tap',
  'restore_purchases_tap', 'contact_us_tap', 'terms_tap', 'privacy_tap', 'language_change',
]);
const PARAMS = new Set(['mode', 'sound_name', 'score', 'duration_seconds', 'language']);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function validateCatSwipeEvents(events, now) {
  if (!Array.isArray(events) || events.length > 50) throw fail('Send at most 50 events');
  return events.map(event => {
    if (!event || !/^[a-f0-9-]{36}$/i.test(event.id || '') || !CATSWIPE_EVENTS.has(event.name)
      || !Number.isSafeInteger(event.occurredAt) || event.occurredAt < now - 7 * DAY
      || event.occurredAt > now + 300000) throw fail('Invalid gameplay event');
    const parameters = event.parameters ?? {};
    if (typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length > 5
      || Object.entries(parameters).some(([key, value]) => !PARAMS.has(key)
        || !(typeof value === 'string' && value.length <= 80
          || Number.isSafeInteger(value) && value >= 0 && value <= 100000000))) {
      throw fail('Invalid gameplay parameters');
    }
    return { id: event.id.toLowerCase(), name: event.name, occurredAt: event.occurredAt, parameters };
  });
}

export function mergeCatSwipeEvents(account, events, now) {
  const seen = Object.fromEntries(Object.entries(account.gameplaySeen || {})
    .filter(([, receivedAt]) => receivedAt >= now - 8 * DAY));
  const incoming = events.filter(event => !seen[event.id]);
  if (Object.keys(seen).length + incoming.length > 10000) throw fail('Gameplay event limit reached', 429);
  const daily = account.gameplayDaily ||= {};
  const recent = account.gameplayRecent ||= [];
  for (const event of events) {
    if (seen[event.id]) continue;
    seen[event.id] = now;
    const date = new Date(event.occurredAt).toISOString().slice(0, 10);
    const counts = daily[date] ||= {};
    counts[event.name] = (counts[event.name] || 0) + 1;
    recent.push(event);
  }
  for (const date of Object.keys(daily)) {
    if (Date.parse(date) < now - 91 * DAY) delete daily[date];
  }
  account.gameplaySeen = seen;
  account.gameplayRecent = recent.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 200);
  account.gameplayTrackedFrom ||= new Date(now).toISOString();
  return events.map(event => event.id);
}

export function catSwipeActivity(accounts, days, now) {
  const start = new Date(now).toISOString().slice(0, 10);
  const firstDay = new Date(Date.parse(start) - (days - 1) * DAY).toISOString().slice(0, 10);
  const counts = {};
  const recent = [];
  for (const account of accounts) {
    for (const [date, events] of Object.entries(account.gameplayDaily || {})) {
      if (date < firstDay) continue;
      for (const [name, count] of Object.entries(events)) counts[name] = (counts[name] || 0) + count;
    }
    for (const event of account.gameplayRecent || []) {
      if (event.occurredAt >= Date.parse(firstDay)) recent.push({ ...event, userId: account.id });
    }
  }
  return { counts, recent: recent.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 200) };
}
