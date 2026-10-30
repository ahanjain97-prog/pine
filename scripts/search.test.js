import test from "node:test";
import assert from "node:assert/strict";
import { matchText, textMatch } from "../public/search.js";

test("player searches ignore case and accents in queries and stored names", () => {
  for (const name of ["Jesús García", "Jesu\u0301s Garci\u0301a", "Jesus Garcia"]) {
    const player = { name };
    for (const query of ["Jesus", "JESUS", "JESÚS", "jesu\u0301s", "GARCIA", "Jesús García"]) {
      assert.equal(matchText(player, query), true, `${query} should find ${name}`);
    }
    assert.equal(player.name, name, "search keeps the original spelling");
    assert.equal(matchText(player, "Jose"), false);
  }
});

test("player filters fold accents across every searchable field", () => {
  for (const field of ["name", "club", "league", "position", "citizenship"]) {
    const player = { [field]: field === "citizenship" ? ["México"] : "México" };
    assert.equal(matchText(player, "MEXICO"), true, field);
    assert.equal(matchText(player, "mex"), true, "partial searches still work");
    assert.equal(matchText(player, "Canada"), false);
  }
  assert.equal(matchText({}, ""), true);
  assert.equal(matchText({}, "Jesus"), false);
});

test("NCAA text filters ignore accents and preserve other search behavior", () => {
  assert.equal(textMatch("JESUS", "Jesús García", "Example School"), true);
  assert.equal(textMatch("SAO PAULO", null, "São Paulo"), true);
  assert.equal(textMatch("münchen", "Munchen"), true);
  assert.equal(textMatch("", null, undefined), true);
  assert.equal(textMatch("missing", null, undefined), false);
  assert.equal(textMatch("東京", "東京 FC"), true);
  assert.equal(textMatch("U-21", "Example U-21"), true);
  assert.equal(textMatch("U21", "Example U-21"), false);
});
