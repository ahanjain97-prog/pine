// Every end-of-season roster decision the clubs announced (options picked up or declined, players out of contract,
// under contract, re-signed, in talks) and the releases they came in, for the Options tab. Like the free agents
// (src/lib/free_agents.js) the list comes from the clubs' own releases and never lives in this public repository:
// scripts/free-agents.mjs uploads the research CSV's rows alongside the free agents, and the option watcher
// (src/lib/option_watch.js) records each release it spots on a club's news page, so PINE can say a club has posted
// before anyone has coded its players.
import { entriesFromDecisions, clubsAgree } from "./free_agents.js";
import { matchName, nameIndex } from "./ncaa.js";
import { findClub, OPTION_CLUBS } from "./option_clubs.js";

export const DECISION_CODES = ["option_declined", "out_of_contract", "option_exercised", "guaranteed_contract", "signed", "negotiating",
  "option_pending", "loan_out", "loan_in", "transfer", "other"];
// Leagues whose releases raise an alert. MLS first teams are read for the Next Pro players they bundle, never alerted.
export const ALERT_LEAGUES = new Set(["USLC", "USL1", "MLSNP"]);
// The fewest players one article must cover for an upload to count it as the club's release.
const RELEASE_MIN_PLAYERS = 4;

const text = (v, max = 120) => (v == null || v === "" ? null : String(v).trim().slice(0, max) || null);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim()) ? String(v).trim() : null);
const webLink = (v) => { const s = text(v, 500); return s && /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null; };
const bare = (s) => String(s || "").replace(/,?\s+(jr|sr|ii|iii|iv)\.?\s*$/i, "").trim();

// The season whose end a date belongs to: decisions made from August on are about that season, the rest about the
// one before (a January release is still last season's).
export const seasonFor = (d = new Date()) => (d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);

// Stores an upload's decisions in place of what the clubs it covers had (the same rule as the free agents), files
// each under the club's PINE name, links players, and adds a release for any alerting club seen for the first time
// so the tab and badge say it posted even if the watcher missed it. Runs in the caller's transaction.
export function saveRosterDecisions(db, { season, decisions }) {
  if (!Array.isArray(decisions) || decisions.length > 5000) throw new Error("Expected up to 5000 decisions");
  const rows = decisions.map((d) => {
    const name = text(d.name, 80), clubRaw = text(d.club, 80);
    if (!name || !clubRaw) throw new Error("Every decision needs a player and a club");
    if (!DECISION_CODES.includes(d.decision)) throw new Error(`${name}: unknown decision "${d.decision}"`);
    const known = findClub(clubRaw);
    return { name, club: known?.club || clubRaw, club_raw: clubRaw, league: known?.league || null, position: text(d.position, 12),
      decision: d.decision, decision_raw: text(d.decision_raw, 400), announced: isoDate(d.announced), source_url: webLink(d.source_url),
      notes: text(d.notes, 600) };
  });
  const clubs = [...new Set(rows.map((r) => r.club))];
  const before = new Set(db.all("SELECT DISTINCT club FROM roster_decisions WHERE season = ?", season).map((r) => r.club));
  const firstUpload = before.size === 0;
  const kept = new Map(db.all("SELECT club, name, player_id FROM roster_decisions WHERE season = ? AND player_id IS NOT NULL", season)
    .map((r) => [`${r.club}\n${r.name}`, r.player_id]));
  const added = [];
  db.tx(() => {
    for (const c of clubs) db.run("DELETE FROM roster_decisions WHERE season = ? AND club = ?", season, c);
    for (const r of rows) {
      db.run(`INSERT INTO roster_decisions(season, club, club_raw, league, name, position, decision, decision_raw, announced, source_url, notes, player_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, season, r.club, r.club_raw, r.league, r.name, r.position, r.decision, r.decision_raw, r.announced,
        r.source_url, r.notes, kept.get(`${r.club}\n${r.name}`) ?? null);
    }
    for (const club of clubs) {
      const mine = rows.filter((r) => r.club === club);
      const league = mine[0].league;
      if (before.has(club) || !ALERT_LEAGUES.has(league)) continue;
      if (db.get("SELECT 1 FROM option_releases WHERE season = ? AND club = ?", season, club)) continue;
      // The link most of its rows cite, as the release to open.
      const tally = new Map();
      for (const r of mine) if (r.source_url) tally.set(r.source_url, (tally.get(r.source_url) || 0) + 1);
      // A release lists several players; one re-signing or departure is a single move, not a club posting its decisions.
      const [url, n] = [...tally].sort((a, b) => b[1] - a[1])[0] || [];
      if (!url || n < RELEASE_MIN_PLAYERS) continue;
      const published = mine.map((r) => r.announced).filter(Boolean).sort().pop() || null;
      const alert = firstUpload ? 0 : 1;
      const r = db.run(`INSERT OR IGNORE INTO option_releases(season, club, league, title, url, published, source, alert)
        VALUES (?,?,?,?,?,?, 'upload', ?)`, season, club, league, `${club} roster decisions`, url, published, alert);
      if (r.changes && alert) added.push({ id: Number(r.lastInsertRowid), club, league, title: `${club} roster decisions`, url });
    }
  });
  linkRosterDecisions(db);
  const unknown = [...new Set(rows.filter((r) => !r.league).map((r) => r.club_raw))];
  return { decisions: rows.length, decision_clubs: clubs.length, unknown_clubs: unknown, new_releases: added };
}

// Matches decisions without a PINE player yet, the same way as the free agents: by name, and only when the
// player's club (or the club he's on loan from) agrees with the one that announced it. Safe to run again.
export function linkRosterDecisions(db) {
  const rows = db.all("SELECT id, club, club_raw, name FROM roster_decisions WHERE player_id IS NULL");
  if (!rows.length) return 0;
  const players = db.all("SELECT id, name, club, loan_from FROM players");
  let linked = 0;
  db.tx(() => {
    for (const r of rows) {
      const agrees = (c) => clubsAgree(r.club, c) || clubsAgree(r.club_raw, c);
      const fits = players.filter((p) => agrees(p.club) || agrees(p.loan_from)).map((p) => ({ ...p, name: bare(p.name) }));
      const m = matchName(nameIndex(fits), bare(r.name));
      if (m) { db.run("UPDATE roster_decisions SET player_id = ? WHERE id = ?", m.id, r.id); linked++; }
    }
  });
  return linked;
}

// New alerting releases since this user last opened the tab, and the newest one (for the toast).
export function optionsUnread(db, userId) {
  const last = db.get("SELECT release_id FROM option_reads WHERE user_id = ?", userId)?.release_id ?? 0;
  const r = db.get(`SELECT count(*) AS n, max(id) AS top FROM option_releases WHERE alert = 1 AND id > ?`, last);
  const latest = r.top ? db.get("SELECT id, club, league, title FROM option_releases WHERE id = ?", r.top) : null;
  return { n: r.n, latest };
}

export function markOptionsRead(db, userId, releaseId) {
  const id = Number(releaseId);
  if (!Number.isInteger(id) || id < 0) throw new Error("Expected a release id");
  db.run(`INSERT INTO option_reads(user_id, release_id) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET release_id = max(release_id, excluded.release_id)`, userId, id);
}

// Everything the Options tab shows for the latest season: the releases, every decision (with whether it makes the
// player a free agent, worked out exactly as the free-agent upload does), and which clubs have posted.
export function optionsPayload(db, userId, watch = null) {
  const season = db.get(`SELECT max(s) AS s FROM (SELECT max(season) AS s FROM roster_decisions UNION ALL SELECT max(season) FROM option_releases)`).s
    ?? seasonFor();
  const releases = db.all(`SELECT id, club, league, title, url, published, found_at, source, alert FROM option_releases WHERE season = ?
    ORDER BY coalesce(published, substr(found_at, 1, 10)) DESC, id DESC`, season);
  const decisions = db.all(`SELECT id, club, league, name, position, decision, decision_raw, announced, source_url, notes, player_id
    FROM roster_decisions WHERE season = ? ORDER BY club, name`, season);
  const { entries } = entriesFromDecisions(decisions.map((d) => ({ player: d.name, club: d.club, decision: d.decision,
    pub_date: d.announced, source_url: d.source_url })));
  const fa = new Map(entries.map((e) => [`${e.club}\n${e.name}`, e]));
  for (const d of decisions) {
    const e = fa.get(`${d.club}\n${d.name}`);
    d.free_agent = Boolean(e && e.reason === d.decision);
    d.in_talks = Boolean(e?.in_talks);
  }
  const posted = new Set(releases.map((r) => r.club)), moved = new Set(decisions.map((d) => d.club));
  const clubs = OPTION_CLUBS.filter((c) => ALERT_LEAGUES.has(c.league))
    .map((c) => ({ club: c.club, league: c.league, status: posted.has(c.club) ? "posted" : moved.has(c.club) ? "moves" : "none" }));
  const last_read = db.get("SELECT release_id FROM option_reads WHERE user_id = ?", userId)?.release_id ?? 0;
  return { season, releases, decisions, clubs, last_read, watch };
}
