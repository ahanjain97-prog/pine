// Link to the NextPro & USL physical-data site (percentiles within league/season/position group).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_URL = "https://ahanjain97-prog.github.io/player-physical-data/site_data.json";
export const PHYS_SITE = "https://ahanjain97-prog.github.io/player-physical-data/";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = null; // { at, data, rows, teamTokenCount, surnameCount }

export const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* ---------- names ---------- */
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
const nameTokens = (s) => norm(s).split(" ").filter((t) => t && !NAME_SUFFIXES.has(t));

// Site names are mostly Wyscout short names ("A. Surname", "J.C. Surname"); about 7% are full names.
function parseSiteName(name) {
  const m = String(name).match(/^((?:[A-Za-z]{1,2}\.\s*)+)(.+)$/);
  if (m) return { initial: m[1][0].toLowerCase(), full: null, sur: nameTokens(m[2]) };
  const t = nameTokens(name);
  return { initial: (t[0] || "")[0] || "", full: t.join(" "), sur: t.length > 1 ? t.slice(1) : t };
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/* ---------- teams ---------- */
// Site team names are short ("Quakes II", "NY Cosmos"). Each maps to the names a Transfermarkt or
// Impect club may use; affiliate teams also list the parent club, so a first-team player matches
// the rows from their second team.
const TEAM_ALIASES = {
  "quakes ii": ["san jose earthquakes"],
  "the town": ["the town", "san jose earthquakes"],
  "sporting jax": ["sporting club jacksonville", "sporting jacksonville"],
  "ny cosmos": ["new york cosmos"],
  "new york rb ii": ["new york red bulls"],
  "new york city ii": ["new york city"],
  "connecticut fc": ["connecticut united", "connecticut"],
  "colorado springs": ["colorado springs switchbacks", "colorado springs"],
  "real monarchs": ["real monarchs", "real salt lake city", "real salt lake"],
  "crown legacy fc": ["crown legacy", "charlotte"],
  "north texas": ["north texas", "dallas"],
  "huntsville city": ["huntsville city", "nashville"],
  "tacoma defiance": ["tacoma defiance", "seattle sounders"],
  "ventura county": ["ventura county", "los angeles galaxy", "la galaxy"],
  "vancouver whitecaps ii": ["vancouver whitecaps", "whitecaps"],
  "inter toronto": ["inter toronto", "york united"],
};
const TEAM_NOISE = new Set(["fc", "sc", "cf", "afc", "club", "the", "ii", "b", "de", "u"]);
const teamKey = (s) => norm(s).split(" ").filter((t) => t && !TEAM_NOISE.has(t)).join(" ");
function siteTeamNames(team) {
  const base = norm(String(team).replace(/^now at\s+/i, ""));
  return (TEAM_ALIASES[base] || [base]).map(teamKey).filter(Boolean);
}

// A club matches when a canonical name is identical, or when they share a word that belongs to only
// one site team (so "Chattanooga" alone can't tie Chattanooga FC to Chattanooga Red Wolves).
function clubMatches(row, clubs, teamTokenCount) {
  for (const club of clubs) {
    const key = teamKey(club);
    if (!key) continue;
    if (row._teams.includes(key)) return true;
    const words = new Set(key.split(" "));
    if (row._teams[0].split(" ").some((t) => t.length >= 4 && teamTokenCount.get(t) === 1 && words.has(t))) return true;
  }
  return false;
}

function build(data) {
  const ML = data.metrics.map((m) => m.l);
  const MG = data.metrics.map((m) => m.g);
  const groups = [...new Set(MG)];
  const seen = {};
  // Row keys mirror the site's own hash keys so deep links open the same player.
  const rows = data.rows.map((r, i) => {
    const p = {
      i, name: r[0], team: r[1], league: data.leagues[r[2]], season: data.seasons[r[3]], pos: r[4],
      grp: data.groups[r[5]].k, age: r[6], mins: r[7], mp: r[8], pool: r[9], raw: r[10], pct: r[11],
    };
    const base = `${p.name}|${p.team}|${p.league}|${p.season}`;
    seen[base] = (seen[base] || 0) + 1;
    p.key = seen[base] > 1 ? `${base}~${seen[base]}` : base;
    p.link = PHYS_SITE + "#" + encodeURIComponent(p.key);
    const g = {}, n = {};
    ML.forEach((_, j) => { g[MG[j]] = (g[MG[j]] || 0) + p.pct[j]; n[MG[j]] = (n[MG[j]] || 0) + 1; });
    p.groupsPct = Object.fromEntries(groups.map((k) => [k, Math.round(g[k] / n[k])]));
    p.overall = Math.round(p.pct.reduce((a, b) => a + b, 0) / p.pct.length);
    const nm = parseSiteName(p.name);
    p._initial = nm.initial;
    p._full = nm.full;
    p._sur = nm.sur;
    p._surname = nm.sur.join(" ");
    p._teams = siteTeamNames(p.team);
    return p;
  });
  // How many site teams use each team word, and how many different site names use each surname word.
  const teamTokenCount = new Map();
  for (const t of new Set(rows.map((r) => r._teams[0]))) for (const w of new Set(t.split(" "))) teamTokenCount.set(w, (teamTokenCount.get(w) || 0) + 1);
  const surnameCount = new Map();
  for (const [, r] of new Map(rows.map((r) => [norm(r.name), r]))) for (const w of new Set(r._sur)) surnameCount.set(w, (surnameCount.get(w) || 0) + 1);
  return { rows, teamTokenCount, surnameCount };
}

export async function loadPhysical(cacheFile) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const url = process.env.PHYS_DATA_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error(`physical data ${res.status}`);
    const data = await res.json();
    cache = { at: Date.now(), data, ...build(data) };
    if (cacheFile) {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(data));
    }
  } catch (e) {
    if (cache) return cache;
    if (!cacheFile) throw e;
    const data = JSON.parse(readFileSync(cacheFile, "utf8")); // offline fallback
    cache = { at: Date.now() - TTL_MS + 60_000, data, ...build(data) };
  }
  return cache;
}

export function meta(c) {
  return { metrics: c.data.metrics, groups: c.data.groups, site: PHYS_SITE };
}

// Loose club comparison used for Transfermarkt candidates (both sides are full club names).
export const teamOverlap = (a, b) => {
  const stop = new Set(["fc", "sc", "cf", "united", "city", "the", "de", "ii", "club"]);
  const A = new Set(norm(a).split(" ").filter((t) => t.length > 2 && !stop.has(t)));
  return norm(b).split(" ").some((t) => A.has(t));
};

const ageOn = (birthdate, when = new Date()) => {
  const b = new Date(String(birthdate).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(b.getTime())) return null;
  let a = when.getUTCFullYear() - b.getUTCFullYear();
  if (when.getUTCMonth() < b.getUTCMonth() || (when.getUTCMonth() === b.getUTCMonth() && when.getUTCDate() < b.getUTCDate())) a--;
  return a;
};

/**
 * Candidate site rows for a player, strongest first. Each carries `reasons` and `auto` (safe to link
 * without review).
 *   Name: "name" = same first initial and surname (or the same full name); "name-close" = same initial
 *   and our surname inside a longer site surname, the first of two surnames, or one that differs only in
 *   spacing or by one letter; "surname-only" =
 *   surname matches but the initial doesn't (never linked automatically).
 *   Age: the site's age is the player's age when the data was exported (the same in every season),
 *   so it is compared with the player's age today; one year either way is allowed.
 *   Club: the player's club, loan club or Impect squad against the row's team.
 * Auto-link: "name" + age agrees (or age unknown and club agrees); "name-close" + age agrees + club
 * agrees or a rare surname. A clear age mismatch always blocks it.
 */
export function matchPhysical(c, player) {
  const words = nameTokens(player.name);
  if (!words.length) return [];
  const initial = words[0][0];
  const full = words.join(" ");
  const suffixes = new Set(words.length > 1 ? words.slice(1).map((_, i) => words.slice(i + 1).join(" ")) : [words[0]]);
  // For "name-close": one of the player's surname endings, word for word, inside a longer site surname
  // ("LeFlore" in "McNeil LeFlore"). Never the reverse: "Henry" is not "Henry-Scott".
  const endings = [...suffixes].map((s) => s.split(" ")).filter((t) => t.every((w) => w.length >= 3));
  // Spanish-style double surnames ("Sergio Ors Navarro"): Wyscout keeps only the first ("S. Ors").
  // Hyphenated surnames stay whole, so "Henry-Scott" never becomes "Henry".
  const units = String(player.name).trim().split(/\s+/).map(nameTokens).filter((t) => t.length);
  const firstSurname = units.length > 2 ? units[1].join(" ") : null;
  const last = words[words.length - 1];
  const age = player.birthdate ? ageOn(player.birthdate) : null;
  const clubs = [player.club, player.loan_from, player.impect_squad].filter(Boolean);
  const out = [];
  for (const r of c.rows) {
    let level = null;
    let shared = null; // the surname words the player and row have in common
    if ((r._full && r._full === full) || (r._initial === initial && suffixes.has(r._surname))) level = "name";
    else if (r._initial === initial) {
      shared = endings.find((t) => t.every((w) => r._sur.includes(w))) || null;
      if (shared || r._surname === firstSurname || r._surname.replace(/ /g, "") === [...suffixes][0]?.replace(/ /g, "")
        || (last.length >= 6 && r._sur.length === 1 && editDistance(r._sur[0], last) === 1)) level = "name-close";
    } else if (words.length > 1 && suffixes.has(r._surname) && r._surname.length >= 4) level = "surname-only";
    if (!level) continue;

    const reasons = [level];
    const ageKnown = age != null && r.age != null;
    const ageOk = ageKnown && Math.abs(r.age - age) <= 1;
    const ageBad = ageKnown && !ageOk;
    const clubOk = clubMatches(r, clubs, c.teamTokenCount);
    if (ageOk) reasons.push("age");
    if (ageBad) reasons.push("age-mismatch");
    if (clubOk) reasons.push("club");
    const rare = (shared || r._sur).some((w) => (c.surnameCount.get(w) || 0) <= 2);
    const auto = !ageBad && (level === "name"
      ? ageOk || (!ageKnown && clubOk)
      : level === "name-close" && (ageOk ? clubOk || rare : !ageKnown && clubOk && rare));
    const score = { name: 3, "name-close": 2, "surname-only": 1 }[level] + (ageOk ? 1 : 0) + (clubOk ? 1 : 0) - (ageBad ? 2 : 0);
    out.push({ ...strip(r), score, reasons, auto });
  }
  return out.sort((a, b) => b.score - a.score || b.season.localeCompare(a.season));
}

// Auto-link keys for many players at once. A row that more than one player would claim is left for
// review instead of being given to either.
export function resolveAutoLinks(c, players) {
  const claims = new Map(); // row key -> player ids
  const byPlayer = new Map();
  for (const p of players) {
    const keys = matchPhysical(c, p).filter((m) => m.auto).map((m) => m.key);
    byPlayer.set(p.id, keys);
    for (const k of keys) claims.set(k, [...(claims.get(k) || []), p.id]);
  }
  const contested = new Set([...claims].filter(([, ids]) => ids.length > 1).map(([k]) => k));
  return { links: new Map([...byPlayer].map(([id, keys]) => [id, keys.filter((k) => !contested.has(k))])), contested };
}

export function searchPhysical(c, q, limit = 25) {
  const n = norm(q);
  if (n.length < 2) return [];
  return c.rows
    .filter((p) => norm(p.name).includes(n) || norm(p.team).includes(n))
    .slice(0, limit)
    .map(strip);
}

export function rowsByKeys(c, keys) {
  const set = new Set(keys);
  return c.rows.filter((p) => set.has(p.key)).map(strip).sort((a, b) => b.season.localeCompare(a.season));
}

function strip(p) {
  const { _initial, _full, _sur, _surname, _teams, ...rest } = p;
  return rest;
}
