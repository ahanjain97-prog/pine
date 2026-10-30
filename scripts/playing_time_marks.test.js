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

test('a slow current season does not prevent older cached seasons from appearing', async () => {
  const { loadPlayingTimePanel } = await import('../public/playing-time.js');
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const panel = { isConnected: true, innerHTML: '', querySelectorAll: () => [] };
  const calls = [];
  const api = async (_, path) => {
    const season = new URL(path, 'http://pine.test').searchParams.get('season');
    if (!season) return { seasons: ['2026', '2025', '2024'].map((season) => ({ season, covered: true })) };
    calls.push(season);
    if (season === '2026') await slow;
    return { season, minutes: 100, share: 50, teams: [{ id: 1, name: 'Example FC', fixtures: [], minutes: 100, share: 50 }] };
  };
  const loading = loadPlayingTimePanel(panel, { id: 9999, impect_id: 9999 }, api);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['2026', '2025', '2024']);
  assert.equal((panel.innerHTML.match(/class="pt-total">100 min/g) || []).length, 2);
  release();
  await loading;
  assert.equal((panel.innerHTML.match(/class="pt-total">100 min/g) || []).length, 3);
});
