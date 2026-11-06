// Only capability crosses into PINE. Match evidence stays on the analysis host.
import { bodyLimit } from "hono/body-limit";
import { tokenMatches } from "../auth.js";
import { logActivity } from "../db.js";

export const LONG_THROW_RULE = "long-throw-v2";
export const hasLongThrow = (p) => p.long_throw_override == null ? Boolean(p.long_throw_detected) : Boolean(p.long_throw_override);
export function longThrowOverride(value) {
  if (value === null) return null;
  if (typeof value !== "boolean") throw Object.assign(new Error("Long throw must be true, false or null (Auto)"), { status: 400 });
  return Number(value);
}

export function saveLongThrows(db, input, now = new Date()) {
  const bad = (message) => { throw new Error(message); };
  if (!input || input.schema_version !== 1 || input.rule_version !== LONG_THROW_RULE) bad("Unsupported long-throw schema or rule");
  const at = Date.parse(input.generated_at);
  if (!Number.isFinite(at) || at > +now + 300000) bad("Invalid generation time");
  if (!Array.isArray(input.players) || input.players.length > 100000) bad("Expected a list of player IDs");
  const ids = new Set();
  for (const id of input.players) {
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) bad("Invalid or duplicate Impect ID");
    ids.add(id);
  }
  for (const key of ["matches", "pending_matches"]) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) bad(`Invalid ${key}`);
  }
  if (!input.matches && ids.size) bad("Positive flags require processed matches");
  return db.tx(() => {
    const previous = db.get("SELECT generated_at, matches FROM long_throw_sync WHERE id = 1");
    if (previous && Date.parse(previous.generated_at) > at) bad("An older sync cannot replace the current one");
    if (previous && input.matches < previous.matches) bad("A sync cannot discard cached match coverage");
    let added = 0, removed = 0;
    for (const { impect_id } of db.all("SELECT impect_id FROM long_throw_players")) {
      if (!ids.has(impect_id)) removed += Number(db.run("DELETE FROM long_throw_players WHERE impect_id = ?", impect_id).changes);
    }
    for (const id of ids) added += Number(db.run("INSERT OR IGNORE INTO long_throw_players(impect_id) VALUES (?)", id).changes);
    db.run(`INSERT OR REPLACE INTO long_throw_sync(id, generated_at, matches, pending_matches, rule_version) VALUES (1,?,?,?,?)`,
      new Date(at).toISOString(), input.matches, input.pending_matches, LONG_THROW_RULE);
    // Wake open boards only when a flag changes; metadata-only syncs don't interrupt staff.
    if (added || removed) logActivity(db, null, null, "synced_long_throws", { added, removed });
    return { added, removed, players: ids.size };
  });
}

export function longThrowSyncStatus(db, now = new Date()) {
  const run = db.get("SELECT generated_at, matches, pending_matches, rule_version FROM long_throw_sync WHERE id = 1");
  return run ? { ...run, stale: +now - Date.parse(run.generated_at) > 48 * 3600000 } : null;
}

export function registerLongThrows(app, { db, token, iterations = async () => [] }) {
  app.get("/api/worker/long-throws/config", async (c) => {
    if (!tokenMatches(c.req.header("X-PINE-Worker-Token"), token)) return c.json({ error: "Worker token missing or wrong" }, 401);
    return c.json({ rule_version: LONG_THROW_RULE, iterations: (await iterations()).filter((i) => Number(i.season) >= 2025)
      .map((i) => ({ id: i.id, season: Number(i.season) })) });
  });
  app.put("/api/worker/long-throws", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    if (c.req.header("X-PINE") !== "1" || !tokenMatches(c.req.header("X-PINE-Worker-Token"), token)) return c.json({ error: "Worker token missing or wrong" }, 401);
    try { return c.json({ ok: true, ...saveLongThrows(db, await c.req.json()) }); }
    catch (e) { return c.json({ error: e.message }, 400); }
  });
}
