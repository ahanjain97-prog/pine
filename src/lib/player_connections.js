import { norm } from "./physical.js";
import { tmSyncFields } from "./tm_sync.js";

export function resolvePlayerId(db, id) {
  return db.get("SELECT player_id FROM player_redirects WHERE id = ?", Number(id))?.player_id ?? Number(id);
}

// Only exact identities, never name-only matches or an ambiguous set of records.
export function connectedDuplicate(db, profile, impectId = null) {
  if (impectId) {
    const linked = db.get("SELECT id, name FROM players WHERE impect_id = ?", impectId);
    if (linked) return linked;
  }
  if (!profile.birthdate || !norm(profile.name)) return null;
  const matches = db.all("SELECT id, name FROM players WHERE birthdate = ?", profile.birthdate)
    .filter((p) => norm(p.name) === norm(profile.name));
  return matches.length === 1 ? matches[0] : null;
}

// Combining an untouched Transfermarkt import with its existing Impect profile is safe. Refuse
// richer duplicates: they need a person to reconcile decisions, rankings and manual edits first.
export function connectionMergeProblem(db, from, into) {
  if (!from || !into || from.id === into.id) return "Choose two existing profiles";
  if (!from.tm_id || from.impect_id || !into.impect_id || into.tm_id) return "These profiles cannot be combined automatically";
  if (!from.birthdate || from.birthdate !== into.birthdate || norm(from.name) !== norm(into.name)) return "The names and dates of birth must match exactly";
  if (from.summary || from.decision || from.is_signed || from.roster_status || JSON.parse(from.tm_overrides || "[]").length || from.phys_confirmed) return "The new profile has staff edits; reconcile them first";
  for (const table of ["notes", "verdicts", "board_entries", "list_members", "agent_info", "cards", "maps", "ncaa_prospects", "ncaa_board", "ncaa_board_removed", "l2_prospects"]) {
    if (db.get(`SELECT 1 FROM ${table} WHERE player_id = ? LIMIT 1`, from.id)) return "The new profile has scouting records; reconcile them first";
  }
  return null;
}

export function mergeConnection(db, fromId, intoId, userId) {
  return db.tx(() => {
    const from = db.get("SELECT * FROM players WHERE id = ?", Number(fromId));
    const into = db.get("SELECT * FROM players WHERE id = ?", Number(intoId));
    const problem = connectionMergeProblem(db, from, into);
    if (problem) throw Object.assign(new Error(problem), { status: 409 });
    const profile = Object.fromEntries(Object.entries(from).filter(([, value]) => value != null && value !== "" && value !== "[]"));
    const fields = tmSyncFields({ ...into, tm_overrides: JSON.parse(into.tm_overrides) }, profile, from.tm_synced_at);
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
    // This profile came from SQLite, so its array fields are already serialized.
    if (!into.phys_confirmed) fields.phys_keys = JSON.stringify([...new Set([...JSON.parse(into.phys_keys), ...JSON.parse(from.phys_keys)])]);
    db.run("INSERT INTO player_redirects(id, player_id, snapshot) VALUES (?,?,?)", from.id, into.id, JSON.stringify({ from, into }));
    db.run("UPDATE player_redirects SET player_id = ? WHERE player_id = ?", into.id, from.id);
    db.run("UPDATE activity SET player_id = ? WHERE player_id = ?", into.id, from.id);
    db.run("DELETE FROM players WHERE id = ?", from.id);
    const cols = Object.keys(fields);
    db.run(`UPDATE players SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...Object.values(fields), into.id);
    db.run("INSERT INTO activity(user_id, player_id, action, detail) VALUES (?,?,?,?)", userId, into.id, "combined_profiles", JSON.stringify({ from_id: from.id }));
    return into.id;
  });
}
