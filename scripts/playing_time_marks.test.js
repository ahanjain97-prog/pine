import test from 'node:test';
import assert from 'node:assert/strict';
import { fixturePositions } from '../public/playing-time.js';

test('congested fixtures stay separate, ordered, and inside desktop and phone charts', () => {
  for (const width of [200, 265, 685]) {
    const fractions = [.2, .201, .202, .21, .5, .9, .901, .902, .999];
    const xs = fixturePositions(fractions, width);
    assert.ok(xs[0] >= 3 && xs.at(-1) <= width - 3);
    assert.ok(xs.every((x, i) => !i || x - xs[i - 1] >= 4.999));
    assert.equal(xs[4], width * .5, 'isolated fixture stays on its actual date');
  }
  assert.deepEqual(fixturePositions([], 200), []);
});
