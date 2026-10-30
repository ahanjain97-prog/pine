import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { registerSigning, setSigned } from "../src/lib/signing.js";
import { tmSyncFields } from "../src/lib/tm_sync.js";
import { mergePlayer } from "../src/lib/ncaa.js";

function setup(t, file = ":memory:") {
  const db = openDb(file);
  t.after(() => db.raw.close());
  db.run("INSERT INTO players(id,name,decision,club) VALUES (1,'Example Player','hold','Example FC')");
  db.run("INSERT INTO board_entries(player_id,role,rank,shortlist) VALUES (1,'LW1',2,1)");
  return db;
}

test("signing is reversible, audited, idempotent, and independent of scouting", (t) => {
  const db = setup(t);
  assert.equal(setSigned(db, 1, true, 1), true);
  const p = db.get("SELECT * FROM players WHERE id=1");
  assert.equal(p.is_signed, 1);
  assert.equal(p.signed_by, 1);
  assert.ok(p.signed_at);
  assert.equal(p.decision, "hold");
  assert.equal(p.club, "Example FC");
  assert.deepEqual({ ...db.get("SELECT rank,shortlist FROM board_entries WHERE player_id=1") }, { rank: 2, shortlist: 1 });
  setSigned(db, 1, true, 2);
  assert.equal(db.get("SELECT signed_by FROM players WHERE id=1").signed_by, 1);
  assert.equal(db.get("SELECT count(*) AS n FROM activity").n, 1);
  assert.equal(setSigned(db, 1, false, 2), false);
  assert.deepEqual({ ...db.get("SELECT is_signed,signed_by,signed_at FROM players WHERE id=1") }, { is_signed: 0, signed_by: null, signed_at: null });
  assert.deepEqual(db.all("SELECT detail FROM activity ORDER BY id").map((a) => JSON.parse(a.detail)),
    [{ signed: true, previous: false }, { signed: false, previous: true }]);
});

test("invalid values and a failed audit never leave a partial signing", (t) => {
  const db = setup(t);
  for (const value of [null, undefined, 0, 1, "false", {}, []]) assert.throws(() => setSigned(db, 1, value, 1), /true or false/);
  assert.throws(() => setSigned(db, 999, true, 1), /not found/);
  db.raw.exec("CREATE TRIGGER fail_signing BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'audit failed'); END");
  assert.throws(() => setSigned(db, 1, true, 1), /audit failed/);
  assert.equal(db.get("SELECT is_signed FROM players WHERE id=1").is_signed, 0);
});

test("existing databases migrate with unsigned defaults and retain signings on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "pine-signing-"));
  try {
    const file = join(dir, "pine.db"), old = openDb(file);
    old.run("INSERT INTO players(id,name) VALUES (1,'Example Player')");
    for (const col of ["signed_at", "signed_by", "is_signed"]) old.raw.exec(`ALTER TABLE players DROP COLUMN ${col}`);
    old.raw.close();
    const db = openDb(file);
    assert.equal(db.get("SELECT is_signed FROM players WHERE id=1").is_signed, 0);
    setSigned(db, 1, true, 1);
    db.raw.close();
    const reopened = openDb(file);
    assert.equal(reopened.get("SELECT is_signed FROM players WHERE id=1").is_signed, 1);
    reopened.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Transfermarkt refresh cannot infer, overwrite or clear a signing", () => {
  const fields = tmSyncFields({ is_signed: 1, tm_overrides: [] }, { club: "Other FC", is_signed: 0, signed_by: 2 });
  assert.equal("is_signed" in fields, false);
  assert.equal("signed_by" in fields, false);
  assert.equal("signed_at" in fields, false);
});

test("college duplicate merges keep signing status and its original attribution", (t) => {
  const db = setup(t);
  db.run("INSERT INTO players(id,name) VALUES (2,'Example Duplicate')");
  setSigned(db, 2, true, 2);
  const signedAt = db.get("SELECT signed_at FROM players WHERE id=2").signed_at;
  mergePlayer(db, 2, 1);
  assert.deepEqual({ ...db.get("SELECT is_signed,signed_by,signed_at FROM players WHERE id=1") },
    { is_signed: 1, signed_by: 2, signed_at: signedAt });
  assert.equal(db.get("SELECT player_id FROM activity WHERE action='set_signed'").player_id, 1);
});

test("signing endpoint requires a staff user and validates the requested boolean", async (t) => {
  const db = setup(t), app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, e.status || 500));
  app.use("*", async (c, next) => { if (c.req.header("Test-User")) c.set("user", { id: 1 }); await next(); });
  registerSigning(app, { db, getPlayer: (id) => {
    const p = db.get("SELECT * FROM players WHERE id=?", Number(id));
    if (!p) throw Object.assign(new Error("Player not found"), { status: 404 });
    return p;
  } });
  const request = (body, user = true, id = 1) => app.request(`/api/players/${id}/signing`, {
    method: "PUT", headers: { "Content-Type": "application/json", ...(user ? { "Test-User": "1" } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await request({ signed: true }, false)).status, 401);
  for (const body of [{}, { signed: "false" }, null]) assert.equal((await request(body)).status, 400);
  assert.equal((await request({ signed: true }, true, 99)).status, 404);
  assert.deepEqual(await (await request({ signed: true })).json(), { signed: true });
  assert.equal(db.get("SELECT is_signed FROM players WHERE id=1").is_signed, 1);
  assert.deepEqual(await (await request({ signed: false })).json(), { signed: false });
});
