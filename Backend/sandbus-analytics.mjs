import { createAnalyticsDataClient } from './analytics-data.mjs';

const MAX_ROWS = 10000;
const EVENTS = [
  'sb_level_start', 'sb_first_transfer', 'sb_level_complete', 'sb_level_timeout',
  'sb_restart', 'sb_shaker_offered', 'sb_shaker_used', 'sb_shaker_settled',
];

export const SANDBUS_REPORT_DAYS = [-1, 1, 7, 30, 90];

function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid Analytics count');
  return number;
}

function normalizeReports(reports, days, now) {
  if (!Array.isArray(reports) || reports.length !== 5) throw new Error('Invalid Analytics reports');
  const [audience, gameplay, shaker, daily, totals] = reports;
  const timeZone = daily.metadata?.timeZone || audience.metadata?.timeZone || gameplay.metadata?.timeZone || null;
  const observedDays = new Map((daily.rows ?? []).map(row => [
    row.dimensionValues[0].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    { active: count(row.metricValues[0]?.value), new: count(row.metricValues[1]?.value) },
  ]));
  let dailyRows = [...observedDays].map(([date, players]) => ({ date, ...players }));
  if (timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(({ type, value }) => [type, value]));
    const today = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    const restricted = daily.metadata?.subjectToThresholding || daily.metadata?.dataLossFromOtherRow;
    dailyRows = Array.from({ length: days }, (_, index) => {
      const date = new Date(today - (days - index - 1) * 86400000).toISOString().slice(0, 10);
      return { date, ...(observedDays.get(date) || { active: restricted ? null : 0, new: restricted ? null : 0 }) };
    });
  }
  dailyRows.sort((a, b) => a.date.localeCompare(b.date));
  const eventTotals = {};
  for (const entry of totals.rows ?? []) {
    const event = entry.dimensionValues[0].value;
    if (EVENTS.includes(event)) eventTotals[event] = count(entry.metricValues[0]?.value);
  }
  const audienceValues = audience.rows?.[0]?.metricValues;
  const players = audienceValues
    ? { active: count(audienceValues[0]?.value), new: count(audienceValues[1]?.value) }
    : { active: 0, new: 0 };
  const rows = new Map();
  for (const entry of gameplay.rows ?? []) {
    const [platform, build, level, event] = entry.dimensionValues.map(item => item.value);
    if (!EVENTS.includes(event) || !['iOS', 'Android'].includes(platform)) continue;
    const key = JSON.stringify([platform, build, level]);
    if (!rows.has(key)) rows.set(key, { platform, build, level, events: {}, meanShakerGain: null });
    rows.get(key).events[event] = count(entry.metricValues[0]?.value);
  }
  for (const entry of shaker.rows ?? []) {
    const key = JSON.stringify(entry.dimensionValues.map(item => item.value));
    const row = rows.get(key);
    if (!row || count(entry.metricValues[1]?.value) === 0) continue;
    const gain = Number(entry.metricValues[0]?.value);
    if (!Number.isFinite(gain) || gain < 0 || gain > 100) throw new Error('Invalid Shaker gain');
    row.meanShakerGain = gain;
  }
  return {
    players,
    daily: dailyRows,
    eventTotals,
    rows: [...rows.values()].sort((a, b) =>
      a.level.localeCompare(b.level, undefined, { numeric: true })
      || a.platform.localeCompare(b.platform)
      || a.build.localeCompare(b.build, undefined, { numeric: true })),
    limited: reports.some(report => report.metadata?.subjectToThresholding
      || report.metadata?.dataLossFromOtherRow || report.rowCount > MAX_ROWS),
    timeZone,
  };
}

export function createSandBusAnalytics(options) {
  const { configured, query } = createAnalyticsDataClient(options);
  const now = options?.now ?? Date.now;

  async function report(days) {
    if (!SANDBUS_REPORT_DAYS.includes(days)) throw new RangeError('Invalid date range');
    if (!configured) return { status: 'not_configured', days };
    const requestedAt = now();
    const dateRanges = days === -1
      ? [{ startDate: 'yesterday', endDate: 'yesterday' }]
      : [{ startDate: days === 1 ? 'today' : `${days - 1}daysAgo`, endDate: 'today' }];
    const groups = ['platform', 'appVersion', 'customEvent:sb_level'].map(name => ({ name }));
    const { reports } = await query('batchRunReports', { requests: [
        { dateRanges, metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }] },
        {
          dateRanges,
          dimensions: [...groups, { name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } },
          },
          limit: String(MAX_ROWS),
        },
        {
          dateRanges,
          dimensions: groups,
          metrics: [
            { name: 'averageCustomEvent:sb_gain_pct' },
            { name: 'countCustomEvent:sb_gain_pct' },
          ],
          dimensionFilter: {
            filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'sb_shaker_settled' } },
          },
          limit: String(MAX_ROWS),
        },
        {
          dateRanges,
          dimensions: [{ name: 'date' }],
          metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: '90',
        },
        {
          dateRanges,
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } } },
        },
    ] });
    return { status: 'ready', days, ...normalizeReports(reports, days, requestedAt) };
  }

  report.realtime = async function realtime() {
    const minutes = 30;
    if (!configured) return { status: 'not_configured', minutes };
    const data = await query('runRealtimeReport', {
      dimensions: [{ name: 'platform' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } },
      },
    });
    const rows = [];
    for (const entry of data.rows ?? []) {
      const [platform, event] = entry.dimensionValues.map(item => item.value);
      if (!['iOS', 'Android'].includes(platform) || !EVENTS.includes(event)) continue;
      rows.push({ platform, event, count: count(entry.metricValues[0]?.value) });
    }
    return { status: 'ready', minutes, rows };
  };

  return report;
}
