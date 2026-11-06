import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { addNote, createItem, resolveItem, reviewBoard, reviewCount } from '../src/lib/review_queue.js';

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

test('the lead assigns a scout, who reviews (with a verdict) or declines; the lead can withdraw', (t) => {
  const db = setup(t);
  const a = createItem(db, RAY, { kind: 'assignment', player_id: 1, to_user: 3, note: 'Watch his last three games.' });
  assert.throws(() => createItem(db, RAY, { kind: 'assignment', player_id: 1, to_user: 3 }), /already assigned/);
  assert.throws(() => createItem(db, RAY, { kind: 'assignment', player_id: 1, to_user: 4 }), /Choose a scout/);
  assert.throws(() => createItem(db, AHAN, { kind: 'assignment', player_id: 1, to_user: 3 }), /Only the review lead/);
  assert.equal(reviewBoard(db, AHAN).items.length, 0, 'an assignment is between the lead and that scout');
  assert.equal(reviewCount(db, FORD), 1);
  assert.throws(() => resolveItem(db, AHAN, a, { outcome: 'reviewed' }), /not found/);
  assert.throws(() => resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'maybe' }), /Verdict/);
  resolveItem(db, FORD, a, { outcome: 'reviewed', verdict: 'pass', note: 'Good in possession.' });
  assert.equal(db.get('SELECT verdict FROM verdicts WHERE player_id = 1 AND user_id = 3').verdict, 'pass');
  const board = reviewBoard(db, RAY).items[0];
  assert.deepEqual([board.status, board.resolved_by_name, board.notes.map((n) => n.body)],
    ['reviewed', 'Ford', ['Watch his last three games.', 'Good in possession.']]);
  const b = createItem(db, RAY, { kind: 'assignment', player_id: 2, to_user: 2 });
  assert.throws(() => resolveItem(db, AHAN, b, { outcome: 'removed' }), /withdraws/);
  resolveItem(db, RAY, b, { outcome: 'removed' });
  const c = createItem(db, RAY, { kind: 'assignment', player_id: 3, to_user: 2 });
  resolveItem(db, AHAN, c, { outcome: 'declined', note: 'Already seen enough.' });
  assert.deepEqual(statuses(db), ['assignment:reviewed', 'assignment:removed', 'assignment:declined']);
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
