import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { setSigned } from "../src/lib/signing.js";
import { registerRoster, rosterSpot, setRosterPosition } from "../src/lib/roster.js";
import { mergePlayer } from "../src/lib/ncaa.js";

function setup(t) {
  const db = openDb(":memory:");
  t.after(() => db.raw.close());
  db.run("INSERT INTO players(id,name,position,foot) VALUES (1,'Example Player','Centre-Back','left')");
  db.run("INSERT INTO players(id,name,position) VALUES (2,'Example Unsigned','Goalkeeper')");
  setSigned(db, 1, true, 1);
  return db;
}

test("roster spot: staff choice, then first board role, then Transfermarkt position", () => {
  assert.equal(rosterSpot({ is_signed: false, position: "Goalkeeper" }), null);
  assert.equal(rosterSpot({ is_signed: true, position: "Centre-Back", foot: "left" }), "LCB");
  assert.equal(rosterSpot({ is_signed: true, position: "Centre-Back", foot: "right" }), "RCB");
  assert.equal(rosterSpot({ is_signed: true, position: "Centre-Back", roles: [{ role: "CDM1" }] }), "CDM");
  assert.equal(rosterSpot({ is_signed: true, position: "Centre-Back", roles: [{ role: "CDM1" }], roster_position: "RB" }), "RB");
  assert.equal(rosterSpot({ is_signed: true, roster_position: "XX", position: "Goalkeeper" }), "GK");
  assert.equal(rosterSpot({ is_signed: true, position: null }), null);
});

test("setting a roster position is validated, audited and idempotent", (t) => {
  const db = setup(t);
  assert.throws(() => setRosterPosition(db, 1, "XX", 1), /Unknown roster position/);
  assert.throws(() => setRosterPosition(db, 2, "GK", 1), /Only signed players/);
  assert.throws(() => setRosterPosition(db, 99, "GK", 1), /not found/);
  assert.equal(setRosterPosition(db, 1, "CDM", 1), "CDM");
  assert.equal(setRosterPosition(db, 1, "CDM", 2), "CDM");
  assert.equal(setRosterPosition(db, 1, null, 2), null);
  assert.deepEqual(db.all("SELECT detail FROM activity WHERE action='set_roster_position' ORDER BY id").map((a) => JSON.parse(a.detail)),
    [{ position: "CDM", previous: null }, { position: null, previous: "CDM" }]);
});

test("unsigning clears the roster position; signing again keeps it cleared", (t) => {
  const db = setup(t);
  setRosterPosition(db, 1, "RB", 1);
  setSigned(db, 1, false, 1);
  assert.equal(db.get("SELECT roster_position FROM players WHERE id=1").roster_position, null);
  setSigned(db, 1, true, 1);
  setRosterPosition(db, 1, "LB", 1);
  setSigned(db, 1, true, 1);
  assert.equal(db.get("SELECT roster_position FROM players WHERE id=1").roster_position, "LB");
});

test("college duplicate merges carry the roster position over to the signed survivor", (t) => {
  const db = setup(t);
  db.run("INSERT INTO players(id,name) VALUES (3,'Example Survivor')");
  setRosterPosition(db, 1, "RB", 1);
  mergePlayer(db, 1, 3);
  assert.deepEqual({ ...db.get("SELECT is_signed, roster_position FROM players WHERE id=3") }, { is_signed: 1, roster_position: "RB" });
});

test("existing databases gain an empty roster_position column", () => {
  const dir = mkdtempSync(join(tmpdir(), "pine-roster-"));
  try {
    const file = join(dir, "pine.db"), old = openDb(file);
    old.run("INSERT INTO players(id,name) VALUES (1,'Example Player')");
    old.raw.exec("ALTER TABLE players DROP COLUMN roster_position");
    old.raw.close();
    const db = openDb(file);
    assert.equal(db.get("SELECT roster_position FROM players WHERE id=1").roster_position, null);
    db.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("roster endpoint requires a staff user and validates the position", async (t) => {
  const db = setup(t), app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, e.status || 500));
  app.use("*", async (c, next) => { if (c.req.header("Test-User")) c.set("user", { id: 1 }); await next(); });
  registerRoster(app, { db, getPlayer: (id) => {
    const p = db.get("SELECT * FROM players WHERE id=?", Number(id));
    if (!p) throw Object.assign(new Error("Player not found"), { status: 404 });
    return p;
  } });
  const request = (body, user = true, id = 1) => app.request(`/api/players/${id}/roster-position`, {
    method: "PUT", headers: { "Content-Type": "application/json", ...(user ? { "Test-User": "1" } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await request({ position: "GK" }, false)).status, 401);
  assert.equal((await request({ position: "XX" })).status, 400);
  assert.equal((await request({ position: "GK" }, true, 2)).status, 400);
  assert.equal((await request({ position: "GK" }, true, 99)).status, 404);
  assert.deepEqual(await (await request({ position: "GK" })).json(), { position: "GK" });
  assert.deepEqual(await (await request({})).json(), { position: null });
});
