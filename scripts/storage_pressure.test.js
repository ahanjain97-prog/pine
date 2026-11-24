import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDiskCache, diskCacheStatus, readDisk, writeDisk } from '../src/lib/disk_cache.js';
import { saveCardFile } from '../src/lib/cards.js';
import { saveSnapshot } from '../src/lib/card_snapshots.js';
import { saveMapsFile } from '../src/lib/maps.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pine-storage-'));
  const cache = join(root, 'cache');
  fs.mkdirSync(cache);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cache };
}

test('startup evicts the oldest compressed cache when its byte budget is exceeded', (t) => {
  const { root, cache } = fixture(t);
  const old = join(cache, 'old.json.gz'), recent = join(cache, 'recent.json.gz');
  fs.writeFileSync(old, Buffer.alloc(100));
  fs.utimesSync(old, new Date(0), new Date(0));
  fs.writeFileSync(recent, Buffer.alloc(100));
  fs.writeFileSync(join(root, 'pine.db'), 'database');
  configureDiskCache(cache, { maxBytes: 150, reserveBytes: 0, availableBytes: () => 1000 });
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.readFileSync(join(root, 'pine.db'), 'utf8'), 'database');
});

test('new cache writes evict old cache instead of exceeding the budget', (t) => {
  const { cache } = fixture(t);
  configureDiskCache(cache, { maxBytes: 128, reserveBytes: 0, availableBytes: () => 1000 });
  const old = join(cache, 'old.json.gz');
  fs.writeFileSync(old, Buffer.alloc(100));
  writeDisk('new', { text: 'x'.repeat(100) });
  assert.equal(fs.existsSync(old), false);
  assert.deepEqual(readDisk('new'), { text: 'x'.repeat(100) });
});

test('optional cache writes are skipped when the free-space reserve cannot be recovered', (t) => {
  const { cache } = fixture(t);
  configureDiskCache(cache, { maxBytes: 1024, reserveBytes: 200, availableBytes: () => 0 });
  writeDisk('optional', { value: 1 });
  assert.equal(readDisk('optional'), null);
  assert.deepEqual(fs.readdirSync(cache), []);
});

test('the Impect page is told when the cache stops saving, and again when it can save', (t) => {
  const { cache } = fixture(t);
  let free = 0;
  t.mock.method(console, 'warn', () => {});
  configureDiskCache(cache, { maxBytes: 1024, reserveBytes: 200, availableBytes: () => free });
  assert.equal(diskCacheStatus().saving, false, 'startup already finds the volume under the reserve');
  writeDisk('optional', { value: 1 });
  writeDisk('optional', { value: 2 });
  assert.equal(console.warn.mock.callCount(), 1, 'one warning while the volume stays full, not one per download');
  free = 1000;
  assert.equal(diskCacheStatus().saving, true, 'a grown volume clears the warning before the next save');
  writeDisk('optional', { value: 3 });
  assert.deepEqual(readDisk('optional'), { value: 3 });
  assert.deepEqual(diskCacheStatus(), { configured: true, saving: true, low_space_since: null, free_bytes: 1000, reserve_bytes: 200 });
});

for (const kind of ['pdf', 'png', 'maps']) {
  test(`${kind} upload reclaims disposable cache after the disk fills, preserving saved data`, (t) => {
    const { root, cache } = fixture(t);
    const old = join(cache, 'old.json.gz');
    let full = false;
    configureDiskCache(cache, {
      maxBytes: 1024, reserveBytes: 200,
      availableBytes: () => full && fs.existsSync(old) ? 0 : 1000,
    });
    fs.writeFileSync(old, Buffer.alloc(100));
    fs.writeFileSync(join(root, 'pine.db'), 'database');
    fs.mkdirSync(join(root, 'backups'));
    fs.writeFileSync(join(root, 'backups', 'snapshot.sqlite'), 'backup');
    fs.mkdirSync(join(root, 'cards'));
    fs.writeFileSync(join(root, 'cards', 'previous.pdf'), '%PDF-previous');
    full = true;
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (...args) => {
      if (String(args[0]).endsWith('.part') && fs.existsSync(old)) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return write(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const job = { id: 1, player_id: 7, iteration_id: 11, position: 'AM' };
    const when = new Date('2026-11-12T01:00:00Z');
    const saved = kind === 'maps'
      ? saveMapsFile(join(root, 'maps'), job, { sample: 'fixture' }, when).file
      : saveCardFile(join(root, 'cards'), job, Buffer.from(kind === 'pdf' ? '%PDF-fixture' : 'png'), when, kind);
    assert.equal(fs.existsSync(join(root, kind === 'maps' ? 'maps' : 'cards', saved)), true);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.readFileSync(join(root, 'pine.db'), 'utf8'), 'database');
    assert.equal(fs.readFileSync(join(root, 'backups', 'snapshot.sqlite'), 'utf8'), 'backup');
    assert.equal(fs.readFileSync(join(root, 'cards', 'previous.pdf'), 'utf8'), '%PDF-previous');
  });
}

test('snapshot upload reclaims cache before creating a new player directory on a full disk', t => {
  const { root, cache } = fixture(t);
  const old = join(cache, 'cohort.json.gz');
  configureDiskCache(cache, { maxBytes: 1024, reserveBytes: 200, availableBytes: () => fs.existsSync(old) ? 0 : 1000 });
  fs.writeFileSync(old, Buffer.alloc(100));
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (...args) => {
    if (fs.existsSync(old)) throw Object.assign(new Error('disk full creating player directory'), { code: 'ENOSPC' });
    return mkdir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const saved = saveSnapshot(join(root, 'cards'), { player_id: 7, id: 1 }, { digest: 'a'.repeat(64), bytes: Buffer.from('{}') });
  assert.ok(fs.existsSync(join(root, 'cards', saved)));
  assert.equal(fs.existsSync(old), false);
});
