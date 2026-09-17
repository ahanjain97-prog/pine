import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark, fixedFloor, percentile, qualifiedReference } from '../src/lib/impect_benchmark.js';

const cats = { Passing: ['pass', 'loss'] };
const meta = new Map([['pass', { inverted: false }], ['loss', { inverted: true }]]);
const rows = Array.from({ length: 20 }, (_, i) => ({ playerId: i, matchShare: 5 + i,
  values: { pass: i, loss: 20 - i } }));

test('floor cannot fall below five, including malformed query parameters', () => {
  for (const x of [undefined, null, 0, .67, -1, NaN, Infinity, 'bad']) assert.equal(fixedFloor(x), 5);
  assert.equal(fixedFloor(10), 10);
});
test('low exposure with extreme rates gets raw values and no category or component percentile', () => {
  const target = { playerId: 99, matchShare: .67, values: { pass: 1e9, loss: 0 } };
  const result = benchmark(target, [...rows, target], cats, meta);
  assert.equal(result.peers, 20);
  assert.equal(result.eligible, false);
  assert.equal(result.categories[0].percentile, null);
  assert.equal(result.categories[0].score, null);
  for (const m of result.categories[0].components) assert.equal(m.percentile, null);
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
