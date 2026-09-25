import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDb } from '../src/db.js';
import { MAPS_SCHEMA, MapsError, claimMap, mapErrorCode, mapProgress, normalizeMaps, removeMapsFiles, saveMapsFile } from '../src/lib/maps.js';

// Made by the card worker's own export code (hearts-of-pine maps.py) from made-up events.
const EXPORT = JSON.parse(readFileSync(new URL('./fixtures/maps-export.json', import.meta.url), 'utf8'));
const JOB = { id: 3, player_id: 1, impect_id: 1, iteration_id: 1916, position: 'CM' };
const copy = () => structuredClone(EXPORT);
const refuses = (raw, pattern, job = JOB) => assert.throws(() => normalizeMaps(raw, job), (e) => e instanceof MapsError && pattern.test(e.message));

test('the worker export is accepted and trimmed to what the Maps tab draws', () => {
  const out = normalizeMaps(copy(), JOB);
  assert.equal(out.schema, MAPS_SCHEMA);
  assert.equal(out.position, 'CM');
  assert.equal(out.group, 'CM');
  assert.match(out.catalog, /^[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(out.layers), ['use', 'defend']);
  for (const side of ['use', 'defend']) {
    const layer = out.layers[side];
    assert.equal(layer.n, layer.points.length);
    assert.equal(layer.sparse, false);
    assert.ok(layer.paths['80'].length && layer.paths['50'].length);
  }
  assert.deepEqual(out.defaults, EXPORT.defaults);
  assert.deepEqual(out.metrics.map((m) => m.key), EXPORT.metrics.map((m) => m.key));
  assert.ok(out.metrics.every((m) => m.label && m.definition && m.category && Array.isArray(m.points)));
  assert.equal(out.player.name, 'Test Player');
  assert.deepEqual(out.sample, EXPORT.sample);
  // Nothing the browser doesn't use survives.
  assert.equal(out.generated_at, undefined);
});

test('an export for another view, or in a shape this PINE cannot draw, is refused', () => {
  refuses({ ...copy(), schema: 2 }, /schema 2/);
  refuses(copy(), /different player/, { ...JOB, impect_id: 2 });
  refuses(copy(), /different player/, { ...JOB, iteration_id: 1248 });
  refuses(copy(), /different player/, { ...JOB, position: 'DM' });
  refuses([], /JSON object/);
  refuses({ ...copy(), catalog: 'not hex!' }, /catalog/);
});

test('contours must be plain path data, so nothing but numbers reaches the SVG', () => {
  const evil = copy();
  evil.layers.use.paths['50'][0] = 'M 1,2 L 3,4 Z" onload="alert(1)';
  refuses(evil, /malformed contour/);
  const missing = copy();
  delete missing.layers.defend.paths['80'];
  refuses(missing, /no 80% contours/);
  // A sparse layer draws its points, so it needs no contours.
  const sparse = copy();
  sparse.layers.defend = { n: 2, sparse: true, paths: {}, points: [[1, 2], [3, 4]] };
  assert.deepEqual(normalizeMaps(sparse, JOB).layers.defend, { n: 2, sparse: true, paths: {}, points: [[1, 2], [3, 4]] });
});

test('points must be on the pitch and counted; metric keys unique and on a known map', () => {
  const off = copy();
  off.metrics[0].points.push([34, 140]);
  refuses(off, /off the pitch/);
  const nan = copy();
  nan.layers.use.points[0] = [null, 3];
  refuses(nan, /off the pitch/);
  const miscount = copy();
  miscount.layers.use.n += 1;
  refuses(miscount, /n doesn't match/);
  const dup = copy();
  dup.metrics.push({ ...dup.metrics[0] });
  refuses(dup, /appears twice/);
  const side = copy();
  side.metrics[0].side = 'both';
  refuses(side, /has no map/);
  const key = copy();
  key.metrics[0].key = '<b>';
  refuses(key, /bad key/);
  const label = copy();
  label.metrics[0].label = 'x'.repeat(61);
  refuses(label, /label/);
});

test('an unavailable metric carries no points, and defaults keep only usable metrics of their own map', () => {
  const raw = copy();
  const goal = raw.metrics.find((m) => m.key === 'goal');
  goal.available = false;
  goal.points = [[1, 1]];
  raw.defaults.use = ['goal', 'prog_pass', 'prog_pass', 'recovery', 'nope'];
  const out = normalizeMaps(raw, JOB);
  assert.deepEqual(out.metrics.find((m) => m.key === 'goal').points, []);
  assert.deepEqual(out.defaults.use, ['prog_pass']);
  assert.ok(out.metrics.filter((m) => m.available).every((m) => m.points.length >= 0));
});

test('points are rounded to 10 cm', () => {
  const raw = copy();
  raw.metrics[0].points = [[1.2345, 6.789]];
  assert.deepEqual(normalizeMaps(raw, JOB).metrics[0].points, [[1.2, 6.8]]);
});

function queueDb() {
  const db = openDb(':memory:');
  const player = Number(db.run("INSERT INTO players(name, impect_id) VALUES ('Test Player', 555)").lastInsertRowid);
  const add = (position, minutesAgo) => Number(db.run(
    `INSERT INTO maps(player_id, impect_id, iteration_id, position, requested_at) VALUES (?, 555, 11, ?, datetime('now', ?))`,
    player, position, `-${minutesAgo} minutes`).lastInsertRowid);
  return { db, player, add };
}

test('the worker claims the oldest queued map job once, then nothing', () => {
  const { db, add } = queueDb();
  const newer = add('LW', 1);
  const older = add('AM', 5);
  assert.deepEqual(claimMap(db), { id: older, impect_id: 555, iteration_id: 11, position: 'AM' });
  assert.deepEqual(claimMap(db), { id: newer, impect_id: 555, iteration_id: 11, position: 'LW' });
  assert.equal(claimMap(db), null);
  assert.equal(db.get('SELECT attempts FROM maps WHERE id = ?', older).attempts, 1);
});

test('a stuck map job is handed out again, and failed after three attempts', () => {
  const { db, add } = queueDb();
  const id = add('CM', 30);
  claimMap(db);
  db.run("UPDATE maps SET started_at = datetime('now', '-16 minutes'), progress = 'fetching_events' WHERE id = ?", id);
  assert.equal(claimMap(db).id, id);
  assert.equal(db.get('SELECT progress FROM maps WHERE id = ?', id).progress, null);
  db.run("UPDATE maps SET started_at = datetime('now', '-16 minutes'), attempts = 3 WHERE id = ?", id);
  assert.equal(claimMap(db), null);
  assert.deepEqual({ ...db.get('SELECT status, error FROM maps WHERE id = ?', id) }, { status: 'failed', error: 'failed' });
});

test('maps share the card failure and progress codes', () => {
  assert.equal(mapErrorCode('position_unavailable'), 'position_unavailable');
  assert.equal(mapErrorCode('rm -rf'), 'failed');
  assert.deepEqual(mapProgress('fetching_events', 12), { code: 'fetching_events', matches: 12 });
  assert.equal(mapProgress('other', 1), null);
});

test('saved maps are gzipped JSON under the player, never overwritten, and removable', () => {
  const root = mkdtempSync(join(tmpdir(), 'pine-maps-'));
  try {
    const data = normalizeMaps(copy(), JOB);
    const when = new Date('2026-09-25T18:00:00Z');
    const saved = saveMapsFile(root, JOB, data, when);
    assert.equal(saved.file, '1/20260925T180000Z-3-1916-CM.json.gz');
    const buf = readFileSync(join(root, saved.file));
    assert.equal(saved.bytes, buf.length);
    assert.deepEqual(JSON.parse(gunzipSync(buf)), data);
    assert.ok(buf.length < JSON.stringify(data).length / 2);
    assert.throws(() => saveMapsFile(root, JOB, data, when), /already exists/);
    assert.deepEqual(readdirSync(join(root, '1')), ['20260925T180000Z-3-1916-CM.json.gz']);
    removeMapsFiles(root, [saved.file, '1/already-gone.json.gz']);
    assert.equal(existsSync(join(root, saved.file)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
