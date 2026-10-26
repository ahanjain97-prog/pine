// USL League Two Top Prospects reports (one a year, 44-55 players picked into a Best XI, Second XI, ...).
// The reports are the league's, not ours to publish, so the list never lives in this public repository:
// scripts/l2-prospects.py reads the PDF and uploads it (PUT /api/worker/l2-prospects), and it's kept in the
// database. Each entry is matched to a PINE player (and to a college scouting profile) by name, using the
// same strictness as the college import plus the birth year the report gives.
import { matchName, nameIndex } from "./ncaa.js";

const TIERS = ["First", "Second", "Third", "Fourth", "Fifth"];
const STATUSES = ["domestic", "international"];
const text = (v, max = 120) => (v == null || v === "" ? null : String(v).trim().slice(0, max) || null);
const birthYear = (d) => Number((String(d || "").match(/\b(19|20)\d\d\b/) || [])[0]) || null;

// Checks one year's list and replaces what's stored for that year. Returns { players, linked }.
export function saveL2Report(db, input) {
  const year = Number(input?.year);
  if (!Number.isInteger(year) || year < 2015 || year > 2100) throw new Error("Expected a report year");
  if (!Array.isArray(input.players) || !input.players.length || input.players.length > 200) throw new Error("Expected 1-200 players");
  const rows = input.players.map((p) => {
    const name = text(p.name, 80);
    if (!name) throw new Error("Every player needs a name");
    const tier = TIERS.find((t) => t.toLowerCase() === String(p.tier || "").toLowerCase()) || null;
    const status = STATUSES.find((s) => String(p.status || "").toLowerCase().startsWith(s)) || null;
    const born = Number.isInteger(p.born) ? p.born : null;
    return { name, tier, status, born, club: text(p.club), position: text(p.position, 12), school: text(p.school), grad: text(p.grad, 20), hometown: text(p.hometown) };
  });
  db.tx(() => {
    db.run("DELETE FROM l2_prospects WHERE year = ?", year);
    for (const r of rows) {
      db.run(`INSERT OR REPLACE INTO l2_prospects(year, name, club, born, tier, position, status, school, grad, hometown)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, year, r.name, r.club, r.born, r.tier, r.position, r.status, r.school, r.grad, r.hometown);
    }
  });
  return { players: rows.length, linked: linkL2(db) };
}

// Matches report entries without a PINE player (or college profile) yet. Birth years more than a year apart
// rule a player out. Safe to run again; returns how many entries gained a PINE player.
export function linkL2(db) {
  const entries = db.all("SELECT year, name, born, player_id, prospect_key FROM l2_prospects WHERE player_id IS NULL OR prospect_key IS NULL");
  if (!entries.length) return 0;
  const players = db.all("SELECT id, name, league, birthdate FROM players");
  // Everyone in the college database is a college player, so short first names count there (Zach / Zachary).
  const prospects = nameIndex(db.all("SELECT key AS id, name, 'NCAA' AS league FROM ncaa_prospects"));
  let linked = 0;
  db.tx(() => {
    for (const e of entries) {
      if (e.player_id == null) {
        const fits = players.filter((p) => e.born == null || birthYear(p.birthdate) == null || Math.abs(birthYear(p.birthdate) - e.born) <= 1);
        const m = matchName(nameIndex(fits), e.name);
        if (m) { db.run("UPDATE l2_prospects SET player_id = ? WHERE year = ? AND name = ?", m.id, e.year, e.name); linked++; }
      }
      if (e.prospect_key == null) {
        const m = matchName(prospects, e.name);
        if (m) db.run("UPDATE l2_prospects SET prospect_key = ? WHERE year = ? AND name = ?", m.id, e.year, e.name);
      }
    }
  });
  return linked;
}
