import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { compressSnapshots, listSnapshots, snapshotBuffer, startDailyBackups, writeSnapshot } from '../src/lib/backup.js';
import { cleanStorage, registerStorage, storageReport } from '../src/lib/storage_maintenance.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pine-maintenance-'));
  const db = openDb(join(root, 'pine.db'));
  t.after(() => { db.raw.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, backups: join(root, 'backups') };
}
function restore(bytes, file) {
  fs.writeFileSync(file, bytes);
  const restored = new DatabaseSync(file);
  try {
    assert.equal(restored.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    return restored.prepare('SELECT name FROM players ORDER BY id').all().map(p => p.name);
  } finally { restored.close(); }
}

test('compressed backups and downloaded backups restore the exact database', t => {
  const { root, db, backups } = fixture(t);
  db.run("INSERT INTO players(name) VALUES ('Synthetic Player')");
  const file = writeSnapshot(db, backups, '2026-11-16');
  assert.ok(file.endsWith('.sqlite.gz'));
  assert.deepEqual(restore(gunzipSync(fs.readFileSync(file)), join(root, 'restored.db')), ['Synthetic Player']);
  assert.deepEqual(restore(snapshotBuffer(db, backups), join(root, 'download.db')), ['Synthetic Player']);
});

test('migration is lossless, preserves different same-date copies and ignores symlinks', t => {
  const { root, db, backups } = fixture(t);
  fs.mkdirSync(backups);
  const raw = join(backups, 'pine-2026-11-15.sqlite');
  db.raw.exec(`VACUUM INTO '${raw}'`);
  const before = fs.readFileSync(raw);
  fs.symlinkSync(join(root, 'pine.db'), join(backups, 'pine-2026-11-14.sqlite'));
  assert.ok(compressSnapshots(backups) > 0);
  assert.equal(fs.existsSync(raw), false);
  assert.deepEqual(gunzipSync(fs.readFileSync(`${raw}.gz`)), before);
  fs.writeFileSync(raw, Buffer.concat([before, Buffer.from('different')]));
  compressSnapshots(backups);
  assert.ok(fs.existsSync(raw), 'a different same-date original is preserved');
  assert.equal(listSnapshots(backups).length, 2, 'symlink is excluded');
});

test('a failed compressed write preserves the original and the last good same-date backup', t => {
  const { db, backups } = fixture(t);
  fs.mkdirSync(backups);
  const raw = join(backups, 'pine-2026-11-15.sqlite');
  db.raw.exec(`VACUUM INTO '${raw}'`);
  const before = fs.readFileSync(raw);
  const existing = writeSnapshot(db, backups, '2026-11-16');
  const prior = fs.readFileSync(existing);
  t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  compressSnapshots(backups);
  assert.deepEqual(fs.readFileSync(raw), before);
  assert.throws(() => writeSnapshot(db, backups, '2026-11-16'), /disk full/);
  assert.deepEqual(fs.readFileSync(existing), prior);
  assert.equal(fs.readdirSync(backups).some(n => n.endsWith('.tmp')), false);
});

test('daily backups migrate legacy snapshots while keeping the fourteen-backup limit', t => {
  const { root, db, backups } = fixture(t);
  fs.mkdirSync(backups);
  const original = join(root, 'seed.sqlite');
  db.raw.exec(`VACUUM INTO '${original}'`);
  for (let i = 1; i <= 14; i++) fs.copyFileSync(original, join(backups, `pine-2020-01-${String(i).padStart(2, '0')}.sqlite`));
  const timer = startDailyBackups(db, backups); clearInterval(timer);
  assert.equal(listSnapshots(backups).length, 14);
  assert.ok(listSnapshots(backups).every(s => s.name.endsWith('.sqlite.gz')));
  assert.equal(fs.existsSync(join(backups, 'pine-2020-01-01.sqlite')), false);
});

test('cleanup removes only cache and old recognized temporary files, preserving durable data', t => {
  const { root, db } = fixture(t);
  const old = [];
  for (const name of ['cache/cohort.json.gz', 'cards/1/.upload.pdf.part', 'backups/download-123.tmp.sqlite']) {
    const file = join(root, name); fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, 'disposable');
    fs.utimesSync(file, new Date(0), new Date(0)); old.push(file);
  }
  for (const name of ['cards/1/card.pdf', 'cards/1/card.png', 'cards/1/card.snapshot.json.gz', 'cards/1/.active.pdf.part', 'maps/1/map.json.gz', 'cache/unknown.keep']) {
    const file = join(root, name); fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, 'keep');
  }
  fs.symlinkSync(join(root, 'pine.db'), join(root, 'cache', 'symlink.json.gz'));
  const before = db.get('SELECT count(*) AS n FROM users').n;
  const result = cleanStorage(root);
  assert.equal(result.removed_files, 3);
  assert.ok(old.every(f => !fs.existsSync(f)));
  assert.equal(db.get('SELECT count(*) AS n FROM users').n, before);
  assert.equal(fs.readFileSync(join(root, 'cards/1/card.pdf'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(join(root, 'cards/1/.active.pdf.part')));
  assert.ok(fs.existsSync(join(root, 'cache/symlink.json.gz')));
  const report = storageReport(root, db);
  assert.ok(report.groups.database.bytes > 0);
  assert.equal(JSON.stringify(report).includes(root), false);
});

test('maintenance requires worker authentication and retries only original generic failures', async t => {
  const { root, db } = fixture(t);
  const player = Number(db.run("INSERT INTO players(name,impect_id) VALUES ('Synthetic Player',555)").lastInsertRowid);
  const add = error => Number(db.run("INSERT INTO cards(player_id,impect_id,iteration_id,position,status,error) VALUES (?,555,1916,'AM','failed',?)", player, error).lastInsertRowid);
  const failed = add('failed'), missing = add('data_missing'), conflict = add('failed');
  const app = new Hono(); registerStorage(app, { root, db, token: 'maintenance-test' });
  const headers = { 'X-PINE-Worker-Token': 'maintenance-test' };
  assert.equal((await app.request('/api/worker/storage')).status, 401);
  assert.equal((await app.request('/api/worker/storage/cleanup', { method: 'POST', headers: { Cookie: 'staff-session' } })).status, 401);
  const report = await app.request('/api/worker/storage', { headers });
  assert.equal(report.status, 200); assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(await report.json()).includes('Synthetic Player'), false);
  assert.equal((await app.request(`/api/worker/storage/cards/${missing}/retry`, { method: 'POST', headers })).status, 409);
  assert.equal((await app.request(`/api/worker/storage/cards/${failed}/retry`, { method: 'POST', headers })).status, 200);
  assert.equal((await app.request(`/api/worker/storage/cards/${conflict}/retry`, { method: 'POST', headers })).status, 409);
  assert.equal((await app.request('/api/worker/storage/cleanup', { method: 'POST', headers })).status, 200);
});

test('cleanup truncates retained SQLite WAL without losing records before backup compression', t => {
  const { root, db, backups } = fixture(t);
  db.run("INSERT INTO players(name, summary) VALUES ('Synthetic Player', ?)", 'retained data '.repeat(10000));
  fs.mkdirSync(backups);
  const raw = join(backups, 'pine-2026-11-15.sqlite');
  db.raw.exec(`VACUUM INTO '${raw}'`);
  const wal = join(root, 'pine.db-wal');
  assert.ok(fs.statSync(wal).size > 0);
  const result = cleanStorage(root, Date.now(), db);
  assert.equal(result.checkpoint.busy, 0);
  assert.equal(fs.statSync(wal).size, 0);
  assert.equal(db.get('SELECT summary FROM players').summary, 'retained data '.repeat(10000));
  assert.ok(result.compressed_bytes_saved > 0);
  assert.deepEqual(restore(gunzipSync(fs.readFileSync(`${raw}.gz`)), join(root, 'restored.db')), ['Synthetic Player']);
});
