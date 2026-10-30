// The NCAA section: the college scouting database (players, grades, reports and its position-ranked
// boards), imported from the college-soccer-scouting repository's data.json, plus the NCAA board.
//
// The NCAA board is one ranked list per pitch position. It starts from the college database's latest
// board, in its order, and also carries every Big Board player whose league names NCAA, so college
// players already being tracked appear without anyone re-adding them. After that the order is PINE's:
// staff drag to re-rank, and a later import only appends players who are new to the board. Earlier
// years' boards are kept as the college database ranked them (ncaa_year_boards), read-only.
//
// Big Board college players join the NCAA board automatically. The other way is staff's call: being on the
// Big Board is what marks a college player as a priority, so the NCAA board shows who is (BB) and offers a
// one-click add at the role their college scouting suggests (bigBoardRole).
//
// College players on that latest board become PINE players (league "NCAA") so they have a profile,
// notes, verdicts and agent details like everyone else. Prospects from earlier classes, many of them
// professionals now, keep their grades and reports here and link to an existing PINE player by name.
import { POSITIONS, ROLES } from "../roles.js";
import { compactRanks } from "./board.js";

export const COLLEGE_DATA_URL = process.env.PINE_COLLEGE_DATA_URL
  || "https://raw.githubusercontent.com/ahjain-cmd/college-soccer-scouting-2026/main/data.json";

// The college boards are keyed by shirt number; this is what each list holds (checked against the data).
export const BOARD_POSITION = { p2: "RB", p3: "RCB", p4: "LCB", p5: "LB", p6: "CDM", p7: "RW", p8: "CM", p9: "FWD", p10: "AM", p11: "LW" };
export const REPRESENTATION = ["unknown", "none", "advisor", "agent"];

// College scouting role (the latest report's) -> Big Board role in the same position. Anything else takes
// the position's first role.
const ROLE_HINTS = [
  [/target/i, { FWD: "FWD2" }],
  [/inverted winger/i, { LW: "LW2", RW: "RW2" }],
  [/wing ?back/i, { LB: "LB1", RB: "RB2" }],
  [/inverted full ?back|defensive full ?back/i, { LB: "LB2", RB: "RB1" }],
  [/ball[- ]playing/i, { LCB: "LCB1", RCB: "RCB2" }],
  [/leader of the line|athletic presence/i, { LCB: "LCB2", RCB: "RCB1" }],
  [/box[- ]to[- ]box|jack of all trades/i, { CM: "CM2" }],
];
export function bigBoardRole(position, collegeRole) {
  for (const [re, byPosition] of ROLE_HINTS) if (byPosition[position] && re.test(collegeRole || "")) return byPosition[position];
  return POSITIONS.find((p) => p.code === position)?.roles[0][0] || null;
}
const COUNTRY_NAMES = { USA: "United States", US: "United States", "U.S.": "United States", UK: "England" };

// Letters that aren't an accent on a base letter, so NFKD leaves them alone (Møller, Björnsson's ð cousins).
const LETTERS = { ø: "o", æ: "ae", ð: "d", þ: "th", ß: "ss", ł: "l", đ: "d", ı: "i", œ: "oe" };
export const normName = (s) => String(s || "").toLowerCase().replace(/[øæðþßłđıœ]/g, (c) => LETTERS[c]).normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/['’`.]/g, "").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

// Name matching between the college database and PINE, strictest first: the same name; the same first and
// last name (a middle name on one side: Úlfur Ágúst Björnsson); the same surname and first three letters of
// the first name (Matt/Matthew, Marten/Martin, Joschi/Josias) for players PINE has in the NCAA. A tier that
// finds two players stops the search: better no link than a guess.
export const nameTokens = (s) => normName(s).split(" ").filter(Boolean);
export const nameIndex = (players) => players.map((p) => ({ id: p.id, t: nameTokens(p.name), ncaa: /\bncaa\b/i.test(p.league || "") }))
  .filter((x) => x.t.length);
export function matchName(index, name) {
  const t = nameTokens(name);
  if (!t.length) return null;
  const first = t[0], last = t.at(-1), long = t.length > 1;
  const tiers = [
    (x) => x.t.join(" ") === t.join(" "),
    (x) => long && x.t.length > 1 && x.t[0] === first && x.t.at(-1) === last,
    (x) => long && x.ncaa && x.t.length > 1 && x.t.at(-1) === last && x.t[0].slice(0, 3) === first.slice(0, 3),
  ];
  for (const [i, tier] of tiers.entries()) {
    const hits = index.filter(tier);
    if (hits.length === 1) return { id: hits[0].id, exact: i === 0 };
    if (hits.length > 1) return null;
  }
  return null;
}

const authorOf = (body) => (String(body || "").match(/\(([A-Z]{2,3})\)\s*$/) || [])[1] || null;
const latestBoardYear = (data) => Object.keys(data.boards || {}).sort().at(-1) || null;

// A player's class in a given college season, worked out as the college scouting site does (classForYear there):
// a report from that season gives it (the senior-most if several; in the player's latest scouted season, their
// profile's class); otherwise their latest class moves up a year per season since (capped at Grad Student).
const CLASS_LADDER = ["Freshman", "Sophomore", "Junior", "Senior", "Grad Student"];
const RS_LADDER = ["R-Freshman", "R-Sophomore", "R-Junior", "R-Senior"];
const classRank = (c) => (CLASS_LADDER.includes(c) ? CLASS_LADDER.indexOf(c) : RS_LADDER.indexOf(c));
function advanceClass(cls, steps) {
  if (!cls || steps <= 0) return cls;
  for (const ladder of [CLASS_LADDER, RS_LADDER]) {
    const i = ladder.indexOf(cls);
    if (i >= 0) return ladder[Math.min(i + steps, ladder.length - 1)];
  }
  return cls; // 5th Year and anything unrecognised stay as they are
}
export function classForYear(prospect, reports, year) {
  const exact = reports.filter((r) => r.class && Number(r.year) === Number(year));
  if (exact.length) {
    if (Number(year) === Number(prospect.year) && prospect.class) return prospect.class;
    return exact.slice().sort((a, b) => classRank(b.class) - classRank(a.class))[0].class;
  }
  return advanceClass(prospect.class, Math.max(0, Number(year) - (Number(prospect.year) || Number(year))));
}
// Each prospect's reports' (year, class), by prospect key.
function reportClasses(db, keys) {
  const by = new Map(keys.map((k) => [k, []]));
  if (!keys.length) return by;
  for (const r of db.all(`SELECT prospect_key, year, class FROM ncaa_reports WHERE class IS NOT NULL
      AND prospect_key IN (${keys.map(() => "?").join(",")})`, ...keys)) by.get(r.prospect_key)?.push(r);
  return by;
}

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
  const index = nameIndex(db.all("SELECT id, name, league FROM players"));
  const linkedIds = new Set(db.all("SELECT player_id FROM ncaa_prospects WHERE player_id IS NOT NULL").map((r) => r.player_id));
  const stats = { prospects: 0, reports: 0, linked: 0, created: 0, boarded: 0, board_year: year ? Number(year) : null };
  const known = new Set(prospects.filter((x) => x?.key && x?.name).map((x) => x.key));

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

      db.run("DELETE FROM ncaa_reports WHERE prospect_key = ? AND origin = 'college_db'", x.key); // PINE's own reports stay
      for (const r of Array.isArray(x.reports) ? x.reports : []) {
        db.run(`INSERT INTO ncaa_reports(prospect_key, dates, match, team, source, grade, grade_present, grade_future,
            role_code, role_name, position, year, author, body, class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          x.key, JSON.stringify(r.dates || []), r.match ?? null, r.team ?? null, r.source ?? null, r.grade ?? null,
          r.grade_present ?? null, r.grade_future ?? null, r.role_code ?? null, r.role_name ?? null, r.position ?? null,
          Number.isFinite(r.year) ? r.year : null, authorOf(r.body), r.body ?? null, r.class ?? null);
        stats.reports++;
      }

      if (db.get("SELECT 1 FROM ncaa_reports WHERE prospect_key = ? AND origin = 'pine'", x.key)) recomputeProspect(db, x.key);
      let playerId = existing?.player_id ?? null;
      if (!playerId && !existing?.no_link) { // "Not this player" turns name matching off for this prospect
        // An exact name may join a player already linked (the college database lists some players twice);
        // a looser match may not.
        const m = matchName(index, x.name);
        if (m && (m.exact || !linkedIds.has(m.id))) { playerId = m.id; stats.linked++; }
      }
      if (!playerId && !existing?.no_link && onBoard.has(x.key)) {
        const country = x.country ? COUNTRY_NAMES[x.country] || x.country : null;
        playerId = insertPlayer({
          name: x.name, club: x.team || x.school || null, league: "NCAA", position: x.position_full || x.position || null,
          birthdate: x.dob || null, foot: x.foot ? String(x.foot).toLowerCase() : null, citizenship: country ? [country] : [],
        });
        index.push({ id: playerId, t: nameTokens(x.name), ncaa: true });
        stats.created++;
      }
      if (playerId) {
        linkedIds.add(playerId);
        db.run("UPDATE ncaa_prospects SET player_id = ? WHERE key = ?", playerId, x.key);
      }
    }
    // Every year's board as the college database ranks it.
    db.run("DELETE FROM ncaa_year_boards");
    for (const [y, lists] of Object.entries(data.boards || {})) {
      if (!/^\d{4}$/.test(y)) continue;
      for (const [list, keys] of Object.entries(lists || {})) {
        if (!BOARD_POSITION[list] || !Array.isArray(keys)) continue;
        keys.filter((k) => known.has(k)).forEach((k, i) => db.run(
          "INSERT OR IGNORE INTO ncaa_year_boards(year, position, rank, prospect_key) VALUES (?,?,?,?)", Number(y), BOARD_POSITION[list], i, k));
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

// Folds player `fromId` into `intoId`: notes, verdicts, roles, lists, cards, maps, agent details, history and
// college links move across (where `intoId` has none of its own), and `fromId` is deleted. On the NCAA board
// the college ranking wins: `intoId` takes `fromId`'s spot.
export function mergePlayer(db, fromId, intoId) {
  db.tx(() => {
    const spot = ncaaSpot(db, fromId);
    if (spot) {
      const old = ncaaSpot(db, intoId);
      db.run("DELETE FROM ncaa_board WHERE player_id = ?", intoId);
      if (old) compact(db, old.position);
      db.run("UPDATE ncaa_board SET player_id = ? WHERE player_id = ?", intoId, fromId);
    }
    for (const table of ["board_entries", "verdicts", "list_members", "agent_info", "ncaa_board_removed"]) {
      db.run(`UPDATE OR IGNORE ${table} SET player_id = ? WHERE player_id = ?`, intoId, fromId);
    }
    for (const table of ["notes", "cards", "maps", "activity", "ncaa_prospects"]) db.run(`UPDATE ${table} SET player_id = ? WHERE player_id = ?`, intoId, fromId);
    db.run(`UPDATE players SET birthdate = coalesce(birthdate, (SELECT birthdate FROM players WHERE id = ?)),
      foot = coalesce(foot, (SELECT foot FROM players WHERE id = ?)) WHERE id = ?`, fromId, fromId, intoId);
    // Preserve an explicit signing when an imported college duplicate is folded into the profile.
    db.run(`UPDATE players SET is_signed = 1,
      signed_by = (SELECT signed_by FROM players WHERE id = ?),
      signed_at = (SELECT signed_at FROM players WHERE id = ?)
      WHERE id = ? AND is_signed = 0 AND (SELECT is_signed FROM players WHERE id = ?) = 1`, fromId, fromId, intoId, fromId);
    db.run("DELETE FROM players WHERE id = ?", fromId);
  });
}

// Players the college import created who turn out to be someone PINE already had (see matchName), merged
// into that player. Returns [{from, into, name, into_name}].
export function mergeCollegeDuplicates(db) {
  const merged = [];
  const players = db.all("SELECT id, name, league, source FROM players ORDER BY id");
  const gone = new Set();
  for (const c of players.filter((p) => p.source === "college_import")) {
    const index = nameIndex(players.filter((p) => p.id !== c.id && !gone.has(p.id) && (p.source !== "college_import" || p.id < c.id)));
    const m = matchName(index, c.name);
    if (!m) continue;
    mergePlayer(db, c.id, m.id);
    gone.add(c.id);
    merged.push({ from: c.id, into: m.id, name: c.name, into_name: players.find((p) => p.id === m.id).name });
  }
  return merged;
}

// For one day every NCAA board player was also put on the Big Board. This takes the players the college import
// created back off (unless staff starred or moved them since), once: it drops the ncaa_bb_linked table that
// recorded the experiment. Returns how many players came off.
export function undoBigBoardAutoLink(db) {
  if (!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ncaa_bb_linked'")) return 0;
  const ids = db.all(`SELECT l.player_id FROM ncaa_bb_linked l JOIN players p ON p.id = l.player_id
    WHERE p.source = 'college_import'
      AND NOT EXISTS (SELECT 1 FROM board_entries b WHERE b.player_id = l.player_id AND b.shortlist = 1)
      AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.player_id = l.player_id AND a.user_id IS NOT NULL
        AND a.action IN ('added_role', 'moved_on_board', 'shortlisted', 'copied_on_board')
        AND coalesce(a.detail, '') NOT LIKE '%"via":"ncaa"%')`).map((r) => r.player_id);
  let removed = 0;
  db.tx(() => {
    const roles = new Set();
    for (const id of ids) {
      db.all("SELECT role FROM board_entries WHERE player_id = ?", id).forEach((r) => roles.add(r.role));
      if (db.run("DELETE FROM board_entries WHERE player_id = ?", id).changes) removed++;
    }
    roles.forEach((role) => compactRanks(db, role));
    db.run("DROP TABLE ncaa_bb_linked");
  });
  return removed;
}

export const ncaaYears = (db) => db.all("SELECT DISTINCT year FROM ncaa_year_boards ORDER BY year DESC").map((r) => r.year);

// An earlier year's board, as the college database ranked it: prospects (linked to PINE or not) by position.
export function ncaaYearBoard(db, year) {
  const board = {};
  const rows = db.all(`SELECT b.position, n.key, n.player_id, n.name, n.class, n.year, n.school, n.team, n.grade, n.status,
      (SELECT count(*) FROM ncaa_reports r WHERE r.prospect_key = n.key) AS reports, ${L2_JSON}
    FROM ncaa_year_boards b JOIN ncaa_prospects n ON n.key = b.prospect_key WHERE b.year = ? ORDER BY b.position, b.rank`, year);
  const classes = reportClasses(db, rows.map((r) => r.key));
  for (const r of rows) (board[r.position] ||= []).push({ ...parseL2(r), class_then: classForYear(r, classes.get(r.key), year) });
  return board;
}

// Players with no citizenship and no hand-set roster status, linked to a college profile that names a country:
// that country becomes their citizenship, so DOM / INTL shows. Transfermarkt's citizenship replaces it if
// they're linked there later. Returns how many were filled.
export function fillCitizenshipFromCollege(db) {
  const rows = db.all(`SELECT p.id, (SELECT n.country FROM ncaa_prospects n WHERE n.player_id = p.id AND n.country IS NOT NULL
      ORDER BY n.year DESC NULLS LAST LIMIT 1) AS country
    FROM players p WHERE coalesce(p.citizenship, '[]') = '[]' AND coalesce(p.roster_status, '') = ''`).filter((r) => r.country);
  db.tx(() => rows.forEach((r) => db.run("UPDATE players SET citizenship = ? WHERE id = ?", JSON.stringify([COUNTRY_NAMES[r.country] || r.country]), r.id)));
  return rows.length;
}

// Whether a school name in PINE ("LMU", "CS UC Santa Barbara", "Dayton") and a Transfermarkt college club
// ("Loyola Marymount Lions (Loyola Marymount Uni.)") are the same school: a shared distinctive word, or one
// side's short name is the other's initials.
const SCHOOL_STOP = new Set(["university", "college", "uni", "the", "and", "state", "saint", "san", "santa", "north", "south",
  "east", "west", "new", "city", "school", "tech", "institute", "club"]);
const initials = (s) => normName(s).split(" ").filter((w) => w && !["of", "the", "at", "and"].includes(w)).map((w) => w[0]).join("");
export function sameSchool(school, tmClub) {
  const words = (s) => normName(s).split(" ").filter((w) => w.length > 2 && !SCHOOL_STOP.has(w));
  const ours = normName(school).split(" ").filter(Boolean);
  const theirs = new Set(words(tmClub));
  if (words(school).some((w) => theirs.has(w))) return true;
  const inside = (String(tmClub).match(/\(([^)]*)\)/) || [])[1] || "";
  const forms = new Set([tmClub, inside, String(tmClub).replace(/\([^)]*\)/, "")].map(initials).filter((x) => x.length >= 2));
  return ours.some((w) => w.length >= 2 && w.length <= 5 && forms.has(w));
}

// Which Transfermarkt search result is this college player, if any can be said for sure: exactly one result with
// the same surname at a college club that is one of the player's schools (their PINE club, or their college
// profile's school). Surname rather than full name, so Calle / Carl Möllerberg still match. Returns it or null.
export function pickCollegeTmMatch(player, results, { isCollege }) {
  const t = nameTokens(player.name);
  const schools = (player.schools || []).filter(Boolean);
  if (!t.length || !schools.length) return null;
  const hits = results.filter((r) => {
    if (!isCollege(r.club) || !schools.some((s) => sameSchool(s, r.club))) return false;
    return nameTokens(r.name).at(-1) === t.at(-1);
  });
  return hits.length === 1 ? hits[0] : null;
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
      FROM ncaa_prospects n WHERE n.player_id IS NOT NULL ORDER BY n.year NULLS FIRST`)) info[r.player_id] = r; // latest profile wins
  const liveYear = ncaaYears(db)[0] ?? null;
  const classes = reportClasses(db, Object.values(info).map((r) => r.key));
  for (const r of Object.values(info)) r.class_now = liveYear ? classForYear(r, classes.get(r.key), liveYear) : r.class;
  const agents = Object.fromEntries(db.all("SELECT player_id, representation, agent, agency FROM agent_info").map((a) => [a.player_id, a]));
  // The Big Board role each board player would get from "+ BB": their latest college role, in this position.
  const collegeRole = new Map(db.all(`SELECT n.player_id, (SELECT r.role_name FROM ncaa_reports r JOIN ncaa_prospects m ON m.key = r.prospect_key
      WHERE m.player_id = n.player_id AND r.role_name IS NOT NULL ORDER BY r.year DESC, r.id DESC LIMIT 1) AS role_name FROM ncaa_board n`)
    .map((r) => [r.player_id, r.role_name]));
  const bb_role = {};
  for (const [position, ids] of Object.entries(board)) for (const id of ids) bb_role[id] = bigBoardRole(position, collegeRole.get(id));
  return { board, info, agents, bb_role, ...ncaaSummary(db) };
}

export function ncaaSummary(db) {
  const last = db.get("SELECT max(imported_at) AS at, count(*) AS n FROM ncaa_prospects");
  const years = ncaaYears(db);
  return { imported_at: last.at, prospects: last.n, reports: db.get("SELECT count(*) AS n FROM ncaa_reports").n,
    years, live_year: years[0] ?? null };
}

// Which year boards a prospect is on: {"2025": {position, rank}}.
const BOARDS_JSON = `(SELECT json_group_object(CAST(b.year AS TEXT), json_object('position', b.position, 'rank', b.rank))
  FROM ncaa_year_boards b WHERE b.prospect_key = n.key) AS boards`;
// USL League Two Top Prospects picks for a prospect (by their college profile, or the PINE player it's linked to).
const L2_JSON = `(SELECT json_group_array(json_object('year', l.year, 'tier', l.tier, 'position', l.position, 'club', l.club))
  FROM l2_prospects l WHERE l.prospect_key = n.key OR (n.player_id IS NOT NULL AND l.player_id = n.player_id)) AS l2`;
const parseL2 = (r) => ({ ...r, l2: JSON.parse(r.l2 || "[]").sort((a, b) => b.year - a.year) });
const withBoards = (r) => parseL2({ ...r, years: JSON.parse(r.years || "[]"), boards: JSON.parse(r.boards || "{}") });

// The college database as a table: every prospect, linked or not.
export function ncaaProspects(db) {
  const rows = db.all(`SELECT n.key, n.player_id, n.name, n.team, n.school, n.class, n.position, n.grade, n.grade_val, n.year, n.years,
      n.status, n.country, (SELECT count(*) FROM ncaa_reports r WHERE r.prospect_key = n.key) AS reports, ${BOARDS_JSON}, ${L2_JSON}
    FROM ncaa_prospects n ORDER BY n.grade_val DESC NULLS LAST, n.name`).map(withBoards);
  const years = ncaaYears(db);
  const classes = reportClasses(db, rows.map((r) => r.key));
  for (const r of rows) r.classes = Object.fromEntries(years.map((y) => [y, classForYear(r, classes.get(r.key), y)]));
  return rows;
}

export function prospectDetail(db, { key = null, playerId = null }) {
  const rows = (key ? db.all(`SELECT n.*, ${BOARDS_JSON} FROM ncaa_prospects n WHERE n.key = ?`, key)
    : db.all(`SELECT n.*, ${BOARDS_JSON} FROM ncaa_prospects n WHERE n.player_id = ? ORDER BY n.year DESC NULLS LAST, n.key`, playerId)).map(withBoards);
  if (!rows.length) return null;
  const p = rows[0]; // the most recently scouted profile; its grade and facts lead
  p.positions = JSON.parse(p.positions || "[]");
  p.boards = Object.assign({}, ...rows.slice(1).reverse().map((r) => r.boards), p.boards);
  p.reports = db.all(`SELECT * FROM ncaa_reports WHERE prospect_key IN (${rows.map(() => "?").join(",")}) ORDER BY year DESC, id`, ...rows.map((r) => r.key))
    .map((r) => ({ ...r, dates: JSON.parse(r.dates || "[]") }));
  p.class_year = ncaaYears(db)[0] ?? null;
  p.class_now = p.class_year ? classForYear(p, p.reports.filter((r) => r.prospect_key === p.key), p.class_year) : p.class;
  return p;
}

/* ---------- college reports written in PINE ---------- */
// Grades, worst to best, as the college scouting site ranks them; a grade's value is its place here.
export const GRADE_SCALE = ["D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "A++", "A+++"];
const gradeVal = (g) => (GRADE_SCALE.includes(g) ? GRADE_SCALE.indexOf(g) : null);
export const CLASSES = [...CLASS_LADDER, ...RS_LADDER, "5th Year"];
export const REPORT_SOURCES = ["Live", "Stream", "Video", "Wyscout"];

// A profile's grade is its best report's by future grade (the first if tied), exactly as the college site
// works it out, so PINE's reports count the same as imported ones. A profile made in PINE also takes its class
// and season from its latest report.
function recomputeProspect(db, key) {
  const reports = db.all("SELECT grade, grade_present, grade_future, year, class FROM ncaa_reports WHERE prospect_key = ? ORDER BY year, id", key);
  let best = null;
  for (const r of reports) if (gradeVal(r.grade_future) != null && (!best || gradeVal(r.grade_future) > gradeVal(best.grade_future))) best = r;
  db.run("UPDATE ncaa_prospects SET grade = ?, grade_present = ?, grade_future = ?, grade_val = ? WHERE key = ?",
    best?.grade ?? null, best?.grade_present ?? null, best?.grade_future ?? null, best ? gradeVal(best.grade_future) : null, key);
  if (db.get("SELECT origin FROM ncaa_prospects WHERE key = ?", key)?.origin !== "pine") return;
  const dated = reports.filter((r) => r.year);
  db.run("UPDATE ncaa_prospects SET year = ?, class = coalesce(?, class), years = ? WHERE key = ?", dated.at(-1)?.year ?? null,
    dated.at(-1)?.class ?? null, JSON.stringify([...new Set(dated.map((r) => r.year))]), key);
}

// Checks a report from the form: grade current/future on the scale, a known class and source, a date.
function reportFields(body) {
  const str = (v, max = 4000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const present = str(body.grade_present, 4), future = str(body.grade_future, 4) || present;
  for (const g of [present, future]) if (g && !GRADE_SCALE.includes(g)) throw new Error(`Unknown grade ${g}`);
  if (future && !present) throw new Error("Give the current grade too");
  const cls = str(body.class, 20);
  if (cls && !CLASSES.includes(cls)) throw new Error(`Unknown class ${cls}`);
  const source = str(body.source, 20);
  if (source && !REPORT_SOURCES.includes(source)) throw new Error(`Unknown source ${source}`);
  const date = str(body.date, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("The report date must be a date");
  const text = str(body.body);
  if (!present && !text) throw new Error("Add a grade or a written report");
  const [y, m, dd] = (date || "").split("-");
  return {
    grade: present ? `${present}/${future}` : null, grade_present: present, grade_future: future,
    class: cls, source, dates: JSON.stringify(date ? [`${m}/${dd}/${y}`] : []), year: date ? Number(y) : new Date().getFullYear(),
    match: str(body.match, 200), position: str(body.position, 20), role_name: str(body.role_name, 60), body: text,
  };
}

// Adds a report written in PINE to a player's college profile, making the profile (origin 'pine') if they have
// none: name, school (given, or their club without the bracketed school), position and country from PINE.
export function addCollegeReport(db, player, body, user) {
  const f = reportFields(body);
  return db.tx(() => {
    let key = db.get("SELECT key FROM ncaa_prospects WHERE player_id = ? ORDER BY origin = 'pine' DESC, year DESC LIMIT 1", player.id)?.key;
    const school = typeof body.school === "string" && body.school.trim() ? body.school.trim().slice(0, 120)
      : player.club ? player.club.replace(/\s*\([^)]*\)\s*$/, "") : null;
    if (!key) {
      key = `pine-${player.id}`;
      db.run(`INSERT INTO ncaa_prospects(key, player_id, name, team, school, class, position, positions, foot, country, intl, years, year, origin)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]',?, 'pine')`,
        key, player.id, player.name, school, school, f.class, f.position || player.position || null, JSON.stringify(f.position ? [f.position] : []),
        player.foot ? cap(player.foot) : null, player.citizenship?.[0] || null,
        player.roster_status ? (player.roster_status === "international" ? 1 : 0) : null, f.year);
    } else if (typeof body.school === "string" && body.school.trim() && db.get("SELECT origin FROM ncaa_prospects WHERE key = ?", key).origin === "pine") {
      db.run("UPDATE ncaa_prospects SET school = ?, team = ? WHERE key = ?", school, school, key);
    }
    const id = Number(db.run(`INSERT INTO ncaa_reports(prospect_key, dates, match, team, source, grade, grade_present, grade_future, role_name,
        position, year, author, body, class, origin, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pine', ?, datetime('now'))`,
      key, f.dates, f.match, school, f.source, f.grade, f.grade_present, f.grade_future, f.role_name, f.position, f.year, user.name, f.body,
      f.class, user.id).lastInsertRowid);
    recomputeProspect(db, key);
    return id;
  });
}
const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : s);

// PINE reports only (imported ones belong to the college database), by their author or an admin.
function ownReport(db, id, user) {
  const r = db.get("SELECT * FROM ncaa_reports WHERE id = ?", id);
  if (!r) throw Object.assign(new Error("Report not found"), { status: 404 });
  if (r.origin !== "pine") throw Object.assign(new Error("Reports from the college database are edited there"), { status: 403 });
  if (r.created_by !== user.id && !user.is_admin) throw Object.assign(new Error("Only its author or an admin can change this report"), { status: 403 });
  return r;
}
export function updateCollegeReport(db, id, body, user) {
  const r = ownReport(db, id, user);
  const f = reportFields(body);
  db.tx(() => {
    db.run(`UPDATE ncaa_reports SET dates = ?, match = ?, source = ?, grade = ?, grade_present = ?, grade_future = ?, role_name = ?,
        position = ?, year = ?, body = ?, class = ? WHERE id = ?`,
      f.dates, f.match, f.source, f.grade, f.grade_present, f.grade_future, f.role_name, f.position, f.year, f.body, f.class, id);
    recomputeProspect(db, r.prospect_key);
  });
  return r.prospect_key;
}
export function deleteCollegeReport(db, id, user) {
  const r = ownReport(db, id, user);
  db.tx(() => {
    db.run("DELETE FROM ncaa_reports WHERE id = ?", id);
    const left = db.get("SELECT count(*) AS n FROM ncaa_reports WHERE prospect_key = ?", r.prospect_key).n;
    if (!left && db.get("SELECT origin FROM ncaa_prospects WHERE key = ?", r.prospect_key)?.origin === "pine") {
      db.run("DELETE FROM ncaa_prospects WHERE key = ?", r.prospect_key); // a PINE profile is only its reports
    } else recomputeProspect(db, r.prospect_key);
  });
  return r.prospect_key;
}

// Every prospect on the latest college board gets a PINE player at import, so one without a player (and not
// unlinked by staff) is someone staff deleted. Keep later imports from bringing them back. Returns how many.
export function dismissDeletedCollegePlayers(db) {
  return db.run(`UPDATE ncaa_prospects SET no_link = 1 WHERE player_id IS NULL AND no_link = 0
    AND key IN (SELECT prospect_key FROM ncaa_year_boards WHERE year = (SELECT max(year) FROM ncaa_year_boards))`).changes;
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
