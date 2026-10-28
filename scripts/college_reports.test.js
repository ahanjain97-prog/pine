import test from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/db.js";
import { addCollegeReport, deleteCollegeReport, importCollege, ncaaBoardView, prospectDetail, updateCollegeReport } from "../src/lib/ncaa.js";

function setup() {
  const db = openDb(":memory:");
  db.run("INSERT INTO users(id, name, is_admin) VALUES (900, 'Scout', 0), (901, 'Boss', 1), (902, 'Other', 0)");
  db.run(`INSERT INTO players(id, name, club, league, position, citizenship, roster_status) VALUES
    (1, 'William Lawson', 'Akron Zips (University of Akron)', 'NCAA', 'Centre-Back', '["United States"]', NULL)`);
  const player = { ...db.get("SELECT * FROM players WHERE id = 1"), citizenship: ["United States"] };
  return { db, player, scout: { id: 900, name: "Scout", is_admin: 0 }, boss: { id: 901, name: "Boss", is_admin: 1 }, other: { id: 902, name: "Other", is_admin: 0 } };
}

test("a first report gives a PINE player a college profile with the grade, class and school", () => {
  const { db, player, scout } = setup();
  addCollegeReport(db, player, { grade_present: "C", grade_future: "B", class: "Sophomore", date: "2026-10-12", source: "Live", match: "Akron vs Ohio State", body: "Big, calm on the ball." }, scout);
  const p = prospectDetail(db, { playerId: 1 });
  assert.equal(p.origin, "pine");
  assert.equal(p.grade, "C/B");
  assert.equal(p.grade_val, 7, "B is 7 on the college scale");
  assert.equal(p.school, "Akron Zips", "the club without its bracketed school");
  assert.equal(p.class, "Sophomore");
  assert.equal(p.year, 2026);
  assert.equal(p.country, "United States");
  assert.deepEqual(p.reports.map((r) => [r.author, r.source, r.origin, r.dates[0]]), [["Scout", "Live", "pine", "10/12/2026"]]);
});

test("the profile grade is the best report's, by future grade, as the college site has it", () => {
  const { db, player, scout } = setup();
  addCollegeReport(db, player, { grade_present: "B", grade_future: "B", date: "2026-09-01", body: "Solid." }, scout);
  addCollegeReport(db, player, { grade_present: "C", grade_future: "A-", date: "2026-10-01", body: "Huge upside." }, scout);
  addCollegeReport(db, player, { grade_present: "B+", grade_future: "B+", date: "2026-10-20", body: "Better now." }, scout);
  assert.equal(prospectDetail(db, { playerId: 1 }).grade, "C/A-");
});

test("only the author or an admin edits or deletes; the last report going takes the PINE profile with it", () => {
  const { db, player, scout, boss, other } = setup();
  addCollegeReport(db, player, { grade_present: "B", date: "2026-10-01", body: "One." }, scout);
  const id = db.get("SELECT id FROM ncaa_reports").id;
  assert.throws(() => updateCollegeReport(db, id, { grade_present: "A", body: "Mine now" }, other), /author or an admin/);
  updateCollegeReport(db, id, { grade_present: "A", grade_future: "A+", date: "2026-10-01", body: "Edited." }, boss);
  assert.equal(prospectDetail(db, { playerId: 1 }).grade, "A/A+");
  deleteCollegeReport(db, id, scout);
  assert.equal(prospectDetail(db, { playerId: 1 }), null);
});

test("reports are checked: grades on the scale, a known class, something to say", () => {
  const { db, player, scout } = setup();
  assert.throws(() => addCollegeReport(db, player, { grade_present: "E" }, scout), /Unknown grade/);
  assert.throws(() => addCollegeReport(db, player, { grade_present: "B", class: "Elder" }, scout), /Unknown class/);
  assert.throws(() => addCollegeReport(db, player, { date: "2026-10-01" }, scout), /grade or a written report/);
});

test("PINE reports on an imported profile survive a re-import and count toward its grade", () => {
  const { db, scout } = setup();
  const data = {
    boards: { 2026: { p4: ["william lawson"] } },
    players: [{ key: "william lawson", name: "William Lawson", class: "Junior", year: 2025, grade: "C/C", grade_present: "C", grade_future: "C", grade_val: 4,
      reports: [{ year: 2025, grade: "C/C", grade_present: "C", grade_future: "C", class: "Junior", body: "Fine. (AJ)" }] }],
  };
  importCollege(db, data, { insertPlayer: () => 0 });
  const player = { ...db.get("SELECT * FROM players WHERE id = 1"), citizenship: [] };
  addCollegeReport(db, player, { grade_present: "B", grade_future: "B+", date: "2026-10-01", body: "Grown a lot." }, scout);
  assert.equal(db.get("SELECT origin FROM ncaa_prospects WHERE player_id = 1").origin, "college_db", "added to the imported profile");
  importCollege(db, data, { insertPlayer: () => 0 });
  const p = prospectDetail(db, { playerId: 1 });
  assert.equal(p.reports.length, 2, "the import replaced only its own report");
  assert.equal(p.grade, "B/B+");
  assert.equal(ncaaBoardView(db).info[1].class_now, "Senior", "class still follows the college database (Junior in 2025)");
});
