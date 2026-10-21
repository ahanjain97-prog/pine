// MLS NEXT Pro graduation gates. Study inputs arrive from scripts/sync-mlsnp-gates.py.
import { bodyLimit } from "hono/body-limit";
import { tokenMatches } from "../auth.js";

export const RULE_VERSION = "mlsnp-graduation-2026-10-20";
export const DEFAULT_MOVE_DATE = "2027-02-28";
const DAY = 86400000;
const GROUPS = ["GK", "CB", "FB", "MID", "W", "CF"];
export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function moveDate() {
  const date = process.env.PINE_MLSNP_MOVE_DATE || DEFAULT_MOVE_DATE;
  if (!validDate(date)) throw new Error("PINE_MLSNP_MOVE_DATE must be a valid YYYY-MM-DD date");
  return date;
}
const isMlsnp = (s) => /^mls(nextpro|np)$/i.test(String(s || "").replace(/[^a-z]/gi, ""));
// A current club's league takes precedence over the historical Impect competition.
export const gatesEligible = (p) => isMlsnp(p.league || p.impect_competition);
const finite = (v, max = Number.MAX_SAFE_INTEGER) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max);

export function validateSnapshot(input, expectedMove = moveDate(), now = new Date()) {
  const bad = (message) => { throw new Error(message); };
  if (!input || input.schema_version !== 1 || input.rule_version !== RULE_VERSION) bad("Unsupported gates schema or rule version");
  if (input.move_date !== expectedMove) bad("Snapshot move date does not match PINE_MLSNP_MOVE_DATE");
  const generated = Date.parse(input.generated_at);
  if (!Number.isFinite(generated) || generated > +now + 5 * 60 * 1000) bad("Invalid snapshot generation time");
  if (!/^[a-f0-9]{40}$/i.test(input.source_commit || "")) bad("Missing study source commit");
  if (!Array.isArray(input.players) || !input.players.length || input.players.length > 10000) bad("Expected 1–10,000 players");
  const ids = new Set();
  const players = input.players.map((p) => {
    if (!Number.isSafeInteger(p.impect_id) || p.impect_id <= 0 || ids.has(p.impect_id)) bad("Invalid or duplicate Impect id");
    ids.add(p.impect_id);
    if (!GROUPS.includes(p.group)) bad("Invalid study position group");
    if (!validDate(p.data_as_of) || p.data_as_of >= expectedMove || Date.parse(p.data_as_of) > generated) bad("Invalid player data date");
    if (p.birthdate !== null && (!validDate(p.birthdate) || p.birthdate >= p.data_as_of)) bad("Invalid birthdate");
    for (const key of ["packing", "ball_wins"]) if (!finite(p[key], 100)) bad(`Invalid ${key} percentile`);
    for (const key of ["pro_minutes", "sample_minutes", "match_shares"]) if (!finite(p[key])) bad(`Invalid ${key}`);
    if (!Array.isArray(p.seasons) || !p.seasons.length || p.seasons.some((s) => !Number.isInteger(s) || s < 2022 || s > Number(expectedMove.slice(0, 4)))) bad("Invalid seasons");
    if (!Array.isArray(p.sources) || !p.sources.length || p.sources.length > 100) bad("Missing source provenance");
    const sources = p.sources.map((s) => {
      if (typeof s.name !== "string" || !s.name.length || s.name.length > 100 || !Number.isFinite(Date.parse(s.fetched_at)) || Date.parse(s.fetched_at) > generated + 300000) bad("Invalid source provenance");
      return { name: s.name, fetched_at: s.fetched_at, stale: s.stale === true };
    });
    if (p.coverage_gap !== true && p.coverage_gap !== false) bad("Missing coverage status");
    return { impect_id: p.impect_id, group: p.group, birthdate: p.birthdate, data_as_of: p.data_as_of,
      packing: p.packing, ball_wins: p.ball_wins, pro_minutes: p.pro_minutes,
      sample_minutes: p.sample_minutes, match_shares: p.match_shares, seasons: [...new Set(p.seasons)].sort(),
      sources, coverage_gap: p.coverage_gap };
  });
  return { schema_version: 1, rule_version: RULE_VERSION, move_date: expectedMove,
    generated_at: new Date(generated).toISOString(), source_commit: input.source_commit, players };
}

export function saveSnapshot(db, input, expectedMove = moveDate()) {
  const snapshot = validateSnapshot(input, expectedMove);
  const prior = db.get("SELECT generated_at FROM mlsnp_gate_run WHERE id = 1");
  if (prior && Date.parse(prior.generated_at) > Date.parse(snapshot.generated_at)) throw new Error("An older snapshot cannot replace the current one");
  db.tx(() => {
    db.run("DELETE FROM mlsnp_gate_inputs");
    for (const player of snapshot.players) db.run("INSERT INTO mlsnp_gate_inputs(impect_id, payload) VALUES (?,?)", player.impect_id, JSON.stringify(player));
    const { players, ...meta } = snapshot;
    db.run("INSERT OR REPLACE INTO mlsnp_gate_run(id, generated_at, payload) VALUES (1,?,?)", snapshot.generated_at, JSON.stringify(meta));
  });
  return snapshot.players.length;
}

// Exact birthday comparison controls the gate; displayed decimals never control a pass.
export function ageOn(birthdate, date) {
  if (!validDate(birthdate) || !validDate(date) || birthdate > date) return null;
  let age = Number(date.slice(0, 4)) - Number(birthdate.slice(0, 4));
  if (date.slice(5) < birthdate.slice(5)) age--;
  return age;
}
export function evaluateGates(p, snapshot, input, targetDate = moveDate(), now = new Date()) {
  const eligible = gatesEligible(p);
  if (!eligible) return { eligible: false };
  const compatible = snapshot?.move_date === targetDate && snapshot?.rule_version === RULE_VERSION;
  const d = compatible ? input : null;
  const dob = validDate(p.birthdate) ? p.birthdate : d?.birthdate;
  const age = ageOn(dob, targetDate);
  const gk = d?.group === "GK" || /goalkeeper|^gk$/i.test(p.position || "");
  const gate = (id, label, threshold, value, applicable = true) => ({
    id, label, threshold, value: value ?? null,
    status: !applicable ? "not_applicable" : value == null ? "unavailable" : value >= threshold ? "met" : "below",
  });
  const gates = [gate("packing", "Packing", 50, d?.packing), gate("ball_wins", "Ball wins", 50, d?.ball_wins, !gk),
    gate("pro_minutes", "Total pro minutes", 2000, d?.pro_minutes), gate("age", "Age at move", 22, age)];
  const warnings = [];
  if (!p.impect_id) warnings.push("Link this player to Impect to load performance and minutes.");
  else if (!snapshot) warnings.push("The first gates update has not arrived yet.");
  else if (!compatible) warnings.push("Waiting for a snapshot for this move date and rule set.");
  else if (!d) warnings.push("No study data for this player in the pre-move window.");
  if (d && (now - new Date(snapshot.generated_at) > 2 * DAY || d.sources.some((s) => s.stale))) warnings.push("Source data may be out of date; showing the last available snapshot.");
  if (d?.match_shares != null && d.match_shares < 5) warnings.push("Provisional: fewer than 5 match shares in the MLSNP sample.");
  else if (d?.sample_minutes != null && d.sample_minutes < 1500) warnings.push("Directional: fewer than 1,500 MLSNP minutes.");
  if (d?.coverage_gap) warnings.push("Coverage gap: some played team matches are not available in Impect.");
  if (validDate(p.birthdate) && d?.birthdate && p.birthdate !== d.birthdate) warnings.push("Birthdates differ between PINE and Impect; using PINE's date of birth.");
  if (targetDate <= now.toISOString().slice(0, 10)) warnings.push("The projected move date has passed; update the recruitment window.");
  return { eligible: true, rule_version: RULE_VERSION, move_date: targetDate, gates,
    met: gates.filter((g) => g.status === "met").length, total: gk ? 3 : 4,
    unavailable: gates.filter((g) => g.status === "unavailable").length,
    provisional: d?.match_shares != null && d.match_shares < 5, warnings,
    age_today: ageOn(dob, now.toISOString().slice(0, 10)), birthdate: dob || null,
    group: d?.group || (gk ? "GK" : null), seasons: d?.seasons || [], sample_minutes: d?.sample_minutes ?? null,
    data_as_of: d?.data_as_of || null, generated_at: d ? snapshot.generated_at : null,
    sources: d?.sources || [], source_commit: d ? snapshot.source_commit : null };
}
export function playerGates(db, p, date = moveDate(), now = new Date()) {
  const run = db.get("SELECT payload FROM mlsnp_gate_run WHERE id = 1");
  const row = p.impect_id && db.get("SELECT payload FROM mlsnp_gate_inputs WHERE impect_id = ?", p.impect_id);
  return evaluateGates(p, run ? JSON.parse(run.payload) : null, row ? JSON.parse(row.payload) : null, date, now);
}

export function registerGates(app, { db, token, getPlayer }) {
  app.get("/api/players/:id/mlsnp-gates", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(playerGates(db, getPlayer(c.req.param("id"))));
  });
  app.put("/api/worker/mlsnp-gates", bodyLimit({ maxSize: 10 * 1024 * 1024 }), async (c) => {
    if (c.req.header("X-PINE") !== "1" || !tokenMatches(c.req.header("X-PINE-Worker-Token"), token)) return c.json({ error: "Worker token missing or wrong" }, 401);
    try { return c.json({ ok: true, players: saveSnapshot(db, await c.req.json()) }); }
    catch (e) { return c.json({ error: e.message }, 400); }
  });
  app.get("/api/worker/mlsnp-gates/config", (c) => {
    if (!tokenMatches(c.req.header("X-PINE-Worker-Token"), token)) return c.json({ error: "Worker token missing or wrong" }, 401);
    return c.json({ rule_version: RULE_VERSION, move_date: moveDate() });
  });
}
