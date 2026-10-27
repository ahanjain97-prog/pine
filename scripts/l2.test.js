import test from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/db.js";
import { linkL2, saveL2Report } from "../src/lib/l2.js";
import { importCollege, ncaaProspects } from "../src/lib/ncaa.js";

// Made-up players in the report's shape.
const report = (year, players) => ({ year, players });
const entry = (name, born, extra = {}) => ({ name, born, club: "Vermont Green FC", tier: "First", position: "CM", status: "Domestic", ...extra });

test("report entries link to PINE players by name, with the birth year as a check", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO players(id, name, league, birthdate) VALUES (1, 'Nicolas Loebus', 'NCAA', '2005-01-01')");
  db.run("INSERT INTO players(id, name, league, birthdate) VALUES (2, 'Sam Carter', 'USL1', '1998-03-01')");
  db.run("INSERT INTO players(id, name, league) VALUES (3, 'Joe McDaid', 'NCAA')");
  const r = saveL2Report(db, report(2026, [
    entry("Nico Loebus", 2005, { status: "International" }), entry("Sam Carter", 2005), entry("Jack McDaid", 2005), entry("Joe McDaid", 2005),
  ]));
  assert.deepEqual(r, { players: 4, linked: 2 });
  const link = (name) => db.get("SELECT player_id FROM l2_prospects WHERE name = ?", name).player_id;
  assert.equal(link("Nico Loebus"), 1, "a short first name, for an NCAA player");
  assert.equal(link("Sam Carter"), null, "born 1998, not 2005: a different Sam Carter");
  assert.equal(link("Jack McDaid"), null, "Jack isn't Joe");
  assert.equal(link("Joe McDaid"), 3);
  assert.equal(db.get("SELECT status FROM l2_prospects WHERE name = 'Nico Loebus'").status, "international");
});

test("uploading a year again replaces that year only, and players added later get linked", () => {
  const db = openDb(":memory:");
  saveL2Report(db, report(2025, [entry("Alex Older", 2003)]));
  saveL2Report(db, report(2026, [entry("Alex Newer", 2005), entry("Ben Second", 2005, { tier: "second" })]));
  saveL2Report(db, report(2026, [entry("Alex Newer", 2005)]));
  assert.deepEqual(db.all("SELECT year, name FROM l2_prospects ORDER BY year").map((r) => [r.year, r.name]), [[2025, "Alex Older"], [2026, "Alex Newer"]]);
  db.run("INSERT INTO players(id, name) VALUES (9, 'Alex Newer')");
  assert.equal(linkL2(db), 1);
  assert.throws(() => saveL2Report(db, report(2026, [])), /players/);
  assert.throws(() => saveL2Report(db, { players: [entry("X", 2000)] }), /year/);
});

test("college prospects carry their L2 picks, even without a PINE player", () => {
  const db = openDb(":memory:");
  importCollege(db, { boards: {}, players: [{ key: "zed tester", name: "Zed Tester", team: "Akron", year: 2025, reports: [] }] }, { insertPlayer: () => 0 });
  saveL2Report(db, report(2025, [entry("Zedediah Tester", 2004, { tier: "Fourth" })])); // the report's longer first name
  assert.deepEqual(ncaaProspects(db)[0].l2.map((e) => [e.year, e.tier]), [[2025, "Fourth"]]);
});

test("a transaction inside another joins it, and an error rolls back both", () => {
  const db = openDb(":memory:");
  db.tx(() => {
    db.run("INSERT INTO players(id, name) VALUES (1, 'Outer')");
    db.tx(() => db.run("INSERT INTO players(id, name) VALUES (2, 'Inner')"));
  });
  assert.equal(db.get("SELECT count(*) AS n FROM players").n, 2);
  assert.throws(() => db.tx(() => {
    db.run("INSERT INTO players(id, name) VALUES (3, 'Doomed')");
    db.tx(() => { throw new Error("inner fails"); });
  }), /inner fails/);
  assert.equal(db.get("SELECT count(*) AS n FROM players").n, 2);
  db.tx(() => db.run("INSERT INTO players(id, name) VALUES (4, 'After')"));
  assert.equal(db.get("SELECT count(*) AS n FROM players").n, 3, "transactions work normally afterwards");
});

test("adding a player inside a transaction links their L2 picks (the Add player path)", () => {
  const db = openDb(":memory:");
  saveL2Report(db, report(2026, [entry("Jack Newcomer", 2007)]));
  const id = db.tx(() => {
    const pid = Number(db.run("INSERT INTO players(name, birthdate) VALUES ('Jack Newcomer', '2007-11-20')").lastInsertRowid);
    linkL2(db); // what insertPlayer does
    return pid;
  });
  assert.equal(db.get("SELECT player_id FROM l2_prospects WHERE name = 'Jack Newcomer'").player_id, id);
});

test("the college import can create players while each creation re-links L2 picks", () => {
  const db = openDb(":memory:");
  saveL2Report(db, report(2026, [entry("Ana Striker", 2005)]));
  const insertPlayer = (f) => {
    const pid = Number(db.run("INSERT INTO players(name, league, source) VALUES (?, 'NCAA', 'college_import')", f.name).lastInsertRowid);
    linkL2(db);
    return pid;
  };
  importCollege(db, { boards: { 2026: { p9: ["ana striker"] } }, players: [{ key: "ana striker", name: "Ana Striker", year: 2026, reports: [] }] }, { insertPlayer });
  assert.ok(db.get("SELECT player_id FROM l2_prospects WHERE name = 'Ana Striker'").player_id);
});

test("db.once runs a one-time change once, inside a transaction", () => {
  const db = openDb(":memory:");
  let runs = 0;
  db.once("demo", () => { runs++; db.run("INSERT INTO players(name) VALUES ('Once')"); });
  db.once("demo", () => { runs++; });
  assert.equal(runs, 1);
  assert.throws(() => db.once("fails", () => { db.run("INSERT INTO players(name) VALUES ('Rolled back')"); throw new Error("no"); }), /no/);
  assert.equal(db.get("SELECT count(*) AS n FROM players WHERE name = 'Rolled back'").n, 0);
  db.once("fails", () => { runs++; });
  assert.equal(runs, 2, "a failed one-time change runs again next time");
});
