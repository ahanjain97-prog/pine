import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { registerScoutingContext, scoutingContext } from "../src/lib/scouting_context.js";

function sample() {
  const db = openDb(":memory:");
  db.run("INSERT INTO players(id,name,birthdate,impect_id,summary) VALUES (1,'Example One','2002-01-02',101,'Private evaluation')");
  db.run("INSERT INTO players(id,name,birthdate,tm_id) VALUES (2,'Example Two','2003-03-04','202')");
  db.run("INSERT INTO players(id,name) VALUES (3,'Example Three')");
  db.run("INSERT INTO board_entries(player_id,role,rank,shortlist) VALUES (1,'LB',0,1),(1,'LW',2,0),(2,'RB',1,0)");
  db.run("INSERT INTO lists(id,name,source,external_id) VALUES (1,'Example list','impect','example')");
  db.run("INSERT INTO list_members(list_id,player_id) VALUES (1,1)");
  return db;
}

test("membership stays separate for two players, including an identity without an Impect link", () => {
  const db = sample();
  const before = db.get("SELECT total_changes() AS n").n;
  const result = scoutingContext(db, new Date("2026-10-15T12:00:00Z"));
  assert.equal(result.checked_at, "2026-10-15T12:00:00.000Z");
  assert.deepEqual(result.players.map((p) => p.roles), [
    [{ role: "LB", shortlist: true }, { role: "LW", shortlist: false }],
    [{ role: "RB", shortlist: false }], [],
  ]);
  assert.equal(result.players[1].impect_id, null);
  assert.equal(result.players[1].tm_id, "202");
  assert.equal(result.players[0].lists[0].name, "Example list");
  assert.deepEqual(result.players[1].lists, []);
  assert.deepEqual(Object.keys(result.players[0]).sort(), ["birthdate", "club", "id", "impect_id", "lists", "name", "roles", "tm_id"]);
  assert.equal(JSON.stringify(result).includes("Private evaluation"), false);
  assert.equal(db.get("SELECT total_changes() AS n").n, before);
});

test("the endpoint requires the worker token and never accepts an unset token", async () => {
  for (const token of ["example-token", ""]) {
    const app = new Hono();
    registerScoutingContext(app, { db: sample(), token });
    for (const value of [undefined, "wrong", "example-token"]) {
      const response = await app.request("/api/worker/scouting-context", {
        headers: value ? { "X-PINE-Worker-Token": value } : {},
      });
      assert.equal(response.status, token && value === token ? 200 : 401);
      if (response.ok) {
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.equal((await response.json()).players.length, 3);
      }
    }
  }
});
