import test from 'node:test';
import assert from 'node:assert/strict';

// A tiny physical-site export. Ages are "age when exported", the same in every season.
const Y = new Date().getUTCFullYear();
const born = (age) => `${Y - age}-01-01`; // exactly `age` today (from Jan 1 on)
const row = (name, team, season, age) => [name, team, 0, season, 'CF', 0, age, 1200, 14, 80, [1], [50]];
const data = {
  leagues: ['USL Championship'], seasons: ['2024', '2025', '2026'], groups: [{ k: 'FWD' }], metrics: [{ l: 'Distance', g: 'Volume' }],
  rows: [
    row('Tommy Silva', 'Detroit City', 2, 24),
    row('Tommy Silva', 'Real Monarchs', 1, 24),
    row('I. McNeil LeFlore', 'Detroit City', 1, 23),
    row('M. Henry', 'Toronto II', 1, 24),
    row('S. Ors', 'Union Omaha', 2, 25),
    row('W. Kuzain', 'St. Louis City II', 0, 27),
    row('J. Sandmeyer', 'Chicago Fire II', 2, null),
    row('K. Stranger', 'Quakes II', 2, 22),
    row('C. Duke', 'Chattanooga', 2, 30),
    row('S. Rempel', 'Fort Wayne', 2, 24),
    row('J. Smith', 'Fort Wayne', 2, 20),
    row('J. Smith', 'Chattanooga Red Wolves', 2, 20),
  ],
};
globalThis.fetch = async () => ({ ok: true, json: async () => data });
const { loadPhysical, matchPhysical, resolveAutoLinks } = await import('../src/lib/physical.js');
const c = await loadPhysical(null);
const auto = (player) => matchPhysical(c, player).filter((m) => m.auto).map((m) => `${m.name}|${m.team}|${m.season}`);
const reasons = (player, siteName) => matchPhysical(c, player).find((m) => m.name === siteName)?.reasons;

test('full-name site rows match, across clubs and seasons', () => {
  assert.deepEqual(auto({ name: 'Tommy Silva', birthdate: born(24), club: 'Detroit City FC' }).sort(),
    ['Tommy Silva|Detroit City|2026', 'Tommy Silva|Real Monarchs|2025']);
});

test('a longer site surname matches, a shorter hyphen half does not', () => {
  assert.deepEqual(auto({ name: 'Isaiah LeFlore', birthdate: born(23), club: 'Tampa Bay Rowdies' }), ['I. McNeil LeFlore|Detroit City|2025']);
  assert.equal(reasons({ name: 'Malik Henry-Scott', birthdate: born(24) }, 'M. Henry'), undefined);
});

test('first of two Spanish surnames matches with age and club', () => {
  assert.deepEqual(reasons({ name: 'Sergio Ors Navarro', birthdate: born(25), club: 'Union Omaha' }, 'S. Ors'), ['name-close', 'age', 'club']);
  assert.deepEqual(auto({ name: 'Sergio Ors Navarro', birthdate: born(25), club: 'Union Omaha' }), ['S. Ors|Union Omaha|2026']);
});

test('age is compared with age today, so older seasons still match', () => {
  assert.deepEqual(auto({ name: 'Wan Kuzain', birthdate: born(27), club: 'Sporting Club Jacksonville' }), ['W. Kuzain|St. Louis City II|2024']);
  assert.deepEqual(auto({ name: 'Wan Kuzain', birthdate: born(31) }), []);
});

test('a row without an age links on club alone, never on name alone', () => {
  assert.deepEqual(auto({ name: 'Jack Sandmeyer', birthdate: born(23), club: 'Chicago Fire FC II' }), ['J. Sandmeyer|Chicago Fire II|2026']);
  assert.deepEqual(auto({ name: 'Jack Sandmeyer', birthdate: born(23), club: 'Austin FC' }), []);
});

test('club aliases work; a city shared by two clubs is not a club match', () => {
  assert.ok(reasons({ name: 'Kai Stranger', club: 'San Jose Earthquakes II' }, 'K. Stranger').includes('club'));
  assert.ok(!reasons({ name: 'Cam Duke', club: 'Chattanooga Red Wolves SC' }, 'C. Duke').includes('club'));
  assert.ok(reasons({ name: 'Jay Smith', club: 'Chattanooga Red Wolves SC' }, 'J. Smith').includes('club'));
});

test('surname-only matches are suggestions, never auto-linked', () => {
  const m = matchPhysical(c, { name: 'Michael Rempel', birthdate: born(24), club: 'Fort Wayne FC' });
  assert.deepEqual(m.map((x) => [x.name, x.reasons, x.auto]), [['S. Rempel', ['surname-only', 'age', 'club'], false]]);
});

test('a row two equally likely players claim goes to neither', () => {
  const { links, contested } = resolveAutoLinks(c, [
    { id: 1, name: 'Jason Smith', birthdate: born(20) },
    { id: 2, name: 'Jared Smith', birthdate: born(20) },
    { id: 3, name: 'Tommy Silva', birthdate: born(24) },
  ]);
  assert.equal(contested.size, 2);
  assert.deepEqual(links.get(1), []);
  assert.deepEqual(links.get(2), []);
  assert.equal(links.get(3).length, 2);
});

test('a contested row goes to the player with the stronger evidence', () => {
  const { links, contested } = resolveAutoLinks(c, [
    { id: 1, name: 'Jason Smith', birthdate: born(20) },                             // name + age
    { id: 2, name: 'Jared Smith', birthdate: born(20), club: 'Fort Wayne FC' },      // name + age + club
  ]);
  assert.deepEqual(links.get(2), ['J. Smith|Fort Wayne|USL Championship|2026']); // his club
  // Jason loses that row and ties on the other, so he keeps nothing rather than being guessed at.
  assert.deepEqual(links.get(1), []);
  assert.deepEqual([...contested], ['J. Smith|Chattanooga Red Wolves|USL Championship|2026']);
});

test('a confirmed link follows its row when the site relabels the team', async () => {
  const moved = JSON.parse(JSON.stringify(data));
  moved.rows.find((r) => r[0] === 'Tommy Silva' && r[3] === 2)[1] = 'Now at Someone Else';
  globalThis.fetch = async () => ({ ok: true, json: async () => moved });
  const { loadPhysical: load, repairKeys } = await import('../src/lib/physical.js?moved');
  const c2 = await load(null);
  const old = ['Tommy Silva|Detroit City|USL Championship|2026', 'Tommy Silva|Real Monarchs|USL Championship|2025'];
  const { keys, changed } = repairKeys(c2, old);
  assert.equal(changed, 1);
  assert.deepEqual(keys, ['Tommy Silva|Now at Someone Else|USL Championship|2026', old[1]]);
  // A key that still resolves is left alone, and an unknown one is kept rather than guessed at.
  assert.deepEqual(repairKeys(c2, ['Nobody|Anywhere|USL Championship|2026']), { keys: ['Nobody|Anywhere|USL Championship|2026'], changed: 0 });
});
