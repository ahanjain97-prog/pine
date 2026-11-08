import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNote, copyReviewNotesToEvals, createItem, resolveItem, reviewBoard, reviewCount, syncReviewNote } from '../src/lib/review_queue.js';

// openDb seeds Ray (1, lead), Ahan (2, scout), Ford (3, scout), Bobby (4, not on the review team).
const RAY = { id: 1 }, AHAN = { id: 2 }, FORD = { id: 3 }, BOBBY = { id: 4 };
function setup(t) {
  const db = openDb(':memory:'); t.after(() => db.raw.close());
  for (const id of [1, 2, 3, 4, 5]) db.run('INSERT INTO players(id, name) VALUES (?, ?)', id, `Example ${id}`);
  return db;
}
const statuses = (db) => db.all('SELECT kind, status FROM review_items ORDER BY id').map((r) => `${r.kind}:${r.status}`);

test('the first review team is Ray as lead and Ahan and Ford as scouts', (t) => {
  const db = setup(t);
  assert.deepEqual(db.all('SELECT name, review_role AS r FROM users WHERE review_role IS NOT NULL ORDER BY id').map((u) => `${u.name}:${u.r}`),
    ['Ray:lead', 'Ahan:scout', 'Ford:scout']);
});

test('a watch list is private to its owner and only for the review team', (t) => {
  const db = setup(t);
  createItem(db, AHAN, { kind: 'watch', player_id: 1, note: 'Follow up after the cup game.' });
  assert.throws(() => createItem(db, AHAN, { kind: 'watch', player_id: 1 }), /already on your watch list/);
  assert.throws(() => createItem(db, BOBBY, { kind: 'watch', player_id: 1 }), /review team/);
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
  assert.throws(() => reviewBoard(db, BOBBY), /review team/);
});

test('an answered assignment waits in the lead\'s Decisions; his call closes it and anything else open on the player', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1, note: 'Free agent.' });
  const decisions = () => reviewBoard(db, RAY).items.filter((i) => i.awaiting_lead || (i.kind === 'sb_review' && i.status === 'open')).map((i) => `${i.kind}:${i.player_id}`);
  assert.deepEqual(decisions(), [], 'nothing until a scout answers');
  assert.equal(reviewCount(db, RAY), 0);
  resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'hold', note: 'Low ball wins.' });
  assert.deepEqual(decisions(), ['assignment:1']);
  assert.equal(reviewBoard(db, FORD).items.find((i) => i.id === a).awaiting_lead, true, 'Ford sees it waiting on Ray (Ready for Ray)');
  assert.equal(reviewCount(db, RAY), 1);
  assert.throws(() => resolveItem(db, AHAN, a, { outcome: 'not_sb' }), /Only the review lead decides/);
  resolveItem(db, RAY, a, { outcome: 'not_sb', note: 'Not for this window.' });
  assert.equal(db.get('SELECT status FROM review_items WHERE id = ?', a).status, 'not_sb');
  assert.equal(reviewBoard(db, FORD).items.find((i) => i.id === a).awaiting_lead, false, 'decided: off Ready, into History');
  assert.deepEqual([decisions(), reviewCount(db, RAY), reviewCount(db, AHAN)], [[], 0, 0], 'Ahan no longer owes an answer');
  assert.throws(() => resolveItem(db, AHAN, a, { outcome: 'reviewed' }), /already been dealt with/);

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

test('notes need text and visibility', (t) => {
  const db = setup(t);
  const id = createItem(db, AHAN, { kind: 'sb_review', player_id: 1 });
  addNote(db, RAY, id, 'Can you send me clips?');
  addNote(db, FORD, id, 'Sent in the group chat.');
  assert.throws(() => addNote(db, RAY, id, '   '), /Note is required/);
  assert.throws(() => addNote(db, BOBBY, id, 'hi'), /review team/);
  assert.deepEqual(reviewBoard(db, AHAN).items[0].notes.map((n) => `${n.user_name}: ${n.body}`),
    ['Ray: Can you send me clips?', 'Ford: Sent in the group chat.']);
  db.run('DELETE FROM players WHERE id = 1');
  assert.equal(db.get('SELECT count(*) AS n FROM review_notes').n, 0, 'a deleted player takes his review items with him');
});
