import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';

const dir = mkdtempSync(join(tmpdir(), 'pine-shortlist-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a new board entry is not a top target until someone stars it', () => {
  const db = openDb(':memory:');
  db.run("INSERT INTO players(id, name) VALUES (1, 'Test Player')");
  db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (1, 'FWD1', 0)");
  assert.equal(db.get('SELECT shortlist FROM board_entries WHERE player_id = 1').shortlist, 0);
  db.run("UPDATE board_entries SET shortlist = 1 WHERE player_id = 1 AND role = 'FWD1'");
  assert.equal(db.get("SELECT shortlist FROM board_entries WHERE role = 'FWD1'").shortlist, 1);
});

test('an existing board survives the upgrade with everyone off the shortlist', () => {
  // A database from before the column existed, with a board already in it.
  const file = join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE players(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE board_entries(player_id INTEGER NOT NULL, role TEXT NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY(player_id, role));
    INSERT INTO players(id, name) VALUES (7, 'Already Ranked');
    INSERT INTO board_entries(player_id, role, rank) VALUES (7, 'RCB2', 3);`);
  old.close();

  const db = openDb(file);
  const row = db.get('SELECT role, rank, shortlist FROM board_entries WHERE player_id = 7');
  assert.deepEqual({ ...row }, { role: 'RCB2', rank: 3, shortlist: 0 }, 'rank kept, not a top target yet');
  db.run("UPDATE board_entries SET shortlist = 1 WHERE player_id = 7");
  db.raw.close();

  // Opening it again (a later deploy) leaves the flag alone.
  const again = openDb(file);
  assert.equal(again.get('SELECT shortlist FROM board_entries WHERE player_id = 7').shortlist, 1);
});
