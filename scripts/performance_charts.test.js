import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, buildTimingChart, dailyChart, dailyPoints, dayKey, eventStats, eventSummary, eventsTable, lastDays, metricLabel,
  overCount, pagesTable, rate, requestsTable, sortItems, speedVerdict, technicalTable, whereTime } from '../public/performance-charts.js';

const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const limits = [50, 100, 250, 500, 1000, 2000, 5000];
const day = '2026-11-23';
// Synthetic daily rows: `values` are individual timings, binned like the server does.
const row = (source, metric, values, extra = {}) => ({ day, source, metric, outcome: 'ok', cold: 0, count: values.length,
  total_ms: values.reduce((a, b) => a + b, 0), max_ms: Math.max(...values),
  buckets: limits.map((limit, i) => values.filter(v => v <= limit && (!i || v > limits[i - 1])).length), ...extra });
const many = (n, ms) => Array(n).fill(ms);
const group = values => row('server', 'x', values);

test('counts over a target are exact on bucket edges', () => {
  const g = group([900, 1000, 1001, 2000, 2500, 4000]);
  assert.equal(overCount(g, limits, 1000), 4);
  assert.equal(overCount(g, limits, 2000), 2);
});

test('status counts timings over the limit and needs only 3 timings', () => {
  assert.equal(rate('page', group([400, 500])).status, 'unknown');
  assert.match(rate('page', group([400, 500])).reason, /Only 2 timings so far/);
  assert.equal(rate('page', group([400, 500, 600]), limits).status, 'good');
  const slow = rate('page', group([400, 2500, 3000]), limits);
  assert.equal(slow.status, 'slow'); assert.equal(slow.reason, '2 of 3 took over 2.0 s; slowest 3.0 s'); assert.equal(slow.over_slow, 2);
  assert.equal(rate('page', group([400, 500, 3000]), limits).status, 'watch', 'a single slow open is worth watching, not alarming');
  assert.equal(rate('page', group([...many(10, 1500), 400, 400]), limits).status, 'watch', 'most over the target');
  assert.equal(rate('page', group([...many(29, 300), 3000]), limits).status, 'good', 'one in 30 over the limit is noise');
  assert.equal(rate('request', group([1200, 1300, 200, 200, 200]), limits).status, 'slow');
});

test('daily points merge rows by day, keep first use counts and never invent days', () => {
  const points = dailyPoints([
    row('browser', 'player-render', [800, 2500]),
    row('browser', 'player-render', [3000], { cold: 1 }),
    row('browser', 'player-render', [9000], { outcome: 'error' }),
    row('server', 'player-render', [10]),
    row('browser', 'player-render', [400], { day: '2026-11-25' }),
  ], limits, 'browser', 'player-render', 'page');
  assert.deepEqual(points.map(p => [p.day, p.count, p.max_ms, p.over_slow, p.cold]), [[day, 3, 3000, 2, 1], ['2026-11-25', 1, 400, 0, 0]]);
  assert.equal(points[0].mean_ms, 6300 / 3);
});

test('report splits server time into like-for-like shares and compares, never subtracts, browser time', () => {
  const report = buildReport([
    row('server', 'impect-kpis', many(20, 1800)), row('external', 'impect-kpis', many(20, 1500)), row('database', 'impect-kpis', many(20, 100), { queries: 40 }),
    row('server', 'cards', many(20, 1200)), row('database', 'cards', many(20, 900), { queries: 2400 }), row('external', 'cards', many(20, 0)),
    row('server', 'players', many(20, 200)), row('database', 'players', many(20, 50)), row('browser', 'players', many(20, 600)),
    row('server', 'config', many(200, 200)), row('server', 'config', [300], { outcome: 'error' }),
  ], limits);
  const item = metric => report.items.find(i => i.metric === metric);
  const kpis = whereTime(item('impect-kpis'));
  assert.equal(kpis.text, 'Mostly waiting on an outside provider');
  assert.deepEqual(kpis.parts.map(p => Math.round(p.ms)), [100, 1500, 200]);
  assert.equal(kpis.queries, 2);
  const cards = whereTime(item('cards'));
  assert.equal(cards.text, 'Mostly database'); assert.equal(cards.queries, 120); assert.ok(cards.many_queries);
  assert.equal(item('players').source, 'browser');
  assert.equal(whereTime(item('players')).text, 'Mostly network or download');
  assert.equal(whereTime(item('config')).text, 'Fast on the server');
  assert.equal(item('config').source, 'server', 'falls back to server time without browser timings');
  assert.equal(report.request_total, 261); assert.equal(report.request_errors, 1);
  assert.deepEqual(report.failing, [{ metric: 'config', label: 'App settings', errors: 1 }]);
  assert.deepEqual(sortItems(report.requests).map(i => i.metric), ['impect-kpis', 'cards', 'players', 'config']);
  assert.deepEqual(sortItems(report.requests, 'impact').map(i => i.metric), ['config', 'impect-kpis', 'cards', 'players']);
});

test('provider and database overlap cannot produce negative app time', () => {
  const report = buildReport([row('server', 'player', many(10, 1000)), row('database', 'player', many(10, 800)), row('external', 'player', many(10, 800))], limits);
  const parts = whereTime(report.items[0]).parts;
  assert.ok(parts.every(p => p.ms >= 0));
  assert.equal(Math.round(parts.reduce((n, p) => n + p.ms, 0)), 1000);
});

test('week-on-week change needs 5 timings in both weeks', () => {
  const week = [row('server', 'player', many(5, 200))], lastWeek = [row('server', 'player', many(6, 400))];
  const rows = [...week, ...lastWeek];
  const report = buildReport(rows, limits, { current: week, previous: lastWeek });
  assert.equal(report.items[0].change, -0.5); assert.deepEqual(report.items[0].week_counts, [5, 6]);
  assert.equal(buildReport(rows, limits, { current: week.map(r => ({ ...r, count: 4 })), previous: lastWeek }).items[0].change, null);
  assert.equal(buildReport(rows, limits).items[0].change, null);
  const html = requestsTable(report, {}, esc);
  assert.match(html, /50% faster/); assert.match(html, /5 timings in the last 7 days, 6 in the 7 before/);
});

test('first use after a break is shown beside the average when clearly slower', () => {
  const rows = [row('browser', 'player-render', many(6, 400)), row('browser', 'player-render', many(3, 2600), { cold: 1 })];
  const report = buildReport(rows, limits);
  assert.equal(report.items[0].main.cold_count, 3); assert.equal(report.items[0].main.warm_mean_ms, 400);
  assert.match(pagesTable(report, {}, esc), /After a break 2\.6 s · 3/);
  const similar = buildReport([row('browser', 'player-render', many(6, 400)), row('browser', 'player-render', many(3, 450), { cold: 1 })], limits);
  assert.doesNotMatch(pagesTable(similar, {}, esc), /After a break/);
});

test('pages expand to the requests they wait for and load afterwards', () => {
  const report = buildReport([row('browser', 'player-render', many(20, 2500)), row('server', 'player', many(20, 300)),
    row('server', 'impect-kpis', many(20, 1200)), row('browser', 'board-render', many(20, 200))], limits);
  const closed = pagesTable(report, { selected: 'player-render' }, esc);
  assert.match(closed, /Player details page/); assert.match(closed, /Slow/); assert.match(closed, /<b>20<\/b> of 20/);
  assert.ok(closed.indexOf('Player details page') < closed.indexOf('Big Board page'), 'slow pages first');
  assert.match(closed, /class="perf-sub" hidden/);
  const open = pagesTable(report, { selected: 'player-render', open: new Set(['player-render', 'board-render']) }, esc);
  assert.match(open, /Page waits for this/); assert.match(open, /Loads after the page opens/);
  assert.match(open, /aria-expanded="true"/); assert.match(open, /loaded at sign-in/);
  assert.match(pagesTable(buildReport([row('server', 'player', [10])], limits), {}, esc), /No page-opening timings/);
  assert.match(pagesTable(buildReport([row('browser', 'board-render', [10, 20])], limits), {}, esc), /2 so far/);
  assert.equal(metricLabel('player-render'), 'Player details page');
});

test('verdict counts only judged items and lists the costliest first', () => {
  const report = buildReport([row('browser', 'player-render', many(20, 2500)), row('server', 'cards', many(40, 2000)),
    row('server', 'maps', [400, 400, 400, 1500]), row('server', 'config', [5000])], limits);
  const verdict = speedVerdict(report);
  assert.equal(verdict.label, '2 slow · 1 to watch');
  assert.deepEqual(verdict.slow.map(i => i.metric), ['cards', 'player-render']);
  assert.equal(speedVerdict(buildReport([row('server', 'config', [5000])], limits)).label, 'Too few timings yet');
});

test('slow and failed events are counted, summarised and escaped', () => {
  const at = Date.UTC(2026, 10, 23, 15);
  const events = [
    { at, version: 'aaaa1111', source: 'browser', metric: 'player-render', status: 200, total_ms: 4200, database_ms: 0, queries: 0, external_ms: 0, cold: 'idle' },
    { at, version: 'aaaa1111', source: 'server', metric: 'cards', status: 200, total_ms: 2000, database_ms: 1500, queries: 80, external_ms: 0, cold: 'idle' },
    { at, version: 'aaaa1111', source: 'server', metric: '<img src=x>', status: 200, total_ms: 1200, database_ms: 100, queries: 3, external_ms: 2000, cold: null },
    { at, version: 'aaaa1111', source: 'server', metric: 'cards', status: 404, total_ms: 20, database_ms: 5, queries: 1, external_ms: 0, cold: 'restart' },
  ];
  const stats = eventStats(events);
  assert.deepEqual(stats, { total: 4, failed: 1, pages: 1, requests: 2, slow: 3, cold: 2 });
  assert.equal(eventSummary(stats, 'the last 14 days'), '1 slow page open, 2 slow requests and 1 failed request in the last 14 days. 2 of the 3 slow ones were the first use after a break, when caches have usually expired.');
  assert.equal(eventSummary(eventStats([]), 'the last 7 days'), 'Nothing slow or failed in the last 7 days.');
  const html = eventsTable(events, esc);
  assert.match(html, /Page open, as staff saw it · First use after a break/);
  assert.match(html, /Error 404/); assert.match(html, /First use after a restart/); assert.match(html, /perf-worse">80/);
  assert.ok(!html.includes('<img')); assert.match(html, /&lt;img/);
  assert.ok(!html.includes('NaN') && !/>-\d|width:-/.test(html), 'provider time is capped by the total');
  assert.equal(eventsTable([], esc), '');
});

test('daily chart places days on a calendar, marks releases and pins far-off slowest timings', () => {
  const days = lastDays(7, Date.UTC(2026, 10, 25, 15));
  assert.equal(days.length, 7); assert.equal(days.at(-1), dayKey(Date.UTC(2026, 10, 25, 15)));
  const points = [days[1], days[2], days[5]].map((d, i) => ({ day: d, count: 2 + i, mean_ms: 600, max_ms: i === 2 ? 300000 : 1500, over_slow: 0, over_good: 1, cold: 1 }));
  const releases = [{ version: 'aaaa1111', first_seen: new Date(`${days[2]}T12:00`).getTime() }, { version: 'bbbb2222', first_seen: new Date(`${days[2]}T13:00`).getTime() }];
  const html = dailyChart(points, { days, label: 'Player details', kind: 'page', releases }, esc);
  assert.equal((html.match(/class="perf-dot-average"/g) || []).length, 3, 'only days with use');
  assert.equal((html.match(/<rect/g) || []).length, 3, 'one volume bar per day with use');
  assert.equal((html.match(/class="perf-release"/g) || []).length, 1); assert.match(html, /2 releases went live/);
  assert.match(html, /perf-target-good/); assert.match(html, /perf-target-slow/);
  assert.match(html, /off-scale/); assert.match(html, /above the chart/);
  assert.match(html, /Days without use are blank/); assert.match(html, /Daily values/);
  assert.ok(!html.includes('NaN'));
  assert.match(dailyChart([points[0]], { days, label: 'x' }, esc), /Only one day with use/);
  assert.match(dailyChart([], { days }, esc), /No successful timings/);
  assert.match(dailyChart([{ ...points[0], day: '2020-01-01' }], { days }, esc), /No successful timings/, 'days outside the period are left out');
});

test('tables escape metric names and the technical table lists every stage', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const report = buildReport([row('server', malicious, many(20, 100)), row('database', malicious, many(20, 10), { queries: 20 }),
    row('server', malicious, [10], { outcome: 'error' })], limits);
  for (const html of [requestsTable(report, { selected: malicious }, esc), technicalTable(report, esc)]) {
    assert.ok(!html.includes('<img')); assert.match(html, /&lt;img/);
  }
  assert.match(requestsTable(report, {}, esc), /perf-worse">1</);
  assert.match(technicalTable(report, esc), /Database/);
});

test('build chart keeps independent populations and distinguishes zero duration from no samples', () => {
  const html = buildTimingChart([
    { kind: 'cards', queue_samples: 3, mean_queue_ms: 0, build_samples: 2, mean_build_ms: 90000 },
    { kind: 'maps', queue_samples: 0, mean_queue_ms: null, build_samples: 0, mean_build_ms: null },
  ]);
  assert.match(html, /0 ms/); assert.match(html, /1.5 min/);
  assert.match(html, /3 starts/); assert.match(html, /2 completions/);
  assert.match(html, /No samples/); assert.match(html, /different jobs/);
  assert.ok(!html.includes('NaN'));
  assert.match(buildTimingChart([]), /No starts or completions observed/);
});
