import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { tokenMatches } from '../src/auth.js';
import { addShares, cardOptions } from '../src/lib/card_options.js';
import { cardErrorCode, cardFileName, claimCard, saveCardFile } from '../src/lib/cards.js';

const it = (id, season, competition = 'USL League One', type = 'League') => ({ id, season, competition, type });

test('card options: league seasons only, positions with at least one match share, newest season first', () => {
  const rows = (playerId, list) => list.map(([position, matchShare]) => ({ playerId, position, matchShare }));
  const shares = new Map([
    [11, addShares(new Map(), rows(7, [['LEFT_WINGER', 4.2], ['ATTACKING_MIDFIELD', 0.6], ['OFFENSIVE_MIDFIELD', 0.5], ['CENTER_FORWARD', 0.99]])).get(7)],
    [12, addShares(new Map(), rows(7, [['CENTER_FORWARD', 9], ['RIGHT_WINGER', 2], ['GOALKEEPER', 20]])).get(7)],
    [13, addShares(new Map(), rows(7, [['CENTRAL_MIDFIELD', 15]])).get(7)], // the cup
    [14, addShares(new Map(), rows(7, [['CENTRAL_DEFENDER', 0.4]])).get(7)], // nothing eligible
    [15, addShares(new Map(), rows(7, [['CENTRAL_DEFENDER', 30]])).get(7)], // not one of our leagues
  ]);
  const out = cardOptions([
    it(12, '2025', 'USL Championship'), it(11, '2026'), it(13, '2026', 'USL Cup', 'Cup'), it(14, '2024'), it(15, '2026', 'Some Other League'),
  ], shares);

  assert.deepEqual(out.seasons.map((s) => [s.iteration_id, s.season, s.competition]), [[11, '2026', 'USL League One'], [12, '2025', 'USL Championship']]);
  // ATTACKING + OFFENSIVE midfield sum to AM (1.1); 0.99 at CF misses the 1.0 threshold; the goalkeeper stint has no card.
  assert.deepEqual(out.seasons[0].positions, [
    { code: 'LW', label: 'Left Winger', match_share: 4.2 },
    { code: 'AM', label: 'Attacking Mid', match_share: 1.1 },
  ]);
  assert.deepEqual(out.seasons[1].positions.map((o) => o.code), ['CF', 'RW']);
  assert.deepEqual(out.default, { iteration_id: 11, position: 'LW' });

  // Exactly 1.0 qualifies.
  const edge = cardOptions([it(11, '2026')], new Map([[11, new Map([['RB', 1]])]]));
  assert.deepEqual(edge.default, { iteration_id: 11, position: 'RB' });
});

test('card options: nothing eligible means no seasons and no default', () => {
  assert.deepEqual(cardOptions([], new Map()), { seasons: [], default: null });
  const gkOnly = new Map([[11, addShares(new Map(), [{ playerId: 3, position: 'GOALKEEPER', matchShare: 25 }]).get(3)]]);
  assert.deepEqual(cardOptions([it(11, '2026')], gkOnly), { seasons: [], default: null });
});

function queueDb() {
  const db = openDb(':memory:');
  const player = Number(db.run("INSERT INTO players(name, tm_id, impect_id) VALUES ('Test Player', '999001', 555)").lastInsertRowid);
  const add = (position, minutesAgo) => Number(db.run(
    `INSERT INTO cards(player_id, impect_id, iteration_id, position, tm_id, requested_at) VALUES (?, 555, 11, ?, '999001', datetime('now', ?))`,
    player, position, `-${minutesAgo} minutes`).lastInsertRowid);
  return { db, player, add };
}

test('the worker claims the oldest queued card once, then nothing', () => {
  const { db, add } = queueDb();
  const newer = add('LW', 1);
  const older = add('AM', 5);
  assert.deepEqual(claimCard(db), { id: older, impect_id: 555, iteration_id: 11, position: 'AM', tm_id: '999001' });
  assert.equal(db.get('SELECT status FROM cards WHERE id = ?', older).status, 'running');
  assert.ok(db.get('SELECT started_at FROM cards WHERE id = ?', older).started_at);
  assert.equal(claimCard(db).id, newer);
  assert.equal(claimCard(db), null);
});

test('a card stuck running for over 15 minutes is handed out again; done and failed cards never are', () => {
  const { db, add } = queueDb();
  const recent = add('LW', 30);
  const stuck = add('AM', 40);
  const done = add('CF', 50);
  const failed = add('RW', 60);
  db.run("UPDATE cards SET status = 'running', started_at = datetime('now', '-5 minutes') WHERE id = ?", recent);
  db.run("UPDATE cards SET status = 'running', started_at = datetime('now', '-16 minutes') WHERE id = ?", stuck);
  db.run("UPDATE cards SET status = 'done', started_at = datetime('now', '-50 minutes') WHERE id = ?", done);
  db.run("UPDATE cards SET status = 'failed', started_at = datetime('now', '-60 minutes') WHERE id = ?", failed);
  assert.equal(claimCard(db).id, stuck);
  assert.equal(claimCard(db), null, 'the reclaimed card is fresh again, and the other one is still inside its 15 minutes');
});

test('a card that keeps getting stuck is failed after three attempts', () => {
  const { db, add } = queueDb();
  const card = add('AM', 90);
  for (let n = 1; n <= 3; n++) {
    assert.equal(claimCard(db).id, card, `attempt ${n}`);
    db.run("UPDATE cards SET started_at = datetime('now', '-16 minutes') WHERE id = ?", card);
  }
  assert.equal(claimCard(db), null);
  assert.deepEqual({ ...db.get('SELECT status, error, attempts FROM cards WHERE id = ?', card) }, { status: 'failed', error: 'failed', attempts: 3 });
});

test('worker token: an unset key opens nothing; only the exact key matches', () => {
  assert.equal(tokenMatches('anything', ''), false);
  assert.equal(tokenMatches('', 'secret-key'), false);
  assert.equal(tokenMatches(undefined, 'secret-key'), false);
  assert.equal(tokenMatches('secret-kez', 'secret-key'), false);
  assert.equal(tokenMatches('secret-key-longer', 'secret-key'), false);
  assert.equal(tokenMatches('secret-key', 'secret-key'), true);
});

test('failure codes outside the contract are stored as "failed"', () => {
  assert.equal(cardErrorCode('not_covered'), 'not_covered');
  assert.equal(cardErrorCode('render_failed'), 'render_failed');
  assert.equal(cardErrorCode('Traceback (most recent call last)'), 'failed');
  assert.equal(cardErrorCode(undefined), 'failed');
});

test('card files are named by UTC time, season and position, and never overwritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'pine-cards-'));
  try {
    const when = new Date('2026-09-24T14:02:12.345Z');
    assert.equal(cardFileName(when, 1916, 'AM'), '20260924T140212Z-1916-AM.pdf');
    const card = { player_id: 7, iteration_id: 1916, position: 'AM' };
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    assert.equal(saveCardFile(root, card, pdf, when), '7/20260924T140212Z-1916-AM.pdf');
    assert.deepEqual(readdirSync(join(root, '7')), ['20260924T140212Z-1916-AM.pdf'], 'no temporary file left behind');
    assert.equal(readFileSync(join(root, '7', '20260924T140212Z-1916-AM.pdf'), 'latin1'), pdf.toString('latin1'));
    assert.throws(() => saveCardFile(root, card, Buffer.from('%PDF-other'), when), /already exists/);
    assert.equal(readFileSync(join(root, '7', '20260924T140212Z-1916-AM.pdf'), 'latin1'), pdf.toString('latin1'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
