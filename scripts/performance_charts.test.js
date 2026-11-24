import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, buildTimingChart, hourlyTimings, metricLabel, pagesTable, previousVersion, rate, requestsTable,
  slowRequestsTable, sortItems, speedVerdict, technicalTable, trendChart, whereTime } from '../public/performance-charts.js';

const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const limits = [50, 100, 250, 500, 1000, 2000, 5000];
const hour = Date.UTC(2026, 10, 23, 12);
// Synthetic rows: `values` are individual timings, binned like the server does.
const row = (source, metric, values, extra = {}) => ({ hour, version: 'aaaa1111', source, metric, outcome: 'ok', count: values.length,
  total_ms: values.reduce((a, b) => a + b, 0), max_ms: Math.max(...values),
  buckets: limits.map((limit, i) => values.filter(v => v <= limit && (!i || v > limits[i - 1])).length), ...extra });
const many = (n, ms) => Array(n).fill(ms);

test('hourly chart merges releases by counts, keeps stages/errors separate and reports exact averages', () => {
  const points = hourlyTimings([
    row('browser', 'player', many(100, 80), { version: '1234abcd' }),
    row('browser', 'player', [2000], { version: 'abcdef12' }),
    row('server', 'player', many(10, 2000)),
    row('browser', 'player', many(10, 2000), { outcome: 'error' }),
    row('browser', 'player', [2000], { hour: hour + 7200000 }),
  ], limits, 'browser', 'player');
  assert.deepEqual(points, [
    { hour, count: 101, mean_ms: 10000 / 101, typical_ms: 100, slower_ms: 100 },
    { hour: hour + 7200000, count: 1, mean_ms: 2000, typical_ms: 2000, slower_ms: 2000 },
  ]);
});

test('status uses targets on bucket edges and flags rare slow ends', () => {
  const s = (mean_ms, p95_upper_ms, count = 30) => ({ mean_ms, p95_upper_ms, count });
  assert.equal(rate('page', s(800, 1000)).status, 'good');
  assert.equal(rate('page', s(1500, 2000)).status, 'watch');
  assert.equal(rate('page', s(2500, 5000)).status, 'slow');
  assert.equal(rate('page', s(400, 10000)).status, 'watch');
  assert.match(rate('page', s(400, 10000)).reason, /1 in 20 takes over 5.0 s/);
  assert.equal(rate('page', s(400, 5000)).status, 'good', 'a slow end inside the 5 s bucket is not over 5 s');
  assert.equal(rate('request', s(300, 500)).status, 'watch');
  assert.equal(rate('request', s(1200, 2000)).status, 'slow');
  assert.equal(rate('request', s(5000, 5000, 4)).status, 'unknown');
  assert.equal(rate('request', undefined).status, 'unknown');
});

test('report splits server time into like-for-like shares and compares, never subtracts, browser time', () => {
  const report = buildReport([
    row('server', 'impect-kpis', many(20, 1800)), row('external', 'impect-kpis', many(20, 1500)), row('database', 'impect-kpis', many(20, 100), { queries: 40 }),
    row('server', 'cards', many(20, 1200)), row('database', 'cards', many(20, 900), { queries: 2400 }), row('external', 'cards', many(20, 0)),
    row('server', 'players', many(20, 200)), row('database', 'players', many(20, 50)), row('browser', 'players', many(20, 600)),
    row('server', 'config', many(200, 200)),
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
  assert.equal(report.request_total, 260); assert.equal(report.request_errors, 0);
  assert.deepEqual(sortItems(report.requests).map(i => i.metric), ['impect-kpis', 'cards', 'players', 'config']);
  assert.deepEqual(sortItems(report.requests, 'impact').map(i => i.metric), ['config', 'impect-kpis', 'cards', 'players']);
});

test('provider and database overlap cannot produce negative app time', () => {
  const report = buildReport([row('server', 'player', many(10, 1000)), row('database', 'player', many(10, 800)), row('external', 'player', many(10, 800))], limits);
  const parts = whereTime(report.items[0]).parts;
  assert.ok(parts.every(p => p.ms >= 0));
  assert.equal(Math.round(parts.reduce((n, p) => n + p.ms, 0)), 1000);
});

test('release comparison needs 20 timings on both sides and picks the release seen before', () => {
  const rows = [row('server', 'player', many(30, 400), { version: 'old00001', hour: hour - 7200000 }),
    row('server', 'player', many(30, 200), { version: 'new00002' }),
    row('server', 'player', many(30, 900), { version: 'newer003', hour: hour + 3600000 })];
  assert.equal(previousVersion(rows, 'new00002'), 'old00001');
  assert.equal(previousVersion(rows, 'old00001'), null);
  assert.equal(previousVersion(rows, 'unseen99'), 'newer003', 'a release without timings compares with the latest one');
  const pick = v => rows.filter(r => r.version === v);
  assert.equal(buildReport(pick('new00002'), limits, pick('old00001')).items[0].change, -0.5);
  const few = [row('server', 'player', many(19, 200))];
  assert.equal(buildReport(few, limits, pick('old00001')).items[0].change, null);
});

test('pages expand to the requests they wait for and load afterwards', () => {
  const report = buildReport([row('browser', 'player-render', many(20, 2500)), row('server', 'player', many(20, 300)),
    row('server', 'impect-kpis', many(20, 1200)), row('browser', 'board-render', many(20, 200))], limits);
  const closed = pagesTable(report, { selected: 'player-render' }, esc);
  assert.match(closed, /Player details page/); assert.match(closed, /Slow/);
  assert.ok(closed.indexOf('Player details page') < closed.indexOf('Big Board page'), 'slow pages first');
  assert.match(closed, /class="perf-sub" hidden/);
  const open = pagesTable(report, { selected: 'player-render', open: new Set(['player-render', 'board-render']) }, esc);
  assert.match(open, /Page waits for this/); assert.match(open, /Loads after the page opens/);
  assert.match(open, /aria-expanded="true"/); assert.match(open, /loaded at sign-in/);
  assert.match(pagesTable(buildReport([row('server', 'player', [10])], limits), {}, esc), /No page-opening timings yet/);
  assert.equal(metricLabel('player-render'), 'Player details page');
});

test('verdict counts only judged items and lists the costliest first', () => {
  const report = buildReport([row('browser', 'player-render', many(20, 2500)), row('server', 'cards', many(40, 2000)),
    row('server', 'maps', many(20, 400)), row('server', 'config', [5000])], limits);
  const verdict = speedVerdict(report);
  assert.equal(verdict.label, '2 slow · 1 to watch');
  assert.deepEqual(verdict.slow.map(i => i.metric), ['cards', 'player-render']);
});

test('time chart leaves missing hours disconnected, shows targets and volume, and never invents zeros', () => {
  const points = [0, 1, 3].map(n => ({ hour: hour + n * 3600000, count: 4, mean_ms: 120, typical_ms: 100, slower_ms: 500 }));
  const html = trendChart(points, { since: hour, end: hour + 4 * 3600000, label: 'Player details' }, esc);
  assert.equal((html.match(/<polyline/g) || []).length, 4, 'two segments for each line');
  assert.equal((html.match(/<circle/g) || []).length, 6, 'only observed hourly points');
  assert.equal((html.match(/<rect/g) || []).length, 3, 'one volume bar per observed hour');
  assert.match(html, /perf-target-good/); assert.match(html, /perf-target-slow/);
  assert.match(html, /Gaps are hours with no use/); assert.match(html, /Hourly values/);
  assert.ok(!html.includes('NaN'));
  const spike = trendChart([{ ...points[0], slower_ms: 300000 }], { since: hour, end: hour + 3600000, label: 'x' }, esc);
  assert.match(spike, /Only one hour/); assert.match(spike, /above the chart/);
  assert.match(trendChart([], { since: hour }, esc), /No successful timings/);
});

test('slow request log shows each request split and escapes labels', () => {
  const html = slowRequestsTable([{ at: hour, metric: 'cards', status: 500, total_ms: 2000, database_ms: 1500, queries: 80, external_ms: 0 },
    { at: hour, metric: '<img src=x>', status: 200, total_ms: 1200, database_ms: 100, queries: 3, external_ms: 2000 }], 1000, esc);
  assert.match(html, /Error 500/); assert.match(html, /perf-worse">80/);
  assert.ok(!html.includes('<img')); assert.match(html, /&lt;img/);
  assert.ok(!html.includes('NaN') && !/>-\d|width:-/.test(html), 'provider time is capped by the total');
  assert.match(slowRequestsTable([], 1000, esc), /No server requests over 1.0 s/);
});

test('tables escape metric names and the technical table lists every stage', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const report = buildReport([row('server', malicious, many(20, 100)), row('database', malicious, many(20, 10), { queries: 20 }),
    row('server', malicious, [10], { outcome: 'error' })], limits);
  for (const html of [requestsTable(report, { selected: malicious }, esc), technicalTable(report, esc)]) {
    assert.ok(!html.includes('<img')); assert.match(html, /&lt;img/);
  }
  assert.match(requestsTable(report, {}, esc), /1 · 4\.8%/);
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
