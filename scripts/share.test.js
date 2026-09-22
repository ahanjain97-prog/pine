import test from "node:test";
import assert from "node:assert/strict";

import { ogTags, playerPreview, sitePreview } from "../src/lib/share.js";

const ORIGIN = "https://pine.example";

test("a player preview names the player and their basics", () => {
  const preview = playerPreview(
    { id: 279, name: "Peter Morrell", age: 28, position: "Centre Back", club: "Hearts of Pine", league: "USL League One", photo_url: "https://img.tm/279.jpg" },
    ORIGIN
  );

  assert.deepEqual(preview, {
    url: "https://pine.example/p/279",
    title: "Peter Morrell · PINE",
    description: "28 · Centre Back · Hearts of Pine · USL League One",
    image: "https://img.tm/279.jpg",
  });
});

test("missing details are dropped, and a player with none falls back to the site line", () => {
  const sparse = playerPreview({ id: 4, name: "Trialist", age: null, position: "", club: null, league: null }, ORIGIN);
  assert.equal(sparse.description, "Player Identification Network Evaluation");
  assert.equal(sparse.image, `${ORIGIN}/hop-crest.png`, "no photo falls back to the crest");

  const partial = playerPreview({ id: 5, name: "Trialist", age: 19, club: "Free agent" }, ORIGIN);
  assert.equal(partial.description, "19 · Free agent");
});

test("a non-https photo is not used as the preview image", () => {
  const p = { id: 6, name: "Trialist", photo_url: "javascript:alert(1)" };
  assert.equal(playerPreview(p, ORIGIN).image, `${ORIGIN}/hop-crest.png`);
});

test("tags escape what goes into them", () => {
  const tags = ogTags(playerPreview({ id: 7, name: 'Bobby "Tables" <script>', club: "A & B" }, ORIGIN));

  assert.match(tags, /<meta property="og:title" content="Bobby &quot;Tables&quot; &lt;script&gt; · PINE">/);
  assert.match(tags, /<meta property="og:description" content="A &amp; B">/);
  assert.ok(!tags.includes("<script>"), "no raw markup escapes into the head");
});

test("the site preview points at the site itself", () => {
  const tags = ogTags(sitePreview(ORIGIN));
  assert.match(tags, /<meta property="og:url" content="https:\/\/pine\.example\/">/);
  assert.match(tags, /<meta property="og:title" content="PINE — Portland Hearts of Pine">/);
});
