// League playing time for every position, including goalkeepers. Raw KPI payloads are reduced
// before caching; a squad/match download is shared by every player and survives server restarts.
import { createHash } from "node:crypto";
import { impectGet, iterations, getImpectPlayer } from "./impect.js";
import { readDisk, writeDisk } from "./disk_cache.js";
import { norm } from "./physical.js";

const TTL = 12 * 60 * 60 * 1000;
const FORMAT = 1;
const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;
const round = (n) => Math.round(n * 100) / 100;
const positive = (v) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;

export function reduceMatch(raw) {
  const sides = [raw.squadHome, raw.squadAway];
  if (sides.some((s) => !s || !Array.isArray(s.players))) throw new Error("Incomplete Impect match data");
  // playDuration includes added time. Dividing by a high-share row recovers actual match length,
  // including extra time, so numerator and denominator use the same clock.
  const reference = sides.flatMap((s) => s.players).filter((r) => positive(r.matchShare) && positive(r.playDuration))
    .sort((a, b) => b.matchShare - a.matchShare)[0];
  if (!reference) throw new Error("Impect match duration is unavailable");
  return {
    duration: reference.playDuration / reference.matchShare,
    squads: sides.map((s) => {
      const players = new Map();
      for (const r of s.players) players.set(Number(r.id), (players.get(Number(r.id)) || 0) + positive(r.playDuration));
      return { id: Number(s.id), players: [...players] };
    }),
  };
}

// An independent factory makes the service testable without credentials, network calls or disk.
export function createPlayingTimeService({ get = impectGet, list = iterations, player = getImpectPlayer,
  read = readDisk, write = writeDisk, now = Date.now, intervalMs = 180 } = {}) {
  const memory = new Map(), building = new Map(), retryAfter = new Map(), queue = [];
  let active = 0, nextStart = 0, timer = null;
  function pump() {
    if (!queue.length || active >= 3 || timer) return;
    const delay = nextStart - Date.now();
    if (delay > 0) { timer = setTimeout(() => { timer = null; pump(); }, delay); return; }
    const foreground = queue.findIndex((t) => !t.owner.background);
    const task = queue.splice(foreground < 0 ? 0 : foreground, 1)[0];
    active++;
    nextStart = Date.now() + intervalMs;
    Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => { active--; pump(); });
    pump();
  }
  const download = (path, owner) => new Promise((resolve, reject) => {
    queue.push({ owner, run: () => get(path, { store: false }), resolve, reject });
    pump();
  });
  function remember(key, value) {
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > 256) memory.delete(memory.keys().next().value);
    return value;
  }
  function refresh(key, build, background) {
    if (building.has(key)) {
      const owner = building.get(key);
      if (!background) owner.background = false;
      return owner.promise;
    }
    const owner = { background, promise: null };
    owner.promise = Promise.resolve().then(() => build(owner)).then((data) => {
      const value = { format: FORMAT, at: now(), data };
      remember(key, value);
      write(key, value);
      retryAfter.delete(key);
      return data;
    }).catch((error) => {
      retryAfter.set(key, now() + 60_000);
      while (retryAfter.size > 256) retryAfter.delete(retryAfter.keys().next().value);
      throw error;
    }).finally(() => building.delete(key));
    building.set(key, owner);
    return owner.promise;
  }
  async function cached(key, build, { maxAge = TTL, stale = false, background = false } = {}) {
    const hit = memory.get(key) || read(key);
    if (hit?.format === FORMAT) {
      remember(key, hit);
      if (now() - hit.at < maxAge) return hit.data;
      if (stale) {
        if (!(retryAfter.get(key) > now())) refresh(key, build, true).catch((e) => console.warn(`[playing time] refresh failed: ${e.message}`));
        return hit.data;
      }
    }
    return refresh(key, build, background);
  }
  const indexAge = (it) => Number(String(it.season).slice(0, 4)) < new Date(now()).getUTCFullYear() ? WEEK : 6 * HOUR;
  function seasonIndex(it, background = false, force = false) {
    return cached(`playing-time-index-${it.id}`, async (owner) => {
      const [squads, matches] = await Promise.all([
        download(`/v5/customerapi/iterations/${it.id}/squads`, owner),
        download(`/v5/customerapi/iterations/${it.id}/matches`, owner),
      ]);
      const teams = await Promise.all(squads.filter((s) => s.access !== false).map(async (s) => {
        const rows = await download(`/v5/customerapi/iterations/${it.id}/squads/${s.id}/player-kpis`, owner);
        const players = new Map();
        for (const r of rows) players.set(Number(r.playerId), (players.get(Number(r.playerId)) || 0) + positive(r.playDuration));
        return { id: Number(s.id), name: s.name, players: [...players] };
      }));
      return { teams, matches: matches.map((m) => ({
        id: m.id, date: m.scheduledDate, home: m.homeSquadId, away: m.awaySquadId,
        available: m.available === true, stage: m.matchDay?.name || null,
      })), names: Object.fromEntries(squads.map((s) => [s.id, s.name])) };
    }, { maxAge: force ? 0 : indexAge(it), background });
  }
  const match = (f, background = false, force = false) => cached(`playing-time-match-${f.id}`, async (owner) =>
    reduceMatch(await download(`/v5/customerapi/matches/${f.id}/player-kpis`, owner)),
    { maxAge: force ? 0 : now() - Date.parse(f.date) > WEEK ? 30 * 24 * HOUR : 6 * HOUR, background });

  async function buildManifest(id) {
    const [p, its] = await Promise.all([player(Number(id)), list()]);
    const allowed = new Map(its.filter((i) => i.type === "League").map((i) => [i.id, i]));
    const mine = (p?.iterations || []).map((i) => allowed.get(i.id)).filter(Boolean);
    const seasons = [...new Set(mine.map((i) => String(i.season)))].sort().reverse();
    // Keep missing intervening years visible. Do not invent zero-minute totals for them.
    if (seasons.length && seasons.every((s) => /^\d{4}$/.test(s))) {
      for (let y = Number(seasons.at(-1)); y <= Number(seasons[0]); y++) if (!seasons.includes(String(y))) seasons.push(String(y));
      seasons.sort().reverse();
    }
    return { seasons: seasons.map((season) => ({ season, covered: mine.some((i) => String(i.season) === season) })), iterations: mine };
  }

  const manifest = (id) => cached(`playing-time-manifest-${Number(id)}`, () => buildManifest(id), { stale: true });

  async function buildSeason(id, label, { joined, club } = {}, background = false) {
    id = Number(id);
    const m = await cached(`playing-time-manifest-${id}`, () => buildManifest(id), { background });
    const its = m.iterations.filter((i) => String(i.season) === String(label));
    if (!its.length) return { season: String(label), teams: [], minutes: null, share: null };
    const clock = now();
    const groups = await Promise.all(its.map(async (it) => {
      const index = await seasonIndex(it, background);
      const teams = index.teams.filter((t) => t.players.some(([pid, seconds]) => pid === id && seconds > 0));
      return Promise.all(teams.map(async (team) => {
        const fixtures = index.matches.filter((f) => (f.home === team.id || f.away === team.id) && Number.isFinite(Date.parse(f.date)) && Date.parse(f.date) <= clock)
          .sort((a, b) => a.date.localeCompare(b.date));
        const games = await Promise.all(fixtures.map(async (f) => {
          if (!f.available) return { ...f, minutes: null, possible_minutes: null };
          const d = await match(f, background);
          const side = d.squads.find((s) => s.id === team.id);
          if (!side) throw new Error("Impect match squad is unavailable");
          return { ...f, minutes: (side.players.find(([pid]) => pid === id)?.[1] || 0) / 60, possible_minutes: d.duration / 60 };
        }));
        return { id: team.id, name: team.name, competition: it.competition, iteration_id: it.id,
          fixtures: games.map((g) => ({ ...g, opponent: index.names[g.home === team.id ? g.away : g.home] || "Opponent" })) };
      }));
    }));
    const teams = groups.flat();
    const joinedDate = /^\d{4}-\d{2}-\d{2}$/.test(joined || "") ? joined : null;
    // Current Transfermarkt club/join date is useful when it agrees with this squad. Historical
    // non-overlapping transfers use the next club's first appearance as an approximate boundary.
    const spans = teams.map((t) => {
      const played = t.fixtures.filter((g) => g.minutes > 0);
      return { team: t, first: played[0]?.date, last: played.at(-1)?.date,
        joined: joinedDate && norm(club) === norm(t.name) ? joinedDate : null };
    }).sort((a, b) => String(a.first || "9999").localeCompare(String(b.first || "9999")));
    for (const span of spans) {
      let start = span.joined || null, end = null;
      const earlier = spans.filter((s) => s !== span && s.last && span.first && s.last < span.first);
      const later = spans.filter((s) => s !== span && s.first && span.last && s.first > span.last);
      if (!start && earlier.length) start = span.first?.slice(0, 10);
      if (later.length) end = later[0].joined || later[0].first?.slice(0, 10);
      const t = span.team;
      t.fixtures = t.fixtures.filter((g) => {
        // Never discard observed minutes if a stale profile or approximate transfer bound disagrees.
        return g.minutes > 0 || ((!start || g.date.slice(0, 10) >= start) && (!end || g.date.slice(0, 10) < end));
      });
      const covered = t.fixtures.filter((g) => g.minutes !== null);
      t.minutes = covered.reduce((sum, g) => sum + g.minutes, 0);
      t.possible_minutes = covered.reduce((sum, g) => sum + g.possible_minutes, 0);
      t.share = t.possible_minutes > 0 ? round(100 * t.minutes / t.possible_minutes) : null;
      t.games = covered.length;
      // IDs/positions/KPIs stay on the server. Only the timeline's compact display data is returned.
      t.fixtures = t.fixtures.map((g) => ({ id: g.id, date: g.date, opponent: g.opponent, minutes: g.minutes === null ? null : round(g.minutes) }));
    }
    const minutes = teams.reduce((sum, t) => sum + t.minutes, 0);
    const possible = teams.reduce((sum, t) => sum + t.possible_minutes, 0);
    return { season: String(label), minutes: teams.length ? round(minutes) : null,
      share: possible > 0 ? round(100 * minutes / possible) : null,
      teams: teams.map((t) => ({ ...t, minutes: round(t.minutes), possible_minutes: round(t.possible_minutes) })) };
  }
  function season(id, label, context = {}) {
    // Key profile-dependent transfer bounds separately; a changed link/club/join date cannot reuse them.
    const signature = createHash("sha1").update(JSON.stringify([Number(id), String(label), context.joined || "", context.club || ""])).digest("hex");
    const maxAge = Number(String(label).slice(0, 4)) < new Date(now()).getUTCFullYear() ? WEEK : 6 * HOUR;
    return cached(`playing-time-player-${signature}`, (owner) => buildSeason(id, label, context, owner.background), { maxAge, stale: true });
  }
  async function warm(it, { force = false } = {}) {
    const index = await seasonIndex(it, true, force);
    const games = index.matches.filter((f) => f.available && Date.parse(f.date) <= now());
    const results = await Promise.allSettled(games.map((f) => match(f, true, force)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) throw new Error(`${failed.length} playing-time games could not be refreshed`);
    return games.length;
  }
  return { manifest, season, warm };
}

export const playingTime = createPlayingTimeService();
