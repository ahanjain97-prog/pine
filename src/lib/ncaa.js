// The NCAA section: the college scouting database (players, grades, reports and its position-ranked
// boards), imported from the college-soccer-scouting repository's data.json, plus the NCAA board.
//
// The NCAA board is one ranked list per pitch position. It starts from the college database's latest
// board, in its order, and also carries every Big Board player whose league names NCAA, so college
// players already being tracked appear without anyone re-adding them. After that the order is PINE's:
// staff drag to re-rank, and a later import only appends players who are new to the board.
//
// College players on that latest board become PINE players (league "NCAA") so they have a profile,
// notes, verdicts and agent details like everyone else. Prospects from earlier classes, many of them
// professionals now, keep their grades and reports here and link to an existing PINE player by name.
import { ROLES } from "../roles.js";

export const COLLEGE_DATA_URL = process.env.PINE_COLLEGE_DATA_URL
  || "https://raw.githubusercontent.com/ahjain-cmd/college-soccer-scouting-2026/main/data.json";

// The college boards are keyed by shirt number; this is what each list holds (checked against the data).
export const BOARD_POSITION = { p2: "RB", p3: "RCB", p4: "LCB", p5: "LB", p6: "CDM", p7: "RW", p8: "CM", p9: "FWD", p10: "AM", p11: "LW" };
export const REPRESENTATION = ["unknown", "none", "advisor", "agent"];
const COUNTRY_NAMES = { USA: "United States", US: "United States", "U.S.": "United States", UK: "England" };

export const normName = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/['’`.]/g, "").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

const authorOf = (body) => (String(body || "").match(/\(([A-Z]{2,3})\)\s*$/) || [])[1] || null;
const latestBoardYear = (data) => Object.keys(data.boards || {}).sort().at(-1) || null;

// Rewrites one position's ranks with `playerId` at `index` (0-based) among the others.
function placeAt(db, playerId, position, index) {
  const ids = db.all("SELECT player_id FROM ncaa_board WHERE position = ? AND player_id <> ? ORDER BY rank", position, playerId)
    .map((r) => r.player_id);
  ids.splice(Math.max(0, Math.min(Number.isInteger(index) ? index : ids.length, ids.length)), 0, playerId);
  db.run("DELETE FROM ncaa_board WHERE player_id = ?", playerId);
  ids.forEach((id, i) => db.run(
    "INSERT INTO ncaa_board(player_id, position, rank) VALUES (?,?,?) ON CONFLICT(player_id) DO UPDATE SET position = excluded.position, rank = excluded.rank",
    id, position, i));
}

function compact(db, position) {
  db.all("SELECT player_id FROM ncaa_board WHERE position = ? ORDER BY rank", position)
    .forEach((r, i) => db.run("UPDATE ncaa_board SET rank = ? WHERE player_id = ?", i, r.player_id));
}

// Automatic adds (import, Big Board sync) skip anyone staff took off the board.
const append = (db, playerId, position) => {
  if (db.get("SELECT 1 FROM ncaa_board WHERE player_id = ?", playerId)) return false;
  if (db.get("SELECT 1 FROM ncaa_board_removed WHERE player_id = ?", playerId)) return false;
  const next = db.get("SELECT coalesce(max(rank), -1) + 1 AS n FROM ncaa_board WHERE position = ?", position).n;
  db.run("INSERT INTO ncaa_board(player_id, position, rank) VALUES (?,?,?)", playerId, position, next);
  return true;
};

// 0-based place on the NCAA board, or null.
export function ncaaSpot(db, playerId) {
  const r = db.get(`SELECT b.position, (SELECT count(*) FROM ncaa_board o WHERE o.position = b.position AND o.rank < b.rank) AS spot
    FROM ncaa_board b WHERE b.player_id = ?`, playerId);
  return r ? { position: r.position, spot: r.spot } : null;
}

export function moveOnNcaaBoard(db, playerId, position, index) {
  const before = ncaaSpot(db, playerId);
  db.tx(() => {
    db.run("DELETE FROM ncaa_board_removed WHERE player_id = ?", playerId);
    placeAt(db, playerId, position, index);
    if (before && before.position !== position) compact(db, before.position);
  });
  return { before, after: ncaaSpot(db, playerId) };
}

export function removeFromNcaaBoard(db, playerId) {
  const before = ncaaSpot(db, playerId);
  if (!before) return null;
  db.tx(() => {
    db.run("DELETE FROM ncaa_board WHERE player_id = ?", playerId);
    db.run("INSERT OR REPLACE INTO ncaa_board_removed(player_id) VALUES (?)", playerId);
    compact(db, before.position);
  });
  return before;
}

// Big Board players whose league names NCAA join the NCAA board at the end of their position (their
// best-ranked big-board role decides which), unless staff took them off it. Returns how many were added.
export function syncBigBoardNcaa(db) {
  const rows = db.all(`SELECT p.id, p.league, b.role, b.rank FROM players p JOIN board_entries b ON b.player_id = p.id
    WHERE p.league LIKE '%ncaa%' AND NOT EXISTS (SELECT 1 FROM ncaa_board n WHERE n.player_id = p.id)
    ORDER BY b.rank, p.name`);
  let added = 0;
  const seen = new Set();
  db.tx(() => {
    for (const r of rows) {
      // LIKE finds candidates; the word match keeps out leagues that merely contain the letters.
      if (seen.has(r.id) || !/\bncaa\b/i.test(r.league || "")) continue;
      seen.add(r.id);
      const position = ROLES[r.role]?.position;
      if (position && append(db, r.id, position)) added++;
    }
  });
  return added;
}

// Imports (or refreshes) the college database. `insertPlayer(fields)` creates a PINE player and returns
// its id. Safe to run again: prospects and reports are refreshed, links and board order are kept.
export function importCollege(db, data, { insertPlayer }) {
  const prospects = Array.isArray(data?.players) ? data.players : null;
  if (!prospects?.length) throw new Error("The college data has no players");
  const year = latestBoardYear(data);
  const board = year ? data.boards[year] : {};
  const onBoard = new Map(); // key -> PINE position, in board order
  for (const [list, keys] of Object.entries(board || {})) {
    if (!BOARD_POSITION[list] || !Array.isArray(keys)) continue;
    for (const k of keys) if (!onBoard.has(k)) onBoard.set(k, BOARD_POSITION[list]);
  }
  const byName = new Map();
  for (const p of db.all("SELECT id, name FROM players")) {
    const k = normName(p.name);
    byName.set(k, byName.has(k) ? null : p.id); // two PINE players with one name: don't guess
  }
  const linkedIds = new Set(db.all("SELECT player_id FROM ncaa_prospects WHERE player_id IS NOT NULL").map((r) => r.player_id));
  const stats = { prospects: 0, reports: 0, linked: 0, created: 0, boarded: 0, board_year: year ? Number(year) : null };

  db.tx(() => {
    for (const x of prospects) {
      if (!x?.key || !x?.name) continue;
      const existing = db.get("SELECT player_id, no_link FROM ncaa_prospects WHERE key = ?", x.key);
      db.run(`INSERT INTO ncaa_prospects(key, name, team, school, class, position, positions, foot, country, intl, dob,
          grade, grade_present, grade_future, grade_val, years, year, status, category, imported_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET name = excluded.name, team = excluded.team, school = excluded.school,
          class = excluded.class, position = excluded.position, positions = excluded.positions, foot = excluded.foot,
          country = excluded.country, intl = excluded.intl, dob = excluded.dob, grade = excluded.grade,
          grade_present = excluded.grade_present, grade_future = excluded.grade_future, grade_val = excluded.grade_val,
          years = excluded.years, year = excluded.year, status = excluded.status, category = excluded.category,
          imported_at = excluded.imported_at`,
        x.key, x.name, x.team ?? null, x.school ?? null, x.class ?? null, x.position ?? null, JSON.stringify(x.positions || []),
        x.foot ?? null, x.country ?? null, x.intl == null ? null : x.intl ? 1 : 0, x.dob ?? null,
        x.grade ?? null, x.grade_present ?? null, x.grade_future ?? null, Number.isFinite(x.grade_val) ? x.grade_val : null,
        JSON.stringify(x.years || []), Number.isFinite(x.year) ? x.year : null, x.status ?? null, x.category ?? null);
      stats.prospects++;

      db.run("DELETE FROM ncaa_reports WHERE prospect_key = ?", x.key);
      for (const r of Array.isArray(x.reports) ? x.reports : []) {
        db.run(`INSERT INTO ncaa_reports(prospect_key, dates, match, team, source, grade, grade_present, grade_future,
            role_code, role_name, position, year, author, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          x.key, JSON.stringify(r.dates || []), r.match ?? null, r.team ?? null, r.source ?? null, r.grade ?? null,
          r.grade_present ?? null, r.grade_future ?? null, r.role_code ?? null, r.role_name ?? null, r.position ?? null,
          Number.isFinite(r.year) ? r.year : null, authorOf(r.body), r.body ?? null);
        stats.reports++;
      }

      let playerId = existing?.player_id ?? null;
      if (!playerId && !existing?.no_link) { // "Not this player" turns name matching off for this prospect
        const match = byName.get(normName(x.name));
        if (match && !linkedIds.has(match)) { playerId = match; stats.linked++; }
      }
      if (!playerId && !existing?.no_link && onBoard.has(x.key)) {
        const country = x.country ? COUNTRY_NAMES[x.country] || x.country : null;
        playerId = insertPlayer({
          name: x.name, club: x.team || x.school || null, league: "NCAA", position: x.position_full || x.position || null,
          birthdate: x.dob || null, foot: x.foot ? String(x.foot).toLowerCase() : null, citizenship: country ? [country] : [],
        });
        stats.created++;
      }
      if (playerId) {
        linkedIds.add(playerId);
        db.run("UPDATE ncaa_prospects SET player_id = ? WHERE key = ?", playerId, x.key);
      }
    }
    // The latest college board, in its order, for anyone not already on the NCAA board.
    for (const [key, position] of onBoard) {
      const pid = db.get("SELECT player_id FROM ncaa_prospects WHERE key = ?", key)?.player_id;
      if (pid && append(db, pid, position)) stats.boarded++;
    }
  });
  stats.boarded += syncBigBoardNcaa(db);
  return stats;
}

export async function fetchCollegeData(url = COLLEGE_DATA_URL) {
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) throw new Error(`College data download failed (${res.status})`);
  return res.json();
}

// Everything the NCAA page draws: board order, and per player the college grade, class and agent status.
export function ncaaBoardView(db) {
  syncBigBoardNcaa(db);
  const board = {};
  for (const r of db.all("SELECT player_id, position FROM ncaa_board ORDER BY position, rank")) (board[r.position] ||= []).push(r.player_id);
  const info = {};
  for (const r of db.all(`SELECT n.player_id, n.key, n.grade, n.grade_present, n.grade_future, n.grade_val, n.class, n.school,
      n.team, n.year, (SELECT count(*) FROM ncaa_reports r WHERE r.prospect_key = n.key) AS reports
      FROM ncaa_prospects n WHERE n.player_id IS NOT NULL`)) info[r.player_id] = r;
  const agents = Object.fromEntries(db.all("SELECT player_id, representation, agent, agency FROM agent_info").map((a) => [a.player_id, a]));
  const last = db.get("SELECT max(imported_at) AS at, count(*) AS n FROM ncaa_prospects");
  return { board, info, agents, imported_at: last.at, prospects: last.n, board_year: db.get("SELECT max(year) AS y FROM ncaa_prospects").y };
}

// The college database as a table: every prospect, linked or not.
export function ncaaProspects(db) {
  return db.all(`SELECT n.key, n.player_id, n.name, n.team, n.school, n.class, n.position, n.grade, n.grade_val, n.year,
      n.status, n.country, (SELECT count(*) FROM ncaa_reports r WHERE r.prospect_key = n.key) AS reports
    FROM ncaa_prospects n ORDER BY n.grade_val DESC NULLS LAST, n.name`);
}

export function prospectDetail(db, { key = null, playerId = null }) {
  const p = key ? db.get("SELECT * FROM ncaa_prospects WHERE key = ?", key)
    : db.get("SELECT * FROM ncaa_prospects WHERE player_id = ? ORDER BY year DESC LIMIT 1", playerId);
  if (!p) return null;
  p.positions = JSON.parse(p.positions || "[]");
  p.years = JSON.parse(p.years || "[]");
  p.reports = db.all("SELECT * FROM ncaa_reports WHERE prospect_key = ? ORDER BY year DESC, id", p.key)
    .map((r) => ({ ...r, dates: JSON.parse(r.dates || "[]") }));
  return p;
}

// Staff say a name-matched prospect isn't this player: unlink it and keep later imports from relinking it.
export function unlinkProspect(db, key) {
  return db.run("UPDATE ncaa_prospects SET player_id = NULL, no_link = 1 WHERE key = ?", key).changes > 0;
}

export function getAgent(db, playerId) {
  return db.get(`SELECT a.*, u.name AS updated_by_name FROM agent_info a LEFT JOIN users u ON u.id = a.updated_by
    WHERE a.player_id = ?`, playerId) || null;
}

const AGENT_FIELDS = ["representation", "agent", "agency", "email", "phone", "last_contact", "notes"];
export function saveAgent(db, playerId, body, userId) {
  const v = Object.fromEntries(AGENT_FIELDS.map((k) => [k, typeof body?.[k] === "string" ? body[k].trim() || null : null]));
  if (v.representation && !REPRESENTATION.includes(v.representation)) throw new Error("Unknown representation status");
  if (v.last_contact && !/^\d{4}-\d{2}-\d{2}$/.test(v.last_contact)) throw new Error("Last contact must be a date");
  db.run(`INSERT INTO agent_info(player_id, ${AGENT_FIELDS.join(", ")}, updated_by, updated_at)
      VALUES (?, ${AGENT_FIELDS.map(() => "?").join(", ")}, ?, datetime('now'))
    ON CONFLICT(player_id) DO UPDATE SET ${AGENT_FIELDS.map((k) => `${k} = excluded.${k}`).join(", ")},
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    playerId, ...AGENT_FIELDS.map((k) => v[k]), userId);
  return getAgent(db, playerId);
}
