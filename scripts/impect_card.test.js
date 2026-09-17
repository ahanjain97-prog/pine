import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_METRICS } from '../src/lib/impect_categories.js';
import { playerKpiCard } from '../src/lib/impect_kpi.js';

test('live card assembly pools three same-season leagues and withholds a cameo target', async () => {
  const oldFetch = globalThis.fetch;
  const oldUser = process.env.IMPECT_USERNAME, oldPass = process.env.IMPECT_PASSWORD;
  process.env.IMPECT_USERNAME = 'fixture'; process.env.IMPECT_PASSWORD = 'fixture';
  const comps = ['USL Championship', 'MLS Next Pro', 'USL League One'];
  const metrics = [...new Set(ALL_METRICS)].map((m, i) => ({ id: i, metric: m,
    name: m.split('__')[1], inverted: false, details: { label: m } }));
  const its = comps.map((name, i) => ({ id: i + 1, season: '2026', competition: { name, type: 'League' } }));
  const ids = (it) => Array.from({length: 12}, (_, i) => it * 100 + i).concat(it === 1 ? [999] : []);
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    let data;
    if (path.endsWith('/token')) return Response.json({access_token: 'fixture', expires_in: 300});
    if (path.endsWith('/countries')) data = [];
    else if (path.endsWith('/iterations')) data = its;
    else if (path === '/v5/customerapi/kpis') data = metrics.filter((m) => m.metric.startsWith('kpi__'));
    else if (path === '/v5/customerapi/player-scores') data = metrics.filter((m) => m.metric.startsWith('score__'));
    else {
      const it = Number(path.match(/iterations\/(\d+)/)?.[1]);
      if (path.endsWith('/players')) data = ids(it).map((id) => ({id, commonname: `Fixture ${id}`, currentSquadId: it}));
      else if (path.endsWith('/squads')) data = [{id: it, name: `Fixture squad ${it}`}];
      else if (path.endsWith('/player-kpis') || path.endsWith('/player-scores')) {
        const kpi = path.endsWith('/player-kpis');
        data = ids(it).map((id, i) => ({playerId: id, position: 'RIGHT_WINGER',
          matchShare: id === 999 ? .67 : 10, playDuration: id === 999 ? 4140 : 54000,
          [kpi ? 'kpis' : 'playerScores']: metrics.filter((m) => m.metric.startsWith(kpi ? 'kpi__' : 'score__')).map((m) => ({
            [kpi ? 'kpiId' : 'playerScoreId']: m.id, value: id === 999 ? 10000 : i + it * 20,
          }))}));
        // Player 111 also logs a small striker stint, to exercise the position list and selection.
        if (it === 1) data.push({ ...data.find((r) => r.playerId === 111), position: 'CENTER_FORWARD', matchShare: 2, playDuration: 10800 });
      } else throw Error(`Unexpected fixture URL: ${path}`);
    }
    return Response.json(data);
  };
  try {
    const low = await playerKpiCard(999, {iterationId: 1, minShare: .67});
    assert.equal(low.min_share_used, 5);
    assert.equal(low.peer_count, 36);
    assert.equal(low.league_peer_count, 12);
    assert.equal(low.eligible, false);
    assert.deepEqual(low.benchmark_competitions, comps);
    assert.equal(low.reference_sources.length, 3);
    // Below the floor the player is still scored against the qualified reference, flagged ineligible.
    assert.ok(low.categories.every((c) => Number.isFinite(c.percentile) && Number.isFinite(c.league_percentile)));
    assert.ok(low.categories[0].components.every((m) => m.value === 10000 && Number.isFinite(m.percentile)));
    const qualified = await playerKpiCard(111, {iterationId: 1});
    assert.equal(qualified.eligible, true);
    assert.ok(qualified.categories[0].league_percentile > 90);
    // The fixture leagues differ only by a constant shift in output; league-adjusted pooling removes it,
    // so the top player in the lowest-output league also ranks near the top of the pooled benchmark.
    assert.equal(qualified.league_adjusted, true);
    assert.ok(qualified.categories[0].percentile > 90);
    assert.equal(qualified.categories[0].peer_count, 36);
    assert.equal(qualified.position, 'W');
    assert.deepEqual(qualified.positions.map((o) => [o.group, o.match_share, o.eligible]), [['W', 10, true], ['ST', 2, false]]);
    const asStriker = await playerKpiCard(111, {iterationId: 1, position: 'ST'});
    assert.equal(asStriker.position, 'ST');
    assert.equal(asStriker.eligible, false);
    assert.ok(asStriker.categories.every((c) => c.percentile === null));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUser === undefined) delete process.env.IMPECT_USERNAME; else process.env.IMPECT_USERNAME = oldUser;
    if (oldPass === undefined) delete process.env.IMPECT_PASSWORD; else process.env.IMPECT_PASSWORD = oldPass;
  }
});
