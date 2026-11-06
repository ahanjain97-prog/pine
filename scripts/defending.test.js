import test from 'node:test';
import assert from 'node:assert/strict';
import { addBallSecurity, addDefending, defendingOutlook, padj, SHRINK_K } from '../src/lib/defending.js';
import { CATEGORIES, COMPOSITES } from '../src/lib/impect_categories.js';

test('possession adjustment: 1 at 50%, more for teams that have the ball more', () => {
  assert.equal(padj(0.5), 1);
  assert.ok(padj(0.6) > 1 && padj(0.4) < 1);
  assert.ok(Math.abs(padj(0.6) * padj(0.4) - (2 / (1 + Math.exp(-1))) * (2 / (1 + Math.exp(1)))) < 1e-12);
});

const row = (group, values, squad = 'A', matchShare = 10) => ({ group, matchShare, squadShares: new Map([[squad, matchShare]]), values: { ...values } });
const duels = (won, lost) => ({ kpi__WON_AERIAL_DUELS_DEF: won, kpi__LOST_AERIAL_DUELS_DEF: lost, kpi__WON_GROUND_DUELS_DEF: won, kpi__LOST_GROUND_DUELS_DEF: lost });

test('duel win rates are pulled toward the league rate, less so with more duels', () => {
  const few = row('CB', duels(0.4, 0.1), 'A', 1);     // 0.4 won of 0.5 contested, over one match
  const many = row('CB', duels(4, 1), 'B', 10);        // the same 80%, over 50 duels
  const rest = row('CB', duels(2, 2), 'C', 20);        // the rest of the league at 50%
  addDefending([few, many, rest], new Map());
  const league = (0.4 * 1 + 4 * 10 + 2 * 20) / (0.5 * 1 + 5 * 10 + 4 * 20);
  const k = SHRINK_K.CB.aerial;
  assert.ok(Math.abs(many.values.derived__AERIAL_WIN_SHRUNK - (40 + k * league) / (50 + k)) < 1e-12);
  assert.ok(few.values.derived__AERIAL_WIN_SHRUNK < many.values.derived__AERIAL_WIN_SHRUNK, 'a tiny sample counts for less');
  assert.ok(many.values.derived__AERIAL_WIN_SHRUNK < 0.8 && many.values.derived__AERIAL_WIN_SHRUNK > league);
});

test('counts are scaled by possession; squads without a figure count as 50%', () => {
  const a = row('MID', { kpi__BALL_WIN_NUMBER: 8, kpi__NUMBER_OF_PRESSES: 20, score__INTERCEPTION_SCORE: 1 }, 'Possession FC');
  const b = row('MID', { kpi__BALL_WIN_NUMBER: 8, kpi__NUMBER_OF_PRESSES: 20, score__INTERCEPTION_SCORE: 1 }, 'Unknown FC');
  addDefending([a, b], new Map([['Possession FC', 0.6]]));
  assert.ok(Math.abs(a.values.derived__PADJ_BALL_WINS - 8 * padj(0.6)) < 1e-12);
  assert.equal(b.values.derived__PADJ_BALL_WINS, 8);
  assert.equal(a.values.derived__PADJ_GROUND_DUELS, null, 'missing inputs give no value rather than zero');
});

test('only the Defending v2 groups get derived metrics, and every derived metric a category uses is produced', () => {
  const w = row('W', { kpi__BALL_WIN_NUMBER: 3 });
  addDefending([w], new Map());
  assert.equal(w.values.derived__PADJ_BALL_WINS, undefined);
  const used = new Set(Object.values(CATEGORIES).flatMap((c) => Object.values(c).flat()).filter((m) => m.startsWith('derived__')));
  const p = row('CB', { ...duels(2, 1), kpi__BALL_WIN_NUMBER: 5, score__INTERCEPTION_SCORE: 1, score__LOOSE_BALL_REGAIN_SCORE: 1, kpi__NUMBER_OF_PRESSES: 9, kpi__SECOND_BALL_START: 3, kpi__SECOND_BALL_WIN: 2,
    kpi__BALL_LOSS_NUMBER: 12, kpi__CRITICAL_BALL_LOSS_NUMBER: 1, score__TOTAL_TOUCHES: 60 });
  addDefending([p], new Map());
  addBallSecurity([p]);
  for (const m of used) assert.ok(Number.isFinite(p.values[m]), `${m} is produced`);
});

test('each Defending overall averages categories that exist at that position', () => {
  for (const [group, comps] of Object.entries(COMPOSITES)) {
    for (const members of Object.values(comps)) for (const m of members) assert.ok(CATEGORIES[group][m], `${group}: ${m}`);
  }
});

test('likely level: pulled toward the median, more so and with a wider range on small samples', () => {
  const full = defendingOutlook(35, 18, 'CB'), thin = defendingOutlook(35, 4, 'CB'), long = defendingOutlook(35, 40, 'CB');
  assert.ok(full.expected > 35 && full.expected < 50, 'a below-median score moves toward the median');
  assert.ok(thin.expected > full.expected && thin.high - thin.low > full.high - full.low, 'fewer matches: nearer 50, wider');
  assert.ok(long.high - long.low < full.high - full.low, 'more matches: narrower');
  assert.ok(full.low < full.expected && full.expected < full.high);
  assert.equal(defendingOutlook(35, 18, 'W'), null, 'only the back-six groups');
  assert.equal(defendingOutlook(null, 18, 'CB'), null);
  const top = defendingOutlook(95, 18, 'FB');
  assert.ok(top.expected < 95 && top.expected > 60);
});

test('ball security is losses per touch, for every group, and empty without touches', () => {
  const w = row('W', { kpi__BALL_LOSS_NUMBER: 12, kpi__CRITICAL_BALL_LOSS_NUMBER: 1, score__TOTAL_TOUCHES: 48 });
  const none = row('CB', { kpi__BALL_LOSS_NUMBER: 3, kpi__CRITICAL_BALL_LOSS_NUMBER: 0, score__TOTAL_TOUCHES: 0 });
  addBallSecurity([w, none]);
  assert.equal(w.values.derived__BALL_LOSSES_PER_TOUCH, 0.25);
  assert.equal(w.values.derived__CRITICAL_LOSSES_PER_TOUCH, 1 / 48);
  assert.equal(none.values.derived__BALL_LOSSES_PER_TOUCH, null);
});
