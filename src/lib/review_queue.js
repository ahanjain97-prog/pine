// The Review tab, for the review team (users.review_role): the lead decides the Short Board, scouts send players up.
//   watch       a member's own follow-up list (players added from the database or a Transfermarkt link)
//   sb_review   a scout asks the lead whether a player goes on the Short Board: the lead adds him (picking the
//               role) or says not for now. The scout who sent it can withdraw it while it waits: it leaves the
//               lead's queue, the Review tab and Activity, as if never sent
//   assignment  the lead asks the scouts to review a player. It always goes to every scout: one item and note
//               thread they share, each scout reviewing (optionally with a verdict) or declining on their own
//               (review_assignees); it settles once every scout has answered. Once anyone has answered, it waits in
//               the lead's Decisions beside the scouts' requests, and his call (Short Board, or not for now) closes it
// Every item keeps a short note thread (why it was sent, replies). Players both scouts have passed, and that no one
// has sent up yet, are suggested to the scouts.
// Notes that report on the player also go in the author's Staff evaluation on the player page: the lead's note when
// assigning, a scout's note when reviewing, declining or sending a player up, and the lead's Short Board decision.
// Thread replies and watch lists stay in the Review tab.
import { logActivity } from "../db.js";
import { ROLES } from "../roles.js";
import { addBoardRole, setBoardStar } from "./board_reasons.js";

const KINDS = ["watch", "sb_review", "assignment"];
const VERDICTS = ["pass", "hold", "fail"];
const OUTCOMES = { watch: ["removed"], sb_review: ["added_sb", "not_sb", "removed"], assignment: ["reviewed", "declined", "removed", "added_sb", "not_sb"] };
// The lead's Short Board call. On any request or assignment it settles every other open one on the same player.
const DECISIONS_SB = ["added_sb", "not_sb"];
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
  return Number(db.run("INSERT INTO review_notes(item_id, user_id, body) VALUES (?,?,?)", itemId, userId, body).lastInsertRowid);
}

// What the copied note was, shown as its context in the evaluation.
function evalContext(action, { to, verdict, role } = {}) {
  const r = role && ROLES[role];
  return {
    assignment: `Review: asked ${to || "the scouts"} to review`,
    sb_review: `Review: sent to ${to || "the lead"} for the Short Board`,
    reviewed: `Review: reviewed${verdict ? `, ${verdict[0].toUpperCase()}${verdict.slice(1)}` : ""}`,
    declined: "Review: declined to review",
    added_sb: `Review: put on the Short Board${r ? ` (${r.position} ${r.label})` : ""}`,
    not_sb: "Review: not for the Short Board for now",
  }[action];
}

// The evaluation copy of a Review note, unless the author already wrote the same note there (ignoring case, spacing
// and punctuation: a report pasted into both, with a full stop added).
const sameText = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function addEvalNote(db, { playerId, userId, reviewNoteId, body, context, at = null }) {
  const key = sameText(body);
  if (db.all("SELECT body FROM notes WHERE player_id = ? AND user_id = ?", playerId, userId).some((n) => sameText(n.body) === key)) return;
  db.run(`INSERT OR IGNORE INTO notes(player_id, user_id, context, body, review_note_id, created_at, updated_at)
    VALUES (?,?,?,?,?, coalesce(?, datetime('now')), coalesce(?, datetime('now')))`, playerId, userId, context, body, reviewNoteId, at, at);
  db.run("UPDATE players SET updated_at = datetime('now') WHERE id = ?", playerId);
}

// Once, for notes written before evaluations got their copy. A scout's answer or the lead's decision is the note
// its activity entry recorded (same author, player and text); the note explaining a request is its sender's first.
export function copyReviewNotesToEvals(db) {
  const rows = db.all(`SELECT n.id, n.user_id, n.body, n.created_at, i.id AS item_id, i.kind, i.player_id, i.to_user,
      n.id = (SELECT min(m.id) FROM review_notes m WHERE m.item_id = i.id AND m.user_id = i.from_user) AS sender_first
    FROM review_notes n JOIN review_items i ON i.id = n.item_id WHERE i.kind <> 'watch' ORDER BY n.id`);
  const answers = db.all(`SELECT user_id, player_id, detail FROM activity
    WHERE action = 'review_resolved' AND json_extract(detail, '$.note') IS NOT NULL`).map((a) => ({ ...a, d: JSON.parse(a.detail) }));
  const nameOf = (id) => db.get("SELECT name FROM users WHERE id = ?", id)?.name;
  for (const r of rows) {
    const answer = answers.find((a) => a.user_id === r.user_id && a.player_id === r.player_id && a.d.kind === r.kind
      && a.d.note === r.body && a.d.outcome !== "removed");
    const context = answer ? evalContext(answer.d.outcome, answer.d)
      : r.sender_first ? evalContext(r.kind, { to: r.kind === "assignment" ? assigneesOf(db, r.item_id).map((a) => a.name).join(" and ") : nameOf(r.to_user) })
      : null;
    if (context) addEvalNote(db, { playerId: r.player_id, userId: r.user_id, reviewNoteId: r.id, body: r.body, context, at: r.created_at });
  }
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
    if (note) {
      const nid = addNoteRow(db, id, me.id, note);
      if (kind !== "watch") addEvalNote(db, { playerId: player.id, userId: me.id, reviewNoteId: nid, body: note,
        context: evalContext(kind, { to: to?.name ?? scouts.map((x) => x.name).join(" and ") }) });
    }
    logActivity(db, me.id, player.id, `review_${kind}`, { to: to?.name ?? (scouts.map((x) => x.name).join(" and ") || null), note, item: id });
    if (kind === "watch") hideLast(db);
    return id;
  });
}

// A withdrawn Short Board request: its Activity entries are hidden (the send, and the withdrawal just logged) and the
// copy of its note in the sender's Staff reports goes, since it would say he was sent to the lead. The item and its
// thread stay in the database.
function withdrawTraces(db, item) {
  hideLast(db);
  db.run(`UPDATE activity SET hidden = 1 WHERE action = 'review_sb_review' AND player_id = ? AND user_id = ?
    AND (json_extract(detail, '$.item') = ? OR (json_extract(detail, '$.item') IS NULL
      AND abs(julianday(created_at) - julianday(?)) * 86400 <= 2))`, item.player_id, item.from_user, item.id, item.created_at);
  db.run("DELETE FROM notes WHERE review_note_id IN (SELECT id FROM review_notes WHERE item_id = ? AND user_id = ?)", item.id, item.from_user);
}

// The author edited the Staff reports copy of a Review note: the thread shows the same words, marked edited.
export function syncReviewNote(db, reviewNoteId, body) {
  if (reviewNoteId != null) db.run("UPDATE review_notes SET body = ?, updated_at = datetime('now') WHERE id = ?", body, reviewNoteId);
}

export function addNote(db, user, itemId, body) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item)) fail(404, "Review item not found");
  addNoteRow(db, item.id, me.id, text(body, "Note", true));
}

export function resolveItem(db, user, itemId, input) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item)) fail(404, "Review item not found");
  const outcome = input?.outcome, decision = DECISIONS_SB.includes(outcome);
  // An assignment both scouts have answered has settled, but still waits for the lead's decision.
  if (item.status !== "open" && !(item.kind === "assignment" && decision && ["reviewed", "declined"].includes(item.status)))
    fail(409, "This has already been dealt with");
  if (!OUTCOMES[item.kind].includes(outcome)) fail(400, "Choose a valid outcome");
  const note = text(input.note, "Note", outcome === "added_sb");
  if (item.kind === "watch" && item.from_user !== me.id) fail(403, "Only its owner changes a watch list");
  if (item.kind === "sb_review" && outcome === "removed" && item.from_user !== me.id) fail(403, "Only the scout who sent it withdraws a request");
  if (item.kind === "sb_review" && outcome !== "removed" && me.role !== "lead") fail(403, "Only the review lead decides the Short Board");
  const mine = item.kind === "assignment" && !decision && outcome !== "removed" ? item.assignees.find((a) => a.user_id === me.id) : null;
  if (item.kind === "assignment") {
    if (decision || outcome === "removed") {
      if (me.role !== "lead") fail(403, decision ? "Only the review lead decides the Short Board" : "Only the review lead withdraws an assignment");
    } else {
      if (!mine) fail(403, "Only the assigned scouts review this");
      if (mine.status !== "open") fail(409, "You've already answered this one");
    }
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
    if (decision) {
      // One call per player: it also settles any other open request, or assignment awaiting him, on the player.
      db.run(`UPDATE review_items SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE player_id = ? AND id <> ?
        AND ((kind = 'sb_review' AND status = 'open') OR (kind = 'assignment' AND status IN ('open', 'reviewed', 'declined')))`,
        outcome, me.id, item.player_id, item.id);
    }
    if (note) {
      const nid = addNoteRow(db, item.id, me.id, note);
      const context = outcome === "removed" ? null : evalContext(outcome, { verdict, role });
      if (context) addEvalNote(db, { playerId: item.player_id, userId: me.id, reviewNoteId: nid, body: note, context });
    }
    logActivity(db, me.id, item.player_id, "review_resolved", { kind: item.kind, outcome, role, verdict, note });
    if (item.kind === "watch") hideLast(db);
    if (item.kind === "sb_review" && outcome === "removed") withdrawTraces(db, item);
  });
}

// Everything the member's Review tab shows. Open items, plus those settled in the last 30 days.
export function reviewBoard(db, user) {
  const me = member(db, user);
  const team = reviewTeam(db);
  const rows = db.all(`SELECT * FROM review_items
    WHERE status = 'open' OR resolved_at >= datetime('now', '-30 days') ORDER BY created_at DESC, id DESC`)
    .map((i) => (i.kind === "assignment" ? { ...i, assignees: assigneesOf(db, i.id) } : i))
    .filter((i) => canSee(me, i) && !(i.kind === "sb_review" && i.status === "removed")); // withdrawn requests are gone
  const notes = rows.length ? db.all(`SELECT n.*, u.name AS user_name FROM review_notes n JOIN users u ON u.id = n.user_id
    WHERE n.item_id IN (${rows.map(() => "?").join(",")}) ORDER BY n.id`, ...rows.map((r) => r.id)) : [];
  const name = (id) => team.find((u) => u.id === id)?.name ?? db.get("SELECT name FROM users WHERE id = ?", id)?.name ?? null;
  const openSb = new Set(rows.filter((r) => r.kind === "sb_review" && r.status === "open").map((r) => r.player_id));
  // An assignment a scout has answered, waiting for the lead's Short Board call: in his Decisions, and in the
  // scouts' Ready for the lead once they've answered it.
  const awaiting = (r) => r.kind === "assignment" && ["open", "reviewed", "declined"].includes(r.status)
    && r.assignees.some((a) => a.status !== "open") && !openSb.has(r.player_id);
  const items = rows.map((r) => ({ ...r, awaiting_lead: awaiting(r), from_name: name(r.from_user),
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
  // The lead: requests waiting on him, plus assignments a scout has answered that he hasn't decided (one per player).
  if (m.role === "lead") return db.get("SELECT count(*) AS n FROM review_items WHERE status = 'open' AND kind = 'sb_review' AND to_user = ?", user.id).n
    + db.get(`SELECT count(*) AS n FROM review_items i WHERE i.kind = 'assignment' AND i.status IN ('open', 'reviewed', 'declined')
        AND (i.status = 'open' OR i.resolved_at >= datetime('now', '-30 days'))
        AND EXISTS (SELECT 1 FROM review_assignees a WHERE a.item_id = i.id AND a.status <> 'open')
        AND NOT EXISTS (SELECT 1 FROM review_items s WHERE s.kind = 'sb_review' AND s.status = 'open' AND s.player_id = i.player_id)`).n;
  return db.get(`SELECT count(*) AS n FROM review_assignees a JOIN review_items i ON i.id = a.item_id
    WHERE i.status = 'open' AND a.status = 'open' AND a.user_id = ?`, user.id).n;
}

export function registerReviewQueue(app, { db }) {
  db.once("review_notes_to_evals_2026_11_08", () => copyReviewNotesToEvals(db));
  // Before the lead decided assignments, a Short Board call made on a scout's request left the player's assignment
  // waiting; it takes that call.
  db.once("assignments_settled_by_sb_call_2026_11_08", () => {
    for (const s of db.all("SELECT player_id, status, resolved_by, resolved_at FROM review_items WHERE kind = 'sb_review' AND status IN ('added_sb', 'not_sb') ORDER BY resolved_at")) {
      db.run(`UPDATE review_items SET status = ?, resolved_by = ?, resolved_at = ? WHERE kind = 'assignment' AND player_id = ?
        AND status IN ('open', 'reviewed', 'declined') AND created_at <= ?`, s.status, s.resolved_by, s.resolved_at, s.player_id, s.resolved_at);
    }
  });
  // Ahan withdrew his Short Board request on Lukas Kamrath (asked 2026-11-08, before scouts could withdraw in the app).
  db.once("withdraw_kamrath_sb_2026_11_08", () => {
    const it = db.get(`SELECT i.id, i.from_user FROM review_items i JOIN players p ON p.id = i.player_id JOIN users u ON u.id = i.from_user
      WHERE i.kind = 'sb_review' AND i.status = 'open' AND p.name = 'Lukas Kamrath' AND u.name = 'Ahan'`);
    if (it) resolveItem(db, { id: it.from_user }, it.id, { outcome: "removed" });
  });
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
