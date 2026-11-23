import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlyTimings, slowestChart, trendChart, performanceCharts, buildTimingChart, metricLabel, responseTimeAxis } from '../public/performance-charts.js';

const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const limits = [50, 100, 500, 2000];
const hour = Date.UTC(2026, 10, 23, 12);
const row = (hour, count, buckets, extra = {}) => ({ hour, count, buckets, source: 'browser', metric: 'player', outcome: 'ok', ...extra });

test('hourly chart recomputes weighted percentiles across releases and keeps stages/errors separate', () => {
  const points = hourlyTimings([
    row(hour, 100, [0, 100, 0, 0], { version: '1234abcd' }),
    row(hour, 1, [0, 0, 0, 1], { version: 'abcdef12' }),
    row(hour, 1000, [0, 0, 0, 1000], { source: 'server' }),
    row(hour, 1000, [0, 0, 0, 1000], { outcome: 'error' }),
    row(hour, 1000, [0, 0, 0, 1000], { metric: 'cards' }),
    row(hour + 7200000, 1, [0, 0, 0, 1]),
  ], limits, 'browser', 'player');
  assert.deepEqual(points, [
    { hour, count: 101, typical_ms: 100, slower_ms: 100 },
    { hour: hour + 7200000, count: 1, typical_ms: 2000, slower_ms: 2000 },
  ]);
});

test('time chart leaves missing hours disconnected, shows single hours, and does not invent zeros', () => {
  const points = [0, 1, 3].map(n => ({ hour: hour + n * 3600000, count: 4, typical_ms: 100, slower_ms: 500 }));
  const html = trendChart(points, { since: hour, end: hour + 4 * 3600000, label: 'Player details' }, esc);
  assert.equal((html.match(/<polyline/g) || []).length, 4, 'two segments for each timing line');
  assert.equal((html.match(/<circle/g) || []).length, 6, 'only observed hourly points');
  assert.match(html, /Gaps mean no recorded/);
  assert.match(html, /Hourly chart values/);
  assert.ok(!html.includes('NaN'));
  assert.match(trendChart([points[0]], { since: hour, end: hour + 3600000, label: 'Player details' }, esc), /Only one hour/);
  assert.match(trendChart([], { since: hour }, esc), /No successful timings/);
});

test('slowest bars sort successful measurements within one stage and show sample counts', () => {
  const item = (metric, p95, extra = {}) => ({ metric, source: 'browser', outcome: 'ok', count: 9,
    mean_ms: 80, p50_upper_ms: 100, p95_upper_ms: p95, ...extra });
  const html = slowestChart([item('player', 500), item('playing-time', 2000),
    item('cards', 10000, { outcome: 'error' }), item('maps', 10000, { source: 'server' })], 'browser', 'player', esc);
  assert.ok(html.indexOf('Playing-time stats') < html.indexOf('Player details'));
  assert.ok(!html.includes('Scouting card list')); assert.ok(!html.includes('Pitch map list'));
  assert.match(html, /9 samples · few samples/);
  assert.match(html, /aria-pressed="true"/);
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

test('response axis keeps ordinary subsecond bars readable beside minute-scale outliers', () => {
  const values = [300000, 1000, 500, 500, 500, 250, 250, 250];
  const axis = responseTimeAxis(values);
  assert.equal(axis.max, 1000); assert.equal(axis.clipped, 1); assert.equal(axis.unit, 'seconds');
  assert.deepEqual(axis.ticks.map(t => t.label), ['0', '0.25', '0.5', '0.75', '1']);
  assert.equal(100 * 500 / axis.max, 50, '500ms fills half the zoomed scale');
  const full = responseTimeAxis(values, { fullRange: true });
  assert.ok(full.max >= 300000); assert.equal(full.clipped, 0); assert.equal(full.canZoom, true);
  assert.equal(responseTimeAxis([300000]).canZoom, false, 'a single measurement keeps its full range');
  assert.equal(responseTimeAxis([300000, 300000, 1000, 500, 500, 250]).clipped, 2);
  assert.equal(responseTimeAxis([50, 100, 250, 500]).canZoom, false);
  for (const input of [[], [0], [50], [50, 100], [250, 500, 5000]]) {
    const scale = responseTimeAxis(input);
    assert.ok(Number.isFinite(scale.max) && scale.max > 0);
    assert.ok(scale.ticks.length >= 2 && scale.ticks.length <= 6);
  }
});

test('clipped bars are explicit, retain timing labels, and can switch to full range', () => {
  const summary = [300000, 1000, 500, 250].map((ms, i) => ({ metric: ['playing-time', 'players', 'player', 'cards'][i],
    source: 'browser', outcome: 'ok', count: 4, p50_upper_ms: 100, p95_upper_ms: ms, mean_ms: 200 }));
  const zoomed = slowestChart(summary, 'browser', 'player', esc);
  assert.match(zoomed, /Show full range/); assert.match(zoomed, /Beyond scale/);
  assert.match(zoomed, /perf-bar-overflow/); assert.match(zoomed, /≤ 5.0 min/);
  assert.match(zoomed, /Response time \(seconds\)/);
  assert.match(zoomed, /width:50%/);
  const full = slowestChart(summary, 'browser', 'player', esc, { fullRange: true });
  assert.match(full, /Zoom to normal range/); assert.ok(!full.includes('Beyond scale'));
});

test('plain labels and chart markup escape data; errors remain visible when there are no successes', () => {
  assert.equal(metricLabel('player-render'), 'Player details · page opening');
  const data = { summary: [{ metric: 'player', source: 'server', outcome: 'error', count: 3 }], rows: [], bucket_upper_ms: limits, since: hour };
  assert.match(performanceCharts(data, 'server', '', esc), /3 failures \(100.0%\)/);
  const malicious = '<img src=x onerror=alert(1)>';
  const html = slowestChart([{ metric: malicious, source: 'browser', outcome: 'ok', count: 1, p50_upper_ms: 50, p95_upper_ms: 100 }], 'browser', malicious, esc);
  assert.ok(!html.includes('<img')); assert.match(html, /&lt;img/);
  assert.match(performanceCharts(data, 'database', '', esc), /do not add them together/);
});
