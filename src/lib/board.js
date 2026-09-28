// The big board: which players hold which role, in what order, and which of them are top targets
// (the Short Board is this board filtered to those). Ranks are 0-based within a role.
//
// Reordering rewrites a role's rows, so every one of these carries `shortlist` across. Losing it
// would quietly empty the Short Board whenever somebody dragged a card.

export function addRole(db, playerId, role) {
  const max = db.get("SELECT coalesce(max(rank), -1) AS m FROM board_entries WHERE role = ?", role).m;
  db.run("INSERT OR IGNORE INTO board_entries(player_id, role, rank) VALUES (?,?,?)", playerId, role, max + 1);
}

// 0-based position of a player within a role (ranks can have gaps), or null if they aren't in it.
export function spotIn(db, playerId, role) {
  const r = db.get(
    "SELECT (SELECT count(*) FROM board_entries o WHERE o.role = b.role AND o.rank < b.rank) AS spot FROM board_entries b WHERE b.player_id = ? AND b.role = ?",
    playerId, role);
  return r ? r.spot : null;
}

export function compactRanks(db, role) {
  db.all("SELECT player_id FROM board_entries WHERE role = ? ORDER BY rank", role)
    .forEach((r, i) => db.run("UPDATE board_entries SET rank = ? WHERE player_id = ? AND role = ?", i, r.player_id, role));
}

// Puts a player at `index` within `toRole`, moving them off `fromRole` when that differs. A player
// carries their top-target flag from one role to the other.
export function moveOnBoard(db, playerId, fromRole, toRole, index) {
  db.tx(() => {
    const flags = new Map(db.all("SELECT player_id, shortlist FROM board_entries WHERE role = ?", toRole)
      .map((r) => [r.player_id, r.shortlist]));
    if (fromRole && fromRole !== toRole) {
      const old = db.get("SELECT shortlist FROM board_entries WHERE player_id = ? AND role = ?", playerId, fromRole);
      if (old) flags.set(playerId, old.shortlist);
      db.run("DELETE FROM board_entries WHERE player_id = ? AND role = ?", playerId, fromRole);
    }
    const ids = db.all("SELECT player_id FROM board_entries WHERE role = ? AND player_id <> ? ORDER BY rank", toRole, playerId)
      .map((r) => r.player_id);
    ids.splice(Math.max(0, Math.min(Number(index) || 0, ids.length)), 0, playerId);
    db.run("DELETE FROM board_entries WHERE role = ?", toRole);
    ids.forEach((pid, i) =>
      db.run("INSERT INTO board_entries(player_id, role, rank, shortlist) VALUES (?,?,?,?)", pid, toRole, i, flags.get(pid) ?? 0));
  });
  return spotIn(db, playerId, toRole);
}
