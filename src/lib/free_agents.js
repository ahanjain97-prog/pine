// End-of-season free agents: players whose club declined their contract option, or let their contract run out,
// as the club announced it. The list comes from the clubs' own releases, and matching it shows who PINE follows,
// so it never lives in this public repository: scripts/free-agents.mjs reads the research CSV and uploads it
// (PUT /api/worker/free-agents), and it's kept in the database. Each entry is matched to a PINE player by name
// (as strict as the college import) and only when the clubs agree too: the player's club, or the club he's on
// loan from, must be the one that announced it. Once matched, the link stays even if his club changes later.
import { matchName, nameIndex, normName } from "./ncaa.js";

export const FA_REASONS = ["option_declined", "out_of_contract"];
// A later decision that means he isn't a free agent after all (signed elsewhere, or re-signed).
const STAYS = new Set(["signed", "option_exercised", "guaranteed_contract", "transfer"]);

const text = (v, max = 120) => (v == null || v === "" ? null : String(v).trim().slice(0, max) || null);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim()) ? String(v).trim() : null);
// "Sam Example Jr." and "Sam Example" are the same player.
const bare = (s) => String(s || "").replace(/,?\s+(jr|sr|ii|iii|iv)\.?\s*$/i, "").trim();

// Club names as releases and PINE write them: "MNUFC2" / "Minnesota United FC 2", "Sporting KC II" / "Sporting
// Kansas City II". Words every club has (FC, City, II) don't count as agreeing.
const CLUB_ALIASES = { mnufc: "minnesota", nycfc: "new york", skc: "sporting kansas", kc: "kansas", rsl: "salt lake", slc: "salt lake",
  tfc: "toronto", lafc: "los angeles", stl: "louis", atl: "atlanta", nerevs: "england" };
const GENERIC = new Set(["fc", "sc", "cf", "afc", "ii", "city", "real", "united", "club", "the", "st", "de", "of", "and", "soccer", "football"]);
const clubWords = (s) => new Set(normName(s).split(" ").flatMap((w) => (CLUB_ALIASES[w] || w).split(" "))
  .filter((w) => w.length > 1 && !GENERIC.has(w)));
export function clubsAgree(a, b) {
  if (!a || !b) return false;
  const A = clubWords(a);
  return [...clubWords(b)].some((w) => A.has(w));
}

// From the research CSV's rows (club, player, decision, source_url, pub_date) to one entry per free agent.
// Someone with a later decision that keeps him signed (another club signed him, his option was picked up) is
// left out; one still in talks with his club is kept and marked so.
export function entriesFromDecisions(rows) {
  const byName = new Map();
  for (const r of rows) {
    const k = normName(bare(r.player));
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const entries = [], skipped = [];
  for (const list of byName.values()) {
    const fa = list.filter((r) => FA_REASONS.includes(r.decision));
    if (!fa.length) continue;
    const r = fa.find((x) => x.decision === "option_declined") || fa[0];
    const when = isoDate(r.pub_date);
    const stay = list.find((x) => STAYS.has(x.decision) && (!when || !isoDate(x.pub_date) || isoDate(x.pub_date) >= when));
    if (stay) { skipped.push({ name: r.player.trim(), club: r.club.trim(), because: `${stay.decision.replace(/_/g, " ")} (${stay.club})` }); continue; }
    entries.push({ name: r.player.trim(), club: r.club.trim(), reason: r.decision, announced: when, source_url: text(r.source_url, 500),
      in_talks: list.some((x) => x.decision === "negotiating") });
  }
  return { entries, skipped };
}

// Edit details can set it by hand: Yes for someone no uploaded list covers, No to hide a listed player (say he
// re-signed). null is Auto: follow the uploaded lists.
export function freeAgentOverride(value) {
  if (value === null) return null;
  if (typeof value !== "boolean") throw Object.assign(new Error("Free agent must be true, false or null (Auto)"), { status: 400 });
  return Number(value);
}
// What a player shows: nothing once he's signed to Hearts of Pine or set to No; otherwise his uploaded entry, or
// { manual: true } when Yes was set by hand and no list has him.
export function freeAgentFor(p, listed) {
  if (p.is_signed || p.free_agent_override === 0) return null;
  return listed || (p.free_agent_override === 1 ? { manual: true } : null);
}

// Checks an upload and replaces what's stored for the clubs it covers (so a later file with only the clubs that
// have posted since leaves the others alone). Returns counts and the names not in PINE.
export function saveFreeAgents(db, input) {
  const season = Number(input?.season);
  if (!Number.isInteger(season) || season < 2015 || season > 2100) throw new Error("Expected a season");
  const clubs = Array.isArray(input.clubs) ? [...new Set(input.clubs.map((c) => text(c, 80)).filter(Boolean))] : [];
  if (!clubs.length || clubs.length > 250) throw new Error("Expected 1-250 clubs");
  if (!Array.isArray(input.entries) || input.entries.length > 1000) throw new Error("Expected up to 1000 entries");
  const rows = input.entries.map((e) => {
    const name = text(e.name, 80), club = text(e.club, 80);
    if (!name) throw new Error("Every entry needs a name");
    if (!clubs.includes(club)) throw new Error(`${name}: club "${club}" isn't one of the clubs uploaded`);
    if (!FA_REASONS.includes(e.reason)) throw new Error(`${name}: reason must be ${FA_REASONS.join(" or ")}`);
    const source = text(e.source_url, 500);
    if (source && !/^https?:\/\//i.test(source)) throw new Error(`${name}: the source must be a web link`);
    return { name, club, reason: e.reason, announced: isoDate(e.announced), source, in_talks: e.in_talks ? 1 : 0 };
  });
  db.tx(() => {
    const kept = new Map(db.all("SELECT club, name, player_id FROM free_agents WHERE season = ? AND player_id IS NOT NULL", season)
      .map((r) => [`${r.club}\n${r.name}`, r.player_id]));
    for (const c of clubs) db.run("DELETE FROM free_agents WHERE season = ? AND club = ?", season, c);
    for (const r of rows) {
      db.run(`INSERT OR REPLACE INTO free_agents(season, club, name, reason, announced, source_url, in_talks, player_id)
        VALUES (?,?,?,?,?,?,?,?)`, season, r.club, r.name, r.reason, r.announced, r.source, r.in_talks, kept.get(`${r.club}\n${r.name}`) ?? null);
    }
  });
  linkFreeAgents(db);
  const marks = clubs.map(() => "?").join(",");
  const stored = db.all(`SELECT name, club, player_id FROM free_agents WHERE season = ? AND club IN (${marks}) ORDER BY club, name`, season, ...clubs);
  return { season, clubs: clubs.length, entries: stored.length, in_pine: stored.filter((r) => r.player_id != null).length,
    not_in_pine: stored.filter((r) => r.player_id == null).map((r) => `${r.name} (${r.club})`) };
}

// Matches entries without a PINE player yet. Safe to run again; returns how many gained one.
export function linkFreeAgents(db) {
  const entries = db.all("SELECT season, club, name FROM free_agents WHERE player_id IS NULL");
  if (!entries.length) return 0;
  const players = db.all("SELECT id, name, league, club, loan_from FROM players");
  let linked = 0;
  db.tx(() => {
    for (const e of entries) {
      const fits = players.filter((p) => clubsAgree(e.club, p.club) || clubsAgree(e.club, p.loan_from)).map((p) => ({ ...p, name: bare(p.name) }));
      const m = matchName(nameIndex(fits), bare(e.name));
      if (m) { db.run("UPDATE free_agents SET player_id = ? WHERE season = ? AND club = ? AND name = ?", m.id, e.season, e.club, e.name); linked++; }
    }
  });
  return linked;
}

// The player's entry from the latest season uploaded, for the player list and profile (SQL, to go in a SELECT).
export const FREE_AGENT_SQL = `(SELECT json_object('reason', f.reason, 'club', f.club, 'announced', f.announced, 'season', f.season,
    'in_talks', f.in_talks, 'source_url', f.source_url)
  FROM free_agents f WHERE f.player_id = p.id AND f.season = (SELECT max(season) FROM free_agents)
  ORDER BY f.announced DESC LIMIT 1) AS free_agent_json`;
