import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { ageOn, evaluateGates, gatesEligible, playerGates, registerGates, RULE_VERSION, saveSnapshot, validateSnapshot } from "../src/lib/mlsnp_gates.js";

const now = new Date("2026-10-21T12:00:00Z");
const player = { id: 1, name: "Example Player", impect_id: 101, league: "MLS NEXT Pro", birthdate: "2005-02-28", position: "Midfielder" };
function input(overrides = {}) {
  return { impect_id: 101, group: "MID", birthdate: "2005-02-28", data_as_of: "2026-10-17",
    packing: 68.2, ball_wins: 43.1, pro_minutes: 2860, sample_minutes: 1680, match_shares: 18.7,
    seasons: [2026], coverage_gap: false, sources: [{ name: "Impect 2026", fetched_at: "2026-10-20T12:00:00Z", stale: false }], ...overrides };
}
function snapshot(row = input()) {
  return { schema_version: 1, rule_version: RULE_VERSION, move_date: "2027-02-28", generated_at: "2026-10-20T14:00:00Z", source_commit: "a".repeat(40), players: [row] };
}
const evaluate = (row = input(), p = player, meta = snapshot(row)) => evaluateGates(p, meta, row, "2027-02-28", now);

test("current club league wins over a historical Impect link", () => {
  assert.equal(gatesEligible(player), true);
  assert.equal(gatesEligible({ impect_competition: "MLS Next Pro" }), true);
  assert.equal(gatesEligible({ league: "MLSNP" }), true);
  assert.equal(gatesEligible({ league: "USL Championship", impect_competition: "MLS Next Pro" }), false);
  assert.equal(gatesEligible({ league: "Major League Soccer", impect_competition: "MLS Next Pro" }), false);
  assert.equal(gatesEligible({}), false);
  assert.deepEqual(evaluate(input(), { league: "USL League One" }), { eligible: false });
});
test("exact inclusive gates, with no rounded-up passes", () => {
  const at = evaluate(input({ packing: 50, ball_wins: 50, pro_minutes: 2000 }));
  assert.equal(at.met, 4);
  assert.equal(at.age_today, 21);
  const below = evaluate(input({ packing: 49.999, ball_wins: 49.999, pro_minutes: 1999.999 }), { ...player, birthdate: "2005-03-01" });
  assert.equal(below.met, 0);
  assert.ok(below.gates.every((g) => g.status === "below"));
  assert.equal(ageOn("2005-02-28", "2027-02-28"), 22);
  assert.equal(ageOn("2004-02-29", "2026-02-28"), 21);
  assert.equal(ageOn("2004-02-29", "2026-03-01"), 22);
  assert.equal(ageOn("2005-02-30", "2027-02-28"), null);
});
test("missing data, zero, and goalkeeper non-applicability stay distinct", () => {
  const missing = evaluate(input({ packing: null, pro_minutes: null, ball_wins: 0 }));
  assert.equal(missing.met, 1);
  assert.equal(missing.unavailable, 2);
  assert.equal(missing.gates[1].status, "below");
  const gk = evaluate(input({ group: "GK", packing: 80, ball_wins: null }));
  assert.equal(gk.total, 3);
  assert.equal(gk.met, 3);
  assert.equal(gk.unavailable, 0);
  assert.equal(gk.gates[1].status, "not_applicable");
});
test("no snapshot still shows age; mismatched move date never reuses old performance", () => {
  const empty = evaluate(null, player, null);
  assert.equal(empty.met, 1);
  assert.equal(empty.unavailable, 3);
  assert.match(empty.warnings.join(" "), /first gates update/);
  const changed = evaluate(input(), player, { ...snapshot(), move_date: "2027-03-01" });
  assert.equal(changed.unavailable, 3);
  assert.equal(changed.generated_at, null);
  assert.match(changed.warnings.join(" "), /move date/);
  const unlinked = evaluateGates({ ...player, impect_id: null }, null, null, "2027-02-28", now);
  assert.match(unlinked.warnings.join(" "), /Link this player/);
});
test("sample, source age, coverage, and DOB conflicts are visible without changing thresholds", () => {
  const row = input({ match_shares: 2, sample_minutes: 180, coverage_gap: true, birthdate: "2000-01-01",
    sources: [{ name: "Impect", fetched_at: "2026-10-10T00:00:00Z", stale: true }] });
  const d = evaluate(row);
  assert.equal(d.provisional, true);
  assert.equal(d.met, 3);
  for (const text of [/Provisional/, /out of date/, /Coverage gap/, /Birthdates differ/]) assert.match(d.warnings.join(" "), text);
  assert.match(evaluate(input({ sample_minutes: 1000 })).warnings.join(" "), /Directional/);
  assert.match(evaluate(input(), player, { ...snapshot(), generated_at: "2026-10-01T00:00:00Z" }).warnings.join(" "), /out of date/);
});
test("validation rejects malformed snapshots and strips unneeded private fields", () => {
  const clean = validateSnapshot({ ...snapshot(), summary: "private", players: [input({ notes: "private" })] }, "2027-02-28", now);
  assert.equal(JSON.stringify(clean).includes("private"), false);
  for (const change of [
    { schema_version: 2 }, { rule_version: "new" }, { move_date: "2027-03-01" }, { players: [] },
    { players: [input(), input()] }, { generated_at: "2030-01-01T00:00:00Z" },
    ...[{ packing: 101 }, { packing: "50" }, { ball_wins: undefined }, { pro_minutes: -1 },
      { group: "CM" }, { birthdate: "2004-02-30" }, { data_as_of: "2027-03-01" }, { sources: [] },
      { sources: [{ name: "Impect", fetched_at: "2030-01-01" }] }].map((r) => ({ players: [input(r)] })),
  ]) assert.throws(() => validateSnapshot({ ...snapshot(), ...change }, "2027-02-28", now));
});
test("snapshot replacement is atomic and rejects older input", () => {
  const db = openDb(":memory:");
  assert.equal(saveSnapshot(db, snapshot(), "2027-02-28"), 1);
  assert.equal(playerGates(db, player, "2027-02-28", now).met, 3);
  assert.throws(() => saveSnapshot(db, { ...snapshot(), players: [input(), input({ impect_id: 202, packing: -1 })] }));
  assert.throws(() => saveSnapshot(db, { ...snapshot(), generated_at: "2026-10-19T14:00:00Z" }));
  assert.equal(playerGates(db, player, "2027-02-28", now).met, 3);
  saveSnapshot(db, { ...snapshot(input({ packing: 20 })), generated_at: "2026-10-20T15:00:00Z" });
  assert.equal(playerGates(db, player, "2027-02-28", now).met, 2);
});
test("worker routes require a configured token and valid payload; staff reads use stored inputs", async () => {
  const app = new Hono(), db = openDb(":memory:");
  registerGates(app, { db, token: "test-token", getPlayer: () => player });
  const url = "/api/worker/mlsnp-gates";
  const headers = { "X-PINE": "1", "X-PINE-Worker-Token": "test-token", "Content-Type": "application/json" };
  for (const h of [{}, { ...headers, "X-PINE-Worker-Token": "wrong" }, { ...headers, "X-PINE": "0" }]) {
    assert.equal((await app.request(url, { method: "PUT", headers: h, body: JSON.stringify(snapshot()) })).status, 401);
  }
  assert.equal((await app.request(url, { method: "PUT", headers, body: "{" })).status, 400);
  assert.equal((await app.request(url, { method: "PUT", headers, body: JSON.stringify(snapshot()) })).status, 200);
  const read = await app.request("/api/players/1/mlsnp-gates");
  assert.equal(read.headers.get("Cache-Control"), "no-store");
  assert.equal((await read.json()).met, 3);
  assert.equal((await app.request(url + "/config")).status, 401);
  assert.equal((await app.request(url + "/config", { headers })).status, 200);
  const disabled = new Hono();
  registerGates(disabled, { db, token: "", getPlayer: () => player });
  assert.equal((await disabled.request(url, { method: "PUT", headers, body: JSON.stringify(snapshot()) })).status, 401);
});
