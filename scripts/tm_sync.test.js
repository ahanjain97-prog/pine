import test from "node:test";
import assert from "node:assert/strict";

import { manualTmOverrides, releaseTmOverrides, tmConflicts, tmSyncFields } from "../src/lib/tm_sync.js";

test("manual Transfermarkt field changes become overrides", () => {
  const player = { agent: null, league: "USL1", tm_overrides: [] };
  const changes = { agent: "fake agent", league: "new league" };

  assert.deepEqual(manualTmOverrides(player, changes), ["agent", "league", "league_code"]);
});

test("sync preserves manual overrides and refreshes untouched fields", () => {
  const player = { tm_overrides: ["agent", "league", "league_code"] };
  const profile = {
    name: "Peter Morrell",
    agent: null,
    league: "USL1",
    league_code: "USC3",
    club: "Updated Club",
    citizenship: ["United States"],
    other_positions: [],
  };

  assert.deepEqual(tmSyncFields(player, profile, "now"), {
    name: "Peter Morrell",
    club: "Updated Club",
    citizenship: ["United States"],
    other_positions: [],
    tm_synced_at: "now",
  });
});

test("clearing a field manually remains an override", () => {
  const player = { agent: "Old Agent", tm_overrides: [] };
  assert.deepEqual(manualTmOverrides(player, { agent: null }), ["agent"]);
});

test("unchanged submitted values do not become overrides", () => {
  const player = { agent: "Same Agent", league: "USL1", tm_overrides: [] };
  assert.deepEqual(manualTmOverrides(player, { agent: "Same Agent", league: "USL1" }), []);
});

test("sync reports differing manual values", () => {
  const player = { agent: "fake agent", league: "new league", tm_overrides: ["agent", "league", "league_code"] };
  const profile = { agent: null, league: "USL1" };
  assert.deepEqual(tmConflicts(player, profile), [
    { field: "league", current: "new league", transfermarkt: "USL1" },
    { field: "agent", current: "fake agent", transfermarkt: null },
  ]);
});

test("releasing one override also releases its related metadata", () => {
  assert.deepEqual(releaseTmOverrides(["agent", "league", "league_code"], ["league"]), ["agent"]);
});
