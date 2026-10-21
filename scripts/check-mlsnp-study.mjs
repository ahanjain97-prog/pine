// Private-data parity check. Pass a generated snapshot and the recent board workbook_input.json.
// Only aggregate counts are printed; neither input is copied into the public repository.
import fs from "node:fs";
import assert from "node:assert/strict";
import { evaluateGates, validateSnapshot } from "../src/lib/mlsnp_gates.js";

const [snapshotFile, studyFile] = process.argv.slice(2);
if (!snapshotFile || !studyFile) throw new Error("Usage: node scripts/check-mlsnp-study.mjs SNAPSHOT_JSON STUDY_WORKBOOK_INPUT_JSON");
const raw = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
const snapshot = validateSnapshot(raw, raw.move_date);
const prior = JSON.parse(fs.readFileSync(studyFile, "utf8"));
assert.equal(snapshot.move_date, prior.metadata.move_date);
const byId = new Map(snapshot.players.map((p) => [p.impect_id, p]));
let compared = 0;
for (const p of [...prior.current, ...prior.affiliates]) {
  const got = byId.get(p.playerId);
  assert.ok(got, "A prior study player is absent");
  for (const [key, studyKey] of [["packing", "pct_IMPECT_SCORE_PACKING"], ["ball_wins", "pct_BALL_WIN_NUMBER"],
    ["pro_minutes", "pro_minutes"], ["sample_minutes", "mlsnp_minutes"]]) {
    assert.ok(Math.abs(got[key] - p[studyKey]) < 0.00001, `Study mismatch in ${key}`);
  }
  const result = evaluateGates({ league: "MLS NEXT Pro", birthdate: p.dob_used, impect_id: p.playerId }, snapshot, got,
    snapshot.move_date, new Date(`${prior.metadata.today}T12:00:00Z`));
  assert.equal(result.met, p.gates_passed, "Gate count differs from the board analysis");
  assert.equal(result.total, p.max_gates, "Applicable gate count differs");
  compared++;
}
console.log(`Parity passed: ${compared} study players, four numeric inputs and all gate counts; ${snapshot.players.length} exported players.`);
