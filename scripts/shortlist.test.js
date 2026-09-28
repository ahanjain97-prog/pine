import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { addRole, moveOnBoard, spotIn } from '../src/lib/board.js';

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

// Reordering rewrites a role's rows. Before this was covered, one drag on the big board emptied that
// role's Short Board.
test('reordering a role keeps everyone their top-target star', () => {
  const db = openDb(':memory:');
  const names = ['Ana', 'Ben', 'Cal', 'Dee'];
  names.forEach((n, i) => {
    db.run('INSERT INTO players(id, name) VALUES (?,?)', i + 1, n);
    db.run("INSERT INTO board_entries(player_id, role, rank, shortlist) VALUES (?, 'CDM1', ?, ?)", i + 1, i, i % 2 ? 1 : 0);
  });
  const board = (role) => db.all(
    `SELECT p.name, b.shortlist FROM board_entries b JOIN players p ON p.id = b.player_id WHERE b.role = ? ORDER BY b.rank`, role)
    .map((r) => `${r.name}${r.shortlist ? '*' : ''}`);
  assert.deepEqual(board('CDM1'), ['Ana', 'Ben*', 'Cal', 'Dee*']);

  moveOnBoard(db, 4, 'CDM1', 'CDM1', 0); // drag Dee to the top
  assert.deepEqual(board('CDM1'), ['Dee*', 'Ana', 'Ben*', 'Cal'], 'stars follow their players');

  moveOnBoard(db, 3, 'CDM1', 'CDM2', 0); // Cal moves to another role
  assert.deepEqual(board('CDM1'), ['Dee*', 'Ana', 'Ben*']);
  assert.deepEqual(board('CDM2'), ['Cal']);

  db.run("UPDATE board_entries SET shortlist = 1 WHERE player_id = 3 AND role = 'CDM2'");
  moveOnBoard(db, 3, 'CDM2', 'CDM1', 1); // and back, still a target
  assert.deepEqual(board('CDM1'), ['Dee*', 'Cal*', 'Ana', 'Ben*'], 'the star comes with them');
});

test('a player added to a role is not a top target until starred', () => {
  const db = openDb(':memory:');
  db.run("INSERT INTO players(id, name) VALUES (1, 'New Name')");
  addRole(db, 1, 'FWD1');
  assert.equal(db.get("SELECT shortlist FROM board_entries WHERE player_id = 1").shortlist, 0);
  assert.equal(spotIn(db, 1, 'FWD1'), 0);
  assert.equal(spotIn(db, 1, 'FWD2'), null);
});
