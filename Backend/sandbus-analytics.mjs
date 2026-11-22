import { createAnalyticsDataClient } from './analytics-data.mjs';

const MAX_ROWS = 10000;
const EVENTS = [
  'sb_level_start', 'sb_first_transfer', 'sb_level_complete', 'sb_level_timeout',
  'sb_restart', 'sb_shaker_offered', 'sb_shaker_used', 'sb_shaker_settled',
];

export const SANDBUS_REPORT_DAYS = [7, 30, 90];

function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid Analytics count');
  return number;
}

function normalizeReports(reports) {
  if (!Array.isArray(reports) || reports.length !== 3) throw new Error('Invalid Analytics reports');
  const [audience, gameplay, shaker] = reports;
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
    rows: [...rows.values()].sort((a, b) =>
      a.level.localeCompare(b.level, undefined, { numeric: true })
      || a.platform.localeCompare(b.platform)
      || a.build.localeCompare(b.build, undefined, { numeric: true })),
    limited: reports.some(report => report.metadata?.subjectToThresholding
      || report.metadata?.dataLossFromOtherRow || report.rowCount > MAX_ROWS),
    timeZone: gameplay.metadata?.timeZone || audience.metadata?.timeZone || null,
  };
}

export function createSandBusAnalytics(options) {
  const { configured, query } = createAnalyticsDataClient(options);

  async function report(days) {
    if (!SANDBUS_REPORT_DAYS.includes(days)) throw new RangeError('Invalid date range');
    if (!configured) return { status: 'not_configured', days };
    const dateRanges = [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }];
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
    ] });
    return { status: 'ready', days, ...normalizeReports(reports) };
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
