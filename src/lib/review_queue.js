// The War Room tab (#/war-room; code and tables keep the name "review"), for the review team (users.review_role): the
// lead decides the Short Board, scouts send players up.
//   watch       a member's own follow-up list (players added from the database or a Transfermarkt link)
//   sb_review   a scout asks the lead whether a player goes on the Short Board, Pass or Hold on him himself. It goes
//               first to the other scout (review_assignees; an NCAA player skips scouts flagged review_no_ncaa),
//               who answers Pass, Hold or Fail: once both are Pass or Hold it goes on to the lead, and a Fail stops
//               it there (status 'reviewed': it never reached the lead, who doesn't see it). Sent when the other
//               scout is already Pass or Hold on him (or there's no one to ask), it goes straight to the lead; so do
//               requests from before this step, which have no assignees. The lead adds him (picking the role) or
//               says not for now. The scout who sent it can withdraw it while it waits: it leaves the queues, the
//               Review tab and Activity, as if never sent.
//               A scout can also send one with no verdict of his own yet (review_items.no_verdict), for the other
//               scout to look at first: their Pass or Hold sends it back to him to watch (he joins review_assignees),
//               and his own Pass or Hold then sends it on to the lead; a Fail from either stops it
//   assignment  the lead (or an assigner: users.review_assigner) asks the scouts to review a player. It goes to every scout (an NCAA
//               player skips scouts flagged users.review_no_ncaa): one item and note thread they share, each scout reviewing (optionally with a verdict) or declining on their own
//               (review_assignees); it settles once every scout has answered, and only then waits in the lead's
//               Decisions beside the scouts' requests. His call closes it: Short Board, Big Board (add him, or move
//               him if he's already on it), or not for now. Whoever has answered (or the lead) can nudge a scout
//               who hasn't
// An assigner is on the War Room only to assign: he sees the assignments he sent (and can nudge or withdraw them) and
// keeps a watch list; the lead still decides on them, and the scouts' requests stay between the lead and the scouts.
// Every item keeps a short note thread (why it was sent, replies). Players both scouts have passed, and that no one
// has sent up yet, are suggested to the scouts.
// Notes that report on the player also go in the author's Staff evaluation on the player page: the lead's note when
// assigning, a scout's note when reviewing, declining or sending a player up (not one sent with no verdict: that asks
// the other scout to look, it doesn't report), and the lead's Short Board decision.
// Thread replies and watch lists stay in the Review tab, which drops what settled more than 30 days ago; the player's
// page keeps every War Room note on him for good (warRoomLog).
// A thread stays open for replies after its item settles, so a question in the lead's decision note can be answered.
// A reply, or a decision or withdrawal note, is new to everyone else on the item (the New notes tab, and a chip on its
// row) until they reply or mark it read; the War Room badge stays what waits on you. Notes sent with a new item and a scout's own review answer aren't: those already reach
// the others as an assignment, a request, or a review waiting on the lead.
import { logActivity } from "../db.js";
import { ROLES } from "../roles.js";
import { addBoardRole, moveBoardCard, setBoardStar } from "./board_reasons.js";
import { spotIn } from "./board.js";

const KINDS = ["watch", "sb_review", "assignment"];
const VERDICTS = ["pass", "hold", "fail"];
const SENDS_UP = ["pass", "hold"]; // the verdicts that send a player on to the lead
// The lead's call on a player: Short Board, Big Board (add, or move up/down if he's on it), or not for now. On any
// request or assignment it settles every other open one on the same player.
const DECISIONS_SB = ["added_sb", "added_bb", "moved_bb", "not_sb"];
const OUTCOMES = { watch: ["removed"], sb_review: [...DECISIONS_SB, "reviewed", "removed"], assignment: ["reviewed", "declined", "removed", ...DECISIONS_SB] };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, name, required = false) => {
  if (value == null || value === "") { if (required) fail(400, `${name} is required`); return null; }
  if (typeof value !== "string" || value.length > 4000) fail(400, `${name} must be text of at most 4000 characters`);
  const t = value.trim();
  if (required && !t) fail(400, `${name} is required`);
  return t || null;
};

// A member's War Room role: lead, scout, or assigner.
export const REVIEW_ROLE = "coalesce(review_role, CASE WHEN review_assigner = 1 THEN 'assigner' END)";
const ASSIGNS = ["lead", "assigner"];

export const reviewTeam = (db) =>
  db.all(`SELECT id, name, ${REVIEW_ROLE} AS role, review_no_ncaa AS no_ncaa FROM users WHERE ${REVIEW_ROLE} IS NOT NULL ORDER BY sort, id`);

// A college player (Transfermarkt sync files them under the league "NCAA"); the front end's isNcaa is the same test.
export const isCollege = (p) => /\bncaa\b/i.test(p?.league || "");
// The scouts an assignment of this player goes to: every scout, less those who don't take NCAA players when he's one
// (all of them, if that would leave no one).
export function assignScouts(team, player) {
  const scouts = team.filter((u) => u.role === "scout");
  const takers = isCollege(player) ? scouts.filter((u) => !u.no_ncaa) : scouts;
  return takers.length ? takers : scouts;
}

// The scouts a Short Board request goes to before the lead: the other scouts an assignment of him would go to, less
// any already Pass or Hold on him. None: it goes straight to the lead.
const verdictOf = (db, playerId, userId) => db.get("SELECT verdict FROM verdicts WHERE player_id = ? AND user_id = ?", playerId, userId)?.verdict ?? null;
export const sbPeers = (db, team, player, me) =>
  assignScouts(team, player).filter((u) => u.id !== me.id && !SENDS_UP.includes(verdictOf(db, player.id, u.id)));
// A Short Board request still with the other scout (one has yet to answer); otherwise it's with the lead.
const withPeer = (item) => item.kind === "sb_review" && item.status === "open" && (item.assignees || []).some((a) => a.status === "open");
// One sent with no verdict that the other scout has passed or held: back with the scout who sent it, to answer himself.
const withSender = (item) => withPeer(item) && item.assignees.some((a) => a.user_id === item.from_user && a.status === "open");
// Who an item went to: its scouts (not the sender of a request, who only answers one that came back to him).
const sentTo = (item) => {
  const to = (item.assignees || []).filter((a) => item.kind !== "sb_review" || a.user_id !== item.from_user);
  return to.length ? to.map((a) => a.name).join(" and ") : null;
};
const WITH_LEAD = (alias) => `NOT EXISTS (SELECT 1 FROM review_assignees ra WHERE ra.item_id = ${alias}.id AND ra.status = 'open')`;

function member(db, user) {
  const m = user && db.get(`SELECT id, name, ${REVIEW_ROLE} AS role FROM users WHERE id = ?`, user.id);
  if (!m?.role) fail(403, "The War Room is for the review team");
  return m;
}

const assigneesOf = (db, itemId) => db.all(`SELECT a.user_id, u.name, a.status, a.resolved_at, a.nudged_at, n.name AS nudged_by_name
  FROM review_assignees a JOIN users u ON u.id = a.user_id LEFT JOIN users n ON n.id = a.nudged_by WHERE a.item_id = ? ORDER BY u.sort, u.id`, itemId);

function itemRow(db, id) {
  const item = db.get("SELECT * FROM review_items WHERE id = ?", Number(id)) || fail(404, "Review item not found");
  if (item.kind !== "watch") item.assignees = assigneesOf(db, item.id);
  return item;
}

// Who may see an item: the owner of a watch; every scout for a Short Board request (the scouts share it), and the
// lead once it has reached him (not while it's with the other scout, nor one stopped there); the lead, its scouts
// and whoever assigned it for an assignment.
function canSee(me, item) {
  if (item.kind === "watch") return item.from_user === me.id;
  if (item.kind === "sb_review") return me.role === "scout" || (me.role === "lead" && !withPeer(item) && item.status !== "reviewed");
  return me.role === "lead" || item.from_user === me.id || (item.assignees || []).some((a) => a.user_id === me.id);
}

function setVerdict(db, playerId, userId, verdict) {
  db.run(`INSERT INTO verdicts(player_id, user_id, verdict) VALUES (?,?,?)
    ON CONFLICT(player_id, user_id) DO UPDATE SET verdict = excluded.verdict, updated_at = datetime('now')`, playerId, userId, verdict);
  logActivity(db, userId, playerId, "set_verdict", { verdict });
}

// A watch list is private: its entries are kept in the activity log but left out of the shared feed.
const hideLast = (db) => db.run("UPDATE activity SET hidden = 1 WHERE id = last_insert_rowid()");

// Writing on a thread also means its author has dealt with everything above.
function addNoteRow(db, itemId, userId, body, kind) {
  const id = Number(db.run("INSERT INTO review_notes(item_id, user_id, body, kind) VALUES (?,?,?,?)", itemId, userId, body, kind).lastInsertRowid);
  setRead(db, itemId, userId, id);
  return id;
}
const setRead = (db, itemId, userId, noteId) => db.run(`INSERT INTO review_reads(item_id, user_id, note_id) VALUES (?,?,?)
  ON CONFLICT(item_id, user_id) DO UPDATE SET note_id = max(note_id, excluded.note_id)`, itemId, userId, noteId);
// Notes that are new to a member: someone else's reply or decision, after the last note he has dealt with.
const NEW_TO = (me) => `n.user_id <> ${Number(me)} AND n.kind IN ('reply', 'decision')
  AND n.id > coalesce((SELECT r.note_id FROM review_reads r WHERE r.item_id = n.item_id AND r.user_id = ${Number(me)}), 0)`;

export function markRead(db, user, itemId) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item)) fail(404, "Review item not found");
  const last = db.get("SELECT max(id) AS id FROM review_notes WHERE item_id = ?", item.id).id;
  if (last) setRead(db, item.id, me.id, last);
}

// What the copied note was, shown as its context in the evaluation.
function evalContext(action, { to, verdict, role, spot } = {}) {
  const r = role && ROLES[role];
  return {
    assignment: `Review: asked ${to || "the scouts"} to review`,
    sb_review: `Review: sent to ${to || "the lead"} for the Short Board`, // "Ford, then Ray" when it goes to the other scout first
    reviewed: `Review: reviewed${verdict ? `, ${verdict[0].toUpperCase()}${verdict.slice(1)}` : ""}`,
    declined: "Review: declined to review",
    added_sb: `Review: put on the Short Board${r ? ` (${r.position} ${r.label})` : ""}`,
    added_bb: `Review: added to the Big Board${r ? ` (${r.position} ${r.label}${spot != null ? `, #${spot + 1}` : ""})` : ""}`,
    moved_bb: `Review: moved on the Big Board${r ? ` (${r.position} ${r.label}${spot != null ? `, to #${spot + 1}` : ""})` : ""}`,
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
  const player = db.get("SELECT id, name, league FROM players WHERE id = ?", Number(input.player_id)) || fail(404, "Player not found");
  const note = text(input.note, "Note");
  const team = reviewTeam(db);
  const names = (list) => list.map((x) => x.name).join(" and ");
  let to = null, peers = [], verdict = null, noVerdict = false;
  if (kind === "watch") {
    if (db.get("SELECT 1 FROM review_items WHERE kind = 'watch' AND status = 'open' AND player_id = ? AND from_user = ?", player.id, me.id))
      fail(409, `${player.name} is already on your watch list`);
  } else if (kind === "sb_review") {
    if (me.role !== "scout") fail(403, "Scouts send players up for a Short Board decision");
    to = team.find((u) => u.role === "lead") || fail(400, "No one is set as the review lead");
    if (db.get("SELECT 1 FROM review_items WHERE kind = 'sb_review' AND status = 'open' AND player_id = ?", player.id))
      fail(409, `${player.name} has already been sent up for a Short Board decision`);
    peers = sbPeers(db, team, player, me);
    noVerdict = input.no_verdict === true;
    if (noVerdict) {
      // No verdict of his own yet: the other scout looks first, so there has to be one who isn't Pass or Hold already.
      if (!peers.length) {
        const others = assignScouts(team, player).filter((u) => u.id !== me.id);
        fail(400, others.length ? `${names(others)} ${others.length === 1 ? "is" : "are"} already Pass or Hold on him: send him with your own Pass or Hold`
          : "No other scout takes him to look at first: send him with your own Pass or Hold");
      }
    } else {
      // The sender is Pass or Hold on him: set with the request, or already. (A page open from before sends none.)
      verdict = input.verdict ?? verdictOf(db, player.id, me.id);
      if (!SENDS_UP.includes(verdict)) fail(400, "Choose Pass or Hold: players go up to the Short Board on Pass or Hold");
    }
  }
  let scouts = [];
  if (kind === "assignment") {
    if (!ASSIGNS.includes(me.role)) fail(403, "Only the review lead or an assigner assigns players");
    // Every scout (less any who skip NCAA players, for a college player), whatever the request names: a page open
    // since before shared assignments still sends one scout.
    scouts = assignScouts(team, player);
    if (!scouts.length) fail(400, "No one is set as a review scout");
    if (db.get("SELECT 1 FROM review_items WHERE kind = 'assignment' AND status = 'open' AND player_id = ?", player.id))
      fail(409, `${player.name} is already out for review`);
  }
  return db.tx(() => {
    if (kind === "sb_review" && !noVerdict && verdictOf(db, player.id, me.id) !== verdict) setVerdict(db, player.id, me.id, verdict);
    // A request keeps the lead as to_user while it's with the other scout: that's where it goes next.
    const id = Number(db.run("INSERT INTO review_items(player_id, kind, from_user, to_user, no_verdict) VALUES (?,?,?,?,?)",
      player.id, kind, me.id, to?.id ?? (scouts.length === 1 ? scouts[0].id : null), noVerdict ? 1 : 0).lastInsertRowid);
    for (const sc of [...scouts, ...peers]) db.run("INSERT INTO review_assignees(item_id, user_id) VALUES (?,?)", id, sc.id);
    const sentTo = peers.length ? names(peers) : to?.name ?? (names(scouts) || null);
    if (note) {
      const nid = addNoteRow(db, id, me.id, note, "ask");
      // Not one sent with no verdict: that note is a question to the other scout, not a report on the player (it
      // would show as the sender's report on the lead's card). The thread and the player's page keep it.
      if (kind !== "watch" && !noVerdict) addEvalNote(db, { playerId: player.id, userId: me.id, reviewNoteId: nid, body: note,
        context: evalContext(kind, { to: peers.length ? `${sentTo}, then ${to.name},` : sentTo }) });
    }
    logActivity(db, me.id, player.id, `review_${kind}`, { to: sentTo, ...(peers.length ? { lead: to.name } : {}), note, item: id,
      ...(noVerdict ? { no_verdict: true } : {}) });
    if (kind === "watch") hideLast(db);
    return id;
  });
}

// A withdrawn Short Board request: its Activity entries are hidden (the send, the other scout's "on to the lead", and
// the withdrawal just logged) and the copy of its note in the sender's Staff reports goes, since it would say he was
// sent up. The other scout's verdict and report stay, and so does the sender's own review of a player that came back
// to him. The item and its thread stay in the database (and on the player's page, for the scouts: warRoomLog).
function withdrawTraces(db, item) {
  hideLast(db);
  db.run(`UPDATE activity SET hidden = 1 WHERE action = 'review_resolved' AND player_id = ? AND json_extract(detail, '$.kind') = 'sb_review'
    AND json_extract(detail, '$.item') = ?`, item.player_id, item.id);
  db.run(`UPDATE activity SET hidden = 1 WHERE action = 'review_sb_review' AND player_id = ? AND user_id = ?
    AND (json_extract(detail, '$.item') = ? OR (json_extract(detail, '$.item') IS NULL
      AND abs(julianday(created_at) - julianday(?)) * 86400 <= 2))`, item.player_id, item.from_user, item.id, item.created_at);
  db.run(`DELETE FROM notes WHERE review_note_id IN (SELECT id FROM review_notes WHERE item_id = ? AND user_id = ?
    AND (kind = 'ask' OR kind IS NULL))`, item.id, item.from_user);
}

// A nudge to the scouts who haven't answered an assignment yet, from a scout who has (or the lead, or its assigner),
// or on a Short Board request, from the scout who sent it. It shows on their row, which moves to the top of their
// list. A scout already nudged in the last 12 hours isn't nudged again.
export function nudgeAssignees(db, user, itemId) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item) || !item.assignees?.length) fail(404, "Review item not found");
  if (item.status !== "open") fail(409, "Everyone has answered this one");
  if (me.role !== "lead" && item.assignees.find((a) => a.user_id === me.id)?.status === "open") fail(409, "Answer it yourself first");
  const waiting = item.assignees.filter((a) => a.status === "open" && a.user_id !== me.id);
  if (!waiting.length) fail(409, "No one is left to answer");
  const due = waiting.filter((a) => !a.nudged_at || Date.parse(a.nudged_at.replace(" ", "T") + "Z") < Date.now() - 12 * 3600e3);
  if (!due.length) fail(429, `${waiting.map((a) => a.name).join(" and ")} ${waiting.length === 1 ? "was" : "were"} nudged in the last 12 hours`);
  for (const a of due) db.run("UPDATE review_assignees SET nudged_at = datetime('now'), nudged_by = ? WHERE item_id = ? AND user_id = ?", me.id, item.id, a.user_id);
  return due.map((a) => a.name);
}

// The author edited the Staff reports copy of a Review note: the thread shows the same words, marked edited.
export function syncReviewNote(db, reviewNoteId, body) {
  if (reviewNoteId != null) db.run("UPDATE review_notes SET body = ?, updated_at = datetime('now') WHERE id = ?", body, reviewNoteId);
}

export function addNote(db, user, itemId, body) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item)) fail(404, "Review item not found");
  addNoteRow(db, item.id, me.id, text(body, "Note", true), "reply");
}

export function resolveItem(db, user, itemId, input) {
  const me = member(db, user), item = itemRow(db, itemId);
  if (!canSee(me, item)) fail(404, "Review item not found");
  const outcome = input?.outcome, decision = DECISIONS_SB.includes(outcome);
  // An assignment both scouts have answered has settled, but still waits for the lead's decision.
  if (item.status !== "open" && !(item.kind === "assignment" && decision && ["reviewed", "declined"].includes(item.status)))
    fail(409, "This has already been dealt with");
  if (!OUTCOMES[item.kind].includes(outcome)) fail(400, "Choose a valid outcome");
  const verdict = input.verdict ?? null;
  // The other scout's answer on a Short Board request: Pass, Hold or Fail, and why when it's a Fail (it stops there).
  const peerAnswer = item.kind === "sb_review" && outcome === "reviewed";
  if (peerAnswer && !VERDICTS.includes(verdict)) fail(400, "Choose Pass, Hold or Fail");
  const note = text(input.note, "Note", outcome === "added_sb" || outcome === "added_bb" || (peerAnswer && verdict === "fail"));
  if (item.kind === "watch" && item.from_user !== me.id) fail(403, "Only its owner changes a watch list");
  if (item.kind === "sb_review" && outcome === "removed" && item.from_user !== me.id) fail(403, "Only the scout who sent it withdraws a request");
  if (item.kind === "sb_review" && decision && me.role !== "lead") fail(403, "Only the review lead decides the Short Board");
  if (item.kind === "sb_review" && decision && withPeer(item)) fail(409, "It's still with the other scout");
  const mine = (item.kind === "assignment" && !decision && outcome !== "removed") || peerAnswer ? item.assignees.find((a) => a.user_id === me.id) : null;
  if (peerAnswer) {
    if (!mine) fail(403, item.from_user === me.id ? `You sent it: the other scout answers${item.no_verdict ? " first" : ""}` : "Only the scout it was sent to answers this");
    if (mine.status !== "open") fail(409, "You've already answered this one");
  }
  if (item.kind === "assignment") {
    if (decision) {
      if (me.role !== "lead") fail(403, "Only the review lead decides the Short Board");
    } else if (outcome === "removed") {
      if (me.role !== "lead" && item.from_user !== me.id) fail(403, "Only the review lead or whoever assigned it withdraws an assignment");
    } else {
      if (!mine) fail(403, "Only the assigned scouts review this");
      if (mine.status !== "open") fail(409, "You've already answered this one");
    }
  }
  if (verdict != null && (item.kind === "watch" || outcome !== "reviewed" || !VERDICTS.includes(verdict))) fail(400, "Verdict must be pass, hold or fail");
  const role = input.role ?? null;
  if (["added_sb", "added_bb", "moved_bb"].includes(outcome) && (typeof role !== "string" || !Object.hasOwn(ROLES, role))) fail(400, "Choose the Big Board role");
  // Where in the role (0 = top); adding without one puts him at the bottom.
  const index = input.index == null || input.index === "" ? null : Number(input.index);
  if (index != null && !(Number.isInteger(index) && index >= 0)) fail(400, "Choose a rank in the role");
  const onRole = role && db.get("SELECT 1 FROM board_entries WHERE player_id = ? AND role = ?", item.player_id, role);
  if (outcome === "added_bb" && onRole) fail(409, "He's already on the Big Board in that role: move him instead");
  if (outcome === "moved_bb" && !onRole) fail(400, "He isn't on the Big Board in that role");
  if (outcome === "moved_bb" && index == null) fail(400, "Choose a rank in the role");
  let spot = null, onToLead = false, stopped = false, backTo = null;
  const lead = item.kind === "sb_review" ? db.get("SELECT name FROM users WHERE id = ?", item.to_user)?.name ?? null : null;

  db.tx(() => {
    if (outcome === "added_sb") {
      // Through the Big Board's own audited moves, with the note as the written reason.
      if (!db.get("SELECT 1 FROM board_entries WHERE player_id = ? AND role = ?", item.player_id, role))
        addBoardRole(db, item.player_id, role, { source: "Referral: Staff", why: note }, me.id);
      setBoardStar(db, item.player_id, role, true, { why: note }, me.id);
    }
    if (outcome === "added_bb") {
      addBoardRole(db, item.player_id, role, { source: "Referral: Staff", why: note }, me.id);
      if (index != null) moveBoardCard(db, item.player_id, { from_role: role, to_role: role, index }, me.id);
      spot = spotIn(db, item.player_id, role);
    }
    if (outcome === "moved_bb") spot = moveBoardCard(db, item.player_id, { from_role: role, to_role: role, index }, me.id);
    if (verdict) setVerdict(db, item.player_id, me.id, verdict);
    if (peerAnswer) {
      // A Fail stops it. Once no one is left to answer it goes on to the lead if the sender and everyone asked are still
      // Pass or Hold (the sender may have changed his verdict meanwhile). One sent with no verdict goes back to the
      // sender instead, to watch and answer himself: he becomes the one it waits on. Otherwise it stops.
      db.run("UPDATE review_assignees SET status = 'reviewed', resolved_at = datetime('now') WHERE item_id = ? AND user_id = ?", item.id, me.id);
      const left = assigneesOf(db, item.id);
      const all = [...new Set([item.from_user, ...left.map((a) => a.user_id)])];
      if (verdict === "fail") stopped = true;
      else if (!left.some((a) => a.status === "open")) {
        if (all.every((u) => SENDS_UP.includes(verdictOf(db, item.player_id, u)))) onToLead = true;
        else if (item.no_verdict && !left.some((a) => a.user_id === item.from_user)) {
          db.run("INSERT INTO review_assignees(item_id, user_id) VALUES (?,?)", item.id, item.from_user);
          backTo = db.get("SELECT name FROM users WHERE id = ?", item.from_user)?.name ?? "the sender";
        } else stopped = true;
      }
      if (stopped) db.run("UPDATE review_items SET status = 'reviewed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", me.id, item.id);
    } else if (mine && outcome !== "removed") {
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
      // An answer that stops a request is a decision: new to the scout who sent it.
      const nid = addNoteRow(db, item.id, me.id, note, mine && !stopped ? "answer" : "decision");
      const context = outcome === "removed" ? null : evalContext(outcome, { verdict, role, spot });
      if (context) addEvalNote(db, { playerId: item.player_id, userId: me.id, reviewNoteId: nid, body: note, context });
    }
    logActivity(db, me.id, item.player_id, "review_resolved", { kind: item.kind, outcome, role, verdict, note, ...(spot != null ? { spot } : {}),
      ...(peerAnswer ? { item: item.id, lead, ...(onToLead ? { to_lead: true } : {}), ...(stopped ? { stopped: true } : {}),
        ...(backTo ? { back_to: backTo } : {}) } : {}) });
    if (item.kind === "watch") hideLast(db);
    if (item.kind === "sb_review" && outcome === "removed") withdrawTraces(db, item);
  });
  return peerAnswer ? { to_lead: onToLead, stopped, ...(backTo ? { back_to: backTo } : {}) } : {};
}

// Everything the member's Review tab shows. Open items, plus those settled in the last 30 days.
export function reviewBoard(db, user) {
  const me = member(db, user);
  const team = reviewTeam(db);
  const rows = db.all(`SELECT * FROM review_items
    WHERE status = 'open' OR resolved_at >= datetime('now', '-30 days') ORDER BY created_at DESC, id DESC`)
    .map((i) => (i.kind !== "watch" ? { ...i, assignees: assigneesOf(db, i.id) } : i))
    .filter((i) => canSee(me, i) && !(i.kind === "sb_review" && i.status === "removed")); // withdrawn requests are gone
  const notes = rows.length ? db.all(`SELECT n.*, u.name AS user_name FROM review_notes n JOIN users u ON u.id = n.user_id
    WHERE n.item_id IN (${rows.map(() => "?").join(",")}) ORDER BY n.id`, ...rows.map((r) => r.id)) : [];
  const name = (id) => team.find((u) => u.id === id)?.name ?? db.get("SELECT name FROM users WHERE id = ?", id)?.name ?? null;
  // Requests with the lead (not those still with the other scout) hold back an assignment of the same player.
  const openSb = new Set(rows.filter((r) => r.kind === "sb_review" && r.status === "open" && !withPeer(r)).map((r) => r.player_id));
  // An assignment every scout has answered (so it has settled), waiting for the lead's call: in his Decisions and the
  // scouts' Ready for the lead. Until then it waits on the scouts.
  const awaiting = (r) => r.kind === "assignment" && ["reviewed", "declined"].includes(r.status) && !openSb.has(r.player_id);
  const fresh = new Set(rows.length ? db.all(`SELECT n.id FROM review_notes n WHERE ${NEW_TO(me.id)}
    AND n.item_id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.id)).map((n) => n.id) : []);
  const items = rows.map((r) => {
    const thread = notes.filter((n) => n.item_id === r.id);
    // The note sent with the item (why he was assigned or sent up): pinned on its row, however long the thread grows.
    const ask = thread[0] && (thread[0].kind === "ask" || (thread[0].kind == null && thread[0].user_id === r.from_user
      && Math.abs(Date.parse(thread[0].created_at.replace(" ", "T") + "Z") - Date.parse(r.created_at.replace(" ", "T") + "Z")) <= 2000)) ? thread[0].id : null;
    return { ...r, awaiting_lead: awaiting(r), with_peer: withPeer(r), with_sender: withSender(r), from_name: name(r.from_user),
      to_name: sentTo(r) ?? (r.to_user ? name(r.to_user) : null),
      lead_name: r.kind === "sb_review" && r.to_user ? name(r.to_user) : null,
      resolved_by_name: r.resolved_by ? name(r.resolved_by) : null, notes: thread, ask_note_id: ask,
      unread: r.kind === "watch" ? [] : thread.filter((n) => fresh.has(n.id)).map((n) => n.id) };
  });
  const scouts = team.filter((u) => u.role === "scout");
  // What the lead decides on carries each scout's take on the player: their verdict and their latest Staff report
  // (War Room notes are copied there, so it is usually the note they sent or reviewed with), shown in full on the row.
  if (me.role === "lead") {
    for (const it of items) if ((it.kind === "sb_review" && it.status === "open") || it.awaiting_lead) it.takes = scoutTakes(db, scouts, it);
  }
  // Players every scout has passed, not on the Short Board, and never sent up (or decided) before.
  const suggestions = me.role === "scout" && scouts.length >= 2 ? db.all(`SELECT p.id AS player_id FROM players p
    WHERE ${scouts.map(() => "EXISTS (SELECT 1 FROM verdicts v WHERE v.player_id = p.id AND v.user_id = ? AND v.verdict = 'pass')").join(" AND ")}
      AND NOT EXISTS (SELECT 1 FROM board_entries b WHERE b.player_id = p.id AND b.shortlist = 1)
      AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.player_id = p.id AND r.kind = 'sb_review')`, ...scouts.map((u) => u.id)).map((r) => r.player_id) : [];
  return { me, team, items, suggestions };
}

// Every War Room note on a player that the member may see, for the player's page: each item on him that has notes,
// newest first, with its whole thread. All of it, however old: the War Room tab drops what settled more than 30 days
// ago, and replies, watch notes and withdrawal notes have no copy in Staff reports. The tab's own rules hold: a watch
// list is its owner's, a request reaches the lead only once the scouts are through with it, and one a scout withdrew
// stays between the scouts (it left the lead's queue as if never sent). No one outside the review team sees any.
export function warRoomLog(db, user, playerId) {
  const me = user && db.get(`SELECT id, name, ${REVIEW_ROLE} AS role FROM users WHERE id = ?`, user.id);
  if (!me?.role) return [];
  const name = (id) => (id == null ? null : db.get("SELECT name FROM users WHERE id = ?", id)?.name ?? null);
  return db.all("SELECT * FROM review_items WHERE player_id = ? ORDER BY created_at DESC, id DESC", Number(playerId))
    .map((i) => (i.kind !== "watch" ? { ...i, assignees: assigneesOf(db, i.id) } : i))
    .filter((i) => (i.kind === "sb_review" && i.status === "removed" ? me.role === "scout" : canSee(me, i)))
    .map((i) => ({ id: i.id, kind: i.kind, status: i.status, no_verdict: i.no_verdict, created_at: i.created_at, resolved_at: i.resolved_at,
      from_user: i.from_user, from_name: name(i.from_user), to_name: sentTo(i) ?? name(i.to_user),
      lead_name: i.kind === "sb_review" ? name(i.to_user) : null, resolved_by_name: name(i.resolved_by),
      with_peer: withPeer(i), with_sender: withSender(i),
      notes: db.all(`SELECT n.id, n.user_id, u.name AS user_name, n.body, n.kind, n.created_at, n.updated_at
        FROM review_notes n JOIN users u ON u.id = n.user_id WHERE n.item_id = ? ORDER BY n.id`, i.id) }))
    .filter((i) => i.notes.length);
}

// Each scout's verdict and latest Staff report on an item's player. A scout who sent it or was assigned it always
// has a place (even with nothing written yet); anyone else only once they have a verdict or a report.
function scoutTakes(db, scouts, item) {
  const involved = new Set([item.from_user, ...(item.assignees || []).map((a) => a.user_id)]);
  return scouts.map((u) => {
    const v = db.get("SELECT verdict, updated_at FROM verdicts WHERE player_id = ? AND user_id = ?", item.player_id, u.id);
    const staff = db.get(`SELECT id, body, context, created_at, updated_at, review_note_id FROM notes WHERE player_id = ? AND user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`, item.player_id, u.id);
    // College reports written in PINE count too (an NCAA player's write-up lives there, not in Staff reports).
    const college = db.get(`SELECT r.id, r.body, r.grade, r.source, r.created_at FROM ncaa_reports r JOIN ncaa_prospects np ON np.key = r.prospect_key
      WHERE np.player_id = ? AND r.origin = 'pine' AND r.created_by = ? AND r.created_at IS NOT NULL ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, item.player_id, u.id);
    const n = college && (!staff || college.created_at > staff.created_at)
      ? { body: college.body || "", created_at: college.created_at, review_note_id: null,
        context: ["College report", college.grade, college.source].filter(Boolean).join(" · ") }
      : staff;
    const reports = db.get("SELECT count(*) AS n FROM notes WHERE player_id = ? AND user_id = ?", item.player_id, u.id).n
      + db.get(`SELECT count(DISTINCT r.id) AS n FROM ncaa_reports r JOIN ncaa_prospects np ON np.key = r.prospect_key
        WHERE np.player_id = ? AND r.origin = 'pine' AND r.created_by = ?`, item.player_id, u.id).n;
    const answer = (item.assignees || []).find((a) => a.user_id === u.id)?.status ?? null;
    if (!v && !n && !involved.has(u.id)) return null;
    return { user_id: u.id, name: u.name, verdict: v?.verdict ?? null, verdict_at: v?.updated_at ?? null, answer,
      sent: item.kind === "sb_review" && item.from_user === u.id, note: n || null, reports };
  }).filter(Boolean);
}

// How many open items are waiting on this member (the War Room badge). Notes new to him aren't counted: they have
// their own tab.
export function reviewCount(db, user) {
  const m = user && db.get(`SELECT ${REVIEW_ROLE} AS role FROM users WHERE id = ?`, user.id);
  if (!m?.role || m.role === "assigner") return 0; // nothing waits on an assigner
  // The lead: requests waiting on him, plus assignments every scout has answered that he hasn't decided (one per player).
  // Requests still with the other scout aren't his yet.
  if (m.role === "lead") return db.get(`SELECT count(*) AS n FROM review_items i WHERE i.status = 'open' AND i.kind = 'sb_review' AND i.to_user = ?
        AND ${WITH_LEAD("i")}`, user.id).n
    + db.get(`SELECT count(*) AS n FROM review_items i WHERE i.kind = 'assignment' AND i.status IN ('reviewed', 'declined')
        AND i.resolved_at >= datetime('now', '-30 days')
        AND NOT EXISTS (SELECT 1 FROM review_items s WHERE s.kind = 'sb_review' AND s.status = 'open' AND s.player_id = i.player_id AND ${WITH_LEAD("s")})`).n;
  // A scout: assignments to review and Short Board requests sent to him.
  return db.get(`SELECT count(*) AS n FROM review_assignees a JOIN review_items i ON i.id = a.item_id
    WHERE i.status = 'open' AND a.status = 'open' AND a.user_id = ?`, user.id).n;
}

// Once, when notes got a kind and threads their read marks. Notes written before are given their kind: the note sent
// with an item, a scout's answer or the lead's decision (the note its activity entry recorded), else a reply. They all
// count as read: New notes starts empty.
export function seedNoteReads(db) {
  db.run(`UPDATE review_notes SET kind = 'ask' WHERE kind IS NULL
    AND id = (SELECT min(m.id) FROM review_notes m WHERE m.item_id = review_notes.item_id)
    AND EXISTS (SELECT 1 FROM review_items i WHERE i.id = review_notes.item_id AND i.from_user = review_notes.user_id
      AND abs(julianday(i.created_at) - julianday(review_notes.created_at)) * 86400 <= 2)`);
  db.run(`UPDATE review_notes SET kind = coalesce((SELECT CASE WHEN json_extract(a.detail, '$.outcome') IN ('reviewed', 'declined') THEN 'answer' ELSE 'decision' END
      FROM activity a JOIN review_items i ON i.id = review_notes.item_id
      WHERE a.action = 'review_resolved' AND a.user_id = review_notes.user_id AND a.player_id = i.player_id
        AND json_extract(a.detail, '$.kind') = i.kind AND json_extract(a.detail, '$.note') = review_notes.body LIMIT 1), 'reply')
    WHERE kind IS NULL`);
  markBacklogRead(db);
}

// Every note written before `before` (UTC; all of them if omitted) is read for the whole review team.
export function markBacklogRead(db, before = null) {
  const team = reviewTeam(db);
  for (const it of db.all("SELECT item_id AS id, max(id) AS last FROM review_notes WHERE ? IS NULL OR created_at < ? GROUP BY item_id", before, before)) {
    for (const u of team) setRead(db, it.id, u.id, it.last);
  }
}

export function registerReviewQueue(app, { db }) {
  db.once("review_notes_to_evals_2026_11_08", () => copyReviewNotesToEvals(db));
  db.once("review_note_reads_2026_11_15", () => seedNoteReads(db));
  // The first release left the lead's notes of the week before as new (29 for one scout): too many to be of use. All
  // notes from before it went live count as read.
  db.once("review_notes_backlog_read_2026_11_16", () => markBacklogRead(db, "2026-11-16 03:00:00"));
  // Before the lead decided assignments, a Short Board call made on a scout's request left the player's assignment
  // waiting; it takes that call.
  db.once("assignments_settled_by_sb_call_2026_11_08", () => {
    for (const s of db.all("SELECT player_id, status, resolved_by, resolved_at FROM review_items WHERE kind = 'sb_review' AND status IN ('added_sb', 'not_sb') ORDER BY resolved_at")) {
      db.run(`UPDATE review_items SET status = ?, resolved_by = ?, resolved_at = ? WHERE kind = 'assignment' AND player_id = ?
        AND status IN ('open', 'reviewed', 'declined') AND created_at <= ?`, s.status, s.resolved_by, s.resolved_at, s.player_id, s.resolved_at);
    }
  });
  // Ford is bypassed on NCAA players (2026-11-19): open assignments of them drop scouts who skip college players and
  // haven't answered; one whose other scouts have all answered settles and goes to the lead (Pablo Pozos, with Ahan
  // reviewed, did).
  db.once("review_ncaa_bypass_open_2026_11_19", () => {
    const open = db.all(`SELECT i.id, p.league FROM review_items i JOIN players p ON p.id = i.player_id
      WHERE i.kind = 'assignment' AND i.status = 'open'`).filter(isCollege);
    const skip = new Set(db.all("SELECT id FROM users WHERE review_no_ncaa = 1").map((u) => u.id));
    for (const it of open) {
      const left = assigneesOf(db, it.id);
      const keep = left.filter((a) => !(skip.has(a.user_id) && a.status === "open"));
      if (!keep.length || keep.length === left.length) continue;
      db.tx(() => {
        for (const a of left) if (!keep.includes(a)) db.run("DELETE FROM review_assignees WHERE item_id = ? AND user_id = ?", it.id, a.user_id);
        if (!keep.some((a) => a.status === "open")) {
          const last = keep.filter((a) => a.resolved_at).sort((a, b) => (a.resolved_at < b.resolved_at ? -1 : 1)).at(-1);
          db.run("UPDATE review_items SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
            keep.some((a) => a.status === "reviewed") ? "reviewed" : "declined", last?.user_id ?? null, last?.resolved_at ?? null, it.id);
        }
      });
    }
  });
  // Ahan withdrew his Short Board request on Lukas Kamrath (asked 2026-11-08, before scouts could withdraw in the app).
  db.once("withdraw_kamrath_sb_2026_11_08", () => {
    const it = db.get(`SELECT i.id, i.from_user FROM review_items i JOIN players p ON p.id = i.player_id JOIN users u ON u.id = i.from_user
      WHERE i.kind = 'sb_review' AND i.status = 'open' AND p.name = 'Lukas Kamrath' AND u.name = 'Ahan'`);
    if (it) resolveItem(db, { id: it.from_user }, it.id, { outcome: "removed" });
  });
  // Jack Clarkson's assignment had waited on the lead since both scouts reviewed him (2026-11-11); Ahan asked
  // (2026-11-19) for it to leave the War Room. Withdrawn, not decided: no Short Board call is recorded for Ray.
  db.once("withdraw_clarkson_assignment_2026_11_19", () => {
    const it = db.get(`SELECT i.id, i.player_id FROM review_items i JOIN players p ON p.id = i.player_id
      WHERE i.kind = 'assignment' AND i.status IN ('open', 'reviewed', 'declined') AND p.name = 'Jack Clarkson'`);
    const ahan = db.get("SELECT id FROM users WHERE name = 'Ahan'");
    if (!it || !ahan) return;
    db.tx(() => {
      db.run("UPDATE review_items SET status = 'removed', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", ahan.id, it.id);
      logActivity(db, ahan.id, it.player_id, "review_resolved", { kind: "assignment", outcome: "removed" });
    });
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
  app.post("/api/review/items/:id/read", (c) => { markRead(db, actor(c), c.req.param("id")); return c.json({ ok: true }); });
  app.post("/api/review/items/:id/nudge", (c) => c.json({ nudged: nudgeAssignees(db, actor(c), c.req.param("id")) }));
  app.post("/api/review/items/:id/resolve", async (c) => {
    const out = resolveItem(db, actor(c), c.req.param("id"), await c.req.json());
    return c.json({ ok: true, ...out });
  });
}
