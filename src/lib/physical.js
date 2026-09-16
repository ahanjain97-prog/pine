// Link to the NextPro & USL physical-data site (percentiles within league/season/position group).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_URL = "https://ahanjain97-prog.github.io/player-physical-data/site_data.json";
export const PHYS_SITE = "https://ahanjain97-prog.github.io/player-physical-data/";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = null; // { at, data, rows }

export const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function build(data) {
  const ML = data.metrics.map((m) => m.l);
  const MG = data.metrics.map((m) => m.g);
  const groups = [...new Set(MG)];
  const seen = {};
  // Row keys mirror the site's own hash keys so deep links open the same player.
  return data.rows.map((r, i) => {
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
    const m = String(p.name).match(/^([A-Za-z])\.\s*(.+)$/);
    p._initial = m ? m[1].toLowerCase() : norm(p.name)[0];
    p._surname = norm(m ? m[2] : p.name);
    p._team = norm(p.team);
    return p;
  });
}

export async function loadPhysical(cacheFile) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const url = process.env.PHYS_DATA_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error(`physical data ${res.status}`);
    const data = await res.json();
    cache = { at: Date.now(), data, rows: build(data) };
    if (cacheFile) {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(data));
    }
  } catch (e) {
    if (cache) return cache;
    if (!cacheFile) throw e;
    const data = JSON.parse(readFileSync(cacheFile, "utf8")); // offline fallback
    cache = { at: Date.now() - TTL_MS + 60_000, data, rows: build(data) };
  }
  return cache;
}

export function meta(c) {
  return { metrics: c.data.metrics, groups: c.data.groups, site: PHYS_SITE };
}

export const teamOverlap = (a, b) => {
  const stop = new Set(["fc", "sc", "cf", "united", "city", "the", "de", "ii", "club"]);
  const A = new Set(norm(a).split(" ").filter((t) => t.length > 2 && !stop.has(t)));
  return norm(b).split(" ").some((t) => A.has(t));
};

// Candidate rows for a player: initial + surname must match; club and age raise confidence.
export function matchPhysical(c, { name, club, birthdate }) {
  const words = norm(name).split(" ").filter(Boolean);
  if (words.length < 1) return [];
  const initial = words[0][0];
  const suffixes = new Set(words.slice(1).map((_, i) => words.slice(i + 1).join(" ")));
  if (words.length === 1) suffixes.add(words[0]);
  const birthYear = birthdate ? Number(String(birthdate).slice(0, 4)) : null;
  const out = [];
  for (const p of c.rows) {
    if (!suffixes.has(p._surname)) continue;
    if (words.length > 1 && p._initial !== initial) continue;
    let score = 1;
    const reasons = ["name"];
    if (club && teamOverlap(club, p.team)) { score += 1; reasons.push("club"); }
    if (birthYear && p.age) {
      const expected = Number(p.season) - birthYear;
      if (Math.abs(p.age - expected) <= 1) { score += 1; reasons.push("age"); }
      else if (Math.abs(p.age - expected) > 2) { score -= 2; reasons.push("age-mismatch"); }
    }
    out.push({ ...strip(p), score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || b.season.localeCompare(a.season));
}

export function searchPhysical(c, q, limit = 25) {
  const n = norm(q);
  if (n.length < 2) return [];
  return c.rows
    .filter((p) => norm(p.name).includes(n) || p._team.includes(n))
    .slice(0, limit)
    .map(strip);
}

export function rowsByKeys(c, keys) {
  const set = new Set(keys);
  return c.rows.filter((p) => set.has(p.key)).map(strip).sort((a, b) => b.season.localeCompare(a.season));
}

function strip(p) {
  const { _initial, _surname, _team, ...rest } = p;
  return rest;
}
