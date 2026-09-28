import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { tmSyncFields } from '../src/lib/tm_sync.js';

const columns = (db) => db.all('PRAGMA table_info(players)').map((c) => c.name);

test('a database from before roster status gains the column when opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-roster-'));
  try {
    const file = join(dir, 'pine.db');
    const old = openDb(file);
    old.run("INSERT INTO players(name) VALUES ('Test Player')");
    old.raw.exec('ALTER TABLE players DROP COLUMN roster_status');
    assert.ok(!columns(old).includes('roster_status'));
    old.raw.close();

    const db = openDb(file);
    assert.ok(columns(db).includes('roster_status'));
    assert.equal(db.get('SELECT roster_status FROM players').roster_status, null);
    db.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('roster status takes domestic or international only', () => {
  const db = openDb(':memory:');
  const id = Number(db.run("INSERT INTO players(name) VALUES ('Test Player')").lastInsertRowid);
  db.run("UPDATE players SET roster_status = 'domestic' WHERE id = ?", id);
  db.run("UPDATE players SET roster_status = 'international' WHERE id = ?", id);
  assert.throws(() => db.run("UPDATE players SET roster_status = 'dual' WHERE id = ?", id), /CHECK/);
});

test('a Transfermarkt sync leaves a hand-set roster status alone', () => {
  const player = { roster_status: 'domestic', citizenship: ['Brazil'], tm_overrides: [] };
  const fields = tmSyncFields(player, { name: 'Test Player', citizenship: ['Brazil', 'Portugal'] });
  assert.ok(!('roster_status' in fields));
});
