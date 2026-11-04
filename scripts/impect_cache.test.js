import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_METRICS } from '../src/lib/impect_categories.js';
import { configureDiskCache } from '../src/lib/disk_cache.js';
import { gunzipSync, gzipSync } from 'node:zlib';

// One league season with one squad of three players, counting how often Impect is asked for rows.
const metrics = [...new Set(ALL_METRICS)].map((m, i) => ({ id: i, name: m.split('__')[1], inverted: false, details: { label: m } }));
let downloads = 0;
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/token')) return Response.json({ access_token: 'fixture', expires_in: 300 });
  if (path === '/v5/customerapi/kpis') return Response.json(metrics.filter((m) => ALL_METRICS.includes(`kpi__${m.name}`)));
  if (path === '/v5/customerapi/player-scores') return Response.json(metrics.filter((m) => ALL_METRICS.includes(`score__${m.name}`)));
  if (path.endsWith('/squads')) return Response.json([{ id: 70, name: 'Fixture FC' }]);
  const kpi = path.endsWith('/player-kpis');
  if (kpi || path.endsWith('/player-scores')) {
    if (kpi) downloads++;
    return Response.json([1, 2, 3].map((playerId) => ({
      playerId, position: playerId === 3 ? 'GOALKEEPER' : 'CENTER_FORWARD', matchShare: 6, playDuration: 32400,
      [kpi ? 'kpis' : 'playerScores']: [{ [kpi ? 'kpiId' : 'playerScoreId']: 0, value: playerId }],
    })));
  }
  throw Error(`Unexpected fixture URL: ${path}`);
};
process.env.IMPECT_USERNAME = 'fixture';
process.env.IMPECT_PASSWORD = 'fixture';

const dir = mkdtempSync(join(tmpdir(), 'pine-cache-'));
configureDiskCache(dir);
test.after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'cohort-7.json.gz');
const readGz = (f) => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));

test('a league season is downloaded once, kept on disk, and survives a restart', async () => {
  const kpi = await import('../src/lib/impect_kpi.js');
  assert.equal(await kpi.warmCohort(7), true);
  assert.equal(downloads, 1);
  assert.equal(await kpi.warmCohort(7), false, 'a fresh copy is not downloaded again');
  assert.equal(downloads, 1);

  // A new module instance stands in for a restarted server reading the same volume.
  const restarted = await import('../src/lib/impect_kpi.js?restart');
  const co = await restarted.cohort(7);
  assert.equal(downloads, 1, 'read from disk, not Impect');
  assert.deepEqual([...co.byGroup.keys()].sort(), ['GK', 'ST']);
  // Card options read every position, goalkeepers included.
  assert.deepEqual(co.shares.get(3), { GOALKEEPER: 6 });
});

test('a stale copy is served at once and replaced in the background', async () => {
  const saved = readGz(file);
  writeFileSync(file, gzipSync(JSON.stringify({ ...saved, at: 0 })));
  const kpi = await import('../src/lib/impect_kpi.js?stale');
  const before = downloads;
  const co = await kpi.cohort(7);
  assert.equal(co.at, 0, 'the old copy comes back without waiting');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(downloads, before + 1, 'and a fresh one was fetched behind it');
  assert.ok(readGz(file).at > 0, 'which replaced the copy on disk');
});

test('the disk cache clears temp files and plain JSON left by older versions', async () => {
  const other = mkdtempSync(join(tmpdir(), 'pine-cache-old-'));
  try {
    writeFileSync(join(other, 'cohort-1.json'), '{}');
    writeFileSync(join(other, 'cohort-2.json.gz.tmp'), 'half');
    writeFileSync(join(other, 'cohort-3.json.gz'), gzipSync('{"keep":true}'));
    configureDiskCache(other);
    assert.deepEqual(readdirSync(other).sort(), ['cohort-3.json.gz']);
  } finally {
    configureDiskCache(dir);
    rmSync(other, { recursive: true, force: true });
  }
});
