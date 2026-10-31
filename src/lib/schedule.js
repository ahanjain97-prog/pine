import { football, FOOTBALL_DAY, FOOTBALL_HOUR } from "./football.js";

export const SCHEDULE_TIMEZONE = "America/New_York";
const ACTIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT", "SUSP"]);
const FINAL = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

// A single shared day lookup, independent of how many games or staff are watching.
// Include the hour before kickoff so a not-started snapshot doesn't delay the first update.
export function fixtureRefreshMs(fixtures, teamIds, date, now = Date.now()) {
  const distance = Math.round((Date.parse(date + "T12:00:00Z") - Date.parse(scheduleDate(now) + "T12:00:00Z")) / FOOTBALL_DAY);
  if (distance !== 0) return Math.abs(distance) <= 2 ? 6 * FOOTBALL_HOUR : FOOTBALL_DAY;
  const games = fixtures.filter((g) => scheduleDate(Date.parse(g.date)) === date && (teamIds.has(g.home.id) || teamIds.has(g.away.id)));
  if (games.some((g) => ACTIVE.has(g.status) || (g.status === "NS" && Date.parse(g.date) <= now + FOOTBALL_HOUR && Date.parse(g.date) >= now - 3 * FOOTBALL_HOUR))) return FOOTBALL_HOUR / 2;
  if (games.length && games.every((g) => FINAL.has(g.status))) return 6 * FOOTBALL_HOUR;
  return FOOTBALL_HOUR;
}
// TM codes identify the competition even when its displayed name varies by source.
const LEAGUE_CODES = { MLS1: 253, USL: 255, USC3: 489, MNP3: 909, CDN1: 479,
  SE1: 113, SE2: 114, DK2: 120, SC2: 180, PO2: 95, AUS1: 188, HO1A: 234, IR1: 357, UGL1: 585 };
const LEAGUE_NAMES = { "mls": 253, "major league soccer": 253, "usl championship": 255,
  "uslc": 255, "usl league one": 489, "usl league 1": 489, "usl1": 489, "mls next pro": 909,
  "canpl": 479, "a league men": 188, "liga portugal 2": 95, "liga nacional apertura": 234, "uganda premier league": 585 };
const normalize = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
// Keep II, B, U21, women's markers etc.: a parent club must never match its reserve side.
export const teamKey = (name) => normalize(name).split(" ").filter((word) => !["fc", "sc", "cf", "afc"].includes(word)).join(" ").replace(/\b2$/, "ii");
const TEAM_NAMES = {
  "new york red bulls ii": "new york rb ii", "new york city fc ii": "new york city ii",
  "new england revolution ii": "new england ii", "philadelphia union ii": "philadelphia union ii",
  "inter miami cf ii": "inter miami ii", "orlando city b": "orlando city ii", "columbus crew 2": "columbus crew ii",
  "atlanta united 2": "atlanta united ii", "austin fc ii": "austin ii", "north carolina fc": "north carolina",
  "chattanooga fc": "chattanooga", "houston dynamo 2": "houston dynamo ii",
  "san jose earthquakes ii": "the town", "the town fc": "the town", "st louis city2": "st louis city ii",
  "sporting kansas city ii": "sporting kc ii", "sporting kansas city": "sporting kansas city",
  "new york cosmos": "ny cosmos", "colorado springs switchbacks fc": "colorado springs",
  "sandvikens if": "sandviken", "helsingborgs if": "helsingborg", "real monarchs slc": "real monarchs",
  "athletic club boise": "boise", "red bull new york ii": "new york rb ii",
  "connecticut united fc": "connecticut fc", "los angeles galaxy ii": "ventura county",
  "cd motagua tegucigalpa": "cd motagua", "sporting club jacksonville": "sporting jax",
  "akademisk boldklub": "ab copenhagen", "greenock morton fc": "morton", "real salt lake city": "real salt lake",
  "kampala capital city authority fc": "kcca", "whitecaps fc 2": "vancouver whitecaps ii",
};
const aliases = new Map(Object.entries(TEAM_NAMES).map(([from, to]) => [teamKey(from), teamKey(to)]));
const canonicalTeam = (name) => aliases.get(teamKey(name)) || teamKey(name);
export function matchTeam(name, teams) {
  const key = canonicalTeam(name);
  if (!key) return null;
  const matches = teams.filter((team) => !team.national && canonicalTeam(team.name) === key);
  const ids = [...new Set(matches.map((team) => team.id))];
  return ids.length === 1 ? matches.find((team) => team.id === ids[0]) : null;
}
export function matchLeague(player, leagues) {
  const name = normalize(player.league || player.impect_competition);
  const id = LEAGUE_CODES[player.league_code] || LEAGUE_NAMES[name];
  if (id) return leagues.find((league) => league.id === id) || null;
  const matches = leagues.filter((league) => league.type === "League" && normalize(league.name) === name);
  return name && matches.length === 1 ? matches[0] : null;
}
export function seasonFor(league, date) {
  const seasons = [...(league.seasons || [])].sort((a, b) => b.year - a.year);
  return seasons.find((season) => season.start <= date && season.end >= date)?.year
    || seasons.find((season) => season.year === Number(date.slice(0, 4)))?.year || null;
}
export function scheduleDate(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SCHEDULE_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
export function validateScheduleDate(date, now = Date.now()) {
  const parsed = new Date(date + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error("Choose a valid date (YYYY-MM-DD)."), { status: 400 });
  }
  if (Math.abs(Date.parse(date + "T12:00:00Z") - Date.parse(scheduleDate(now) + "T12:00:00Z")) > 366 * FOOTBALL_DAY) {
    throw Object.assign(new Error("Choose a date within one year of today."), { status: 400 });
  }
  return date;
}
export function reduceFixture(row) {
  if (!row.fixture?.id || !Number.isFinite(row.fixture.timestamp) || !row.teams?.home?.id || !row.teams?.away?.id || !row.league?.id) {
    throw new Error("API-Football returned an incomplete fixture. The previous schedule has been kept.");
  }
  return { id: row.fixture.id, date: new Date(row.fixture.timestamp * 1000).toISOString(),
    status: row.fixture.status?.short || "TBD", status_label: row.fixture.status?.long || "Time to be confirmed",
    league: { id: row.league.id, name: row.league.name, country: row.league.country },
    home: { id: row.teams.home.id, name: row.teams.home.name }, away: { id: row.teams.away.id, name: row.teams.away.name },
    goals: { home: row.goals?.home ?? null, away: row.goals?.away ?? null } };
}

export function createScheduleService({ client = football, now = Date.now } = {}) {
  async function day(players, requestedDate) {
    const date = validateScheduleDate(requestedDate || scheduleDate(now()), now());
    const base = { date, timezone: SCHEDULE_TIMEZONE, configured: client.configured(), games: [], unmatched: [], warnings: [],
      updated_at: null, stale: false, total_players: players.length, matched_players: 0, refresh_after_ms: FOOTBALL_HOUR, cache_minutes: 60 };
    const college = players.filter((p) => /\bncaa\b/i.test(p.league || ""));
    base.college_players = college.length;
    base.unmatched = college.map((p) => ({ id: p.id, name: p.name, club: p.club || p.impect_squad, league: p.league,
      reason: "College games aren't supported yet; API-Football doesn't cover NCAA soccer" }));
    const supported = players.filter((p) => !/\bncaa\b/i.test(p.league || ""));
    if (!base.configured || !supported.length) return base;
    const snapshots = [];
    const get = async (...args) => {
      const result = await client.get(...args); snapshots.push(result);
      if (result.error) base.warnings.push(result.error);
      return result.data;
    };
    let leagues;
    try {
      leagues = await get("leagues", {}, { ttl: 30 * FOOTBALL_DAY, reduce: (rows) => rows.map((row) => ({
        id: row.league.id, name: row.league.name, type: row.league.type, country: row.country.name,
        seasons: row.seasons.map(({ year, start, end }) => ({ year, start, end })),
      })) });
    } catch (error) { base.warnings.push(error.message); return base; }
    const access = new Map(), mapped = new Map();
    for (const player of supported) {
      const club = player.club || player.impect_squad;
      const league = matchLeague(player, leagues), season = league && seasonFor(league, date);
      const missing = (reason) => base.unmatched.push({ id: player.id, name: player.name, club, league: player.league, reason });
      if (!club || ["without club", "free agent", "retired"].includes(normalize(club))) { missing("No current club saved"); continue; }
      if (!league || !season) { missing("Competition or season isn't mapped to API-Football"); continue; }
      try {
        // Explicit season check: the free plan can return a broad date list while rejecting
        // the requested league-season. Never turn that partial coverage into an empty day.
        const scope = `${league.id}-${season}`;
        if (!access.has(scope)) {
          try {
            access.set(scope, await get("fixtures", { league: league.id, season, timezone: SCHEDULE_TIMEZONE }, {
              ttl: FOOTBALL_DAY, reduce: (rows) => rows.map(reduceFixture),
            }));
          } catch (error) { access.set(scope, error); }
        }
        if (access.get(scope) instanceof Error) throw access.get(scope);
        // The league's season fixtures are also its team directory. This confirms league
        // membership, handles cross-border clubs and needs no per-team/player lookups.
        const teams = [...new Map(access.get(scope).flatMap((game) => [game.home, game.away]).map((team) => [team.id, team])).values()];
        const team = matchTeam(club, teams);
        if (!team) { missing("No unique team match; club name needs review"); continue; }
        if (!mapped.has(team.id)) mapped.set(team.id, []);
        mapped.get(team.id).push({ id: player.id, name: player.name, position: player.position, club,
          short_board: Boolean(player.short_board), team_id: team.id });
        base.matched_players++;
      } catch (error) { base.warnings.push(error.message); missing("Schedule coverage unavailable"); }
    }
    if (mapped.size) {
      try {
        const teamIds = new Set(mapped.keys());
        const ttl = (fixtures) => fixtureRefreshMs(fixtures, teamIds, date, now());
        // One global day request catches cup fixtures and matches outside a player's league.
        const fixtures = await get("fixtures", { date, timezone: SCHEDULE_TIMEZONE }, { ttl, reduce: (rows) => rows.map(reduceFixture) });
        base.updated_at = new Date(snapshots.at(-1).at).toISOString();
        base.cache_minutes = ttl(fixtures) / 60_000;
        // Check Pine's shared cache every half hour while this date still has games ahead.
        // Completed/past days need only hourly UI checks, including the rollover to Today.
        const today = date === scheduleDate(now());
        base.refresh_after_ms = today && base.cache_minutes < 360 ? FOOTBALL_HOUR / 2 : FOOTBALL_HOUR;
        const byId = new Map();
        for (const game of fixtures) {
          if (scheduleDate(Date.parse(game.date)) !== date) continue;
          const boardPlayers = [...(mapped.get(game.home.id) || []), ...(mapped.get(game.away.id) || [])];
          if (boardPlayers.length) byId.set(game.id, { ...game, players: [...new Map(boardPlayers.map((p) => [p.id, p])).values()] });
        }
        base.games = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      } catch (error) { base.warnings.push(error.message); }
    }
    base.stale = snapshots.some((snapshot) => snapshot.stale);
    base.warnings = [...new Set(base.warnings)];
    return base;
  }
  return { day };
}

export function registerSchedule(app, { db, service = createScheduleService() }) {
  app.get("/api/schedule", async (c) => {
    const players = db.all(`SELECT p.id, p.name, p.position, p.club, p.league, p.league_code, p.impect_squad, p.impect_competition,
      max(b.shortlist) AS short_board FROM players p JOIN board_entries b ON b.player_id = p.id GROUP BY p.id ORDER BY p.name COLLATE NOCASE`);
    return c.json(await service.day(players, c.req.query("date")));
  });
}
