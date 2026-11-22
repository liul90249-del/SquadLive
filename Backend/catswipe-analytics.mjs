import { createAnalyticsDataClient } from './analytics-data.mjs';

export const CATSWIPE_REPORT_DAYS = [7, 30, 90];

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
    const audienceMetrics = ['activeUsers', 'newUsers', 'sessions'];
    const eventMetrics = ['eventCount', 'totalUsers'];
    const metrics = names => names.map(name => ({ name }));
    const { reports } = await query('batchRunReports', {
      requests: [
        { dateRanges, metrics: metrics(audienceMetrics) },
        { dateRanges, dimensions: [{ name: 'date' }], metrics: metrics(audienceMetrics),
          orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }] },
        { dateRanges, dimensions: [{ name: 'eventName' }], metrics: metrics(eventMetrics), limit: '1000' },
        { dateRanges, dimensions: [{ name: 'country' }, { name: 'city' }],
          metrics: metrics(['activeUsers', 'newUsers']), limit: '500',
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }] },
        { dateRanges, dimensions: [{ name: 'platform' }, { name: 'appVersion' }, { name: 'deviceCategory' }],
          metrics: metrics(['activeUsers', 'sessions']), limit: '500',
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }] },
      ],
    });
    if (reports?.length !== 5) throw new Error('Invalid Analytics reports');
    const [audience, daily, events, regions, versions] = reports;
    return {
      status: 'ready',
      timeZone: daily.metadata?.timeZone ?? null,
      limited: reports.some(({ metadata }) => metadata?.subjectToThresholding || metadata?.dataLossFromOtherRow),
      audience: readCounts(audience.rows?.[0], audienceMetrics),
      daily: (daily.rows ?? []).map(row => ({
        date: row.dimensionValues[0].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        ...readCounts(row, audienceMetrics),
      })),
      eventRows: (events.rows ?? []).map(row => ({
        name: row.dimensionValues[0].value, ...readCounts(row, eventMetrics),
      })).filter(row => row.name && row.name !== '(not set)' && row.eventCount > 0)
        .sort((a, b) => b.eventCount - a.eventCount),
      regions: (regions.rows ?? []).map(row => ({
        country: row.dimensionValues[0].value, city: row.dimensionValues[1].value,
        ...readCounts(row, ['activeUsers', 'newUsers']),
      })),
      versions: (versions.rows ?? []).map(row => ({
        platform: row.dimensionValues[0].value, version: row.dimensionValues[1].value,
        device: row.dimensionValues[2].value, ...readCounts(row, ['activeUsers', 'sessions']),
      })),
      events: Object.fromEntries((events.rows ?? []).map(row => [
        row.dimensionValues[0].value, readCounts(row, eventMetrics).eventCount,
      ])),
    };
  };
}
