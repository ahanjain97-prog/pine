import test from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/db.js";
import {
  bigBoardRole, fillCitizenshipFromCollege, importCollege, matchName, pickCollegeTmMatch, sameSchool, mergeCollegeDuplicates, moveOnNcaaBoard, ncaaBoardView, ncaaProspects, ncaaYearBoard, normName,
  removeFromNcaaBoard, saveAgent, syncBigBoardNcaa, undoBigBoardAutoLink, unlinkProspect,
} from "../src/lib/ncaa.js";

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
  assert.equal(normName("Oliver Møller-Jensen"), "oliver moller jensen");
});

test("loose name matches: middle names, and short first names among NCAA players; never a guess between two", () => {
  const index = [
    { id: 1, t: ["ulfur", "agust", "bjornsson"], ncaa: true }, { id: 2, t: ["matthew", "dreas"], ncaa: true },
    { id: 3, t: ["martin", "bakken"], ncaa: false }, { id: 4, t: ["sam", "jones"], ncaa: true }, { id: 5, t: ["samuel", "jones"], ncaa: true },
  ];
  assert.deepEqual(matchName(index, "Ulfur Bjornsson"), { id: 1, exact: false });
  assert.deepEqual(matchName(index, "Matt Dreas"), { id: 2, exact: false });
  assert.equal(matchName(index, "Steinar Bjornsson"), null, "a brother is not the same player");
  assert.equal(matchName(index, "Marten Bakken"), null, "first-three-letters only for players PINE has in the NCAA");
  assert.equal(matchName(index, "Sami Jones"), null, "two candidates: no link");
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

test("earlier years' boards are kept as the college database ranked them, and prospects list the boards they're on", () => {
  const { db, insertPlayer } = setup();
  const stats = importCollege(db, college(), { insertPlayer });
  assert.equal(stats.board_year, 2026);
  assert.deepEqual(ncaaYearBoard(db, 2025).FWD.map((r) => r.name), ["Old Striker"]);
  assert.equal(ncaaYearBoard(db, 2025).FWD[0].player_id, null, "an old-class prospect with no PINE match still shows");
  const ana = ncaaProspects(db).find((x) => x.key === "ana striker");
  assert.deepEqual(ana.boards, { 2026: { position: "FWD", rank: 0 } });
});

test("college roles pick the Big Board role within the position; anything else takes its first role", () => {
  assert.equal(bigBoardRole("FWD", "True #9 (Target)"), "FWD2");
  assert.equal(bigBoardRole("FWD", "Poacher / Finisher"), "FWD1");
  assert.equal(bigBoardRole("RW", "Inverted Winger"), "RW2");
  assert.equal(bigBoardRole("RB", "Wing Back"), "RB2");
  assert.equal(bigBoardRole("LB", "Defensive Fullback"), "LB2");
  assert.equal(bigBoardRole("RCB", "Leader of the Line"), "RCB1");
  assert.equal(bigBoardRole("LCB", "Ball-Playing CB"), "LCB1");
  assert.equal(bigBoardRole("CM", "Box-to-Box Grinder"), "CM2");
  assert.equal(bigBoardRole("CDM", "True #6 (Double Pivot)"), "CDM1");
  assert.equal(bigBoardRole("GK", null), "GK1");
});

test("the import leaves the Big Board alone, and the board suggests a Big Board role from the college role", () => {
  const { db, insertPlayer } = setup();
  importCollege(db, college(), { insertPlayer });
  assert.equal(db.get("SELECT count(*) AS n FROM board_entries").n, 0);
  const view = ncaaBoardView(db);
  const ana = db.get("SELECT id FROM players WHERE name = 'Ana Striker'").id;
  assert.equal(view.bb_role[ana], "FWD1", "Poacher → FWD #1");
});

test("undoing the Big Board auto-add takes off college-import players staff haven't touched, once", () => {
  const { db, insertPlayer } = setup();
  db.run("INSERT INTO users(id, name) VALUES (900, 'Test Scout')");
  importCollege(db, college(), { insertPlayer });
  db.run("CREATE TABLE ncaa_bb_linked(player_id INTEGER PRIMARY KEY)");
  db.run("INSERT INTO players(id, name, league, source) VALUES (70, 'Tracked Already', 'NCAA', 'tm')");
  const id = (name) => db.get("SELECT id FROM players WHERE name = ?", name).id;
  const [ana, ben, cal] = ["Ana Striker", "Ben Striker", "Cal Centreback"].map(id);
  db.run("INSERT INTO board_entries(player_id, role, rank, shortlist) VALUES (70, 'FWD1', 0, 0), (?, 'FWD1', 1, 0), (?, 'FWD1', 2, 1), (?, 'LCB1', 0, 0)", ana, ben, cal);
  [70, ana, ben, cal].forEach((pid) => db.run("INSERT INTO ncaa_bb_linked(player_id) VALUES (?)", pid));
  db.run(`INSERT INTO activity(user_id, player_id, action, detail) VALUES (900, ?, 'moved_on_board', '{}')`, cal);
  assert.equal(undoBigBoardAutoLink(db), 1, "only Ana: Ben is starred, Cal was moved by staff, Tracked Already isn't an import");
  assert.deepEqual(db.all("SELECT player_id, rank FROM board_entries WHERE role = 'FWD1' ORDER BY rank").map((r) => [r.player_id, r.rank]), [[70, 0], [ben, 1]]);
  assert.equal(db.get("SELECT 1 AS found FROM sqlite_master WHERE name = 'ncaa_bb_linked'"), undefined);
  assert.equal(undoBigBoardAutoLink(db), 0);
});

test("a college-import player who was already in PINE is merged into them, keeping the college rank and staff work", () => {
  const { db, insertPlayer } = setup();
  db.run("INSERT INTO users(id, name) VALUES (900, 'Test Scout')");
  importCollege(db, college(), { insertPlayer }); // Ben Striker is created...
  // ... while staff had him in PINE under his full name (as happened before names matched this loosely).
  db.run("INSERT INTO players(id, name, club, league, source, birthdate) VALUES (60, 'Benjamin Striker', 'Duke Blue Devils', 'NCAA', 'tm', '2004-01-02')");
  db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (60, 'FWD3', 0)");
  syncBigBoardNcaa(db); // the Big Board sync appends Benjamin to the NCAA board too
  const ben = db.get("SELECT id FROM players WHERE name = 'Ben Striker'").id;
  db.run("INSERT INTO notes(player_id, user_id, body) VALUES (?, 900, 'Watched him live')", ben);
  const merged = mergeCollegeDuplicates(db);
  assert.deepEqual(merged.map((m) => [m.name, m.into]), [["Ben Striker", 60]]);
  assert.equal(db.get("SELECT 1 AS found FROM players WHERE id = ?", ben), undefined);
  assert.deepEqual(order(db, "FWD"), ["Ana Striker", "Benjamin Striker"], "Benjamin takes Ben's college rank, once");
  assert.equal(db.get("SELECT player_id FROM ncaa_prospects WHERE key = 'ben striker'").player_id, 60);
  assert.equal(db.get("SELECT count(*) AS n FROM notes WHERE player_id = 60").n, 1);
  assert.deepEqual(db.all("SELECT role FROM board_entries WHERE player_id = 60").map((r) => r.role), ["FWD3"], "his Big Board role stays");
  assert.equal(mergeCollegeDuplicates(db).length, 0);
});

test("a college player with no citizenship takes their college profile's country", () => {
  const { db, insertPlayer } = setup();
  db.run("INSERT INTO players(id, name, league) VALUES (50, 'Ana Striker', 'NCAA')");
  db.run("INSERT INTO players(id, name, league, roster_status) VALUES (51, 'Cal Centreback', 'NCAA', 'international')");
  importCollege(db, college(), { insertPlayer });
  assert.equal(fillCitizenshipFromCollege(db), 1);
  assert.deepEqual(JSON.parse(db.get("SELECT citizenship FROM players WHERE id = 50").citizenship), ["United States"]);
  assert.equal(db.get("SELECT citizenship FROM players WHERE id = 51").citizenship, "[]", "a hand-set status is left alone");
});

test("schools match by a distinctive word or by initials", () => {
  assert.ok(sameSchool("LMU", "Loyola Marymount Lions (Loyola Marymount Uni.)"));
  assert.ok(sameSchool("UCSB", "Santa Barbara Gauchos (Uni. of CAL Santa Barbara)"));
  assert.ok(sameSchool("CS UC Santa Barbara", "Santa Barbara Gauchos (Uni. of CAL Santa Barbara)"));
  assert.ok(sameSchool("Liberty", "Liberty Flames (Liberty University)"));
  assert.ok(!sameSchool("San Jose St.", "MDC Sharks (Miami Dade College)"));
  assert.ok(!sameSchool("Ohio State", "San Jose State Spartans (San Jose State University)"), "'State' alone isn't a match");
});

test("Transfermarkt picks for college players: one result with the surname at one of the player's schools", () => {
  const opts = { isCollege: (club) => /\((.*\b(university|college)\b|.*\buni\.)/i.test(club || "") };
  const madsens = [
    { name: "Mikkel Madsen", club: "Herfölge Boldklub", tm_id: 1 },
    { name: "Mikkel Madsen", club: "Dayton Flyers (University of Dayton)", tm_id: 2 },
  ];
  assert.equal(pickCollegeTmMatch({ name: "Mikkel Madsen", schools: ["Dayton"] }, madsens, opts).tm_id, 2);
  assert.equal(pickCollegeTmMatch({ name: "Calle Mollerberg", schools: ["CS UC Santa Barbara"] },
    [{ name: "Carl Möllerberg", club: "Santa Barbara Gauchos (Uni. of CAL Santa Barbara)", tm_id: 3 }], opts).tm_id, 3);
  assert.equal(pickCollegeTmMatch({ name: "Samson Kpardeh", schools: ["Gardner-Webb", "Liberty"] },
    [{ name: "Samson Kpardeh", club: "Liberty Flames (Liberty University)", tm_id: 7 }], opts).tm_id, 7, "his college profile has the new school");
  assert.equal(pickCollegeTmMatch({ name: "Angel Fernandez", schools: ["San Jose St."] },
    [{ name: "Angel Fernandez", club: "MDC Sharks (Miami Dade College)", tm_id: 4 }], opts), null, "a namesake at another college");
  assert.equal(pickCollegeTmMatch({ name: "Jose de la Torre", schools: ["CS Fullerton"] }, [{ name: "José de la Torre", club: "Retired", tm_id: 6 }], opts), null);
});
