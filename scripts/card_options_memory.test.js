import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_METRICS } from '../src/lib/impect_categories.js';

// Nine league seasons (more than the eight cohorts kept in memory) and no disk cache, as when the volume is
// full. One invented player appears in every season; downloads of squad rows are counted per season.
const metrics = [...new Set(ALL_METRICS)].map((m, i) => ({ id: i, name: m.split('__')[1], inverted: false, details: { label: m } }));
const seasons = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, season: String(2018 + i), competition: { id: 5, name: 'USL Championship', type: 'League' } }));
let downloads = 0;
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/token')) return Response.json({ access_token: 'fixture', expires_in: 300 });
  if (path === '/v5/customerapi/kpis') return Response.json(metrics.filter((m) => ALL_METRICS.includes(`kpi__${m.name}`)));
  if (path === '/v5/customerapi/player-scores') return Response.json(metrics.filter((m) => ALL_METRICS.includes(`score__${m.name}`)));
  if (path === '/v5/customerapi/iterations') return Response.json(seasons);
  if (path === '/v5/customerapi/countries' || path.endsWith('/squad-scores')) return Response.json([]);
  if (/\/iterations\/\d+\/players$/.test(path)) return Response.json([{ id: 1, commonname: 'Fixture Forward', countryIds: [], idMappings: [] }]);
  if (path.endsWith('/squads')) return Response.json([{ id: 70, name: 'Fixture FC' }]);
  const kpi = path.endsWith('/player-kpis');
  if (kpi || path.endsWith('/player-scores')) {
    if (kpi) downloads++;
    return Response.json([{ playerId: 1, position: 'CENTER_FORWARD', matchShare: 6, playDuration: 32400,
      [kpi ? 'kpis' : 'playerScores']: [{ [kpi ? 'kpiId' : 'playerScoreId']: 0, value: 1 }] }]);
  }
  throw Error(`Unexpected fixture URL: ${path}`);
};
process.env.IMPECT_USERNAME = 'fixture';
process.env.IMPECT_PASSWORD = 'fixture';

test('card season options never re-download a league season that has left memory', async () => {
  const kpi = await import('../src/lib/impect_kpi.js');
  const { playerCardOptions } = await import('../src/lib/card_options.js');
  for (const s of seasons) assert.equal(await kpi.warmCohort(s.id), true);
  assert.equal(downloads, 9);
  const options = await playerCardOptions(1);
  assert.equal(downloads, 9, 'the 2018 cohort was evicted, but its match shares were kept');
  assert.equal(options.seasons.length, 9);
  assert.deepEqual(options.default, { iteration_id: 9, position: 'CF' });
});
