// A read-only view for the match-prep worker. Keep staff evaluations and account data private.
import { tokenMatches } from "../auth.js";

export function scoutingContext(db, now = new Date()) {
  const players = db.all(`SELECT id, name, birthdate, impect_id, tm_id, club
    FROM players ORDER BY id`).map((p) => ({
    ...p,
    roles: db.all("SELECT role, shortlist FROM board_entries WHERE player_id = ? ORDER BY role", p.id)
      .map((r) => ({ role: r.role, shortlist: Boolean(r.shortlist) })),
    lists: db.all(`SELECT l.name, l.source, l.external_id FROM lists l
      JOIN list_members m ON m.list_id = l.id WHERE m.player_id = ? ORDER BY l.name`, p.id),
  }));
  return { schema_version: 1, checked_at: now.toISOString(), players };
}

export function registerScoutingContext(app, { db, token }) {
  app.get("/api/worker/scouting-context", (c) => {
    if (!tokenMatches(c.req.header("X-PINE-Worker-Token"), token)) {
      return c.json({ error: "Worker token missing or wrong" }, 401);
    }
    c.header("Cache-Control", "no-store");
    return c.json(scoutingContext(db));
  });
}
