import { logActivity } from "../db.js";
import { POSITIONS, ROLES, suggestPosition } from "../roles.js";

const CODES = new Set(POSITIONS.map((p) => p.code));

// Where a signed player sits on the Roster page: the position staff chose for them, else the position of
// their first Big Board role, else a guess from their Transfermarkt position and foot. Null if none fits.
export function rosterSpot(p) {
  if (!p?.is_signed) return null;
  if (p.roster_position && CODES.has(p.roster_position)) return p.roster_position;
  const role = (p.roles || []).map((r) => ROLES[r.role]).find(Boolean);
  return role?.position || suggestPosition(p.position, p.foot);
}

// Staff pin a signed player to a roster position; null hands the choice back to rosterSpot's fallbacks.
export function setRosterPosition(db, playerId, position, userId) {
  if (position !== null && !CODES.has(position)) throw Object.assign(new Error("Unknown roster position"), { status: 400 });
  return db.tx(() => {
    const p = db.get("SELECT is_signed, roster_position FROM players WHERE id = ?", playerId);
    if (!p) throw Object.assign(new Error("Player not found"), { status: 404 });
    if (!p.is_signed) throw Object.assign(new Error("Only signed players are on the roster"), { status: 400 });
    if ((p.roster_position ?? null) === position) return position;
    db.run("UPDATE players SET roster_position = ?, updated_at = datetime('now') WHERE id = ?", position, playerId);
    logActivity(db, userId, playerId, "set_roster_position", { position, previous: p.roster_position ?? null });
    return position;
  });
}

export function registerRoster(app, { db, getPlayer }) {
  app.put("/api/players/:id/roster-position", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const p = getPlayer(c.req.param("id"));
    const body = await c.req.json();
    const position = setRosterPosition(db, p.id, body?.position ?? null, user.id);
    return c.json({ position });
  });
}
