import { logActivity } from "../db.js";

// Signing is an explicit staff action, independent of scouting decisions and club metadata.
export function setSigned(db, playerId, signed, userId) {
  if (typeof signed !== "boolean") throw Object.assign(new Error("Signed must be true or false"), { status: 400 });
  return db.tx(() => {
    const p = db.get("SELECT is_signed FROM players WHERE id = ?", playerId);
    if (!p) throw Object.assign(new Error("Player not found"), { status: 404 });
    if (Boolean(p.is_signed) === signed) return signed;
    db.run(`UPDATE players SET is_signed = ?, signed_by = ?, signed_at = ?, updated_at = datetime('now') WHERE id = ?`,
      Number(signed), signed ? userId : null, signed ? new Date().toISOString() : null, playerId);
    logActivity(db, userId, playerId, "set_signed", { signed, previous: Boolean(p.is_signed) });
    return signed;
  });
}

export function registerSigning(app, { db, getPlayer }) {
  app.put("/api/players/:id/signing", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const p = getPlayer(c.req.param("id"));
    const body = await c.req.json();
    const signed = setSigned(db, p.id, body?.signed, user.id);
    return c.json({ signed });
  });
}
