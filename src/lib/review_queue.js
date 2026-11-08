// The Review tab, for the review team (users.review_role): the lead decides the Short Board, scouts send players up.
//   watch       a member's own follow-up list (players added from the database or a Transfermarkt link)
//   sb_review   a scout asks the lead whether a player goes on the Short Board: the lead adds him (picking the
//               role) or says not for now
//   assignment  the lead asks the scouts to review a player. It always goes to every scout: one item and note
//               thread they share, each scout reviewing (optionally with a verdict) or declining on their own
//               (review_assignees); it settles once every scout has answered
// Every item keeps a short note thread (why it was sent, replies). Players both scouts have passed, and that no one
// has sent up yet, are suggested to the scouts.
import { logActivity } from "../db.js";
import { ROLES } from "../roles.js";
import { addBoardRole, setBoardStar } from "./board_reasons.js";

const KINDS = ["watch", "sb_review", "assignment"];
const VERDICTS = ["pass", "hold", "fail"];
const OUTCOMES = { watch: ["removed"], sb_review: ["added_sb", "not_sb"], assignment: ["reviewed", "declined", "removed"] };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, name, required = false) => {
  if (value == null || value === "") { if (required) fail(400, `${name} is required`); return null; }
  if (typeof value !== "string" || value.length > 4000) fail(400, `${name} must be text of at most 4000 characters`);
  const t = value.trim();
  if (required && !t) fail(400, `${name} is required`);
  return t || null;
};

export const reviewTeam = (db) =>
  db.all("SELECT id, name, review_role AS role FROM users WHERE review_role IS NOT NULL ORDER BY sort, id");

function member(db, user) {
  const m = user && db.get("SELECT id, name, review_role AS role FROM users WHERE id = ?", user.id);
  if (!m?.role) fail(403, "The Review tab is for the review team");
  return m;
}

const assigneesOf = (db, itemId) => db.all(`SELECT a.user_id, u.name, a.status, a.resolved_at FROM review_assignees a
  JOIN users u ON u.id = a.user_id WHERE a.item_id = ? ORDER BY u.sort, u.id`, itemId);

function itemRow(db, id) {
  const item = db.get("SELECT * FROM review_items WHERE id = ?", Number(id)) || fail(404, "Review item not found");
  if (item.kind === "assignment") item.assignees = assigneesOf(db, item.id);
  return item;
}

// Who may see an item: the owner of a watch; the lead and every scout for a Short Board request (the scouts share
// it); the lead and its scouts for an assignment.
function canSee(me, item) {
  if (item.kind === "watch") return item.from_user === me.id;
  if (item.kind === "sb_review") return true;
  return me.role === "lead" || (item.assignees || []).some((a) => a.user_id === me.id);
}

// A watch list is private: its entries are kept in the activity log but left out of the shared feed.
const hideLast = (db) => db.run("UPDATE activity SET hidden = 1 WHERE id = last_insert_rowid()");

function addNoteRow(db, itemId, userId, body) {
  db.run("INSERT INTO review_notes(item_id, user_id, body) VALUES (?,?,?)", itemId, userId, body);
}

export function createItem(db, user, input) {
  const me = member(db, user);
  const kind = input?.kind;
  if (!KINDS.includes(kind)) fail(400, "Choose watch, sb_review or assignment");
  const player = db.get("SELECT id, name FROM players WHERE id = ?", Number(input.player_id)) || fail(404, "Player not found");
  const note = text(input.note, "Note");
  const team = reviewTeam(db);
  let to = null;
  if (kind === "watch") {
    if (db.get("SELECT 1 FROM review_items WHERE kind = 'watch' AND status = 'open' AND player_id = ? AND from_user = ?", player.id, me.id))
      fail(409, `${player.name} is already on your watch list`);
  } else if (kind === "sb_review") {
    if (me.role !== "scout") fail(403, "Scouts send players up for a Short Board decision");
    to = team.find((u) => u.role === "lead") || fail(400, "No one is set as the review lead");
    if (db.get("SELECT 1 FROM review_items WHERE kind = 'sb_review' AND status = 'open' AND player_id = ?", player.id))
      fail(409, `${player.name} is already waiting for a Short Board decision`);
  }
  let scouts = [];
  if (kind === "assignment") {
    if (me.role !== "lead") fail(403, "Only the review lead assigns players");
    // Every scout, whatever the request names: a page open since before shared assignments still sends one scout.
    scouts = team.filter((u) => u.role === "scout");
    if (!scouts.length) fail(400, "No one is set as a review scout");
    if (db.get("SELECT 1 FROM review_items WHERE kind = 'assignment' AND status = 'open' AND player_id = ?", player.id))
      fail(409, `${player.name} is already out for review`);
  }
  return db.tx(() => {
    const id = Number(db.run("INSERT INTO review_items(player_id, kind, from_user, to_user) VALUES (?,?,?,?)",
      player.id, kind, me.id, to?.id ?? (scouts.length === 1 ? scouts[0].id : null)).lastInsertRowid);
    for (const sc of scouts) db.run("INSERT INTO review_assignees(item_id, user_id) VALUES (?,?)", id, sc.id);
    if (note) addNoteRow(db, id, me.id, note);
    logActivity(db, me.id, player.id, `review_${kind}`, { to: to?.name ?? (scouts.map((x) => x.name).join(" and ") || null), note });
    if (kind === "watch") hideLast(db);
    return id;
  });
}

export function addNote(db, user, itemId, body) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item)) fail(404, "Review item not found");
  addNoteRow(db, item.id, me.id, text(body, "Note", true));
}

export function resolveItem(db, user, itemId, input) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item)) fail(404, "Review item not found");
  if (item.status !== "open") fail(409, "This has already been dealt with");
  const outcome = input?.outcome;
  if (!OUTCOMES[item.kind].includes(outcome)) fail(400, "Choose a valid outcome");
  const note = text(input.note, "Note", outcome === "added_sb");
  if (item.kind === "watch" && item.from_user !== me.id) fail(403, "Only its owner changes a watch list");
  if (item.kind === "sb_review" && me.role !== "lead") fail(403, "Only the review lead decides the Short Board");
  const mine = item.kind === "assignment" ? item.assignees.find((a) => a.user_id === me.id) : null;
  if (item.kind === "assignment") {
    if (outcome === "removed" ? me.role !== "lead" : !mine) fail(403, outcome === "removed"
      ? "Only the review lead withdraws an assignment" : "Only the assigned scouts review this");
    if (outcome !== "removed" && mine.status !== "open") fail(409, "You've already answered this one");
  }
  const verdict = input.verdict ?? null;
  if (verdict != null && (item.kind !== "assignment" || outcome !== "reviewed" || !VERDICTS.includes(verdict))) fail(400, "Verdict must be pass, hold or fail");
  const role = input.role ?? null;
  if (outcome === "added_sb" && (typeof role !== "string" || !Object.hasOwn(ROLES, role))) fail(400, "Choose the Big Board role");

  return db.tx(() => {
    if (outcome === "added_sb") {
      // Through the Big Board's own audited moves, with the note as the written reason.
      if (!db.get("SELECT 1 FROM board_entries WHERE player_id = ? AND role = ?", item.player_id, role))
        addBoardRole(db, item.player_id, role, { source: "Referral: Staff", why: note }, me.id);
      setBoardStar(db, item.player_id, role, true, { why: note }, me.id);
    }
    if (verdict) {
      db.run(`INSERT INTO verdicts(player_id, user_id, verdict) VALUES (?,?,?)
        ON CONFLICT(player_id, user_id) DO UPDATE SET verdict = excluded.verdict, updated_at = datetime('now')`, item.player_id, me.id, verdict);
      logActivity(db, me.id, item.player_id, "set_verdict", { verdict });
    }
    if (mine && outcome !== "removed") {
      // One scout's answer; the assignment settles when the last scout has answered (reviewed if anyone did).
      db.run("UPDATE review_assignees SET status = ?, resolved_at = datetime('now') WHERE item_id = ? AND user_id = ?", outcome, item.id, me.id);
      const left = assigneesOf(db, item.id);
      if (!left.some((a) => a.status === "open")) {
        db.run("UPDATE review_items SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?",
          left.some((a) => a.status === "reviewed") ? "reviewed" : "declined", me.id, item.id);
      }
    } else {
      db.run("UPDATE review_items SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", outcome, me.id, item.id);
    }
    if (note) addNoteRow(db, item.id, me.id, note);
    logActivity(db, me.id, item.player_id, "review_resolved", { kind: item.kind, outcome, role, verdict, note });
    if (item.kind === "watch") hideLast(db);
  });
}

// Everything the member's Review tab shows. Open items, plus those settled in the last 30 days.
export function reviewBoard(db, user) {
  const me = member(db, user);
  const team = reviewTeam(db);
  const rows = db.all(`SELECT * FROM review_items
    WHERE status = 'open' OR resolved_at >= datetime('now', '-30 days') ORDER BY created_at DESC, id DESC`)
    .map((i) => (i.kind === "assignment" ? { ...i, assignees: assigneesOf(db, i.id) } : i)).filter((i) => canSee(me, i));
  const notes = rows.length ? db.all(`SELECT n.*, u.name AS user_name FROM review_notes n JOIN users u ON u.id = n.user_id
    WHERE n.item_id IN (${rows.map(() => "?").join(",")}) ORDER BY n.id`, ...rows.map((r) => r.id)) : [];
  const name = (id) => team.find((u) => u.id === id)?.name ?? db.get("SELECT name FROM users WHERE id = ?", id)?.name ?? null;
  const items = rows.map((r) => ({ ...r, from_name: name(r.from_user),
    to_name: r.assignees ? r.assignees.map((a) => a.name).join(" and ") : r.to_user ? name(r.to_user) : null,
    resolved_by_name: r.resolved_by ? name(r.resolved_by) : null, notes: notes.filter((n) => n.item_id === r.id) }));
  // Players every scout has passed, not on the Short Board, and never sent up (or decided) before.
  const scouts = team.filter((u) => u.role === "scout");
  const suggestions = me.role === "scout" && scouts.length >= 2 ? db.all(`SELECT p.id AS player_id FROM players p
    WHERE ${scouts.map(() => "EXISTS (SELECT 1 FROM verdicts v WHERE v.player_id = p.id AND v.user_id = ? AND v.verdict = 'pass')").join(" AND ")}
      AND NOT EXISTS (SELECT 1 FROM board_entries b WHERE b.player_id = p.id AND b.shortlist = 1)
      AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.player_id = p.id AND r.kind = 'sb_review')`, ...scouts.map((u) => u.id)).map((r) => r.player_id) : [];
  return { me, team, items, suggestions };
}

// How many open items are waiting on this member (the Review tab's badge).
export function reviewCount(db, user) {
  const m = user && db.get("SELECT review_role AS role FROM users WHERE id = ?", user.id);
  if (!m?.role) return 0;
  if (m.role === "lead") return db.get("SELECT count(*) AS n FROM review_items WHERE status = 'open' AND kind = 'sb_review' AND to_user = ?", user.id).n;
  return db.get(`SELECT count(*) AS n FROM review_assignees a JOIN review_items i ON i.id = a.item_id
    WHERE i.status = 'open' AND a.status = 'open' AND a.user_id = ?`, user.id).n;
}

export function registerReviewQueue(app, { db }) {
  const actor = (c) => c.get("user") || fail(401, "Not signed in");
  app.get("/api/review", (c) => c.json(reviewBoard(db, actor(c))));
  app.post("/api/review/items", async (c) => {
    const id = createItem(db, actor(c), await c.req.json());
    return c.json({ id }, 201);
  });
  app.post("/api/review/items/:id/notes", async (c) => {
    addNote(db, actor(c), c.req.param("id"), (await c.req.json()).body);
    return c.json({ ok: true });
  });
  app.post("/api/review/items/:id/resolve", async (c) => {
    resolveItem(db, actor(c), c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
}
