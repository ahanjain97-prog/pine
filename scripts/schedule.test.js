import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { createFootballClient, FOOTBALL_DAY, FOOTBALL_HOUR } from "../src/lib/football.js";
import { createScheduleService, matchTeam, matchLeague, registerSchedule, scheduleDate, validateScheduleDate } from "../src/lib/schedule.js";
import { easternDate, fixtureGroup } from "../public/today.js";

const NOW = Date.parse("2026-10-31T18:00:00Z");
const payload = (response, errors = []) => Response.json({ response, errors, results: response.length, paging: { current: 1, total: 1 } });
function setup(options = {}) {
  const disk = new Map(), calls = [];
  let time = NOW, handler = () => payload([{ id: 1 }]);
  const shared = { read: (key) => structuredClone(disk.get(key)), write: (key, value) => disk.set(key, structuredClone(value)),
    now: () => time, spacingMs: 0, credentials: () => ({ key: "test-key", rapid: false }),
    fetcher: async (url, init) => { calls.push({ url: new URL(url), init }); return handler(new URL(url), init); }, ...options };
  return { disk, calls, shared, client: createFootballClient(shared), advance: (ms) => { time += ms; }, handle: (fn) => { handler = fn; } };
}

test("concurrent viewers, reloads and restarts share one persistent hourly download", async () => {
  const t = setup();
  const get = (client = t.client) => client.get("fixtures", { date: "2026-10-31", timezone: "America/New_York" });
  await Promise.all(Array.from({ length: 20 }, () => get()));
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].init.headers["x-apisports-key"], "test-key");
  await get(createFootballClient(t.shared));
  assert.equal(t.calls.length, 1, "restart reads the same disk cache");
  t.advance(FOOTBALL_HOUR - 1); await get(); assert.equal(t.calls.length, 1);
  t.advance(1); await get(); assert.equal(t.calls.length, 2);
});

test("provider errors inside HTTP 200 never become empty fixtures; failures are throttled across restarts", async () => {
  const t = setup();
  t.handle(() => payload([], { plan: "Not allowed" }));
  await assert.rejects(t.client.get("fixtures", { league: 489, season: 2026 }), /plan doesn't cover/);
  await assert.rejects(createFootballClient(t.shared).get("fixtures", { league: 489, season: 2026 }), /plan doesn't cover/);
  await assert.rejects(t.client.get("fixtures", { league: 255, season: 2026 }), /plan doesn't cover/);
  assert.equal(t.calls.length, 1, "account-level cooldown also protects other requests");
  t.advance(FOOTBALL_HOUR); t.handle(() => payload([]));
  assert.deepEqual((await t.client.get("fixtures", { league: 489, season: 2026 })).data, []);
  assert.equal(t.calls.length, 2);
});

test("failed refreshes retain the last good fixtures and report their real age", async () => {
  const t = setup();
  const before = await t.client.get("fixtures");
  t.advance(FOOTBALL_HOUR); t.handle(() => { throw new Error("network down"); });
  const stale = await t.client.get("fixtures");
  assert.deepEqual(stale.data, before.data);
  assert.equal(stale.at, NOW); assert.equal(stale.stale, true); assert.match(stale.error, /Couldn't reach/);
  assert.equal((await createFootballClient(t.shared).get("fixtures")).stale, true);
  assert.equal(t.calls.length, 2, "failure cooldown is durable");
});

test("request caps count misses and failures, survive restart, and reset at UTC midnight", async () => {
  const t = setup({ dailyLimit: () => 2 });
  await t.client.get("fixtures", { date: "2026-10-30" });
  await t.client.get("fixtures", { date: "2026-10-31" });
  const restarted = createFootballClient(t.shared);
  await assert.rejects(restarted.get("fixtures", { date: "2026-11-01" }), /budget/);
  assert.equal(t.calls.length, 2); assert.equal(restarted.usage().count, 2);
  await restarted.get("fixtures", { date: "2026-10-31" });
  assert.equal(t.calls.length, 2, "cached data remains accessible after the cap");
  t.advance(FOOTBALL_DAY);
  await restarted.get("fixtures", { date: "2026-11-01" });
  assert.equal(t.calls.length, 3); assert.equal(restarted.usage().count, 1);
});

test("provider quota reserve and 429s stop requests; malformed and paginated data is rejected", async () => {
  const t = setup();
  t.handle(() => Response.json({ response: [], errors: [], results: 0 }, { headers: { "x-ratelimit-requests-remaining": "5" } }));
  await t.client.get("fixtures", { date: "2026-10-31" });
  await assert.rejects(t.client.get("fixtures", { date: "2026-11-01" }), /budget/);
  assert.equal(t.calls.length, 1);
  const rate = setup(); rate.handle(() => Response.json({}, { status: 429 }));
  await assert.rejects(rate.client.get("fixtures"), /request limit/);
  await assert.rejects(rate.client.get("leagues"), /request limit/); assert.equal(rate.calls.length, 1);
  const bad = setup(); bad.handle(() => Response.json({ response: [], results: 20, errors: [], paging: { total: 2 } }));
  await assert.rejects(bad.client.get("fixtures"), /incomplete data/);
});

test("the in-process request cap still holds if the disk cache cannot persist writes", async () => {
  const t = setup({ dailyLimit: () => 1, read: () => null, write: () => {} });
  await t.client.get("fixtures", { date: "2026-10-31" });
  await assert.rejects(t.client.get("fixtures", { date: "2026-11-01" }), /budget/);
  assert.equal(t.calls.length, 1);
});

test("RapidAPI uses its own host and headers; unconfigured clients never dispatch", async () => {
  const t = setup({ credentials: () => ({ key: "rapid-key", rapid: true }) });
  await t.client.get("fixtures");
  assert.equal(t.calls[0].url.hostname, "api-football-v1.p.rapidapi.com");
  assert.equal(t.calls[0].init.headers["x-rapidapi-key"], "rapid-key");
  assert.equal(t.calls[0].init.headers["x-apisports-key"], undefined);
  const off = setup({ credentials: () => ({}) });
  assert.equal(off.client.configured(), false);
  await assert.rejects(off.client.get("fixtures"), /not configured/); assert.equal(off.calls.length, 0);
});

const leagues = [
  { league: { id: 489, name: "USL League One", type: "League" }, country: { name: "USA" }, seasons: [{ year: 2026, start: "2026-03-01", end: "2026-11-30" }] },
  { league: { id: 909, name: "MLS Next Pro", type: "League" }, country: { name: "USA" }, seasons: [{ year: 2026, start: "2026-03-01", end: "2026-11-30" }] },
];
const fixture = (id, home, away, date = "2026-10-31T23:00:00Z", league = 489, status = "NS") => ({
  fixture: { id, timestamp: Date.parse(date) / 1000, status: { short: status, long: status === "FT" ? "Match Finished" : "Not Started" } },
  league: { id: league, name: league === 489 ? "USL League One" : "Cup", country: "USA" },
  teams: { home, away }, goals: { home: status === "FT" ? 0 : null, away: status === "FT" ? 0 : null },
});
const richmond = { id: 10, name: "Richmond Kickers" }, greenville = { id: 20, name: "Greenville Triumph" };
const leagueGames = [fixture(1, richmond, greenville)];
const players = [
  { id: 1, name: "Example One", club: "Richmond Kickers FC", league_code: "USC3", position: "CM", short_board: 1 },
  { id: 2, name: "Example Two", club: "Greenville Triumph SC", league: "USL League One", short_board: 0 },
];
function serviceSetup() {
  const t = setup();
  t.handle((url) => url.pathname === "/leagues" ? payload(leagues)
    : url.searchParams.has("league") ? payload(leagueGames)
      : payload([fixture(2, richmond, greenville, "2026-11-01T02:00:00Z", 1095, "FT"), fixture(3, richmond, greenville, "2026-11-01T05:00:00Z")]));
  return { ...t, service: createScheduleService({ client: t.client, now: t.shared.now }) };
}

test("schedule matches both teams by league and stable ID, includes cups, preserves 0–0, and honors Eastern dates", async () => {
  const t = serviceSetup();
  const result = await t.service.day(players, "2026-10-31");
  assert.equal(result.games.length, 1, "UTC Nov 1 at 02:00 is still Oct 31 in Eastern time; 05:00 is next day");
  assert.equal(result.games[0].league.id, 1095, "cup matches are included without another cup request");
  assert.deepEqual(result.games[0].players.map((p) => [p.id, p.short_board]), [[1, true], [2, false]]);
  assert.deepEqual(result.games[0].goals, { home: 0, away: 0 });
  assert.equal(result.matched_players, 2); assert.equal(result.updated_at, new Date(NOW).toISOString());
  assert.deepEqual(result.unmatched, []); assert.deepEqual(result.warnings, []);
  assert.equal(t.calls.length, 3, "one index, one league directory, one shared day");
  const changed = await t.service.day(players.map((p) => ({ ...p, short_board: 0 })), "2026-10-31");
  assert.ok(changed.games[0].players.every((p) => p.short_board === false));
  assert.equal(t.calls.length, 3, "board membership isn't frozen into the provider cache");
  await t.service.day(players, "2026-11-01");
  assert.equal(t.calls.length, 4, "another date reuses the season's team directory");
});

test("league matching is strict and reserve, senior and women's teams stay separate", () => {
  assert.equal(matchTeam("Toronto FC II", [{ id: 1, name: "Toronto FC" }]), null);
  assert.equal(matchTeam("Greenville Triumph", [{ id: 1, name: "Greenville Triumph W" }]), null);
  assert.equal(matchTeam("Chattanooga", [{ id: 1, name: "Chattanooga Red Wolves" }]), null);
  assert.equal(matchTeam("New York Red Bulls II", [{ id: 1, name: "New York RB II" }]).id, 1);
  assert.equal(matchTeam("Whitecaps FC 2", [{ id: 1, name: "Vancouver Whitecaps II" }]).id, 1);
  assert.equal(matchTeam("Colorado Rapids 2", [{ id: 1, name: "Colorado Rapids II" }]).id, 1);
  assert.equal(matchTeam("St. Louis CITY SC 2", [{ id: 1, name: "St. Louis City II" }]).id, 1);
  assert.equal(matchTeam("Club FC", [{ id: 1, name: "Club FC" }, { id: 2, name: "Club SC" }]), null);
  assert.equal(matchLeague({ league: "Premier League" }, [{ id: 1, type: "League", name: "Premier League" }, { id: 2, type: "League", name: "Premier League" }]), null);
});

test("an empty board and an unconfigured source make no provider requests", async () => {
  const t = serviceSetup();
  const empty = await t.service.day([], "2026-10-31");
  assert.equal(empty.total_players, 0); assert.equal(t.calls.length, 0);
  const off = setup({ credentials: () => ({}) });
  const result = await createScheduleService({ client: off.client, now: off.shared.now }).day(players, "2026-10-31");
  assert.equal(result.configured, false); assert.equal(off.calls.length, 0);
});

test("current club takes precedence over old Impect links and missing mappings remain visible", async () => {
  const t = serviceSetup();
  const result = await t.service.day([
    { ...players[0], club: "New Club", impect_squad: "Richmond Kickers" },
    { ...players[1], league: "NCAA" },
  ], "2026-10-31");
  assert.equal(result.games.length, 0); assert.equal(result.unmatched.length, 2);
  assert.match(result.unmatched[0].reason, /unique team/);
  assert.match(result.unmatched[1].reason, /Competition/);
  assert.equal(t.calls.length, 2, "no global day call when no team can be matched");
});

test("free-plan denial is a coverage warning, never a falsely complete empty day", async () => {
  const t = serviceSetup();
  t.handle((url) => url.pathname === "/leagues" ? payload(leagues) : payload([], { plan: "Free plans do not have access to this season" }));
  const result = await t.service.day(players, "2026-10-31");
  assert.equal(result.unmatched.length, 2); assert.match(result.warnings[0], /plan doesn't cover/);
  assert.equal(t.calls.length, 2);
});

test("date validation rejects impossible dates and applies Eastern time across daylight saving", () => {
  for (const date of ["2026-02-30", "2026-99-01", "2026-11-31", "abc", "2026-1-1", "2028-01-01"]) {
    assert.throws(() => validateScheduleDate(date, NOW), (e) => e.status === 400);
  }
  for (const time of ["2026-11-01T03:59:59Z", "2026-11-01T04:00:00Z", "2026-11-01T06:01:00Z", "2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z"]) {
    assert.equal(scheduleDate(Date.parse(time)), easternDate(Date.parse(time)));
  }
  assert.equal(scheduleDate(Date.parse("2026-11-01T03:59:59Z")), "2026-10-31");
  assert.equal(scheduleDate(Date.parse("2026-11-01T04:00:00Z")), "2026-11-01");
  assert.equal(fixtureGroup("FT"), "Finished"); assert.equal(fixtureGroup("PST"), "Other fixtures");
});

test("the schedule endpoint reads every board player once and updates Short Board membership immediately", async (t) => {
  const db = openDb(":memory:"); t.after(() => db.raw.close());
  db.run("INSERT INTO players(id,name,club) VALUES(1,'Example One','Richmond Kickers'),(2,'Off board','Greenville Triumph')");
  db.run("INSERT INTO board_entries(player_id,role,rank,shortlist) VALUES(1,'CM1',0,0),(1,'CM2',0,1)");
  const app = new Hono();
  app.use("/api/*", async (c, next) => c.req.header("X-Test-Auth") ? next() : c.json({ error: "Not signed in" }, 401));
  const seen = [];
  registerSchedule(app, { db, service: { day: async (rows, date) => { seen.push(rows); return { date, players: rows }; } } });
  assert.equal((await app.request("/api/schedule")).status, 401);
  const response = await app.request("/api/schedule?date=2026-10-31", { headers: { "X-Test-Auth": "1" } });
  assert.equal(response.status, 200); assert.equal(seen[0].length, 1); assert.equal(seen[0][0].short_board, 1);
  assert.equal("summary" in seen[0][0], false, "the provider join doesn't read staff scouting notes");
  db.run("UPDATE board_entries SET shortlist=0 WHERE player_id=1");
  await app.request("/api/schedule", { headers: { "X-Test-Auth": "1" } });
  assert.equal(seen[1][0].short_board, 0);
});
