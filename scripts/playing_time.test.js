import test from "node:test";
import assert from "node:assert/strict";
import { createPlayingTimeService, reduceMatch } from "../src/lib/playing_time.js";

const clock = Date.parse("2026-10-29T12:00:00Z");
function fixture({ broken = false } = {}) {
  const calls = new Map(), disk = new Map();
  const squads = [{ id: 10, name: "First FC" }, { id: 20, name: "Second FC" }, { id: 30, name: "Opponent" }];
  const game = (id, date, home, available = true) => ({ id, scheduledDate: date + "T12:00:00Z", homeSquadId: home, awaySquadId: 30, available });
  const games = [game(1, "2026-01-10", 10), game(2, "2026-02-10", 10),
    game(3, "2026-06-16", 20), game(4, "2026-07-10", 20), game(5, "2026-08-10", 20),
    game(6, "2026-09-10", 20, false), game(7, "2030-01-01", 20)];
  const row = (id, minutes, share) => ({ id, playDuration: minutes * 60, matchShare: share });
  const durations = [90, 100, 90, 120, 100];
  let shouldBreak = broken;
  const get = async (path) => {
    calls.set(path, (calls.get(path) || 0) + 1);
    if (path.endsWith('/squads')) return squads;
    if (path.endsWith('/matches')) return games;
    const squad = Number(path.match(/squads\/(\d+)/)?.[1]);
    if (squad) return squad === 10 ? [{ playerId: 1, playDuration: 3600 }, { playerId: 2, playDuration: 11400 }]
      : squad === 20 ? [{ playerId: 1, playDuration: 4800 }] : [];
    const id = Number(path.match(/matches\/(\d+)/)?.[1]);
    if (id === 2 && shouldBreak) { shouldBreak = false; throw Error('Temporary upstream failure'); }
    if (id < 1 || id > 5) throw Error(`Should not fetch unavailable/future match ${id}`);
    const duration = durations[id - 1];
    // A position switch produces two rows for the same player in match 1.
    const mine = id === 1 ? [row(1, 30, 1 / 3), row(1, 30, 1 / 3)] : id === 4 ? [row(1, 30, .25)] : id === 5 ? [row(1, 50, .5)] : [];
    return { squadHome: { id: id <= 2 ? 10 : 20, players: [...mine, row(2, duration, 1)] },
      squadAway: { id: 30, players: [row(3, duration, 1)] } };
  };
  const options = { get, list: async () => [{ id: 100, season: '2026', type: 'League', competition: 'League' },
    { id: 99, season: '2025', type: 'Cup', competition: 'Cup' }, { id: 98, season: '2024', type: 'League', competition: 'League' }],
    player: async () => ({ iterations: [{ id: 100 }, { id: 99 }, { id: 98 }] }),
    now: () => clock, intervalMs: 0, read: (key) => disk.get(key), write: (key, value) => disk.set(key, value) };
  return { service: createPlayingTimeService(options), calls, disk, options };
}

test('manifest excludes cups and keeps missing years distinct from zero minutes', async () => {
  const { service } = fixture();
  assert.deepEqual((await service.manifest(1)).seasons, [{ season: '2026', covered: true }, { season: '2025', covered: false }, { season: '2024', covered: true }]);
  assert.equal((await service.season(1, '2025')).minutes, null);
});

test('totals combine positions; share counts zero-minute fixtures and actual match lengths', async () => {
  const { service, calls } = fixture();
  const result = await service.season(1, '2026', { club: 'Second FC', joined: '2026-06-15' });
  assert.equal(result.minutes, 140);
  assert.equal(result.share, 28, '140 minutes / 500 possible minutes across the two stints');
  assert.deepEqual(result.teams.map((t) => [t.minutes, t.possible_minutes, t.share, t.games]), [[60, 190, 31.58, 2], [80, 310, 25.81, 3]]);
  assert.equal(result.teams[0].fixtures[1].minutes, 0, 'a real team game without the player is zero');
  assert.equal(result.teams[1].fixtures.at(-1).minutes, null, 'unavailable game is not zero and not in the denominator');
  assert.ok(![...calls.keys()].some((p) => /matches\/[67]\//.test(p)), 'future and unavailable games are never requested');
  assert.ok(!JSON.stringify(result).includes('kpis'));
});

test('goalkeepers work, concurrent players share downloads, and reduced caches survive restart', async () => {
  const { service, calls, options } = fixture();
  const [a, keeper] = await Promise.all([service.season(1, '2026'), service.season(2, '2026')]);
  assert.equal(a.minutes, 140);
  // The fixture index lists this keeper for First FC only.
  assert.equal(keeper.minutes, 190);
  assert.equal(keeper.share, 100);
  assert.ok([...calls.values()].every((n) => n === 1), 'every shared resource is fetched once');
  const count = [...calls.values()].reduce((a, b) => a + b, 0);
  await createPlayingTimeService(options).season(2, '2026');
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), count, 'reads reduced disk cache');
});

test('upstream failure is an error, never zero minutes; a later retry succeeds', async () => {
  const { service, calls } = fixture({ broken: true });
  await assert.rejects(service.season(1, '2026'), /Temporary upstream failure/);
  assert.equal((await service.season(1, '2026')).minutes, 140);
  assert.equal(calls.get('/v5/customerapi/matches/2/player-kpis'), 2);
});

test('a known join date bounds transfers without dropping any observed appearances', async () => {
  const { service } = fixture();
  const result = await service.season(1, '2026', { club: 'Second FC', joined: '2026-07-15' });
  assert.equal(result.minutes, 140, 'July 10 appearance survives inconsistent profile join date');
  assert.equal(result.teams[1].games, 2, 'pre-arrival zero-minute game is excluded');
});

test('an overlapping loan or reserve-team spell retains observed minutes in both teams', async () => {
  const { options } = fixture();
  const get = options.get;
  options.get = async (path) => {
    const result = await get(path);
    if (path.endsWith('/matches')) return result.map((g) => g.id === 1 ? { ...g, scheduledDate: '2026-07-20T12:00:00Z' } : g);
    return result;
  };
  const result = await createPlayingTimeService(options).season(1, '2026');
  assert.equal(result.minutes, 140);
  assert.equal(result.teams.length, 2);
});

test('invalid or missing duration fails instead of inventing a denominator', () => {
  assert.throws(() => reduceMatch({ squadHome: { players: [] } }), /Incomplete/);
  assert.throws(() => reduceMatch({ squadHome: { players: [] }, squadAway: { players: [] } }), /duration/);
});

test('saved player timelines return during a stalled refresh and survive a restart', async () => {
  const { service, disk, options } = fixture();
  const original = await service.season(1, '2026');
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const get = options.get;
  const restarted = createPlayingTimeService({ ...options, now: () => clock + 13 * 60 * 60 * 1000,
    get: async (path) => { calls++; await gate; return get(path); } });
  const result = await Promise.race([restarted.season(1, '2026'), new Promise((_, reject) => setTimeout(() => reject(Error('Blocked on refresh')), 100))]);
  assert.deepEqual(result, original);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls > 0, 'refresh started independently');
  release();
  // Wait for the replacement snapshot, not just the first resource download.
  for (let n = 0; n < 40 && ![...disk].some(([key, v]) => key.startsWith('playing-time-player-') && v.at > clock); n++) await new Promise((r) => setTimeout(r, 5));
  assert.ok([...disk].some(([key, v]) => key.startsWith('playing-time-player-') && v.at > clock));
});

test('completed historical matches are reused when the season index expires', async () => {
  const { service, options, calls, disk } = fixture();
  await service.season(1, '2026');
  for (const [key] of disk) if (key.startsWith('playing-time-player-')) disk.delete(key);
  await createPlayingTimeService({ ...options, now: () => clock + 13 * 60 * 60 * 1000 }).season(1, '2026');
  assert.equal(calls.get('/v5/customerapi/matches/1/player-kpis'), 1);
  assert.equal(calls.get('/v5/customerapi/iterations/100/matches'), 2);
});

test('background warm-up makes a previously unseen player need no additional match downloads', async () => {
  const { service, calls } = fixture();
  await service.warm({ id: 100, season: '2026' });
  const before = [...calls.values()].reduce((a, b) => a + b, 0);
  const keeper = await service.season(2, '2026');
  assert.equal(keeper.share, 100);
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), before);
});

test('cached transfer bounds are not reused after the player club/join date changes', async () => {
  const { service } = fixture();
  const before = await service.season(1, '2026', { club: 'Second FC', joined: '2026-06-15' });
  const after = await service.season(1, '2026', { club: 'Second FC', joined: '2026-07-15' });
  assert.notEqual(before.share, after.share);
  assert.equal(before.minutes, after.minutes);
});

test('an offline refresh preserves the saved timeline and backs off instead of retrying every view', async () => {
  const { service, options } = fixture();
  const original = await service.season(1, '2026');
  let calls = 0;
  const restarted = createPlayingTimeService({ ...options, now: () => clock + 13 * 60 * 60 * 1000,
    get: async () => { calls++; throw Error('Offline fixture'); } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await restarted.season(1, '2026'), original);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterFailure = calls;
    assert.ok(afterFailure > 0);
    assert.deepEqual(await restarted.season(1, '2026'), original);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, afterFailure);
  } finally { console.warn = warn; }
});

test('the explicit refresh action can replace otherwise-fresh match data', async () => {
  const { service, calls } = fixture();
  await service.warm({ id: 100, season: '2026' });
  await service.warm({ id: 100, season: '2026' });
  assert.equal(calls.get('/v5/customerapi/matches/1/player-kpis'), 1);
  await service.warm({ id: 100, season: '2026' }, { force: true });
  assert.equal(calls.get('/v5/customerapi/matches/1/player-kpis'), 2);
});
