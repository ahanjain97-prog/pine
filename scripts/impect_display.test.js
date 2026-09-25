import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../src/lib/impect_categories.js';
import { categoryDisplay, phasesFor, metricKind, PHASES } from '../src/lib/impect_display.js';

test('every study category has a shown name, a phase and a description', () => {
  const phases = new Set(PHASES.map((p) => p.id));
  for (const [group, cats] of Object.entries(CATEGORIES)) {
    for (const name of Object.keys(cats)) {
      const d = categoryDisplay(group, name);
      assert.ok(phases.has(d.phase), `${group} "${name}" has no phase; add it to impect_display.js`);
      assert.ok(d.description, `${group} "${name}" has no description`);
    }
    const labels = Object.keys(cats).map((name) => categoryDisplay(group, name).label);
    assert.equal(new Set(labels).size, labels.length, `${group} shows two categories under one name`);
  }
});

test('the same metrics get the same name at every position', () => {
  const byMetrics = new Map();
  for (const [group, cats] of Object.entries(CATEGORIES)) {
    for (const [name, metrics] of Object.entries(cats)) {
      const key = [...metrics].sort().join(',');
      const label = categoryDisplay(group, name).label;
      if (!byMetrics.has(key)) byMetrics.set(key, new Set());
      byMetrics.get(key).add(label);
    }
  }
  for (const labels of byMetrics.values()) assert.equal(labels.size, 1, `one metric set, several names: ${[...labels]}`);
  // Centre mids' "Ball security and directness" is plain ball security; wingers' adds backward passing.
  assert.equal(categoryDisplay('CM', 'Ball security and directness').label, 'Ball security');
  assert.equal(categoryDisplay('W', 'Ball security and directness').label, 'Ball security & directness');
});

test('a category the display map does not know still renders, under Other', () => {
  assert.deepEqual(categoryDisplay('CM', 'Brand new category'), { label: 'Brand new category', phase: 'other', description: null });
  assert.deepEqual(phasesFor(['defend', 'other', 'build']).map((p) => p.id), ['build', 'defend', 'other']);
});

test('metric kinds', () => {
  assert.equal(metricKind('kpi__LOST_GROUND_DUELS_DEF'), 'mistake');
  assert.equal(metricKind('kpi__PXT_PASS_FAIL'), 'mistake');
  assert.equal(metricKind('score__UNSUCCESSFUL_PASSES_CLEAN'), 'mistake');
  assert.equal(metricKind('score__GROUND_DUEL_SCORE'), 'score');
  assert.equal(metricKind('score__RATIO_GROUND_DUELS'), 'rate');
  assert.equal(metricKind('score__PASS_COMPLETION_OVER_EXPECTED'), 'rate');
  assert.equal(metricKind('score__GK_PREVENTED_GOALS_TOTAL_SHOT_XG'), 'rate');
  assert.equal(metricKind('score__NUMBER_OF_GROUND_DUELS'), 'volume');
  assert.equal(metricKind('kpi__PXT_PASS_PRO'), 'volume');
});
