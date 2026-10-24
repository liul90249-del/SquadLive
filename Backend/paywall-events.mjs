// Client events describe exposure and intent only. Revenue must still come
// from verified Apple transactions, never from this payload.
const names = new Set(['paywall_open', 'purchase_attempt', 'purchase_cancelled', 'purchase_failed', 'paywall_dismissed']);
const tiers = new Set(['default', 'free7', 'intro099', 'intro199', 'intro399', 'intro699']);
const templates = new Set(['storage', 'compact', 'comparison', 'special_annual']);
const surfaces = new Set(['main', 'policy_surprise', 'secret_annual']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => Object.assign(new Error('Invalid paywall event metadata'), {status: 400});

export function validatePaywallEvents(events, now) {
  if (events === undefined) return [];
  if (!Array.isArray(events) || events.length > 100) throw invalid();
  return events.map(e => {
    if (!e || typeof e !== 'object' || !uuid.test(e.id || '') || !uuid.test(e.presentationId || '') ||
        !names.has(e.name) || !Number.isSafeInteger(e.at) || e.at < Date.UTC(2020, 0, 1) || e.at > now + 300000 ||
        !Number.isSafeInteger(e.revision) || e.revision < 0 || !tiers.has(e.tier) || !templates.has(e.template) ||
        !surfaces.has(e.surface) || typeof e.entryPoint !== 'string' || !/^[a-z0-9_]{1,80}$/.test(e.entryPoint) ||
        typeof e.productId !== 'string' || !/^com\.hecathehe\.PhoneCleaner\.[a-zA-Z0-9.]{1,80}$/.test(e.productId)) throw invalid();
    return {id:e.id.toLowerCase(), presentationId:e.presentationId.toLowerCase(), name:e.name, at:e.at,
      revision:e.revision, tier:e.tier, template:e.template, surface:e.surface, entryPoint:e.entryPoint, productId:e.productId};
  });
}

export function mergePaywallEvents(account, events, now) {
  if (!events.length) return;
  const saved = new Map((account.paywallEvents || []).map(e => [e.id,e]));
  for (const event of events) {
    // Retries are idempotent; a reused ID cannot rewrite an earlier exposure.
    if (!saved.has(event.id)) saved.set(event.id, {...event, receivedAt:now});
  }
  const ordered = [...saved.values()].sort((a,b) => a.at-b.at || a.id.localeCompare(b.id));
  if (ordered.length > 500) account.paywallHistoryTruncated = true;
  account.paywallEvents = ordered.slice(-500);
  account.paywallTrackedFrom ||= now;
}
