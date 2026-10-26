import test from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/db.js";
import { importCollege, moveOnNcaaBoard, ncaaBoardView, normName, removeFromNcaaBoard, saveAgent, syncBigBoardNcaa, unlinkProspect } from "../src/lib/ncaa.js";

// A college database in the repository's shape: players with reports, and position-ranked boards keyed
// by shirt number (p9 = strikers, p4 = left centre-backs).
const college = () => ({
  years: ["2026", "2025"],
  boards: {
    "2025": { p9: ["old striker"] },
    "2026": { p9: ["ana striker", "ben striker"], p4: ["cal centreback"] },
  },
  players: [
    { key: "ana striker", name: "Ana Striker", team: "Akron", class: "Junior", position: "ST", country: "USA", grade: "B/A", grade_val: 8, year: 2026,
      reports: [{ dates: ["10/01/2025"], match: "Akron vs Ohio", source: "Live", grade: "B/A", role_name: "Poacher", year: 2025, body: "Sharp in the box. (AJ)" }] },
    { key: "ben striker", name: "Ben Striker", team: "Duke", class: "Senior", position: "ST", country: "England", grade: "C/B", grade_val: 6, year: 2026, reports: [] },
    { key: "cal centreback", name: "Cal Centreback", team: "UNC", class: "Sophomore", position: "LCB", grade: "B/B", grade_val: 7, year: 2026, reports: [] },
    { key: "old striker", name: "Old Striker", team: "Indiana", class: "Senior", position: "ST", status: "Graduated", year: 2024,
      reports: [{ source: "Video", body: "Strong. (AJ)" }] },
  ],
});

function setup() {
  const db = openDb(":memory:");
  const insertPlayer = (f) => Number(db.run(
    "INSERT INTO players(name, club, league, position, birthdate, foot, citizenship, source) VALUES (?,?,?,?,?,?,?, 'college_import')",
    f.name, f.club, f.league, f.position, f.birthdate, f.foot, JSON.stringify(f.citizenship || [])).lastInsertRowid);
  return { db, insertPlayer };
}
const order = (db, position) => db.all(
  "SELECT p.name FROM ncaa_board b JOIN players p ON p.id = b.player_id WHERE b.position = ? ORDER BY b.rank", position).map((r) => r.name);

test("names match across accents and punctuation", () => {
  assert.equal(normName("Xavier O’Neil"), normName("Xavier ONeil"));
  assert.equal(normName("Úlfur Björnsson"), "ulfur bjornsson");
});

test("the latest college board becomes the NCAA board, in order; existing PINE players are linked, not duplicated", () => {
  const { db, insertPlayer } = setup();
  db.run("INSERT INTO players(id, name, club, league) VALUES (50, 'Ben Striker', 'Duke', 'NCAA')");
  db.run("INSERT INTO players(id, name, club, league) VALUES (60, 'Old Striker', 'Real Monarchs SLC', 'MLS Next Pro')");
  const stats = importCollege(db, college(), { insertPlayer });

  assert.equal(stats.prospects, 4);
  assert.equal(stats.reports, 2);
  assert.equal(stats.linked, 2, "Ben (on the board) and Old Striker (a past class, now pro) link by name");
  assert.equal(stats.created, 2, "Ana and Cal are new; the 2024 graduate is not added as an NCAA player");
  assert.deepEqual(order(db, "FWD"), ["Ana Striker", "Ben Striker"]);
  assert.deepEqual(order(db, "LCB"), ["Cal Centreback"]);
  assert.equal(db.get("SELECT count(*) AS n FROM players WHERE name = 'Ben Striker'").n, 1);
  assert.equal(db.get("SELECT player_id FROM ncaa_prospects WHERE key = 'old striker'").player_id, 60);
  assert.equal(db.get("SELECT 1 AS found FROM ncaa_board WHERE player_id = 60"), undefined, "a pro from an old class is not on the NCAA board");

  const ana = db.get("SELECT * FROM players WHERE name = 'Ana Striker'");
  assert.equal(ana.league, "NCAA");
  assert.deepEqual(JSON.parse(ana.citizenship), ["United States"], "USA becomes the citizenship that reads as domestic");
  assert.equal(db.get("SELECT author FROM ncaa_reports WHERE prospect_key = 'ana striker'").author, "AJ");
});

test("Big Board players whose league names NCAA join the NCAA board at their position", () => {
  const { db, insertPlayer } = setup();
  importCollege(db, college(), { insertPlayer });
  db.run("INSERT INTO players(id, name, league) VALUES (70, 'Big Board Winger', 'NCAA D1')");
  db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (70, 'LW1', 0)");
  db.run("INSERT INTO players(id, name, league) VALUES (71, 'Pro Winger', 'USL1')");
  db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (71, 'LW1', 1)");
  assert.equal(syncBigBoardNcaa(db), 1);
  assert.deepEqual(order(db, "LW"), ["Big Board Winger"]);
  assert.ok(ncaaBoardView(db).board.LW.includes(70));
});

test("re-importing refreshes grades and reports but keeps staff's order", () => {
  const { db, insertPlayer } = setup();
  importCollege(db, college(), { insertPlayer });
  const created = db.get("SELECT count(*) AS n FROM players WHERE source = 'college_import'").n;
  const ben = db.get("SELECT id FROM players WHERE name = 'Ben Striker'").id;
  moveOnNcaaBoard(db, ben, "FWD", 0);
  assert.deepEqual(order(db, "FWD"), ["Ben Striker", "Ana Striker"]);

  const again = college();
  again.players[0].grade = "A/A";
  again.players[0].reports.push({ source: "Video", body: "Even better. (AJ)" });
  importCollege(db, again, { insertPlayer });
  assert.deepEqual(order(db, "FWD"), ["Ben Striker", "Ana Striker"], "the dragged order survives");
  assert.equal(db.get("SELECT grade FROM ncaa_prospects WHERE key = 'ana striker'").grade, "A/A");
  assert.equal(db.get("SELECT count(*) AS n FROM ncaa_reports WHERE prospect_key = 'ana striker'").n, 2);
  assert.equal(db.get("SELECT count(*) AS n FROM players WHERE source = 'college_import'").n, created, "no new players on a second import");
});

test("moving across positions and removing keep both positions' ranks contiguous", () => {
  const { db, insertPlayer } = setup();
  importCollege(db, college(), { insertPlayer });
  const ana = db.get("SELECT id FROM players WHERE name = 'Ana Striker'").id;
  const { before, after } = moveOnNcaaBoard(db, ana, "AM", 0);
  assert.deepEqual(before, { position: "FWD", spot: 0 });
  assert.deepEqual(after, { position: "AM", spot: 0 });
  assert.deepEqual(db.all("SELECT rank FROM ncaa_board WHERE position = 'FWD' ORDER BY rank").map((r) => r.rank), [0]);
  removeFromNcaaBoard(db, ana);
  assert.deepEqual(order(db, "AM"), []);
});

test("agent details are validated and kept per player", () => {
  const { db } = setup();
  db.run("INSERT INTO users(id, name) VALUES (900, 'Test Scout')");
  db.run("INSERT INTO players(id, name) VALUES (5, 'Someone')");
  const a = saveAgent(db, 5, { representation: "advisor", agent: " Jane Doe ", email: "jane@example.com", last_contact: "2026-10-20" }, 900);
  assert.equal(a.agent, "Jane Doe");
  assert.equal(a.updated_by_name, "Test Scout");
  assert.throws(() => saveAgent(db, 5, { representation: "manager" }, 900), /representation/);
  assert.throws(() => saveAgent(db, 5, { last_contact: "next week" }, 900), /date/);
});

test("an unlinked prospect stays unlinked on the next import", () => {
  const { db, insertPlayer } = setup();
  db.run("INSERT INTO players(id, name, club, league) VALUES (60, 'Old Striker', 'Real Monarchs SLC', 'MLS Next Pro')");
  importCollege(db, college(), { insertPlayer });
  assert.equal(db.get("SELECT player_id FROM ncaa_prospects WHERE key = 'old striker'").player_id, 60);
  assert.ok(unlinkProspect(db, "old striker"));
  importCollege(db, college(), { insertPlayer });
  assert.equal(db.get("SELECT player_id FROM ncaa_prospects WHERE key = 'old striker'").player_id, null);
});

test("a player taken off the NCAA board stays off through the Big Board sync and re-imports, until moved back", () => {
  const { db, insertPlayer } = setup();
  importCollege(db, college(), { insertPlayer });
  db.run("INSERT INTO players(id, name, league) VALUES (70, 'Big Board Winger', 'NCAA')");
  db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (70, 'LW1', 0)");
  syncBigBoardNcaa(db);
  const ana = db.get("SELECT id FROM players WHERE name = 'Ana Striker'").id;
  removeFromNcaaBoard(db, 70);
  removeFromNcaaBoard(db, ana);
  assert.equal(syncBigBoardNcaa(db), 0);
  importCollege(db, college(), { insertPlayer });
  assert.deepEqual(order(db, "LW"), []);
  assert.deepEqual(order(db, "FWD"), ["Ben Striker"]);
  moveOnNcaaBoard(db, 70, "LW", 0);
  removeFromNcaaBoard(db, 70);
  moveOnNcaaBoard(db, 70, "RW", 0);
  assert.deepEqual(order(db, "RW"), ["Big Board Winger"], "dragging back on works after a removal");
});
