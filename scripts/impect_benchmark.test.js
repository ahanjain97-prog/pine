import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark, fixedFloor, median, percentile, qualifiedReference } from '../src/lib/impect_benchmark.js';
import { CATEGORIES } from '../src/lib/impect_categories.js';

test('each position assigns every component to only one non-empty category', () => {
  for (const [position, categories] of Object.entries(CATEGORIES)) {
    assert.ok(Object.keys(categories).length > 0, `${position} has no categories`);
    const metrics = Object.values(categories).flat();
    assert.ok(Object.values(categories).every((components) => components.length > 0), `${position} has an empty category`);
    assert.equal(new Set(metrics).size, metrics.length, `${position} repeats a component across categories`);
  }
});

const cats = { Passing: ['pass', 'loss'] };
const meta = new Map([['pass', { inverted: false }], ['loss', { inverted: true }]]);
const rows = Array.from({ length: 20 }, (_, i) => ({ playerId: i, matchShare: 5 + i,
  values: { pass: i, loss: 20 - i } }));

test('floor cannot fall below five, including malformed query parameters', () => {
  for (const x of [undefined, null, 0, .67, -1, NaN, Infinity, 'bad']) assert.equal(fixedFloor(x), 5);
  assert.equal(fixedFloor(10), 10);
});
test('low exposure is scored against the qualified reference but flagged ineligible', () => {
  const target = { playerId: 99, matchShare: .67, values: { pass: 1e9, loss: 0 } };
  const result = benchmark(target, [...rows, target], cats, meta);
  assert.equal(result.peers, 20);
  assert.equal(result.eligible, false);
  assert.ok(Number.isFinite(result.categories[0].percentile));
  assert.ok(Number.isFinite(result.categories[0].score));
  for (const m of result.categories[0].components) assert.ok(Number.isFinite(m.percentile));
  assert.equal(result.categories[0].components[0].value, 1e9);
});
test('ineligible extreme samples cannot affect qualified normalization or ranking', () => {
  const target = rows[10];
  const base = benchmark(target, rows, cats, meta);
  const noisy = benchmark(target, [...rows, {playerId: 99, matchShare: .1, values: {pass: 1e12, loss: -1e12}}], cats, meta);
  assert.deepEqual(noisy, base);
});
test('direction, midpoint ties, zeros and valid denominators', () => {
  assert.equal(percentile(0, Array(8).fill(0)), 50);
  assert.equal(percentile(1, [0, 1, 2]), null);
  const result = benchmark(rows[19], rows, cats, meta).categories[0];
  assert.equal(result.percentile, 97.5);
  assert.equal(result.components[1].percentile, 97.5);
  const missing = rows.map((p, i) => ({...p, values: {...p.values, loss: i < 13 ? null : p.values.loss}}));
  const m = benchmark(missing[19], missing, cats, meta).categories[0].components[1];
  assert.equal(m.peer_count, 7);
  assert.equal(m.percentile, null);
});
test('pool uses raw metric scale, not league-relative percentiles', () => {
  const weak = rows.map((r) => ({...r, playerId: r.playerId + 100,
    values: {pass: r.values.pass - 100, loss: r.values.loss + 100}}));
  const target = weak[19];
  assert.equal(benchmark(target, weak, cats, meta).categories[0].percentile, 97.5);
  assert.ok(benchmark(target, [...rows, ...weak], cats, meta).categories[0].percentile < 50);
});
test('transfers enter reference once, using largest qualified league sample', () => {
  const transfer = {...rows[0], matchShare: 30, values: {pass: 99, loss: 0}};
  const ref = qualifiedReference([...rows, transfer], 5);
  assert.equal(ref.length, 20);
  assert.equal(ref.find((p) => p.playerId === 0), transfer);
});

test('league-adjusted pooling removes a league-wide shift', () => {
  const cats2 = { Passing: ['pass'] };
  const meta2 = new Map([['pass', { inverted: false }]]);
  const a = Array.from({ length: 20 }, (_, i) => ({ playerId: i, league: 'A', matchShare: 10, values: { pass: i } }));
  const b = Array.from({ length: 20 }, (_, i) => ({ playerId: 100 + i, league: 'B', matchShare: 10, values: { pass: i + 50 } }));
  const all = [...a, ...b];
  const pct = (t, opts) => benchmark(t, all, cats2, meta2, 5, opts).categories[0].percentile;
  assert.ok(pct(b[0]) > pct(a[19]), 'unadjusted: the whole higher-output league outranks the other');
  assert.equal(pct(a[7], { byLeague: true }), pct(b[7], { byLeague: true }), 'adjusted: same within-league rank, same percentile');
  const mean = (list, opts) => list.reduce((s, t) => s + pct(t, opts), 0) / list.length;
  assert.ok(Math.abs(mean(a, { byLeague: true }) - 50) < 1.5);
  assert.ok(Math.abs(mean(b, { byLeague: true }) - 50) < 1.5);
  const comp = (t) => benchmark(t, all, cats2, meta2, 5, { byLeague: true }).categories[0].components[0].percentile;
  assert.equal(comp(a[12]), comp(b[12]), 'component percentiles are league-adjusted too');
});

test('without byLeague the original single-fit result is unchanged', () => {
  const t = rows[10];
  const plain = benchmark(t, rows, cats, meta);
  const flagged = benchmark(t, rows.map((r, i) => ({ ...r, league: i % 2 ? 'X' : 'Y' })), cats, meta, 5, { byLeague: false });
  assert.deepEqual(flagged.categories.map((c) => c.percentile), plain.categories.map((c) => c.percentile));
  assert.equal(plain.league_adjusted, false);
});

test('each metric carries the raw median of qualified peers', () => {
  assert.equal(median([1, 2, 3, 4, 5, 6, 7]), null, 'fewer than eight peers');
  assert.equal(median([8, 1, 7, 2, 6, 3, 5, 4]), 4.5);
  assert.equal(median([9, 1, 8, 2, 7, 3, 6, 4, 5, null, NaN]), 5);
  const loud = { playerId: 99, matchShare: .1, values: { pass: 1e9, loss: 1e9 } };
  const [pass, loss] = benchmark(rows[0], [...rows, loud], cats, meta).categories[0].components;
  assert.equal(pass.median, 9.5, 'raw scale, and the unqualified player is ignored');
  assert.equal(loss.median, 10.5, 'not flipped for lower-is-better metrics');
});
