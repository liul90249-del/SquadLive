import { createAnalyticsDataClient } from './analytics-data.mjs';

export const CATSWIPE_REPORT_DAYS = [7, 30, 90];
const EVENTS = ['game_start', 'game_end', 'cat_sounds_open', 'sound_play'];

function readCounts(row, metrics) {
  const values = row?.metricValues;
  return Object.fromEntries(metrics.map((name, index) => {
    const count = values ? Number(values[index]?.value) : 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Analytics count');
    return [name, count];
  }));
}

export function createCatSwipeAnalytics(options) {
  const { configured, query } = createAnalyticsDataClient(options);

  return async function report(days) {
    if (!CATSWIPE_REPORT_DAYS.includes(days)) throw new RangeError('Invalid date range');
    if (!configured) return { status: 'not_configured' };

    const dateRanges = [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }];
    const audienceMetrics = ['activeUsers', 'newUsers'];
    const eventMetrics = ['eventCount'];
    const metrics = names => names.map(name => ({ name }));
    const { reports } = await query('batchRunReports', {
      requests: [
        { dateRanges, metrics: metrics(audienceMetrics) },
        { dateRanges, dimensions: [{ name: 'date' }], metrics: metrics(audienceMetrics),
          orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }] },
        { dateRanges, dimensions: [{ name: 'eventName' }], metrics: metrics(eventMetrics),
          dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: EVENTS, caseSensitive: true } } } },
      ],
    });
    if (reports?.length !== 3) throw new Error('Invalid Analytics reports');
    const [audience, daily, events] = reports;
    return {
      status: 'ready',
      timeZone: daily.metadata?.timeZone ?? null,
      limited: reports.some(({ metadata }) => metadata?.subjectToThresholding || metadata?.dataLossFromOtherRow),
      audience: readCounts(audience.rows?.[0], audienceMetrics),
      daily: (daily.rows ?? []).map(row => ({
        date: row.dimensionValues[0].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        ...readCounts(row, audienceMetrics),
      })),
      events: Object.fromEntries((events.rows ?? []).map(row => [
        row.dimensionValues[0].value, readCounts(row, eventMetrics).eventCount,
      ])),
    };
  };
}
