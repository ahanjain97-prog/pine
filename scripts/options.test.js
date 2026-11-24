import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { findClub } from "../src/lib/option_clubs.js";
import { optionsPayload, saveRosterDecisions, seasonFor } from "../src/lib/roster_decisions.js";
import { articleDate, isReleaseTitle, ownLink, parseMlsCards, parseWpFeed, runOptionWatch, utcStamp } from "../src/lib/option_watch.js";
import { groupDecisions, groupsOf } from "../public/options.js";
import { enrichOptions, findImpect, scoringIteration, summarizeCard } from "../src/lib/options_impect.js";

// Made-up players and headlines; club names and news pages are the public ones PINE follows.
const dec = (name, club, decision, extra = {}) => ({ name, club, decision, announced: "2026-11-24", source_url: "https://www.example-club.com/news/release", ...extra });

test("release headlines: a club's end-of-season roster news counts; single moves, match notes and call-ups don't", () => {
  for (const t of ["Testville FC Announces 2027 Roster Decisions", "Hounds announce first 2027 roster decisions", "Example Rising Announces 2026 Year-End Roster Moves",
    "Example United Provides First Roster Update", "Example United Says Goodbye to Seven Players", "Example FC picks up contract options on 5 players, other updates announced",
    "Example 2 announce end of year roster updates", "EXFC2 2026 End of Season Roster Update", "Example City B announces 2026 end-of-year roster statuses",
    "Eight Example players from the 2026 squad will return as the club begins shaping its roster for the 2027 season.",
    "Example FC Announces Contract Decisions for Three Players"]) assert.ok(isReleaseTitle(t, 2026), t);
  for (const t of ["Roster Notes", "Example midfielder named to U-17 World Cup roster", "Example and The Town FC Announce Roster for 2025 MLS NEXT Pro Season",
    "Example Defiance Announces Roster Decisions to Conclude 2025 Season", "Sam Example Departs Example City FC After Two Seasons",
    "Example FC Sign Defender Sam Sample to Two-Year Contract Extension Through 2028", "Example United Exercises Purchase Option for Forward Sam Sample",
    "Example 2 acquire MLS NEXT Pro International Roster Slot", "Example FC Announces 2027 Sprint Season Schedule",
    "Example FC players return for 2027 preseason", "Example FC signs Sam Sample through 2027 with club option"]) assert.ok(!isReleaseTitle(t, 2026), t);
});

test("headlines and links are read as text, and only links on the club's own site are kept", () => {
  assert.equal(ownLink("/news/a-release", "www.example-club.com/news"), "https://www.example-club.com/news/a-release");
  assert.equal(ownLink("https://example-club.com/x", "www.example-club.com"), "https://example-club.com/x");
  assert.equal(ownLink("https://evil.test/x", "www.example-club.com"), null);
  assert.equal(ownLink("javascript:alert(1)", "www.example-club.com"), null);
  assert.deepEqual(parseWpFeed([{ date: "2026-11-24T10:00:00", link: "https://www.example-club.com/news/r", title: { rendered: "Roster &#8211; <b>Decisions</b> &amp; more" } },
    { date: "2026-11-23T10:00:00", link: "https://elsewhere.test/r", title: { rendered: "Elsewhere" } }], "www.example-club.com"),
  [{ title: "Roster – Decisions & more", url: "https://www.example-club.com/news/r", published: "2026-11-24" }]);
  const html = `<a class="fm-card-wrap x" href="/news/one" title="One &amp; Two"></a><a class="fm-card-wrap" href="/news/one" title="Dup"></a>`;
  assert.deepEqual(parseMlsCards(html, "www.example-club.com/2/news"), [{ title: "One & Two", url: "https://www.example-club.com/news/one", published: null }]);
  assert.equal(articleDate('<script>{"datePublished":"2026-11-20T15:00:00Z"}</script>'), "2026-11-20T15:00:00Z");
  assert.equal(articleDate('<meta property="article:published_time" content="2026-11-20T10:00:00-05:00">'), "2026-11-20T15:00:00Z", "as UTC");
  assert.equal(utcStamp("2026-11-24 17:36:15", true), "2026-11-24T17:36:15Z");
  assert.equal(utcStamp("2026-11-24"), "2026-11-24");
  assert.deepEqual(parseWpFeed([{ date: "2026-11-24T12:36:15", date_gmt: "2026-11-24T19:36:15", link: "https://www.example-club.com/news/r", title: { rendered: "R" } }], "www.example-club.com")[0].published,
    "2026-11-24T19:36:15Z", "the feed's UTC time, not the club's local one");
  assert.equal(seasonFor(new Date("2027-01-15T00:00:00Z")), 2026);
});

test("research club spellings file under one PINE name and league", () => {
  assert.equal(findClub("MNUFC2").club, "Minnesota United FC 2");
  assert.equal(findClub("Sporting KC II").league, "MLSNP");
  assert.equal(findClub("st. louis city2").club, "St. Louis CITY SC 2");
  assert.equal(findClub("Minnesota United FC").league, "MLS", "a first team isn't its Next Pro side");
  assert.equal(findClub("Nowhere Rovers"), null);
});

// A fake web: each club page answers with what the test puts there; everything else fails.
function fakeWeb(pages) {
  return async (url) => {
    const hit = Object.entries(pages).find(([k]) => url.startsWith(k));
    if (!hit) throw new Error("offline");
    const body = hit[1];
    return { ok: true, status: 200, json: async () => body, text: async () => body };
  };
}
const wp = (items) => items.map(([title, slug, date]) => ({ title: { rendered: title }, link: `https://www.fctulsa.com/news/${slug}/`, date: `${date}T12:00:00` }));

test("the watcher takes in a page quietly the first time, then alerts once per new release (never for MLS first teams)", async () => {
  const db = openDb(":memory:");
  const now = new Date("2026-11-24T18:00:00Z");
  const quiet = await runOptionWatch(db, { now, fetch: fakeWeb({
    "https://www.fctulsa.com/": wp([["Old Example News", "old", "2026-11-01"], ["Testers Announce 2027 Roster Decisions", "first", "2026-11-20"]]),
  }) });
  assert.deepEqual(quiet.map((r) => [r.club, r.alert]), [["FC Tulsa", 0]]);
  assert.equal(db.get("SELECT count(*) AS n FROM activity").n, 0);

  const mlsPage = `<a class="fm-card-wrap" href="/news/crew-2-roster" title="Crew 2 announce end of year roster updates"></a>
    <a class="fm-card-wrap" href="/news/first-team-decisions" title="Example First Team Announces 2026 End of Season Roster Decisions"></a>`;
  // The Columbus page's first read is quiet too; seed it, then post again.
  await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.columbuscrew.com/news": `<a class="fm-card-wrap" href="/news/older" title="Older news"></a>` }) });
  const found = await runOptionWatch(db, { now, fetch: fakeWeb({
    "https://www.fctulsa.com/": wp([["Testers Announce 2027 Roster Decisions", "first", "2026-11-20"], ["Testers Announce Further 2027 Roster Moves", "second", "2026-11-24"],
      ["Testers Roster Decisions to Conclude 2025 Season", "stale", "2025-11-01"]]),
    "https://www.columbuscrew.com/news/crew-2-roster": `{"datePublished":"2026-11-24T10:00:00Z"}`,
    "https://www.columbuscrew.com/news/first-team-decisions": `{"datePublished":"2026-11-23T10:00:00Z"}`,
    "https://www.columbuscrew.com/news": mlsPage,
  }) });
  assert.deepEqual(found.map((r) => [r.club, r.league, r.alert]).sort((a, b) => a[0].localeCompare(b[0])), [["Columbus Crew", "MLS", 0], ["Columbus Crew 2", "MLSNP", 1], ["FC Tulsa", "USLC", 1]]);
  assert.equal(db.get("SELECT count(*) AS n FROM activity").n, 0, "no alerts in PINE: the tab just lists them");
  assert.deepEqual((await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.fctulsa.com/": wp([["Testers Announce Further 2027 Roster Moves", "second", "2026-11-24"]]) }) })), [],
    "a release already seen isn't found again");
});

test("a Next Pro page's first-team story is the first team's; an upload's release takes the club's own headline", async () => {
  const db = openDb(":memory:");
  const now = new Date("2026-11-24T18:00:00Z");
  const page = (cards) => cards.map(([slug, title]) => `<a class="fm-card-wrap" href="/news/${slug}" title="${title}"></a>`).join("");
  const nyc = "https://www.newyorkcityfc.com/news/topics/nycfcii-latest-news";
  await runOptionWatch(db, { now, fetch: fakeWeb({ [nyc]: page([["old", "Older story"]]), "https://www.fctulsa.com/": wp([["Seed", "seed", "2026-11-01"]]) }) });
  saveRosterDecisions(db, { season: 2026, decisions: [dec("Seed Row", "Toronto FC II", "other")] });
  const tulsaUrl = "https://www.fctulsa.com/news/release/";
  saveRosterDecisions(db, { season: 2026, decisions: ["A", "B", "C", "D"].map((n) => dec(`${n} Example`, "FC Tulsa", "option_exercised", { source_url: tulsaUrl })) });
  assert.equal(db.get("SELECT title FROM option_releases WHERE url = ?", tulsaUrl).title, "FC Tulsa roster decisions");
  const found = await runOptionWatch(db, { now, fetch: fakeWeb({
    [nyc]: page([["first-team", "New York City FC Announces Roster Moves for 2027"], ["np", "New York City FC II Announce 2026 End of Season Roster Decisions"]]),
    "https://www.newyorkcityfc.com/news/first-team": `{"datePublished":"2026-11-12T10:00:00Z"}`,
    "https://www.newyorkcityfc.com/news/np": `{"datePublished":"2026-11-13T10:00:00Z"}`,
    "https://www.fctulsa.com/": wp([["Testers Announce 2027 Roster Decisions", "release", "2026-11-24"]]),
  }) });
  assert.deepEqual(found.map((r) => [r.club, r.league, r.alert]).sort((a, b) => a[0].localeCompare(b[0])), [["New York City FC", "MLS", 0], ["New York City FC II", "MLSNP", 1]]);
  assert.equal(db.get("SELECT title FROM option_releases WHERE url = ?", tulsaUrl).title, "Testers Announce 2027 Roster Decisions");
  assert.equal(db.get("SELECT count(*) AS n FROM option_releases WHERE url = ?", tulsaUrl).n, 1);
  saveRosterDecisions(db, { season: 2026, decisions: ["E", "F", "G", "H"].map((n) => dec(`${n} Example`, "Union Omaha", "option_exercised",
    { source_url: "https://www.unionomaha.com/news/2026/11/24/release", announced: "2026-11-24" })) });
  const twice = await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.unionomaha.com/": [{ title: { rendered: "Union Announce 2027 Roster Decisions" },
    link: "https://www.unionomaha.com/news/2026/11/24/release/?utm=x", date: "2026-11-24T12:00:00" }] }) });
  assert.deepEqual(twice.map((r) => r.alert), [0], "Omaha's page is new here, so quiet anyway");
  const again = await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.unionomaha.com/": [{ title: { rendered: "Union Announce More 2027 Roster Decisions" },
    link: "https://www.unionomaha.com/news/2026/11/24/release-2/", date: "2026-11-24T12:00:00" }] }) });
  assert.deepEqual(again.map((r) => r.alert), [0], "a club already announced that day isn't announced twice");
});

test("a run that suddenly finds a pile of releases alerts for none of them", async () => {
  const db = openDb(":memory:");
  const now = new Date("2026-11-24T18:00:00Z");
  await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.fctulsa.com/": wp([["Seed", "seed", "2026-11-01"]]) }) });
  const many = Array.from({ length: 14 }, (_, i) => [`Testers Roster Update ${i + 1}`, `r${i}`, "2026-11-24"]);
  const found = await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.fctulsa.com/": wp(many) }) });
  assert.equal(found.length, 14);
  assert.ok(found.every((r) => !r.alert));
  assert.equal(db.get("SELECT count(*) AS n FROM activity").n, 0);
});

test("uploaded decisions file under PINE names, link players, and announce a club's first decisions (not on the very first upload)", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO users(id, name) VALUES (90, 'Test Scout')");
  db.run("INSERT INTO players(id, name, club, league) VALUES (1, 'Alan Declined', 'Minnesota United FC 2', 'MLS Next Pro')");
  db.run("INSERT INTO players(id, name, club, loan_from, league) VALUES (2, 'Lou Loaned', 'FC Tulsa', 'Minnesota United FC 2', 'USLC')");
  const first = saveRosterDecisions(db, { season: 2026, decisions: [dec("Alan Declined", "MNUFC2", "option_declined"), dec("Lou Loaned", "MNUFC2", "out_of_contract"),
    dec("Kim Kept", "MNUFC2", "option_exercised"), dec("Sid Moved", "Real Monarchs", "option_declined", { announced: "2026-11-10" }),
    dec("Sid Moved", "FC Tulsa", "signed", { announced: "2026-11-18" })] });
  assert.deepEqual([first.decisions, first.decision_clubs, first.new_releases.length, first.unknown_clubs], [5, 3, 0, []]);
  assert.equal(db.get("SELECT count(*) AS n FROM option_releases WHERE alert = 1").n, 0, "the first upload is taken in quietly");
  assert.deepEqual(db.all("SELECT club, name, player_id FROM roster_decisions WHERE player_id IS NOT NULL ORDER BY name").map((r) => [r.club, r.name, r.player_id]),
    [["Minnesota United FC 2", "Alan Declined", 1], ["Minnesota United FC 2", "Lou Loaned", 2]]);

  const phx = { source_url: "https://www.example-club.com/news/phx" };
  const second = saveRosterDecisions(db, { season: 2026, decisions: [dec("Pat Posted", "Phoenix Rising", "out_of_contract", phx),
    dec("Pia Posted", "Phoenix Rising", "guaranteed_contract", phx), dec("Pod Posted", "Phoenix Rising", "guaranteed_contract", phx),
    dec("Pam Posted", "Phoenix Rising", "option_exercised", phx), dec("Solo Signing", "Union Omaha", "signed"),
    dec("Zed Unknown", "Nowhere Rovers", "option_declined")] });
  assert.deepEqual(second.new_releases.map((r) => [r.club, r.league, r.url]), [["Phoenix Rising FC", "USLC", "https://www.example-club.com/news/phx"]]);
  assert.deepEqual(second.unknown_clubs, ["Nowhere Rovers"]);
  assert.equal(db.get("SELECT count(*) AS n FROM option_releases WHERE club = 'Union Omaha'").n, 0, "one signing is a single move, not a release");
  // Later the same club posts its full release: that one is announced.
  const omaha = { source_url: "https://www.example-club.com/news/omaha-release" };
  const third = saveRosterDecisions(db, { season: 2026, decisions: [dec("Solo Signing", "Union Omaha", "signed"),
    ...["Ola", "Oli", "Oma", "Ona", "Ora"].map((n) => dec(`${n} Example`, "Union Omaha", "option_exercised", omaha))] });
  assert.deepEqual(third.new_releases.map((r) => r.club), ["Union Omaha"], "a club with only single moves before still alerts when its release arrives");
  assert.equal(saveRosterDecisions(db, { season: 2026, decisions: [dec("Solo Signing", "Union Omaha", "signed"),
    ...["Ola", "Oli", "Oma", "Ona", "Ora"].map((n) => dec(`${n} Example`, "Union Omaha", "option_exercised", omaha))] }).new_releases.length, 0, "and only once");
  assert.throws(() => saveRosterDecisions(db, { season: 2026, decisions: [dec("Bad Code", "FC Tulsa", "maybe")] }), /unknown decision/);

  const page = optionsPayload(db, 90);
  assert.deepEqual(page.releases.map((r) => r.club).sort(), ["Phoenix Rising FC", "Union Omaha"]);
  const fa = Object.fromEntries(page.decisions.map((d) => [`${d.name}|${d.club}`, d.free_agent]));
  assert.equal(fa["Alan Declined|Minnesota United FC 2"], true);
  assert.equal(fa["Sid Moved|Real Monarchs SLC"], false, "signed by another club since");
  assert.equal(fa["Kim Kept|Minnesota United FC 2"], false);
  const status = Object.fromEntries(page.clubs.map((c) => [c.club, c.status]));
  assert.deepEqual([status["Phoenix Rising FC"], status["FC Tulsa"], status["Union Omaha"], status["Charleston Battery"], status["Brooklyn FC"]], ["posted", "moves", "posted", "none", "none"]);
});

test("the tab's filters: league, free agents, in or not in PINE, and a search on player or club", () => {
  const rows = [
    { id: 1, club: "FC Tulsa", league: "USLC", name: "Ána Example", decision: "option_declined", free_agent: true, announced: "2026-11-24", player_id: 7 },
    { id: 2, club: "FC Tulsa", league: "USLC", name: "Ben Example", decision: "guaranteed_contract", free_agent: false, announced: "2026-11-24", player_id: null },
    { id: 3, club: "Union Omaha", league: "USL1", name: "Cal Example", decision: "out_of_contract", free_agent: true, announced: "2026-11-20", player_id: null },
  ];
  const inPine = (d) => d.player_id != null;
  const names = (f) => groupDecisions(rows, [], { league: "", show: "", pine: "", q: "", ...f }, inPine).flatMap((g) => g.rows.map((r) => r.name));
  assert.deepEqual(names({}), ["Ána Example", "Ben Example", "Cal Example"], "newest club first, free agents first within it");
  assert.deepEqual(names({ league: "USL1" }), ["Cal Example"]);
  assert.deepEqual(names({ show: "fa" }), ["Ána Example", "Cal Example"]);
  assert.deepEqual(names({ pine: "out" }), ["Ben Example", "Cal Example"]);
  assert.deepEqual(names({ q: "ana" }), ["Ána Example"]);
  assert.deepEqual(names({ q: "omaha" }), ["Cal Example"]);
});

test("HTTP: the upload carries the decisions and the tab lists them, without alerts", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pine-options-")), file = join(dir, "pine.db");
  const db = openDb(file);
  db.run("INSERT INTO players(id, name, club, league) VALUES (10001, 'Alan Declined', 'Toronto FC II', 'MLS Next Pro')");
  db.raw.close();
  const child = spawn(process.execPath, ["--import", "./scripts/fixtures/offline-fetch.mjs", "src/server.js"], {
    cwd: process.cwd(), env: { ...process.env, PINE_DB: file, PINE_AUTH: "off", PORT: "0", PINE_OPTION_WATCH: "off",
      PINE_WORKER_TOKEN: "local-test-token", PINE_SITE_PASSWORD: "", IMPECT_USERNAME: "", IMPECT_PASSWORD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } rmSync(dir, { recursive: true, force: true }); });
  let output = "", port;
  child.stdout.on("data", (d) => { output += d; const m = output.match(/localhost:(\d+)/); if (m) port = Number(m[1]); });
  child.stderr.on("data", (d) => { output += d; });
  for (let i = 0; i < 100 && !port; i++) {
    if (child.exitCode !== null) throw new Error(`Server failed to start: ${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const call = (path, method = "GET", body, token) => fetch(`http://127.0.0.1:${port}${path}`, { method, body: body && JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-PINE": "1", ...(token ? { "X-PINE-Worker-Token": token } : {}) } });
  const entry = { name: "Alan Declined", club: "Toronto FC II", reason: "option_declined", announced: "2026-11-24", source_url: "https://www.example-club.com/r" };
  // An older script sends only the free agents: still fine, and nothing lands on the tab.
  assert.equal((await call("/api/worker/free-agents", "PUT", { season: 2026, clubs: ["Toronto FC II"], entries: [entry] }, "local-test-token")).status, 200);
  assert.equal((await (await call("/api/options")).json()).decisions.length, 0);
  const up = await call("/api/worker/free-agents", "PUT", { season: 2026, clubs: ["Toronto FC II"], entries: [entry],
    decisions: [dec("Alan Declined", "Toronto FC II", "option_declined"), dec("Kim Kept", "Toronto FC II", "option_exercised")] }, "local-test-token");
  assert.equal(up.status, 200);
  assert.deepEqual(((({ decisions, decision_clubs }) => [decisions, decision_clubs])(await up.json())), [2, 1]);
  const later = await call("/api/worker/free-agents", "PUT", { season: 2026, clubs: ["Union Omaha"], entries: [],
    decisions: ["Una", "Uri", "Ula", "Uma"].map((n) => dec(`${n} Example`, "Union Omaha", "guaranteed_contract", { source_url: "https://www.example-club.com/omaha" })) }, "local-test-token");
  assert.equal(later.status, 200);
  assert.deepEqual((await later.json()).new_releases.map((r) => r.club), ["Union Omaha"], "a club's first decisions after the first upload alert");
  assert.equal((await (await call("/api/changes")).json()).options, undefined, "no Options alerts in the change poll");
  const tab = await (await call("/api/options")).json();
  assert.deepEqual([tab.season, tab.decisions.length - 3, tab.releases.map((r) => r.club), tab.watch.enabled], [2026, 3, ["Union Omaha"], false], "Toronto's two rows are single moves, not a release");
  assert.equal(tab.decisions.find((d) => d.name === "Alan Declined").player_id, 10001);
  assert.equal((await call("/api/options/check", "POST", {})).status, 200, "auth off: the acting admin can run it (offline here, so it finds nothing)");
  const acts = (await (await call("/api/activity")).json());
  assert.ok(!JSON.stringify(acts).includes("found_option_release"), "and nothing in Activity");
});

// A made-up Impect pool: two leagues' 2026 seasons and one older season.
const it = (id, competition, season = "2026") => ({ id, competition, season });
const fakePool = () => ({ players: [
  { impect_id: 501, name: "Ana Example", squad: "FC Tulsa", iterations: [it(11, "USL Championship")] },
  { impect_id: 502, name: "Ben Example", squad: "Union Omaha", iterations: [it(12, "USL League One")] },
  { impect_id: 503, name: "Ben Example", squad: "Elsewhere FC", iterations: [it(12, "USL League One")] },
  { impect_id: 504, name: "Cal Q. Example", squad: "Minnesota United FC 2", iterations: [it(9, "MLS Next Pro", "2025"), it(13, "MLS Next Pro")] },
  { impect_id: 505, name: "Dee Example", squad: "Minnesota United FC", iterations: [it(14, "MLS")] },
] });
const indexPool = (raw) => {
  const byId = new Map(raw.players.map((p) => [p.impect_id, p])), bySeasonComp = new Map();
  for (const p of raw.players) for (const i of p.iterations) if (i.season === "2026") (bySeasonComp.get(i.competition) || bySeasonComp.set(i.competition, []).get(i.competition)).push(p);
  return { players: raw.players, byId, bySeasonComp };
};

test("Options players link to Impect by name within their league's season, never on a coin flip", () => {
  const pool = indexPool(fakePool());
  assert.equal(findImpect({ name: "Ana Example", club: "FC Tulsa", league: "USLC" }, pool)?.impect_id, 501);
  assert.equal(findImpect({ name: "Ben Example", club: "Union Omaha", league: "USL1" }, pool)?.impect_id, 502, "two Ben Examples in League One: his club settles it");
  assert.equal(findImpect({ name: "Ben Example", club: "Westchester SC", league: "USL1" }, pool), null, "and with no club to settle it, no guess");
  assert.equal(findImpect({ name: "Cal Example", club: "MNUFC2", league: "MLSNP" }, pool)?.impect_id, 504, "first and last name, a middle initial on one side");
  assert.equal(findImpect({ name: "Dee Example", club: "Minnesota United FC", league: "MLS" }, pool)?.impect_id, 505, "first team: by club");
  assert.equal(findImpect({ name: "Ana Example", club: "FC Tulsa", league: "USLC" }, pool, 503)?.impect_id, 503, "a PINE player's own link wins");
  assert.deepEqual(scoringIteration(pool.byId.get(504), "MLSNP", 2026), it(13, "MLS Next Pro"));
  assert.equal(scoringIteration(pool.byId.get(505), "MLS", 2026), null, "MLS isn't a benchmark league: no data tag");
});

test("the tags come from the KPI card: all his league minutes, and the average of his position's category percentiles", () => {
  assert.deepEqual(summarizeCard({ iteration: { id: 11, competition: "USL Championship" }, squad: "FC Tulsa", position: "CB",
    positions: [{ minutes: 1500 }, { minutes: 200 }],
    categories: [{ percentile: 70 }, { percentile: 50 }, { percentile: null }, { percentile: 99, composite: true }] }),
  { minutes: 1700, group: "CB", data_pct: 60, iteration_id: 11, competition: "USL Championship", squad: "FC Tulsa" });
  assert.equal(summarizeCard({ empty: true }), null);
});

test("linking runs over the decisions offline, keeps results across uploads, and the tab filters on them", async () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO users(id, name) VALUES (90, 'Test Scout')");
  saveRosterDecisions(db, { season: 2026, decisions: [dec("Ana Example", "FC Tulsa", "option_declined", { position: "D" }),
    dec("Cal Example", "MNUFC2", "out_of_contract"), dec("Zed Nobody", "FC Tulsa", "out_of_contract", { position: "F" })] });
  const cards = { 501: { iteration: { id: 11, competition: "USL Championship" }, squad: "FC Tulsa", position: "CB", positions: [{ minutes: 2100 }], categories: [{ percentile: 72 }] },
    504: { iteration: { id: 13, competition: "MLS Next Pro" }, squad: "Minnesota United FC 2", position: "W", positions: [{ minutes: 640 }], categories: [{ percentile: 41 }] } };
  const asked = [];
  const r = await enrichOptions(db, { playerPool: async () => fakePool(), playerKpiCard: async (id, o) => { asked.push([id, o.iterationId]); return cards[id]; } });
  assert.deepEqual([r.matched, r.scored, r.total], [2, 2, 3]);
  assert.deepEqual(asked.sort(), [[501, 11], [504, 13]]);
  // A new upload replaces the decisions; the Impect links stay.
  saveRosterDecisions(db, { season: 2026, decisions: [dec("Ana Example", "FC Tulsa", "option_declined", { position: "D" }), dec("Zed Nobody", "FC Tulsa", "out_of_contract", { position: "F" })] });
  const rows = optionsPayload(db, 90).decisions;
  const ana = rows.find((d) => d.name === "Ana Example");
  assert.deepEqual([ana.impect_id, ana.minutes, ana.position_group, ana.data_pct], [501, 2100, "CB", 72]);
  const inPine = () => false;
  const names = (f) => groupDecisions(rows, [], { league: "", show: "", pine: "", pos: "", goodMin: false, goodData: false, q: "", ...f }, inPine).flatMap((g) => g.rows.map((x) => x.name));
  assert.deepEqual(names({ pos: "CB" }), ["Ana Example"]);
  assert.deepEqual(names({ pos: "ST" }), ["Zed Nobody"], "no Impect position: the release's F counts as W or ST");
  assert.deepEqual(names({ goodMin: true, goodData: true }), ["Ana Example"]);
  assert.deepEqual(groupsOf({ position: "M" }), ["MID", "AM"]);
});

test("clubs list newest release first, by posting time within a day; a day-only release picks up its time later", async () => {
  const rows = ["Early FC", "Late FC", "Older FC"].map((club, i) => ({ id: i + 1, club, league: "USLC", name: `${club} Player`, decision: "option_declined", announced: club === "Older FC" ? "2026-11-20" : "2026-11-24" }));
  const releases = [{ club: "Early FC", published: "2026-11-24T14:00:00Z", found_at: "2026-11-24 14:05:00" },
    { club: "Late FC", published: "2026-11-24T19:36:15Z", found_at: "2026-11-24 19:40:00" },
    { club: "Older FC", published: "2026-11-20", found_at: "2026-11-24 13:00:00" }];
  const f = { league: "", show: "", pine: "", pos: "", goodMin: false, goodData: false, q: "" };
  assert.deepEqual(groupDecisions(rows, releases, f, () => false).map((g) => g.club), ["Late FC", "Early FC", "Older FC"]);

  const db = openDb(":memory:");
  const now = new Date("2026-11-24T22:00:00Z");
  await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.fctulsa.com/": wp([["Seed", "seed", "2026-11-01"]]) }) });
  saveRosterDecisions(db, { season: 2026, decisions: [dec("Seed Row", "Toronto FC II", "other")] });
  const url = "https://www.fctulsa.com/news/release/";
  saveRosterDecisions(db, { season: 2026, decisions: ["A", "B", "C", "D"].map((n) => dec(`${n} Example`, "FC Tulsa", "option_exercised", { source_url: url })) });
  assert.equal(db.get("SELECT published FROM option_releases WHERE url = ?", url).published, "2026-11-24");
  await runOptionWatch(db, { now, fetch: fakeWeb({ "https://www.fctulsa.com/": [{ title: { rendered: "Testers Announce 2027 Roster Decisions" }, link: url, date: "2026-11-24T12:36:15", date_gmt: "2026-11-24T19:36:15" }] }) });
  assert.equal(db.get("SELECT published FROM option_releases WHERE url = ?", url).published, "2026-11-24T19:36:15Z");
});
