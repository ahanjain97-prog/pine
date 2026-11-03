import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Hono } from "hono";
import { openDb } from "../src/db.js";
import { boardLastReviews, registerReview, REVIEW_AFTER_DAYS } from "../src/lib/review.js";

function setup(t) {
  const db = openDb(":memory:");
  t.after(() => db.raw.close());
  for (const id of [1, 2, 3]) db.run("INSERT INTO players(id, name, created_at) VALUES (?, ?, '2026-08-01 12:00:00')", id, `Example ${id}`);
  db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (1, 'FWD1', 0), (1, 'FWD2', 0), (2, 'FWD1', 1)");
  return db;
}

test("last review is one grouped query, per player across roles, with creation fallback and no backfill", (t) => {
  const db = setup(t), calls = [];
  const reviews = boardLastReviews({ all: (...args) => { calls.push(args); return db.all(...args); } });
  assert.equal(calls.length, 1);
  assert.deepEqual([...reviews], [[1, "2026-08-01 12:00:00"], [2, "2026-08-01 12:00:00"]]);
  assert.equal(db.get("SELECT count(*) AS n FROM activity").n, 0);
});

test("each qualifying staff action resets review; hidden, automated and unrelated activity does not", (t) => {
  const db = setup(t);
  const insert = (action, date, user = 1, hidden = 0) => db.run(
    "INSERT INTO activity(player_id, user_id, action, created_at, hidden) VALUES (1, ?, ?, ?, ?)", user, action, date, hidden);
  for (const action of ["added_note", "edited_note", "set_verdict", "set_decision", "added_role", "moved_on_board", "copied_on_board", "marked_reviewed", "shortlisted", "unshortlisted", "removed_role"]) {
    db.run("DELETE FROM activity");
    insert(action, "2026-09-01T12:00:00Z");
    assert.equal(boardLastReviews(db).get(1), "2026-09-01 12:00:00", action);
  }
  for (const action of ["synced_tm", "linked_impect", "refreshed_impect", "requested_card", "edited_player", "deleted_note", "moved_on_ncaa_board", "added_player"]) {
    insert(action, "2026-11-01 12:00:00");
  }
  insert("added_note", "2026-11-02 12:00:00", 1, 1);
  insert("added_role", "2026-11-02 12:00:00", null);
  // Latest timestamp wins, even when an older event was inserted later.
  insert("edited_note", "2026-08-20 12:00:00");
  assert.equal(boardLastReviews(db).get(1), "2026-09-01 12:00:00");
  assert.equal(boardLastReviews(db).get(2), "2026-08-01 12:00:00");
});

test("Mark reviewed requires staff, records the canonical player and clears staleness without changing scouting", async (t) => {
  const db = setup(t), app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, e.status || 500));
  app.use("*", async (c, next) => { if (c.req.header("Test-User")) c.set("user", { id: 2 }); await next(); });
  registerReview(app, { db, getPlayer: (id) => {
    const p = db.get("SELECT * FROM players WHERE id = ?", id === "alias" ? 1 : Number(id));
    if (!p) throw Object.assign(new Error("Player not found"), { status: 404 });
    return p;
  } });
  const before = db.get("SELECT * FROM players WHERE id = 1");
  const request = (id, staff = true) => app.request(`/api/players/${id}/review`, { method: "POST", headers: staff ? { "Test-User": "2" } : {} });
  assert.equal((await request(1, false)).status, 401);
  assert.equal((await request(99)).status, 404);
  assert.equal(db.get("SELECT count(*) AS n FROM activity").n, 0);
  assert.deepEqual(await (await request("alias")).json(), { ok: true });
  const a = db.get("SELECT * FROM activity");
  assert.equal(a.action, "marked_reviewed");
  assert.equal(a.user_id, 2);
  assert.equal(a.player_id, 1);
  assert.equal(boardLastReviews(db).get(1), a.created_at);
  assert.deepEqual(db.get("SELECT * FROM players WHERE id = 1"), before);
  assert.equal(db.get("SELECT count(*) AS n FROM board_entries WHERE player_id = 1").n, 2);
});

// Exercise the actual no-build card renderer with fixed time and minimal presentation helpers.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function cardHarness() {
  const context = vm.createContext({
    S: { config: { review_after_days: REVIEW_AFTER_DAYS } },
    Date: class extends Date { static now() { return Date.parse("2026-11-03T12:00:00Z"); } },
    boardReasonTooltip: () => "", rankIn: () => 0, isNcaa: () => false, isTopTarget: (p) => p.starred,
    esc: (s) => String(s), photo: () => "", nameWithMark: (p) => p.name,
    rosterBadge: () => "<span>DOM</span>", ncaaBadge: () => "<span>NCAA</span>",
    l2Badge: () => "<span>L2</span>", verdictDots: () => "",
  });
  vm.runInContext(source.slice(source.indexOf("function toDate("), source.indexOf("const fmtDate ="))
    + source.slice(source.indexOf("function tagRow("), source.indexOf("// What the marks"))
    + source.slice(source.indexOf("function boardCard("), source.indexOf("// Star clicks")), context);
  return context;
}

test("Big Board flags at exactly 28 days in every role; top targets and roleless cards stay unflagged", () => {
  const ctx = cardHarness();
  const p = { id: 1, name: "Example", roles: [{ role: "FWD1", shortlist: 0 }, { role: "FWD2", shortlist: 0 }], starred: false,
    last_review_at: "2026-10-06 12:00:00" };
  for (const role of ["FWD1", "FWD2"]) {
    const card = ctx.boardCard(p, role);
    assert.match(card, /needs-review/);
    assert.match(card, /title="Last review 28 days ago">Review<\/span>/);
    assert.match(card, /class="review-heading">Example<span class="roster review"/); // separate from tagRow
    assert.match(card, /class="review-age">Last review 28 days ago<\/span>/);
  }
  // Starred in any role = on the Short Board: no flag on any of their Big Board cards.
  const target = { ...p, roles: [{ role: "FWD1", shortlist: 1 }, { role: "FWD2", shortlist: 0 }], starred: true };
  for (const role of ["FWD1", "FWD2"]) assert.doesNotMatch(ctx.boardCard(target, role), /needs-review|>Review<|review-age/);
  assert.doesNotMatch(ctx.boardCard(p, null), /needs-review|>Review</);
  for (const last_review_at of ["2026-10-06 12:00:01", "2026-11-03T12:00:00Z", null, "bad-date"]) {
    assert.doesNotMatch(ctx.boardCard({ ...p, last_review_at }, "FWD1"), /needs-review|>Review</);
  }
  assert.match(ctx.tagRow(["a", "b", "c", "d"]), /\+1/);
  // Even if the regular tag list grows beyond three, Review remains outside its fold.
  const originalTags = ctx.tagRow;
  ctx.tagRow = (tags) => originalTags([...tags, "<span>Extra</span>"]);
  const crowded = ctx.boardCard(p, "FWD1");
  assert.match(crowded, /\+1<\/span>/);
  assert.match(crowded, /class="review-heading">Example<span class="roster review"/);
  assert.doesNotMatch(crowded, /title="[^"]*Review/);
});

test("Short Board cards never carry the review flag, however long since the last review", () => {
  const ctx = cardHarness();
  const p = { id: 1, name: "Example", roles: [{ role: "FWD1", shortlist: 1 }], starred: true };
  for (const last_review_at of ["2026-10-20 12:00:00", "2026-10-06 12:00:00", "2025-01-01 12:00:00"]) {
    const card = ctx.boardCard({ ...p, last_review_at }, "FWD1", true, 0);
    assert.doesNotMatch(card, /needs-review|>Review<|review-age/);
    assert.match(card, /class="star on"/);
  }
});
