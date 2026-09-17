// Impect Customer API: player pool across our iterations, used for search/import and to link PINE players.
import { norm } from "./physical.js";

const HOST = "https://api.impect.com";
const TOKEN_URL = "https://login.impect.com/auth/realms/production/protocol/openid-connect/token";
const TTL_MS = 12 * 60 * 60 * 1000;

let token = null;
const cache = new Map(); // path -> { at, data }
let poolCache = null;
let poolPromise = null;

export const impectConfigured = () => Boolean(process.env.IMPECT_USERNAME && process.env.IMPECT_PASSWORD);

let tokenPromise = null;

// Single-flight: concurrent callers share one login, and a transient failure is retried twice.
async function getToken(force = false) {
  if (!force && token && token.exp > Date.now() + 30_000) return token.value;
  if (tokenPromise) return tokenPromise;
  if (!impectConfigured()) throw new Error("Impect credentials are not configured (IMPECT_USERNAME / IMPECT_PASSWORD)");
  tokenPromise = (async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "api",
          grant_type: "password",
          username: process.env.IMPECT_USERNAME,
          password: process.env.IMPECT_PASSWORD,
        }),
      });
      if (res.ok) {
        const j = await res.json();
        token = { value: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
        return token.value;
      }
      if (attempt >= 2) throw new Error(`Impect login failed (${res.status})`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  })();
  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

// store: false skips the 12-hour response cache, for large raw payloads callers reduce and cache themselves.
export async function impectGet(path, { ttl = TTL_MS, store = true } = {}) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  let force = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(HOST + path, {
      headers: { Authorization: `Bearer ${await getToken(force)}`, Accept: "application/json" },
    });
    if (res.status === 401 && !force) { force = true; continue; }
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`Impect ${path} failed (${res.status})`);
    const j = await res.json();
    const data = j && typeof j === "object" && "data" in j ? j.data : j;
    if (store) cache.set(path, { at: Date.now(), data });
    return data;
  }
  throw new Error(`Impect ${path} failed after retries`);
}

const idMap = (obj, key) => {
  for (const m of obj.idMappings || []) if (key in m) return m[key]?.[0] ?? null;
  return null;
};

export async function iterations() {
  const its = await impectGet("/v5/customerapi/iterations");
  return its
    .map((it) => ({ id: it.id, season: it.season, competition: it.competition?.name || `Competition ${it.competition?.id}`, type: it.competition?.type }))
    .sort((a, b) => String(b.season).localeCompare(String(a.season)) || a.competition.localeCompare(b.competition));
}

// Every player we have access to, one entry per Impect player id, with the iterations they appear in.
export async function playerPool() {
  if (poolCache && Date.now() - poolCache.at < TTL_MS) return poolCache;
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    const [its, countries] = await Promise.all([iterations(), impectGet("/v5/customerapi/countries")]);
    const countryName = Object.fromEntries(countries.map((c) => [c.id, c.name]));
    const byId = new Map();
    const squadName = new Map();
    // Oldest season first, and cups before leagues, so a player's newest *league* iteration wins.
    const order = [...its].sort((a, b) => String(a.season).localeCompare(String(b.season)) || (a.type === "Cup" ? 0 : 1) - (b.type === "Cup" ? 0 : 1));
    for (const it of order) {
      const [players, squads] = await Promise.all([
        impectGet(`/v5/customerapi/iterations/${it.id}/players`, { store: false }),
        impectGet(`/v5/customerapi/iterations/${it.id}/squads`),
      ]);
      for (const s of squads) squadName.set(s.id, s.name);
      for (const p of players) {
        const name = p.commonname || [p.firstname, p.lastname].filter(Boolean).join(" ");
        const e = byId.get(p.id) || { impect_id: p.id, iterations: [] };
        Object.assign(e, {
          name,
          firstname: p.firstname,
          lastname: p.lastname,
          birthdate: p.birthdate || null,
          birthplace: p.birthplace || null,
          foot: p.leg ? p.leg.toLowerCase() : null,
          height_cm: p.height ? Math.round(p.height * 100) : null,
          citizenship: (p.countryIds || []).map((id) => countryName[id]).filter(Boolean),
          current_squad_id: p.currentSquadId,
          wyscout_id: idMap(p, "wyscout"),
          skillcorner_id: idMap(p, "skill_corner"),
          transfermarkt_id: idMap(p, "transfermarkt"),
        });
        e.iterations.push({ id: it.id, season: it.season, competition: it.competition });
        byId.set(p.id, e);
      }
    }
    const players = [...byId.values()].map((e) => {
      const latest = e.iterations[e.iterations.length - 1];
      return {
        ...e,
        squad: squadName.get(e.current_squad_id) || null,
        competition: latest?.competition || null,
        season: latest?.season || null,
        _n: norm(e.name),
        _alt: norm([e.firstname, e.lastname].filter(Boolean).join(" ")),
      };
    });
    poolCache = { at: Date.now(), players, iterations: its };
    return poolCache;
  })();
  try {
    return await poolPromise;
  } finally {
    poolPromise = null;
  }
}

const strip = ({ _n, _alt, ...rest }) => rest;

export async function searchImpect(q, { iterationId, limit = 40 } = {}) {
  const { players } = await playerPool();
  const n = norm(q);
  const itId = iterationId ? Number(iterationId) : null;
  return players
    .filter((p) => (!n || p._n.includes(n) || p._alt.includes(n)) && (!itId || p.iterations.some((i) => i.id === itId)))
    .sort((a, b) => String(b.season).localeCompare(String(a.season)) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(strip);
}

export async function getImpectPlayer(id) {
  const { players } = await playerPool();
  const p = players.find((x) => x.impect_id === Number(id));
  return p ? strip(p) : null;
}

/* ---------- Impect Scouting (the scouting.impect.com backend; not part of the documented Customer API) ---------- */
const SCOUTING = "https://api.impect.com/v1/scouting";

async function scoutingFetch(path, { method = "GET", body } = {}) {
  let force = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(SCOUTING + path, {
      method,
      headers: {
        Authorization: `Bearer ${await getToken(force)}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !force) { force = true; continue; }
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`Impect Scouting ${path.split("?")[0]} failed (${res.status})`);
    const j = await res.json();
    return j && typeof j === "object" && "data" in j ? j.data : j;
  }
  throw new Error(`Impect Scouting ${path} failed after retries`);
}

export async function shortLists() {
  const d = await scoutingFetch("/player-short-lists?gender=MALE");
  return (d?.shortListsWithAccessRights || [])
    .map(({ shortList: s }) => ({
      id: s.id,
      name: s.name,
      emoji: s.emoji || null,
      player_ids: (s.players || []).map((p) => p.playerId),
      updated_at: s.lastEditedOn || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// playerId -> { iteration_id, position } (position = where they've played most, per Impect match shares)
export async function shortListPlayerMeta(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await scoutingFetch("/player-short-lists/players", { method: "POST", body: { playerIds: ids.slice(i, i + 100) } });
    for (const r of rows || []) {
      const top = [...(r.matchShares || [])].sort((a, b) => b.matchShare - a.matchShare)[0];
      out.set(r.playerId, { iteration_id: r.mainCompetitionIterationId ?? null, position: top?.position || null });
    }
  }
  return out;
}

// Name + birthdate is required for a confident link; Impect carries no Transfermarkt ids for our leagues.
export async function matchImpect({ name, birthdate }) {
  const { players } = await playerPool();
  const n = norm(name);
  if (!n) return { best: null, candidates: [] };
  const last = n.split(" ").slice(-1)[0];
  const candidates = players
    .filter((p) => p._n === n || p._alt === n || (birthdate && p.birthdate === birthdate && (p._n.endsWith(last) || p._alt.endsWith(last))))
    .map((p) => ({ ...strip(p), confidence: birthdate && p.birthdate === birthdate ? "high" : "name" }));
  const high = candidates.filter((c) => c.confidence === "high");
  return { best: high.length === 1 ? high[0] : null, candidates };
}
