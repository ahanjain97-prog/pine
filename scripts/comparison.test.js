import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComparison, comparisonPath, mergeRows, gap, orderRows, choosePair, kpiComparable, kpiRows,
  physicalComparable, physicalRows, scoutingComparable, scoutingRows } from '../public/comparison-data.js';

const metric = (id, percentile, value = 0) => ({ id, label: id, percentile, value, direction: 'higher' });
const kpi = () => ({ position: 'MID', iteration: { id: 1916, season: '2026' }, benchmark_competitions: ['USL League One', 'USL Championship'], min_share_used: 5,
  phases: [{ id: 'build', name: 'On-Ball' }], categories: [{ name: 'Distribution', label: 'Passing', phase: 'build', percentile: 82,
    components: [{ metric: 'failed_passes', label: 'Failed passes', kind: 'mistake', inverted: true, value: 0, percentile: 90 }] }] });
const snapshot = () => ({ data_as_of: '2026-10-01', render_input: { schema_version: 16, subject: { season: 2026, league: 'USL1', profiles: [{ group: 'CM',
  percentiles: { IMPECT_SCORE_PXT: 0 }, grid: [{ metric: 'TEST', name: 'Passing', bucket: 'passing', direction: 'lower', value: 0, percentile: 90, rare: false },
    { metric: 'RARE', name: 'Rare metric', bucket: 'shooting', direction: 'higher', value: 0, percentile: 99, rare: true }, { film: 'Watch film', name: 'Film' }] }] },
  value: { PxT: ['IMPECT_SCORE_PXT'] }, grid: { source: '/source/metric_grid.yml', ledger: 'ledger.csv' }, provenance: { sha256: { '/source/metric_grid.yml': 'a'.repeat(64) } } } });

test('comparison links round trip independent selections and encoded physical keys', () => {
  const state = { ids: [1, 2], tab: 'physical', sort: 'close', f0: 'A. Example|Harbor|USL1|2026', f1: 'name & club/2025', k0: '1916', p0: 'MID' };
  assert.deepEqual(parseComparison(comparisonPath(state).replace('#/compare/', '')), state);
  assert.deepEqual(parseComparison('7,7').ids, [7, null]);
  assert.deepEqual(parseComparison('bad,-2?tab=bad&sort=wrong').ids, [null, null]);
  assert.equal(parseComparison('1,2?tab=bad').tab, 'kpi');
});

test('alignment uses exact source identity, preserves zeros and puts missing gaps last', () => {
  const a = [metric('one', 0), metric('two', 80), metric('missing', null), metric('left-only', 90)];
  const b = [metric('two', 20), metric('one', 0), { ...metric('different-id', 90), label: 'left-only' }];
  const rows = mergeRows(a, b);
  assert.equal(rows.length, 5); assert.equal(rows[0].a.value, 0); assert.equal(rows[0].b.percentile, 0);
  assert.equal(rows[3].b, null, 'matching display text does not merge different source metrics');
  assert.equal(gap(rows[0]), 0); assert.equal(gap(rows[1]), 60); assert.equal(gap(rows[2]), null);
  assert.equal(gap(rows[1], false), null);
  assert.equal(gap({ a: metric('x', 80), b: { ...metric('x', 20), direction: 'lower' } }), null);
  assert.deepEqual(orderRows(rows, 'gap').map(r => r.id).slice(0, 2), ['two', 'one']);
  assert.deepEqual(orderRows(rows, 'close').map(r => r.id).slice(0, 2), ['one', 'two']);
  assert.deepEqual(orderRows(rows, 'gap', false), rows);
});

test('defaults choose latest shared season and retain explicit unavailable selections', () => {
  const a = [{ key: 1, season: '2026' }, { key: 2, season: '2025' }];
  const b = [{ key: 3, season: '2027' }, { key: 4, season: '2026' }, { key: 5, season: '2025' }];
  assert.deepEqual(choosePair(a, b).map(x => x.key), [1, 4]);
  assert.deepEqual(choosePair(a, b, ['2', null]).map(x => x.key), [2, 5]);
  assert.equal(choosePair(a, b, ['gone', '4'])[0], null);
});

test('KPI gaps require the same positional pooled context; lower-is-better is not re-inverted', () => {
  const a = kpi(), b = kpi(); b.iteration.id = 1918; b.benchmark_competitions.reverse();
  assert.equal(kpiComparable(a, b), true, 'different league IDs can share the same pooled benchmark');
  for (const edit of [x => x.position = 'FB', x => x.iteration.season = '2025', x => x.min_share_used = 10,
    x => x.benchmark_competitions.pop(), x => x.empty = true, x => delete x.iteration.season, x => delete x.min_share_used]) {
    const other = structuredClone(b); edit(other); assert.equal(kpiComparable(a, other), false);
  }
  const rows = kpiRows(a);
  assert.equal(rows[0].children[0].percentile, 90); assert.equal(rows[0].children[0].value, 0);
  assert.equal(rows[0].children[0].direction, 'lower');
  assert.deepEqual(kpiRows({ empty: true }), []);
});

test('physical metrics align by source ID across reordered metadata; differing or tiny pools suppress gaps', () => {
  const row = { league: 'USL1', season: '2026', grp: 'MID', pool: 30, raw: [0, 21.23], pct: [0, null] };
  const a = physicalRows({ meta: { metrics: [{ k: 'sprint', l: 'Sprint count' }, { k: 'speed', l: 'Speed' }] } }, row);
  const b = physicalRows({ meta: { metrics: [{ k: 'speed', l: 'Speed' }, { k: 'sprint', l: 'Sprint count' }] } }, { ...row, raw: [22, 2], pct: [80, 20] });
  assert.equal(mergeRows(a, b)[0].b.value, 2);
  assert.equal(a[0].value, 0); assert.equal(a[1].percentile, null);
  assert.equal(physicalComparable(row, row), true);
  for (const changes of [{ league: 'MLSNP' }, { season: '2025' }, { grp: 'FB' }, { pool: 31 }, { pool: 5 }]) assert.equal(physicalComparable(row, { ...row, ...changes }), false);
});

test('scouting comparisons retain original values, suppress rare ranks and reject unsupported contexts', () => {
  const a = snapshot(), b = snapshot();
  assert.equal(scoutingComparable(a, b), true);
  const rows = scoutingRows(a);
  assert.equal(rows.length, 3); assert.equal(rows[0].percentile, 0); assert.equal(rows[1].value, 0);
  assert.equal(rows[2].percentile, null); assert.equal(rows[2].rare, true);
  for (const edit of [x => x.render_input.schema_version++, x => x.data_as_of = '2026-09-01', x => x.render_input.subject.league = 'USLC',
    x => x.render_input.subject.profiles[0].group = 'W', x => x.render_input.grid.ledger = 'other.csv', x => x.render_input.provenance.sha256 = {}]) {
    const other = snapshot(); edit(other); assert.equal(scoutingComparable(a, other), false);
  }
  const unknown = snapshot(); unknown.render_input.schema_version = 99;
  assert.deepEqual(scoutingRows(unknown), []);
  assert.equal(scoutingComparable(a, null), false);
  const missing = snapshot(); delete missing.render_input.subject.league;
  assert.equal(scoutingComparable(missing, structuredClone(missing)), false);
  assert.equal(kpiComparable({}, {}), false);
  assert.equal(physicalComparable({}, {}), false);
});
