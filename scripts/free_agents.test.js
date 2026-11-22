import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { clubsAgree, entriesFromDecisions, freeAgentFor, freeAgentOverride, linkFreeAgents, saveFreeAgents } from "../src/lib/free_agents.js";
import { mergePlayer } from "../src/lib/ncaa.js";
import { tmSyncFields } from "../src/lib/tm_sync.js";
import { parseCsv } from "./free-agents.mjs";

// Made-up players in the research CSV's shape.
const row = (player, club, decision, pub_date = "2026-11-17", extra = {}) => ({ player, club, decision, pub_date, source_url: "https://example.com/release", ...extra });
const entry = (name, club, reason = "option_declined", extra = {}) => ({ name, club, reason, announced: "2026-11-17", source_url: "https://example.com/release", ...extra });

test("club names agree across the ways releases and PINE write them", () => {
  assert.ok(clubsAgree("MNUFC2", "Minnesota United FC 2"));
  assert.ok(clubsAgree("St. Louis CITY2", "St. Louis CITY SC 2"));
  assert.ok(clubsAgree("Sporting KC II", "Sporting Kansas City II"));
  assert.ok(clubsAgree("Real Monarchs", "Real Monarchs SLC"));
  assert.ok(clubsAgree("Austin FC", "Austin FC II"));
  assert.ok(!clubsAgree("Orlando City B", "Huntsville City FC"), "City and FC alone don't make two clubs the same");
  assert.ok(!clubsAgree("Toronto FC II", null));
});

test("one entry per free agent: declined or out of contract, unless he's since signed", () => {
  const { entries, skipped } = entriesFromDecisions([
    row("Alan Declined", "Toronto FC II", "option_declined"),
    row("Ollie Expired", "Real Monarchs", "out_of_contract", ""),
    row("Ted Talks", "Real Monarchs", "out_of_contract"), row("Ted Talks", "Real Monarchs", "negotiating"),
    row("Sid Moved", "Sporting KC II", "option_declined", "2026-11-10"), row("Sid Moved", "Carolina Core FC", "signed", "2026-11-18"),
    row("Kept Player", "MNUFC2", "option_exercised"),
    row("Ray Junior Jr.", "Orlando City B", "option_declined"),
  ]);
  assert.deepEqual(entries.map((e) => [e.name, e.reason, e.announced, e.in_talks]), [
    ["Alan Declined", "option_declined", "2026-11-17", false],
    ["Ollie Expired", "out_of_contract", null, false],
    ["Ted Talks", "out_of_contract", "2026-11-17", true],
    ["Ray Junior Jr.", "option_declined", "2026-11-17", false],
  ]);
  assert.deepEqual(skipped, [{ name: "Sid Moved", club: "Sporting KC II", because: "signed (Carolina Core FC)" }]);
});

test("entries link to PINE players by name only when the club agrees, including the club he's on loan from", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO players(id, name, club, league) VALUES (1, 'Alan Declined', 'Toronto FC II', 'MLS Next Pro')");
  db.run("INSERT INTO players(id, name, club, loan_from, league) VALUES (2, 'Lou Loaned', 'Tulsa Test FC', 'Minnesota United FC 2', 'USLC')");
  db.run("INSERT INTO players(id, name, club, league) VALUES (3, 'Sam Same', 'Different Rovers', 'USL1')");
  db.run("INSERT INTO players(id, name, club, league) VALUES (4, 'Ray Junior', 'Orlando City B', 'MLS Next Pro')");
  const r = saveFreeAgents(db, { season: 2026, clubs: ["Toronto FC II", "MNUFC2", "Colorado Rapids 2", "Orlando City B"], entries: [
    entry("Alan Declined", "Toronto FC II"), entry("Lou Loaned", "MNUFC2"), entry("Sam Same", "Colorado Rapids 2", "out_of_contract"),
    entry("Ray Junior Jr.", "Orlando City B"),
  ] });
  assert.deepEqual(r, { season: 2026, clubs: 4, entries: 4, in_pine: 3, not_in_pine: ["Sam Same (Colorado Rapids 2)"] });
  const link = (name) => db.get("SELECT player_id FROM free_agents WHERE name = ?", name).player_id;
  assert.equal(link("Alan Declined"), 1);
  assert.equal(link("Lou Loaned"), 2, "on loan from MNUFC2");
  assert.equal(link("Sam Same"), null, "same name, different club: not him");
  assert.equal(link("Ray Junior Jr."), 4, "Jr. or not, the same player");
});

test("an upload replaces only the clubs it covers, keeps links when a club changes, and checks its input", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO players(id, name, club) VALUES (1, 'Alan Declined', 'Toronto FC II')");
  saveFreeAgents(db, { season: 2026, clubs: ["Toronto FC II", "Real Monarchs"], entries: [entry("Alan Declined", "Toronto FC II"), entry("Ollie Expired", "Real Monarchs")] });
  db.run("UPDATE players SET club = 'Without Club' WHERE id = 1"); // his Transfermarkt club after the decision
  saveFreeAgents(db, { season: 2026, clubs: ["Toronto FC II"], entries: [entry("Alan Declined", "Toronto FC II", "option_declined", { in_talks: true })] });
  assert.deepEqual(db.all("SELECT club, name, player_id, in_talks FROM free_agents ORDER BY club").map((x) => [x.club, x.name, x.player_id, x.in_talks]),
    [["Real Monarchs", "Ollie Expired", null, 0], ["Toronto FC II", "Alan Declined", 1, 1]]);
  db.run("INSERT INTO players(id, name, club) VALUES (2, 'Ollie Expired', 'Real Monarchs SLC')");
  assert.equal(linkFreeAgents(db), 1, "a player added later picks up his entry");
  assert.throws(() => saveFreeAgents(db, { clubs: ["X"], entries: [] }), /season/);
  assert.throws(() => saveFreeAgents(db, { season: 2026, clubs: [], entries: [] }), /clubs/);
  assert.throws(() => saveFreeAgents(db, { season: 2026, clubs: ["A FC"], entries: [entry("Zed", "B FC")] }), /isn't one of the clubs/);
  assert.throws(() => saveFreeAgents(db, { season: 2026, clubs: ["A FC"], entries: [entry("Zed", "A FC", "released")] }), /reason/);
  assert.throws(() => saveFreeAgents(db, { season: 2026, clubs: ["A FC"], entries: [entry("Zed", "A FC", "option_declined", { source_url: "javascript:alert(1)" })] }), /web link/);
});

test("Edit details can set it by hand: Yes without a list entry, No to hide one, never once he's signed", () => {
  const listed = { reason: "option_declined", club: "Toronto FC II" };
  assert.deepEqual(freeAgentFor({ free_agent_override: null }, listed), listed);
  assert.equal(freeAgentFor({ free_agent_override: null }, null), null);
  assert.deepEqual(freeAgentFor({ free_agent_override: 1 }, null), { manual: true });
  assert.deepEqual(freeAgentFor({ free_agent_override: 1 }, listed), listed, "the release's details still show");
  assert.equal(freeAgentFor({ free_agent_override: 0 }, listed), null);
  assert.equal(freeAgentFor({ free_agent_override: 1, is_signed: true }, listed), null);
  assert.deepEqual([freeAgentOverride(true), freeAgentOverride(false), freeAgentOverride(null)], [1, 0, null]);
  for (const v of ["yes", 1, 0, undefined, {}]) assert.throws(() => freeAgentOverride(v), /Free agent/);
});

test("a Transfermarkt sync can't change the hand-set answer, and a college merge keeps it", () => {
  assert.equal("free_agent_override" in tmSyncFields({ free_agent_override: 0, tm_overrides: [] }, { name: "Example", free_agent_override: 1 }), false);
  const db = openDb(":memory:");
  db.run("INSERT INTO players(id, name, free_agent_override) VALUES (1, 'Example', null), (2, 'Duplicate', 1), (3, 'Other', 0), (4, 'Other duplicate', 1)");
  mergePlayer(db, 2, 1);
  assert.equal(db.get("SELECT free_agent_override FROM players WHERE id = 1").free_agent_override, 1, "the duplicate's Yes carries over");
  mergePlayer(db, 4, 3);
  assert.equal(db.get("SELECT free_agent_override FROM players WHERE id = 3").free_agent_override, 0, "the kept profile's own answer wins");
});

test("a database from before the hand-set column gains it, empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "pine-fa-col-")), file = join(dir, "pine.db");
  try {
    const old = openDb(file);
    old.run("INSERT INTO players(id, name) VALUES (1, 'Example')");
    old.raw.exec("ALTER TABLE players DROP COLUMN free_agent_override");
    old.raw.close();
    const db = openDb(file);
    assert.equal(db.get("SELECT free_agent_override FROM players").free_agent_override, null);
    assert.throws(() => db.run("UPDATE players SET free_agent_override = 2"), /CHECK/);
    db.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CSV reader handles quoted commas, quotes and newlines", () => {
  const rows = parseCsv('﻿club,player,decision,notes\r\nMNUFC2,Alan Declined,option_declined,"a, b ""c""\nnext line"\r\nX FC,,,\r\n');
  assert.deepEqual(rows, [{ club: "MNUFC2", player: "Alan Declined", decision: "option_declined", notes: 'a, b "c"\nnext line' }, { club: "X FC", player: "", decision: "", notes: "" }]);
});

test("HTTP: the worker uploads the list, players carry it, and it's hidden once he's signed", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pine-free-agents-")), file = join(dir, "pine.db");
  const db = openDb(file);
  db.run("INSERT INTO players(id, name, club, league) VALUES (10001, 'Alan Declined', 'Toronto FC II', 'MLS Next Pro')");
  db.run("INSERT INTO players(id, name, club, league) VALUES (10002, 'Manny Manual', 'Unlisted Town FC', 'USL1')");
  db.raw.close();
  const child = spawn(process.execPath, ["--import", "./scripts/fixtures/offline-fetch.mjs", "src/server.js"], {
    cwd: process.cwd(), env: { ...process.env, PINE_DB: file, PINE_AUTH: "off", PORT: "0",
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
  const list = { season: 2026, clubs: ["Toronto FC II"], entries: [entry("Alan Declined", "Toronto FC II")] };
  assert.equal((await call("/api/worker/free-agents", "PUT", list, "wrong")).status, 401);
  const up = await call("/api/worker/free-agents", "PUT", list, "local-test-token");
  assert.equal(up.status, 200);
  assert.equal((await up.json()).in_pine, 1);
  const player = async () => (await (await call("/api/players/10001")).json()).player;
  assert.deepEqual((await player()).free_agent, { reason: "option_declined", club: "Toronto FC II", announced: "2026-11-17", season: 2026, in_talks: 0, source_url: "https://example.com/release" });
  const everyone = (await (await call("/api/players")).json()).players;
  assert.equal(everyone.find((p) => p.id === 10001).free_agent.club, "Toronto FC II");
  // By hand, in Edit details.
  const edit = async (id, v) => { const r = await call(`/api/players/${id}`, "PATCH", { free_agent_override: v }); assert.equal(r.status, 200); return (await r.json()).player; };
  const manny = await edit(10002, true);
  assert.deepEqual([manny.free_agent, manny.free_agent_listed, manny.free_agent_override], [{ manual: true }, false, 1]);
  assert.equal((await edit(10002, null)).free_agent, null);
  const hidden = await edit(10001, false);
  assert.deepEqual([hidden.free_agent, hidden.free_agent_listed], [null, true], "No hides a listed player; Auto would still say Yes");
  assert.equal((await edit(10001, null)).free_agent.club, "Toronto FC II");
  for (const v of ["yes", 1, 0, {}]) assert.equal((await call("/api/players/10001", "PATCH", { free_agent_override: v })).status, 400);
  assert.equal((await call("/api/players/10001/signing", "PUT", { signed: true })).status, 200);
  assert.equal((await player()).free_agent, null);
});
