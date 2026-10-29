// League playing time for every position, including goalkeepers. Raw KPI payloads are reduced
// before caching; a squad/match download is shared by every player and survives server restarts.
import { impectGet, iterations, getImpectPlayer } from "./impect.js";
import { readDisk, writeDisk } from "./disk_cache.js";
import { norm } from "./physical.js";

const TTL = 12 * 60 * 60 * 1000;
const FORMAT = 1;
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
  const memory = new Map(), building = new Map(), queue = [];
  let active = 0, nextStart = 0, timer = null;
  function pump() {
    if (!queue.length || active >= 3 || timer) return;
    const delay = nextStart - Date.now();
    if (delay > 0) { timer = setTimeout(() => { timer = null; pump(); }, delay); return; }
    const task = queue.shift();
    active++;
    nextStart = Date.now() + intervalMs;
    Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => { active--; pump(); });
    pump();
  }
  const download = (path) => new Promise((resolve, reject) => {
    queue.push({ run: () => get(path, { store: false }), resolve, reject });
    pump();
  });
  function remember(key, value) {
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > 256) memory.delete(memory.keys().next().value);
    return value;
  }
  async function cached(key, build) {
    const hit = memory.get(key) || read(key);
    if (hit?.format === FORMAT && now() - hit.at < TTL) return remember(key, hit).data;
    if (building.has(key)) return building.get(key);
    const promise = Promise.resolve().then(build).then((data) => {
      const value = { format: FORMAT, at: now(), data };
      remember(key, value);
      write(key, value);
      return data;
    }).finally(() => building.delete(key));
    building.set(key, promise);
    return promise;
  }
  function seasonIndex(it) {
    return cached(`playing-time-index-${it.id}`, async () => {
      const [squads, matches] = await Promise.all([
        download(`/v5/customerapi/iterations/${it.id}/squads`),
        download(`/v5/customerapi/iterations/${it.id}/matches`),
      ]);
      const teams = await Promise.all(squads.filter((s) => s.access !== false).map(async (s) => {
        const rows = await download(`/v5/customerapi/iterations/${it.id}/squads/${s.id}/player-kpis`);
        const players = new Map();
        for (const r of rows) players.set(Number(r.playerId), (players.get(Number(r.playerId)) || 0) + positive(r.playDuration));
        return { id: Number(s.id), name: s.name, players: [...players] };
      }));
      return { teams, matches: matches.map((m) => ({
        id: m.id, date: m.scheduledDate, home: m.homeSquadId, away: m.awaySquadId,
        available: m.available === true, stage: m.matchDay?.name || null,
      })), names: Object.fromEntries(squads.map((s) => [s.id, s.name])) };
    });
  }
  const match = (id) => cached(`playing-time-match-${id}`, async () => reduceMatch(await download(`/v5/customerapi/matches/${id}/player-kpis`)));

  async function manifest(id) {
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

  async function season(id, label, { joined, club } = {}) {
    id = Number(id);
    const m = await manifest(id);
    const its = m.iterations.filter((i) => String(i.season) === String(label));
    if (!its.length) return { season: String(label), teams: [], minutes: null, share: null };
    const clock = now();
    const groups = await Promise.all(its.map(async (it) => {
      const index = await seasonIndex(it);
      const teams = index.teams.filter((t) => t.players.some(([pid, seconds]) => pid === id && seconds > 0));
      return Promise.all(teams.map(async (team) => {
        const fixtures = index.matches.filter((f) => (f.home === team.id || f.away === team.id) && Number.isFinite(Date.parse(f.date)) && Date.parse(f.date) <= clock)
          .sort((a, b) => a.date.localeCompare(b.date));
        const games = await Promise.all(fixtures.map(async (f) => {
          if (!f.available) return { ...f, minutes: null, possible_minutes: null };
          const d = await match(f.id);
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
  return { manifest, season };
}

export const playingTime = createPlayingTimeService();
