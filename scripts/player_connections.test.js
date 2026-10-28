import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { connectedDuplicate, connectionMergeProblem, mergeConnection, resolvePlayerId } from "../src/lib/player_connections.js";

function setup(t) {
  const db = openDb(":memory:");
  t.after(() => db.raw.close());
  db.run(`INSERT INTO players(id,name,birthdate,source,impect_id,impect_squad,foot,phys_keys)
    VALUES (10,'Ana García','2000-01-02','impect',123,'Example FC','right','["physical-season"]')`);
  db.run(`INSERT INTO players(id,name,birthdate,source,tm_id,tm_url,tm_synced_at,club,citizenship,contract_expires)
    VALUES (20,'Ana Garcia','2000-01-02','transfermarkt','456','https://www.transfermarkt.com/ana/profil/spieler/456','2026-10-28T10:00:00Z','Example FC','["Spain"]','2026-12-31')`);
  return db;
}

test("combining keeps Impect, physical data, board rank, scouting and all old links", (t) => {
  const db = setup(t);
  db.run("INSERT INTO board_entries(player_id,role,rank,shortlist) VALUES (10,'RCB_2',6,1)");
  db.run("INSERT INTO notes(player_id,user_id,body) VALUES (10,1,'Example scouting note')");
  db.run("INSERT INTO verdicts(player_id,user_id,verdict) VALUES (10,1,'hold')");
  db.run("INSERT INTO activity(player_id,action) VALUES (20,'added_player')");
  db.run("INSERT INTO cards(player_id,impect_id,iteration_id,position,file) VALUES (10,123,99,'CB','10/example.pdf')");
  db.run("INSERT INTO player_redirects(id,player_id,snapshot) VALUES (19,20,'{}')");
  assert.equal(mergeConnection(db,20,10,1),10);
  const player = db.get("SELECT * FROM players WHERE id = 10");
  assert.equal(player.tm_id,'456');
  assert.equal(player.impect_id,123);
  assert.equal(player.foot,'right','missing TM fields do not erase Impect details');
  assert.equal(player.contract_expires,'2026-12-31');
  assert.equal(player.citizenship,'["Spain"]','arrays stay valid JSON');
  assert.equal(player.phys_keys,'["physical-season"]');
  assert.deepEqual({ ...db.get("SELECT rank,shortlist FROM board_entries WHERE player_id=10") },{rank:6,shortlist:1});
  assert.equal(db.get("SELECT body FROM notes WHERE player_id=10").body,'Example scouting note');
  assert.equal(db.get("SELECT verdict FROM verdicts WHERE player_id=10").verdict,'hold');
  assert.equal(db.get("SELECT file FROM cards WHERE player_id=10").file,'10/example.pdf');
  assert.equal(db.get("SELECT player_id FROM activity WHERE action='added_player'").player_id,10);
  assert.equal(resolvePlayerId(db,20),10);
  assert.equal(resolvePlayerId(db,19),10);
  assert.equal(db.get("SELECT id FROM players WHERE id=20"),undefined);
  const snapshot = JSON.parse(db.get("SELECT snapshot FROM player_redirects WHERE id=20").snapshot);
  assert.equal(snapshot.from.tm_id,'456');
  assert.equal(snapshot.into.impect_id,123);
  assert.deepEqual(db.all("PRAGMA foreign_key_check"),[]);
});

test("merging preserves hand-edited canonical facts and confirmed physical links", (t) => {
  const db = setup(t);
  db.run(`UPDATE players SET club='Manual FC',tm_overrides='["club"]',phys_confirmed=1 WHERE id=10`);
  db.run(`UPDATE players SET phys_keys='["other-row"]' WHERE id=20`);
  mergeConnection(db,20,10,1);
  const p = db.get("SELECT * FROM players WHERE id=10");
  assert.equal(p.club,'Manual FC');
  assert.equal(p.tm_overrides,'["club"]');
  assert.equal(p.phys_keys,'["physical-season"]');
  assert.equal(p.phys_confirmed,1);
});

test("same-name players with a different or missing DOB are never combined", (t) => {
  const db = setup(t);
  for (const dob of ['2004-01-02',null]) {
    db.run("UPDATE players SET birthdate=? WHERE id=20",dob);
    assert.throws(() => mergeConnection(db,20,10,1),/dates of birth/);
    assert.equal(db.get("SELECT count(*) AS n FROM players").n,2);
    assert.equal(db.get("SELECT count(*) AS n FROM player_redirects").n,0);
  }
});

test("scouting records and manual edits on the duplicate block an automatic merge", (t) => {
  const db = setup(t);
  db.run("INSERT INTO notes(player_id,user_id,body) VALUES (20,1,'Keep this')");
  assert.throws(() => mergeConnection(db,20,10,1),/scouting records/);
  db.run("DELETE FROM notes WHERE player_id=20");
  db.run("UPDATE players SET summary='Keep this too' WHERE id=20");
  assert.throws(() => mergeConnection(db,20,10,1),/staff edits/);
  db.run("UPDATE players SET summary=NULL, phys_confirmed=1 WHERE id=20");
  assert.throws(() => mergeConnection(db,20,10,1),/staff edits/);
});

test("incompatible links, self-merges and repeated requests fail without changing data", (t) => {
  const db = setup(t);
  db.run("UPDATE players SET tm_id='999' WHERE id=10");
  assert.throws(() => mergeConnection(db,20,10,1),/cannot be combined/);
  assert.throws(() => mergeConnection(db,10,10,1),/two existing profiles/);
  db.run("UPDATE players SET tm_id=NULL WHERE id=10");
  mergeConnection(db,20,10,1);
  assert.throws(() => mergeConnection(db,20,10,1),/two existing profiles/);
  assert.equal(db.get("SELECT tm_id FROM players WHERE id=10").tm_id,'456');
});

test("preview and creation detect cross-source identities without name-only guesses", (t) => {
  const db = setup(t);
  db.run("DELETE FROM players WHERE id=20");
  assert.equal(connectedDuplicate(db,{name:'Ana Garcia',birthdate:'2000-01-02'}).id,10);
  assert.equal(connectedDuplicate(db,{name:'Ana Garcia',birthdate:'2004-01-02'}),null);
  assert.equal(connectedDuplicate(db,{name:'Ana Garcia'}),null);
  assert.equal(connectedDuplicate(db,{name:'Other name'},123).id,10);
  db.run("INSERT INTO players(name,birthdate) VALUES ('Ana García','2000-01-02')");
  assert.equal(connectedDuplicate(db,{name:'Ana Garcia',birthdate:'2000-01-02'}),null,'ambiguous identities are not guessed');
});

test("merge failure rolls back records, activity and redirects together", (t) => {
  const db = setup(t);
  db.raw.exec("CREATE TRIGGER fail_merge BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
  assert.throws(() => mergeConnection(db,20,10,1),/test rollback/);
  assert.equal(db.get("SELECT count(*) AS n FROM players").n,2);
  assert.equal(db.get("SELECT count(*) AS n FROM player_redirects").n,0);
  assert.equal(db.get("SELECT count(*) AS n FROM activity").n,0);
  const from = db.get("SELECT * FROM players WHERE id=20"), into = db.get("SELECT * FROM players WHERE id=10");
  assert.equal(connectionMergeProblem(db,from,into),null);
});
