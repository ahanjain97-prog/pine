import test from 'node:test';
import assert from 'node:assert/strict';
import { stampSummary } from '../public/summary-stamp.js';

const NOW = new Date('2026-11-08T15:00:00Z');
const stamp = (before, after) => stampSummary(before, after, 'Ahan', NOW);

test('an update added to the summary is dated and signed where it starts', () => {
  assert.equal(stamp('', "Agent says he's open to League One."), "[Nov 8, 2026 · Ahan] Agent says he's open to League One.");
  assert.equal(stamp('Open to League One.', 'Open to League One.\n\nSpoke again today, wants a visa deal.'),
    'Open to League One.\n\n[Nov 8, 2026 · Ahan] Spoke again today, wants a visa deal.');
  assert.equal(stamp('Had his call with Charleston.', 'Had his call with Charleston. Loudoun interest has dropped off.'),
    'Had his call with Charleston. [Nov 8, 2026 · Ahan] Loudoun interest has dropped off.');
  assert.equal(stamp('Line one.\nLine two.', 'New update from the agent today.\nLine one.\nLine two.'),
    '[Nov 8, 2026 · Ahan] New update from the agent today.\nLine one.\nLine two.');
});

test('edits, small touch-ups and mid-sentence additions are left as written', () => {
  for (const [before, after] of [
    ['Agent thinks he can get first team.', 'Agent thinks he can get a first team deal at LAFC.'], // changes existing words
    ['Agent called.', 'Agent called back.'], // too small to be an update
    ['Some text', 'Some text, plus a mid-sentence clause added'],
    ['Agent called', 'Agent called Monday about a visa deal'], // continues the sentence
    ['Old text that got rewritten.', 'New text that replaced it entirely.'],
    ['Same.', 'Same.'],
  ]) assert.equal(stamp(before, after), after);
});
