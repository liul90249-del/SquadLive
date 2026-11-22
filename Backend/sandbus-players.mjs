import { createHash, randomUUID } from 'node:crypto';

export const SANDBUS_EVENTS = ['app_open', 'sb_level_start', 'sb_first_transfer', 'sb_level_complete',
  'sb_level_timeout', 'sb_restart', 'sb_shaker_offered', 'sb_shaker_used', 'sb_shaker_settled'];
const DAY = 86400000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');

function validate(body, now) {
  if (body?.consent !== true) throw fail('Gameplay analytics consent is required');
  if (!/^sb_[a-f0-9]{64}$/.test(body.credential || '')) throw fail('Invalid installation credential', 401);
  if (!['iOS', 'Android', 'Desktop'].includes(body.platform)) throw fail('Invalid platform');
  if (typeof body.version !== 'string' || !/^[0-9A-Za-z. _-]{1,40}$/.test(body.version)) throw fail('Invalid version');
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) throw fail('Send 1–50 events');
  return body.events.map(event => {
    if (!/^[a-f0-9]{32}$/.test(event.id || '') || !SANDBUS_EVENTS.includes(event.name)) throw fail('Invalid gameplay event');
    if (!Number.isSafeInteger(event.at) || event.at < now - 7 * DAY || event.at > now + 300000) throw fail('Invalid event time');
    if (event.level !== undefined && (!Number.isInteger(event.level) || event.level < 1 || event.level > 30)) throw fail('Invalid level');
    if (event.gain !== undefined && (!Number.isFinite(event.gain) || event.gain < 0 || event.gain > 100)) throw fail('Invalid gain');
    return { id: event.id, name: event.name, at: event.at, ...(event.level === undefined ? {} : { level: event.level }),
      ...(event.gain === undefined ? {} : { gain: event.gain }) };
  });
}

export function sandBusPlayersReport(root, { days = 30, search = '', user = '', now = Date.now() } = {}) {
  if (![-1, 1, 7, 30, 90].includes(days)) throw fail('Invalid date range');
  const midnight = Date.parse(new Date(now + 8 * 3600000).toISOString().slice(0, 10)) - 8 * 3600000;
  const cutoff = days === -1 ? midnight - DAY : days === 1 ? midnight : now - days * DAY;
  const end = days === -1 ? midnight : Infinity;
  const inRange = timestamp => timestamp >= cutoff && timestamp < end;
  const accounts = Object.values(root.sandBusPlayers?.accounts || {});
  const query = String(search).toLowerCase().slice(0, 200);
  const users = accounts.filter(account => !query || [account.id, account.lastIPAddress, account.networkCountry,
    account.networkCountryCode, account.networkCity, account.networkOrganization, account.platform, account.version]
    .some(value => String(value || '').toLowerCase().includes(query))).map(account => ({
      id: account.id, createdAt: account.createdAt, lastSeenAt: account.lastSeenAt, platform: account.platform,
      version: account.version, lastIPAddress: account.lastIPAddress || null,
      country: account.networkCountry || account.networkCountryCode || null, city: account.networkCity || null,
      organization: account.networkOrganization || account.networkISP || null, asn: account.networkASN || null,
      possibleAppleNetwork: Boolean(account.possibleAppleNetwork),
      networkStatus: account.networkLookupStatus || 'pending', ipHistory: account.ipHistory || [],
      sharedIPUsers: accounts.filter(other => account.lastIPAddress && other.lastIPAddress === account.lastIPAddress).length,
      events: (account.events || []).filter(event => inRange(event.at)),
    })).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const totals = {};
  for (const account of accounts) for (const event of account.events || []) {
    if (inRange(event.at)) totals[event.name] = (totals[event.name] || 0) + 1;
  }
  const countries = new Map();
  for (const account of accounts.filter(a => inRange(Date.parse(a.lastSeenAt)))) {
    const label = account.networkCountry || account.networkCountryCode || '待解析';
    countries.set(label, (countries.get(label) || 0) + 1);
  }
  const detail = user ? users.find(account => account.id === user) : null;
  if (user && !detail) throw fail('Player not found', 404);
  return {
    days, total: accounts.length, matched: users.length,
    users: users.slice(0, 500).map(({ events, ...account }) => ({ ...account, eventCount: events.length,
      highestLevel: Math.max(0, ...events.map(event => event.level || 0)) })),
    detail: detail ? { ...detail, events: [...detail.events].sort((a, b) => b.at - a.at).slice(0, 200) } : null,
    events: SANDBUS_EVENTS.map(name => ({ name, count: totals[name] || 0 })),
    countries: [...countries].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count),
  };
}

export function createSandBusPlayers({ getStore, saveStore, onSession = () => {}, now = Date.now }) {
  let queue = Promise.resolve();
  return {
    collect(body, request) {
      const run = async () => {
        const timestamp = now();
        const incoming = validate(body, timestamp);
        const root = await getStore();
        const previous = root.sandBusPlayers;
        const state = structuredClone(previous || { accounts: {}, credentials: {} });
        const hash = digest(body.credential);
        let account = state.accounts[state.credentials[hash]];
        if (!account) {
          const id = 'sb_' + randomUUID();
          account = { id, createdAt: new Date(timestamp).toISOString(), events: [] };
          state.accounts[id] = account;
          state.credentials[hash] = id;
        }
        account.events = account.events.filter(event => event.at >= timestamp - 90 * DAY);
        const ids = new Set(account.events.map(event => event.id));
        const accepted = [];
        for (const event of incoming) {
          if (!ids.has(event.id)) { account.events.push(event); ids.add(event.id); }
          accepted.push(event.id);
        }
        if (account.events.length > 20000) throw fail('Event history capacity reached', 429);
        account.platform = body.platform;
        account.version = body.version;
        account.lastSeenAt = new Date(timestamp).toISOString();
        root.sandBusPlayers = state;
        try {
          onSession(root, account, request);
          await saveStore(root);
        } catch (error) {
          if (previous) root.sandBusPlayers = previous;
          else delete root.sandBusPlayers;
          throw error;
        }
        return { user_id: account.id, accepted };
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
  };
}
