import test from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/db.js";
import { collegeLeague } from "../src/lib/transfermarkt.js";
import { backfillCollegeLeagues } from "../src/lib/tm_sync.js";

test("college clubs with no Transfermarkt league become NCAA", () => {
  for (const club of [
    "Indiana Hoosiers (Indiana University)",
    "Providence Friars (Providence College)",
    "UNCA Bulldogs (University of NC, Asheville)",
    "Army West Point Black Knights (US Military Academy)",
  ]) assert.equal(collegeLeague(club, null), "NCAA", club);
});

test("professional clubs and real leagues are left alone", () => {
  assert.equal(collegeLeague("University College Dublin", "Premier Division"), "Premier Division");
  assert.equal(collegeLeague("University College Dublin", null), null, "no school in brackets");
  assert.equal(collegeLeague("IMG Academy", null), null);
  assert.equal(collegeLeague("Real Monarchs SLC", "MLS NEXT Pro"), "MLS NEXT Pro");
  assert.equal(collegeLeague(null, null), null);
});

test("the backfill fills linked college players but keeps hand-edited leagues", () => {
  const db = openDb(":memory:");
  const add = (id, club, league, overrides = []) => db.run(
    "INSERT INTO players(id, name, club, league, tm_url, tm_overrides) VALUES (?,?,?,?,?,?)",
    id, `P${id}`, club, league, `https://www.transfermarkt.com/x/profil/spieler/${id}`, JSON.stringify(overrides));
  add(1, "Clemson Tigers (Clemson University)", null);
  add(2, "Clemson Tigers (Clemson University)", "", ["league", "league_code"]); // cleared by hand
  add(3, "Real Monarchs SLC", null);
  add(4, "Akron Zips (University of Akron)", "Big East");
  db.run("INSERT INTO players(id, name, club) VALUES (5, 'Manual', 'Wake Forest Demon Deacons (Wake Forest University)')");

  assert.equal(backfillCollegeLeagues(db), 1);
  const league = (id) => db.get("SELECT league FROM players WHERE id = ?", id).league;
  assert.equal(league(1), "NCAA");
  assert.equal(league(2), "", "a league someone cleared stays cleared");
  assert.equal(league(3), null);
  assert.equal(league(4), "Big East");
  assert.equal(league(5), null, "players without a Transfermarkt link are typed by hand");
  assert.equal(backfillCollegeLeagues(db), 0, "running again changes nothing");
});
