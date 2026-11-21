import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_ROLE, addNote, registerReviewQueue, copyReviewNotesToEvals, createItem, markBacklogRead, markRead, nudgeAssignees as nudge, resolveItem, reviewBoard, reviewCount, reviewTeam, seedNoteReads, syncReviewNote } from '../src/lib/review_queue.js';

// openDb seeds Ray (1, lead), Ahan (2, scout), Ford (3, scout), Bobby (4, assigner), Alex (5, not on the review team).
const RAY = { id: 1 }, AHAN = { id: 2 }, FORD = { id: 3 }, BOBBY = { id: 4 }, ALEX = { id: 5 };
function setup(t) {
  const db = openDb(':memory:'); t.after(() => db.raw.close());
  for (const id of [1, 2, 3, 4, 5]) db.run('INSERT INTO players(id, name) VALUES (?, ?)', id, `Example ${id}`);
  return db;
}
const statuses = (db) => db.all('SELECT kind, status FROM review_items ORDER BY id').map((r) => `${r.kind}:${r.status}`);

test('the review team is Ray as lead, Ahan and Ford as scouts, and Bobby as an assigner', (t) => {
  const db = setup(t);
  assert.deepEqual(db.all(`SELECT name, ${REVIEW_ROLE} AS r FROM users WHERE ${REVIEW_ROLE} IS NOT NULL ORDER BY id`).map((u) => `${u.name}:${u.r}`),
    ['Ray:lead', 'Ahan:scout', 'Ford:scout', 'Bobby:assigner']);
  assert.deepEqual(reviewTeam(db).map((u) => u.role), ['lead', 'scout', 'scout', 'assigner']);
});

test('a watch list is private to its owner and only for the review team', (t) => {
  const db = setup(t);
  createItem(db, AHAN, { kind: 'watch', player_id: 1, note: 'Follow up after the cup game.' });
  assert.throws(() => createItem(db, AHAN, { kind: 'watch', player_id: 1 }), /already on your watch list/);
  assert.throws(() => createItem(db, ALEX, { kind: 'watch', player_id: 1 }), /review team/);
  assert.equal(reviewBoard(db, FORD).items.length, 0, 'another member never sees it');
  const [item] = reviewBoard(db, AHAN).items;
  assert.equal(item.notes[0].body, 'Follow up after the cup game.');
  assert.throws(() => resolveItem(db, RAY, item.id, { outcome: 'removed' }), /not found/);
  resolveItem(db, AHAN, item.id, { outcome: 'removed' });
  assert.deepEqual(statuses(db), ['watch:removed']);
  assert.deepEqual(db.all("SELECT hidden FROM activity WHERE action LIKE 'review_%'").map((r) => r.hidden), [1, 1], 'kept out of the shared feed');
});

test('scouts send a player up; the lead puts him on the Short Board through the audited board moves', (t) => {
  const db = setup(t);
  const id = createItem(db, AHAN, { kind: 'sb_review', player_id: 2, note: 'We both passed him on video.' });
  assert.throws(() => createItem(db, FORD, { kind: 'sb_review', player_id: 2 }), /already waiting/);
  assert.throws(() => createItem(db, RAY, { kind: 'sb_review', player_id: 3 }), /Scouts send/);
  assert.equal(reviewBoard(db, FORD).items.length, 1, 'the scouts share what was sent up');
  assert.equal(reviewCount(db, RAY), 1);
  assert.throws(() => resolveItem(db, AHAN, id, { outcome: 'added_sb', role: 'FWD1', note: 'x' }), /Only the review lead/);
  assert.throws(() => resolveItem(db, RAY, id, { outcome: 'added_sb', role: 'FWD1' }), /Note is required/);
  assert.throws(() => resolveItem(db, RAY, id, { outcome: 'added_sb', role: 'NOPE', note: 'x' }), /role/);
  resolveItem(db, RAY, id, { outcome: 'added_sb', role: 'FWD1', note: 'Top of our striker list.' });
  assert.equal(db.get('SELECT shortlist FROM board_entries WHERE player_id = 2 AND role = ?', 'FWD1').shortlist, 1);
  assert.deepEqual(db.all('SELECT kind, why FROM board_reasons WHERE player_id = 2 ORDER BY id').map((r) => `${r.kind}:${r.why}`),
    ['add:Top of our striker list.', 'promote:Top of our striker list.']);
  assert.equal(reviewCount(db, RAY), 0);
  assert.throws(() => resolveItem(db, RAY, id, { outcome: 'not_sb' }), /already been dealt with/);
  const declined = createItem(db, FORD, { kind: 'sb_review', player_id: 3 });
  resolveItem(db, RAY, declined, { outcome: 'not_sb', note: 'Not for this window.' });
  assert.deepEqual(statuses(db), ['sb_review:added_sb', 'sb_review:not_sb']);
});

test('the scout who sent a request can withdraw it: gone from the queue, the Review tab, Activity and Staff reports', (t) => {
  const db = setup(t);
  const id = createItem(db, AHAN, { kind: 'sb_review', player_id: 2, note: 'Second thoughts coming.' });
  assert.equal(db.get('SELECT count(*) AS n FROM notes WHERE player_id = 2').n, 1, 'the send note was copied to his Staff reports');
  assert.equal(reviewCount(db, RAY), 1);
  assert.throws(() => resolveItem(db, FORD, id, { outcome: 'removed' }), /Only the scout who sent it/);
  assert.throws(() => resolveItem(db, RAY, id, { outcome: 'removed' }), /Only the scout who sent it/);
  resolveItem(db, AHAN, id, { outcome: 'removed' });
  assert.equal(reviewCount(db, RAY), 0);
  for (const who of [RAY, AHAN, FORD]) assert.equal(reviewBoard(db, who).items.length, 0);
  assert.deepEqual(db.all("SELECT action, hidden FROM activity WHERE action LIKE 'review_%' ORDER BY id").map((r) => `${r.action}:${r.hidden}`),
    ['review_sb_review:1', 'review_resolved:1']);
  assert.equal(db.get('SELECT count(*) AS n FROM notes WHERE player_id = 2').n, 0);
  assert.throws(() => resolveItem(db, AHAN, id, { outcome: 'removed' }), /already been dealt with/);
  createItem(db, FORD, { kind: 'sb_review', player_id: 2 }); // the player can be sent again
});

test('the lead assigns both scouts: one item and thread they share, each answering on their own', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1, note: 'Watch his last three games.' });
  assert.throws(() => createItem(db, RAY, { kind: 'assignment', player_id: 1 }), /already out for review/);
  assert.throws(() => createItem(db, AHAN, { kind: 'assignment', player_id: 2 }), /Only the review lead/);
  for (const scout of [AHAN, FORD]) {
    const [item] = reviewBoard(db, scout).items;
    assert.equal(item.id, a, 'both scouts see the same item');
    assert.equal(item.to_name, 'Ahan and Ford');
  }
  assert.equal(reviewCount(db, AHAN), 1); assert.equal(reviewCount(db, FORD), 1);
  addNote(db, FORD, a, 'I can take the first two.');
  resolveItem(db, AHAN, a, { outcome: 'reviewed', verdict: 'pass', note: 'Good in possession.' });
  assert.throws(() => resolveItem(db, AHAN, a, { outcome: 'declined' }), /already answered/);
  assert.equal(db.get('SELECT verdict FROM verdicts WHERE player_id = 1 AND user_id = 2').verdict, 'pass');
  let item = reviewBoard(db, RAY).items[0];
  assert.equal(item.status, 'open', 'open until every scout has answered');
  assert.deepEqual(item.assignees.map((x) => `${x.name}:${x.status}`), ['Ahan:reviewed', 'Ford:open']);
  assert.equal(reviewCount(db, AHAN), 0); assert.equal(reviewCount(db, FORD), 1);
  resolveItem(db, FORD, a, { outcome: 'declined', note: 'Seen enough from Ahan\'s notes.' });
  item = reviewBoard(db, RAY).items[0];
  assert.deepEqual([item.status, item.notes.length], ['reviewed', 4], 'settled as reviewed when anyone reviewed; one thread');
  assert.throws(() => reviewBoard(db, ALEX), /review team/);
});

test('an assignment waits in the lead\'s Decisions once both scouts have answered; his call closes it', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1, note: 'Free agent.' });
  const decisions = () => reviewBoard(db, RAY).items.filter((i) => i.awaiting_lead || (i.kind === 'sb_review' && i.status === 'open')).map((i) => `${i.kind}:${i.player_id}`);
  resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'hold', note: 'Low ball wins.' });
  assert.deepEqual([decisions(), reviewCount(db, RAY)], [[], 0], 'one answer is not enough: it waits on Ahan');
  assert.equal(reviewBoard(db, FORD).items.find((i) => i.id === a).awaiting_lead, false);
  resolveItem(db, AHAN, a, { outcome: 'reviewed', verdict: 'fail', note: 'Not for us.' });
  assert.deepEqual([decisions(), reviewCount(db, RAY)], [['assignment:1'], 1]);
  assert.equal(reviewBoard(db, FORD).items.find((i) => i.id === a).awaiting_lead, true, 'Ford sees it waiting on Ray (Ready for Ray)');
  assert.throws(() => resolveItem(db, AHAN, a, { outcome: 'not_sb' }), /Only the review lead decides/);
  resolveItem(db, RAY, a, { outcome: 'not_sb', note: 'Not for this window.' });
  assert.equal(db.get('SELECT status FROM review_items WHERE id = ?', a).status, 'not_sb');
  assert.deepEqual([decisions(), reviewCount(db, RAY)], [[], 0]);
  assert.equal(reviewBoard(db, FORD).items.find((i) => i.id === a).awaiting_lead, false, 'decided: off Ready, into History');

  // The lead can still call one early (it isn't in his Decisions, but nothing stops him); it closes for both scouts.
  const early = createItem(db, RAY, { kind: 'assignment', player_id: 5 });
  resolveItem(db, RAY, early, { outcome: 'not_sb' });
  assert.equal(reviewCount(db, AHAN), 0);
  assert.throws(() => resolveItem(db, AHAN, early, { outcome: 'reviewed' }), /already been dealt with/);

  // Answered by both (settled as reviewed) and sent up too: one row, and one call settles both.
  const b = createItem(db, RAY, { kind: 'assignment', player_id: 2 });
  resolveItem(db, AHAN, b, { outcome: 'reviewed', verdict: 'pass' });
  resolveItem(db, FORD, b, { outcome: 'declined' });
  assert.deepEqual(decisions(), ['assignment:2']);
  const sb = createItem(db, AHAN, { kind: 'sb_review', player_id: 2, note: 'SB him.' });
  assert.deepEqual([decisions(), reviewCount(db, RAY)], [['sb_review:2'], 1], 'the request stands for the player');
  resolveItem(db, RAY, sb, { outcome: 'added_sb', role: 'FWD1', note: 'Top of the list.' });
  assert.deepEqual(db.all('SELECT kind, status FROM review_items WHERE player_id = 2 ORDER BY id').map((r) => `${r.kind}:${r.status}`),
    ['assignment:added_sb', 'sb_review:added_sb']);

  // Deciding from the assignment does the Short Board move itself.
  const c = createItem(db, RAY, { kind: 'assignment', player_id: 3 });
  resolveItem(db, FORD, c, { outcome: 'reviewed', verdict: 'pass' });
  resolveItem(db, RAY, c, { outcome: 'added_sb', role: 'FWD1', note: 'Ford passed him.' });
  assert.equal(db.get("SELECT shortlist FROM board_entries WHERE player_id = 3 AND role = 'FWD1'").shortlist, 1);
  assert.equal(reviewCount(db, RAY), 0);
});

test('an assignment always goes to every scout, even when an old page names one; all declining settles it as declined', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1, to_user: 2 });
  assert.deepEqual(reviewBoard(db, RAY).items[0].assignees.map((x) => x.name), ['Ahan', 'Ford']);
  assert.equal(db.get('SELECT to_user FROM review_items WHERE id = ?', a).to_user, null);
  assert.equal(reviewBoard(db, FORD).items.length, 1, 'Ford sees it too');
  resolveItem(db, FORD, a, { outcome: 'declined' });
  resolveItem(db, AHAN, a, { outcome: 'declined' });
  assert.equal(reviewBoard(db, RAY).items[0].status, 'declined');
  const b = createItem(db, RAY, { kind: 'assignment', player_id: 2 });
  assert.throws(() => resolveItem(db, AHAN, b, { outcome: 'removed' }), /withdraws/);
  resolveItem(db, RAY, b, { outcome: 'removed' });
  assert.deepEqual(statuses(db), ['assignment:declined', 'assignment:removed']);
  assert.equal(reviewCount(db, AHAN), 0, 'a withdrawn assignment waits on no one');
});

test('open assignments made for one scout get every scout when PINE starts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-review-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pine.db');
  let db = openDb(file);
  for (const id of [1, 2]) db.run('INSERT INTO players(id, name) VALUES (?, ?)', id, `Example ${id}`);
  // As the old page left them: one scout each; the second already settled.
  for (const [player, status] of [[1, 'open'], [2, 'reviewed']]) {
    const id = Number(db.run("INSERT INTO review_items(player_id, kind, from_user, to_user, status) VALUES (?, 'assignment', 1, 2, ?)", player, status).lastInsertRowid);
    db.run('INSERT INTO review_assignees(item_id, user_id, status) VALUES (?, 2, ?)', id, status);
  }
  db.run("DELETE FROM done_migrations WHERE name = 'review_assign_every_scout_2026_11_07'");
  db.raw.close();
  db = openDb(file); t.after(() => db.raw.close());
  assert.deepEqual(db.all(`SELECT i.player_id AS p, i.to_user, group_concat(a.user_id || ':' || a.status) AS who FROM review_items i
    JOIN review_assignees a ON a.item_id = i.id GROUP BY i.id ORDER BY i.id`).map((r) => ({ ...r })),
    [{ p: 1, to_user: null, who: '2:open,3:open' }, { p: 2, to_user: 2, who: '2:reviewed' }]);
  assert.equal(reviewCount(db, FORD), 1);
});

test('players both scouts passed are suggested until someone sends them up, and never once on the Short Board', (t) => {
  const db = setup(t);
  for (const [p, u] of [[4, 2], [4, 3], [5, 2], [5, 3], [1, 2]]) db.run("INSERT INTO verdicts(player_id, user_id, verdict) VALUES (?, ?, 'pass')", p, u);
  db.run("INSERT INTO board_entries(player_id, role, rank, shortlist) VALUES (5, 'FWD1', 1, 1)");
  assert.deepEqual(reviewBoard(db, AHAN).suggestions, [4]);
  assert.deepEqual(reviewBoard(db, RAY).suggestions, [], 'suggestions are for the scouts');
  createItem(db, FORD, { kind: 'sb_review', player_id: 4 });
  assert.deepEqual(reviewBoard(db, AHAN).suggestions, []);
});

test('notes that report on a player go in the author\'s staff evaluation; replies and watch lists stay in Review', (t) => {
  const db = setup(t);
  const evals = () => db.all(`SELECT n.player_id AS p, u.name AS who, n.context, n.body FROM notes n JOIN users u ON u.id = n.user_id
    ORDER BY n.player_id, n.id`).map((r) => `${r.p}|${r.who}|${r.context}|${r.body}`);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1, note: 'Good offensive production two years in a row.' });
  addNote(db, AHAN, a, 'I can take the first two games.');
  resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'hold', note: 'More of a deep/wide winger.' });
  resolveItem(db, AHAN, a, { outcome: 'declined' }); // no note, nothing to copy
  const sb = createItem(db, AHAN, { kind: 'sb_review', player_id: 2, note: 'BP LF CB, very good technique.' });
  resolveItem(db, RAY, sb, { outcome: 'added_sb', role: 'FWD1', note: 'Needed depth.' });
  createItem(db, AHAN, { kind: 'watch', player_id: 3, note: 'Private follow-up.' });
  db.run("INSERT INTO notes(player_id, user_id, body) VALUES (4, 2, 'Already  written here')");
  const c = createItem(db, RAY, { kind: 'assignment', player_id: 4, note: 'Already written here.' }); // Ray's, so it's copied
  resolveItem(db, AHAN, c, { outcome: 'reviewed', note: 'Already written here.' }); // Ahan wrote it (bar a full stop): no duplicate
  const live = evals();
  assert.deepEqual(live, [
    '1|Ray|Review: asked Ahan and Ford to review|Good offensive production two years in a row.',
    '1|Ford|Review: reviewed, Hold|More of a deep/wide winger.',
    '2|Ahan|Review: sent to Ray for the Short Board|BP LF CB, very good technique.',
    '2|Ray|Review: put on the Short Board (FWD Complete)|Needed depth.',
    '4|Ahan|null|Already  written here',
    '4|Ray|Review: asked Ahan and Ford to review|Already written here.',
  ]);
  // The one-time copy of older notes reads the same actions back from the timestamps, and never copies twice.
  db.run('DELETE FROM notes WHERE review_note_id IS NOT NULL');
  copyReviewNotesToEvals(db);
  copyReviewNotesToEvals(db);
  assert.deepEqual(evals().sort(), live.sort());
});

test('editing the Staff reports copy of a Review note updates the thread, marked edited', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1 });
  resolveItem(db, AHAN, a, { outcome: 'reviewed', verdict: 'hold', note: 'First take.' });
  const copy = db.get('SELECT review_note_id FROM notes WHERE player_id = 1 AND user_id = 2');
  syncReviewNote(db, copy.review_note_id, 'First take, plus the second watch.');
  const [n] = reviewBoard(db, RAY).items[0].notes;
  assert.equal(n.body, 'First take, plus the second watch.');
  assert.ok(n.updated_at);
  syncReviewNote(db, null, 'ignored'); // an ordinary note has no Review original
});

test('the lead can put a reviewed player on the Big Board, or move him up it, instead of the Short Board', (t) => {
  const db = setup(t);
  for (const id of [1, 2, 3]) db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (?, 'FWD1', ?)", id, id - 1);
  // Player 4: not on the board. Added at #2 of FWD1, with the reason recorded like any Big Board add.
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 4 });
  resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'hold' });
  assert.throws(() => resolveItem(db, RAY, a, { outcome: 'added_bb', role: 'FWD1' }), /Note is required/);
  assert.throws(() => resolveItem(db, AHAN, a, { outcome: 'added_bb', role: 'FWD1', note: 'x' }), /Only the review lead/);
  resolveItem(db, RAY, a, { outcome: 'added_bb', role: 'FWD1', index: 1, note: 'Depth behind our top two.' });
  const order = () => db.all("SELECT player_id FROM board_entries WHERE role = 'FWD1' ORDER BY rank").map((r) => r.player_id);
  assert.deepEqual(order(), [1, 4, 2, 3]);
  assert.equal(db.get("SELECT shortlist FROM board_entries WHERE player_id = 4").shortlist, 0, 'not starred');
  assert.equal(db.get("SELECT why FROM board_reasons WHERE player_id = 4 AND kind = 'add'").why, 'Depth behind our top two.');
  assert.equal(db.get('SELECT status FROM review_items WHERE id = ?', a).status, 'added_bb');
  assert.equal(db.get('SELECT context FROM notes WHERE player_id = 4 AND user_id = 1').context, 'Review: added to the Big Board (FWD Complete, #2)');

  // Player 3, already on FWD1 at #4: a request moves him to the top.
  const sb = createItem(db, AHAN, { kind: 'sb_review', player_id: 3, note: 'Better than his spot.' });
  assert.throws(() => resolveItem(db, RAY, sb, { outcome: 'added_bb', role: 'FWD1', note: 'x' }), /already on the Big Board in that role/);
  assert.throws(() => resolveItem(db, RAY, sb, { outcome: 'moved_bb', role: 'FWD1' }), /Choose a rank/);
  assert.throws(() => resolveItem(db, RAY, sb, { outcome: 'moved_bb', role: 'FWD2', index: 0 }), /isn't on the Big Board in that role/);
  resolveItem(db, RAY, sb, { outcome: 'moved_bb', role: 'FWD1', index: 0 });
  assert.deepEqual(order(), [3, 1, 4, 2]);
  assert.equal(db.get('SELECT status FROM review_items WHERE id = ?', sb).status, 'moved_bb');
  assert.equal(reviewCount(db, RAY), 0);
});

test('a scout who has answered (or the lead) can nudge the one who has not, at most every 12 hours', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1 });
  assert.throws(() => nudge(db, AHAN, a), /Answer it yourself first/);
  resolveItem(db, AHAN, a, { outcome: 'reviewed', verdict: 'fail' });
  assert.deepEqual(nudge(db, AHAN, a), ['Ford']);
  const ford = reviewBoard(db, FORD).items[0].assignees.find((x) => x.name === 'Ford');
  assert.ok(ford.nudged_at);
  assert.equal(ford.nudged_by_name, 'Ahan');
  assert.throws(() => nudge(db, AHAN, a), /nudged in the last 12 hours/);
  assert.throws(() => nudge(db, RAY, a), /nudged in the last 12 hours/);
  db.run("UPDATE review_assignees SET nudged_at = datetime('now', '-13 hours') WHERE user_id = 3");
  assert.deepEqual(nudge(db, RAY, a), ['Ford'], 'the lead can nudge too, after 12 hours');
  assert.throws(() => nudge(db, ALEX, a), /review team/);
  assert.throws(() => nudge(db, BOBBY, a), /not found/, 'an assigner nudges only on what he assigned');
  resolveItem(db, FORD, a, { outcome: 'declined' });
  assert.throws(() => nudge(db, AHAN, a), /Everyone has answered/);
});

test('notes need text and visibility', (t) => {
  const db = setup(t);
  const id = createItem(db, AHAN, { kind: 'sb_review', player_id: 1 });
  addNote(db, RAY, id, 'Can you send me clips?');
  addNote(db, FORD, id, 'Sent in the group chat.');
  assert.throws(() => addNote(db, RAY, id, '   '), /Note is required/);
  assert.throws(() => addNote(db, ALEX, id, 'hi'), /review team/);
  assert.throws(() => addNote(db, BOBBY, id, 'hi'), /not found/, 'the scouts\' requests are between them and the lead');
  assert.deepEqual(reviewBoard(db, AHAN).items[0].notes.map((n) => `${n.user_name}: ${n.body}`),
    ['Ray: Can you send me clips?', 'Ford: Sent in the group chat.']);
  db.run('DELETE FROM players WHERE id = 1');
  assert.equal(db.get('SELECT count(*) AS n FROM review_notes').n, 0, 'a deleted player takes his review items with him');
});

test('an assigner (Bobby) assigns players to every scout like the lead; the lead still makes the call', (t) => {
  const db = setup(t);
  const a = createItem(db, BOBBY, { kind: 'assignment', player_id: 1, note: 'Saw him live on Saturday.' });
  assert.deepEqual(db.all('SELECT user_id FROM review_assignees WHERE item_id = ?', a).map((r) => r.user_id), [2, 3], 'to Ahan and Ford');
  assert.throws(() => createItem(db, RAY, { kind: 'assignment', player_id: 1 }), /already out for review/);
  assert.throws(() => createItem(db, BOBBY, { kind: 'sb_review', player_id: 2 }), /Scouts send/);
  assert.throws(() => createItem(db, AHAN, { kind: 'assignment', player_id: 2 }), /lead or an assigner/);
  assert.throws(() => createItem(db, ALEX, { kind: 'assignment', player_id: 2 }), /review team/);
  assert.equal(db.get("SELECT context FROM notes WHERE player_id = 1 AND user_id = 4").context, 'Review: asked Ahan and Ford to review', 'his note goes in his Staff reports');
  assert.equal(reviewBoard(db, AHAN).items[0].from_name, 'Bobby');
  assert.equal(reviewBoard(db, RAY).items[0].from_name, 'Bobby', 'the lead sees it too');
  assert.deepEqual([reviewCount(db, AHAN), reviewCount(db, FORD), reviewCount(db, BOBBY)], [1, 1, 0], 'nothing waits on an assigner');

  // He sees what he assigned, not the scouts' requests or the lead's own assignments.
  const sb = createItem(db, FORD, { kind: 'sb_review', player_id: 3 });
  const ray = createItem(db, RAY, { kind: 'assignment', player_id: 4 });
  assert.deepEqual(reviewBoard(db, BOBBY).items.map((i) => i.id), [a]);
  assert.throws(() => resolveItem(db, BOBBY, sb, { outcome: 'not_sb' }), /not found/);
  assert.throws(() => resolveItem(db, BOBBY, ray, { outcome: 'removed' }), /not found/);
  addNote(db, AHAN, a, 'Watching his last three.');
  addNote(db, BOBBY, a, 'Thanks.');
  assert.throws(() => resolveItem(db, BOBBY, a, { outcome: 'reviewed' }), /Only the assigned scouts/);

  // He can nudge, then the lead decides once both scouts have answered.
  resolveItem(db, AHAN, a, { outcome: 'reviewed', verdict: 'pass', note: 'Good.' });
  assert.deepEqual(nudge(db, BOBBY, a), ['Ford']);
  assert.equal(reviewBoard(db, FORD).items.find((i) => i.id === a).assignees.find((x) => x.name === 'Ford').nudged_by_name, 'Bobby');
  resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'hold' });
  assert.equal(reviewBoard(db, BOBBY).items[0].awaiting_lead, true, 'waiting on Ray');
  assert.equal(reviewCount(db, RAY), 2, 'in Ray\'s Decisions beside Ford\'s request');
  assert.throws(() => resolveItem(db, BOBBY, a, { outcome: 'not_sb' }), /Only the review lead decides/);
  resolveItem(db, RAY, a, { outcome: 'added_bb', role: 'CM1', note: 'Worth a spot.' });
  assert.equal(reviewBoard(db, BOBBY).items[0].status, 'added_bb');

  // He withdraws his own open assignment; the lead can withdraw his too.
  const b = createItem(db, BOBBY, { kind: 'assignment', player_id: 5 });
  resolveItem(db, BOBBY, b, { outcome: 'removed', note: 'Signed elsewhere.' });
  assert.equal(db.get('SELECT status FROM review_items WHERE id = ?', b).status, 'removed');
  const c = createItem(db, BOBBY, { kind: 'assignment', player_id: 5 });
  resolveItem(db, RAY, c, { outcome: 'removed' });
  assert.equal(reviewCount(db, AHAN), 1, 'only Ray\'s assignment is left for Ahan');
});

const unread = (db, who) => reviewBoard(db, who).items.filter((i) => i.unread.length).map((i) => i.id);

test('a note from the lead is new to the scouts until they reply or mark it read, and a thread takes replies after it settles', (t) => {
  const db = setup(t);
  const sb = createItem(db, AHAN, { kind: 'sb_review', player_id: 1, note: 'Both passed him.' });
  assert.deepEqual([unread(db, RAY), unread(db, FORD)], [[], []], 'the note sent with a request is not a new note: the request is');
  addNote(db, RAY, sb, 'Is his shooting good enough in the data?');
  assert.deepEqual([unread(db, AHAN), unread(db, FORD), unread(db, RAY)], [[sb], [sb], []]);
  assert.deepEqual([reviewCount(db, AHAN), reviewCount(db, FORD), reviewCount(db, RAY)], [0, 0, 1], 'the badge stays what waits on you: Ray\'s 1 is the request');
  addNote(db, AHAN, sb, 'Top third for xG per shot, low volume.');
  assert.deepEqual([unread(db, AHAN), unread(db, RAY), reviewCount(db, RAY)], [[], [sb], 1], 'replying deals with it; the reply is new to Ray');
  assert.equal(reviewBoard(db, FORD).items[0].unread.length, 2, 'Ford has both to read');
  markRead(db, FORD, sb);
  assert.deepEqual(unread(db, FORD), []);
  assert.throws(() => markRead(db, ALEX, sb), /review team/);
  assert.throws(() => markRead(db, BOBBY, sb), /not found/);

  // His decision note settles the item, and is still theirs to read and answer.
  resolveItem(db, RAY, sb, { outcome: 'not_sb', note: 'Not yet. Can he play wide too?' });
  assert.deepEqual([unread(db, AHAN), unread(db, FORD), reviewCount(db, AHAN)], [[sb], [sb], 0]);
  addNote(db, FORD, sb, 'He played 6 games at RW last year.');
  assert.deepEqual([unread(db, FORD), unread(db, RAY), reviewCount(db, RAY)], [[], [sb], 0], 'a reply on a settled thread reaches Ray');
  assert.equal(db.get('SELECT status FROM review_items WHERE id = ?', sb).status, 'not_sb', 'the call is still his');
  assert.equal(db.get("SELECT count(*) AS n FROM notes WHERE body LIKE 'He played 6%'").n, 0, 'replies stay out of Staff reports');
  markRead(db, RAY, sb); markRead(db, AHAN, sb);
  assert.deepEqual([unread(db, RAY), unread(db, AHAN)], [[], []]);
});

test('the note sent with an assignment stays pinned, and a scout\'s own answer is not a new note to the others', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1, note: 'Is he good enough shooting, data-wise?' });
  resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'hold', note: 'Decent on video.' });
  assert.deepEqual([unread(db, AHAN), unread(db, RAY), reviewCount(db, RAY)], [[], [], 0], 'Ahan reviews blind; it reaches Ray when both have answered');
  let item = reviewBoard(db, AHAN).items[0];
  assert.equal(item.notes.find((n) => n.id === item.ask_note_id).body, 'Is he good enough shooting, data-wise?', 'still pinned under Ford\'s note');
  addNote(db, RAY, a, 'Ahan, check his xG too.');
  assert.deepEqual([unread(db, AHAN), reviewCount(db, AHAN)], [[a], 1], 'new to Ahan; the badge is the review he owes');
  resolveItem(db, AHAN, a, { outcome: 'reviewed', verdict: 'fail', note: 'Bottom third for xG per shot.' });
  assert.deepEqual([unread(db, AHAN), reviewCount(db, AHAN)], [[], 0], 'answering under it deals with it');
  assert.deepEqual(db.all('SELECT kind FROM review_notes ORDER BY id').map((n) => n.kind), ['ask', 'answer', 'reply', 'answer']);

  // A request with no note has nothing pinned; a watch list never has new notes; an assigner hears back on his own.
  const bare = createItem(db, FORD, { kind: 'sb_review', player_id: 2 });
  addNote(db, RAY, bare, 'Why him?');
  assert.equal(reviewBoard(db, FORD).items.find((i) => i.id === bare).ask_note_id, null);
  const mine = createItem(db, BOBBY, { kind: 'assignment', player_id: 3, note: 'Agent called.' });
  addNote(db, AHAN, mine, 'Which agent?');
  assert.deepEqual([unread(db, BOBBY), reviewCount(db, BOBBY)], [[mine], 0], 'no request or Ray assignment in his list');
  assert.deepEqual(unread(db, RAY).sort(), [mine], 'the lead sees every assignment thread');
});

test('notes written before read marks are given their kind and all count as read; a later clear-out spares notes after its cutoff', (t) => {
  const db = setup(t);
  const old = createItem(db, AHAN, { kind: 'sb_review', player_id: 1, note: 'Send him up.' });
  resolveItem(db, RAY, old, { outcome: 'not_sb', note: 'Too old for us.' });
  const recent = createItem(db, RAY, { kind: 'assignment', player_id: 2, note: 'Shooting good enough?' });
  resolveItem(db, AHAN, recent, { outcome: 'reviewed', verdict: 'fail', note: 'No.' });
  resolveItem(db, FORD, recent, { outcome: 'reviewed', verdict: 'hold' });
  resolveItem(db, RAY, recent, { outcome: 'not_sb', note: 'Agree. What about his data?' });
  const replied = createItem(db, FORD, { kind: 'sb_review', player_id: 3 });
  addNote(db, RAY, replied, 'Clips?');
  addNote(db, FORD, replied, 'Sent.');
  // As it was before notes had kinds and read marks.
  db.run('UPDATE review_notes SET kind = NULL'); db.run('DELETE FROM review_reads');
  seedNoteReads(db);
  assert.deepEqual(db.all('SELECT kind FROM review_notes ORDER BY id').map((n) => n.kind), ['ask', 'decision', 'ask', 'answer', 'decision', 'reply', 'reply']);
  assert.deepEqual([unread(db, AHAN), unread(db, FORD), unread(db, RAY)], [[], [], []], 'New notes starts empty');

  // The clear-out after the first release: read marks back as that release left them, one note written since.
  db.run('DELETE FROM review_reads');
  db.run("UPDATE review_notes SET created_at = datetime('now', '-2 days')");
  addNote(db, RAY, old, 'Any change on him?');
  db.run('DELETE FROM review_reads');
  assert.equal(unread(db, AHAN).length, 3);
  markBacklogRead(db, db.get("SELECT datetime('now', '-1 day') AS t").t);
  assert.deepEqual([unread(db, AHAN), unread(db, FORD), unread(db, RAY)], [[old], [old], []], 'only the note written since is still new');
});

test('an NCAA player is assigned to Ahan only: Ford is bypassed, whoever assigns him', (t) => {
  const db = setup(t);
  db.run("UPDATE players SET league = 'NCAA' WHERE id IN (1, 2)");
  const who = (id) => db.all('SELECT user_id FROM review_assignees WHERE item_id = ? ORDER BY user_id', id).map((r) => r.user_id);
  const college = createItem(db, RAY, { kind: 'assignment', player_id: 1, note: 'Senior year film.' });
  assert.deepEqual(who(college), [2]);
  assert.deepEqual(who(createItem(db, BOBBY, { kind: 'assignment', player_id: 2 })), [2], 'Bobby too');
  assert.deepEqual(who(createItem(db, RAY, { kind: 'assignment', player_id: 3 })), [2, 3], 'a pro player still goes to both');
  assert.equal(reviewBoard(db, FORD).items.some((i) => i.id === college), false, 'Ford never sees it');
  assert.equal(reviewBoard(db, RAY).items.find((i) => i.id === college).to_name, 'Ahan');
  resolveItem(db, AHAN, college, { outcome: 'reviewed', verdict: 'pass', note: 'Ready for USL1.' });
  assert.equal(db.get('SELECT status FROM review_items WHERE id = ?', college).status, 'reviewed', 'his answer alone settles it for Ray');
  db.run('UPDATE users SET review_no_ncaa = 1 WHERE id = 2');
  db.run("UPDATE players SET league = 'NCAA' WHERE id = 4");
  assert.deepEqual(who(createItem(db, RAY, { kind: 'assignment', player_id: 4 })), [2, 3], 'if no scout would be left, both get him');
});

test('open NCAA assignments drop Ford once: one Ahan has answered goes to Ray, one he has not stays with him', (t) => {
  const db = setup(t);
  const answered = createItem(db, RAY, { kind: 'assignment', player_id: 1 });
  const waiting = createItem(db, RAY, { kind: 'assignment', player_id: 2 });
  const pro = createItem(db, RAY, { kind: 'assignment', player_id: 3 });
  resolveItem(db, AHAN, answered, { outcome: 'reviewed', verdict: 'hold' });
  db.run("UPDATE players SET league = 'NCAA' WHERE id IN (1, 2)"); // assigned before the bypass, to both scouts
  db.run("DELETE FROM done_migrations WHERE name = 'review_ncaa_bypass_open_2026_11_19'");
  registerReviewQueue(new Proxy({}, { get: () => () => {} }), { db });
  const who = (id) => db.all('SELECT user_id, status FROM review_assignees WHERE item_id = ? ORDER BY user_id', id).map((r) => `${r.user_id}:${r.status}`);
  assert.deepEqual([who(answered), who(waiting), who(pro)], [['2:reviewed'], ['2:open'], ['2:open', '3:open']]);
  assert.deepEqual(statuses(db), ['assignment:reviewed', 'assignment:open', 'assignment:open']);
  assert.equal(reviewCount(db, RAY), 1, 'the answered one now waits on Ray');
});

test("the lead's decisions carry each scout's verdict and latest report; the scouts' boards don't", (t) => {
  const db = setup(t);
  const sent = createItem(db, AHAN, { kind: 'sb_review', player_id: 1, note: 'Best 9 we have seen this year.' });
  db.run("INSERT INTO verdicts(player_id, user_id, verdict) VALUES (1, 2, 'pass'), (1, 3, 'hold')");
  db.run("INSERT INTO notes(player_id, user_id, body, created_at) VALUES (1, 3, 'Good feet, worried about his pace.', datetime('now', '+1 minute'))");
  const asg = createItem(db, RAY, { kind: 'assignment', player_id: 2 });
  resolveItem(db, AHAN, asg, { outcome: 'reviewed', verdict: 'fail', note: 'Too slow for us.' });
  resolveItem(db, FORD, asg, { outcome: 'declined' });
  const byId = (id) => reviewBoard(db, RAY).items.find((i) => i.id === id);
  const take = (id, name) => byId(id).takes.find((x) => x.name === name);
  assert.equal(take(sent, 'Ahan').verdict, 'pass');
  assert.equal(take(sent, 'Ahan').sent, true);
  assert.equal(take(sent, 'Ahan').note.body, 'Best 9 we have seen this year.');
  assert.equal(take(sent, 'Ford').verdict, 'hold', 'a scout with a verdict has a place even if he did not send it');
  assert.equal(take(sent, 'Ford').note.body, 'Good feet, worried about his pace.');
  assert.deepEqual([take(asg, 'Ahan').verdict, take(asg, 'Ahan').note.body, take(asg, 'Ford').answer, take(asg, 'Ford').note], ['fail', 'Too slow for us.', 'declined', null]);
  assert.equal(reviewBoard(db, AHAN).items.some((i) => i.takes), false);
  createItem(db, AHAN, { kind: 'sb_review', player_id: 3 });
  assert.deepEqual(reviewBoard(db, RAY).items.find((i) => i.player_id === 3).takes.map((x) => x.name), ['Ahan'], 'a scout with nothing on him and no part in it is left out');
});

test("a scout's college report written in PINE shows when it is newer than their Staff reports", (t) => {
  const db = setup(t);
  db.run("INSERT INTO ncaa_prospects(key, name, player_id) VALUES ('p1', 'Example 1', 1)");
  db.run("INSERT INTO notes(player_id, user_id, body, created_at) VALUES (1, 2, 'Old staff note.', datetime('now', '-3 days'))");
  db.run("INSERT INTO ncaa_reports(prospect_key, body, grade, source, origin, created_by, created_at) VALUES ('p1', 'Senior film: dominant in the air.', 'B/A', 'Video', 'pine', 2, datetime('now', '-1 day'))");
  const id = createItem(db, AHAN, { kind: 'sb_review', player_id: 1 });
  const take = reviewBoard(db, RAY).items.find((i) => i.id === id).takes.find((x) => x.name === 'Ahan');
  assert.equal(take.note.body, 'Senior film: dominant in the air.');
  assert.equal(take.note.context, 'College report · B/A · Video');
  assert.equal(take.reports, 2);
});
