import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { tokenMatches } from '../src/auth.js';
import { addShares, cardOptions, playerCardOptions, warmCardShares } from '../src/lib/card_options.js';
import { cardErrorCode, cardFileName, cardProgress, claimCard, isPdf, isPng, saveCardFile } from '../src/lib/cards.js';

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

/* ---------- the stored season index, against a mocked Impect ---------- */
// Card seasons: 21 and 22 are the current season, 23 and 24 are closed. 25 (the cup) and 26 (another
// league) are never fetched. Each iteration has two squads; rows are Impect player-scores rows.
const IMPECT_ITERATIONS = [
  { id: 21, season: '2026', competition: { name: 'USL League One', type: 'League' } },
  { id: 22, season: '2026', competition: { name: 'USL Championship', type: 'League' } },
  { id: 23, season: '2025', competition: { name: 'USL League One', type: 'League' } },
  { id: 24, season: '2024', competition: { name: 'MLS Next Pro', type: 'League' } },
  { id: 25, season: '2026', competition: { name: 'USL Cup', type: 'Cup' } },
  { id: 26, season: '2026', competition: { name: 'Some Other League', type: 'League' } },
];
const row = (playerId, position, matchShare) => ({ playerId, position, matchShare });
const fixtureScores = () => ({
  21: [[row(7, 'LEFT_WINGER', 4.2), row(7, 'ATTACKING_MIDFIELD', 0.6), row(8, 'CENTER_FORWARD', 12)],
    [row(7, 'OFFENSIVE_MIDFIELD', 0.5), row(9, 'GOALKEEPER', 20), row(10, 'CENTER_FORWARD', 0.99)]],
  22: [[row(11, 'RIGHT_WINGER', 3)], [row(8, 'CENTER_FORWARD', 2), row(8, 'RIGHT_WINGER', 1)]],
  23: [[row(7, 'CENTER_FORWARD', 9), row(7, 'RIGHT_WINGER', 2)], [row(8, 'CENTRAL_MIDFIELD', 15), row(10, 'CENTRAL_DEFENDER', 0.4)]],
  24: [[row(7, 'DEFENSE_MIDFIELD', 5), row(11, 'LEFT_WINGBACK_DEFENDER', 7)], [row(11, 'RIGHT_WINGBACK_DEFENDER', 7)]],
  25: [[row(7, 'CENTRAL_MIDFIELD', 15)], []],
  26: [[row(7, 'CENTRAL_DEFENDER', 30)], []],
});
const impect = { scores: fixtureScores(), fetched: {}, gate: null };
let realFetch, realUser, realPass;

before(() => {
  realFetch = globalThis.fetch;
  realUser = process.env.IMPECT_USERNAME; realPass = process.env.IMPECT_PASSWORD;
  process.env.IMPECT_USERNAME = 'fixture'; process.env.IMPECT_PASSWORD = 'fixture';
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/token')) return Response.json({ access_token: 'fixture', expires_in: 300 });
    if (path === '/v5/customerapi/iterations') return Response.json(IMPECT_ITERATIONS);
    const it = Number(path.match(/iterations\/(\d+)/)?.[1]);
    if (path.endsWith('/squads')) return Response.json(impect.scores[it].map((_, n) => ({ id: it * 10 + n, name: `Squad ${it * 10 + n}` })));
    const squad = Number(path.match(/squads\/(\d+)\/player-scores$/)?.[1]);
    if (!squad) throw Error(`Unexpected fixture URL: ${path}`);
    impect.fetched[it] = (impect.fetched[it] || 0) + 1;
    if (impect.gate) await impect.gate.promise;
    return Response.json(impect.scores[it][squad % 10]);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  if (realUser === undefined) delete process.env.IMPECT_USERNAME; else process.env.IMPECT_USERNAME = realUser;
  if (realPass === undefined) delete process.env.IMPECT_PASSWORD; else process.env.IMPECT_PASSWORD = realPass;
});

function sharesDb() {
  impect.scores = fixtureScores();
  impect.fetched = {};
  impect.gate = null;
  return openDb(':memory:');
}
const builtAt = (db) => Object.fromEntries(db.all('SELECT iteration_id, built_at FROM card_share_builds').map((r) => [r.iteration_id, r.built_at]));
async function within(ms, promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(Error(`still waiting after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

test('a season never built is fetched once, even with concurrent callers and the startup pass', async () => {
  const db = sharesDb();
  const [a, b, c] = await Promise.all([playerCardOptions(db, 7), playerCardOptions(db, 7), playerCardOptions(db, 8), warmCardShares(db)]);
  assert.deepEqual(a, b);
  // One player-scores request per squad, per card season; the cup and the other league are never asked for.
  assert.deepEqual(impect.fetched, { 21: 2, 22: 2, 23: 2, 24: 2 });
  assert.deepEqual(Object.keys(builtAt(db)).map(Number).sort(), [21, 22, 23, 24]);
  assert.deepEqual(a.seasons.map((s) => s.iteration_id), [21, 23, 24]);
  assert.deepEqual(c.default, { iteration_id: 21, position: 'CF' });
  // Stored once, nothing more is fetched.
  await playerCardOptions(db, 11);
  assert.deepEqual(await warmCardShares(db), { built: 0, refreshed: 0, failed: 0 });
  assert.deepEqual(impect.fetched, { 21: 2, 22: 2, 23: 2, 24: 2 });
  // Only card positions are stored (no goalkeepers), summed per card position.
  assert.equal(db.get('SELECT count(*) AS n FROM card_shares WHERE impect_id = 9').n, 0);
  assert.equal(db.get("SELECT match_share FROM card_shares WHERE iteration_id = 21 AND impect_id = 7 AND position = 'AM'").match_share, 1.1);
});

test('closed seasons are never fetched again; a current season over 12 hours old is served from storage and rebuilt in the background', async () => {
  const db = sharesDb();
  assert.deepEqual(await warmCardShares(db), { built: 4, refreshed: 0, failed: 0 });
  const before = await playerCardOptions(db, 7);
  assert.equal(before.seasons[0].positions[0].match_share, 4.2);

  // Under 12 hours old: nothing is fetched.
  db.run("UPDATE card_share_builds SET built_at = datetime('now', '-11 hours')");
  await playerCardOptions(db, 7);
  assert.deepEqual(impect.fetched, { 21: 2, 22: 2, 23: 2, 24: 2 });

  // Days old. Impect now has more minutes for player 7 and answers slowly.
  db.run("UPDATE card_share_builds SET built_at = datetime('now', '-3 days')");
  const closedAt = { 23: builtAt(db)[23], 24: builtAt(db)[24] };
  impect.scores[21][0][0] = row(7, 'LEFT_WINGER', 6.2);
  let release;
  impect.gate = { promise: new Promise((r) => { release = r; }) };
  // Served at once from the stored rows while both current seasons rebuild; a second request doesn't start another rebuild.
  assert.deepEqual(await within(500, playerCardOptions(db, 7)), before);
  assert.deepEqual(await within(500, playerCardOptions(db, 7)), before);
  assert.deepEqual(impect.fetched, { 21: 4, 22: 4, 23: 2, 24: 2 });

  release();
  await warmCardShares(db); // joins the rebuilds in flight
  const now = builtAt(db);
  assert.ok(now[21] > closedAt[23] && now[22] > closedAt[23], 'current seasons rebuilt');
  assert.deepEqual({ 23: now[23], 24: now[24] }, closedAt, 'closed seasons untouched');
  const afterRebuild = await playerCardOptions(db, 7);
  assert.equal(afterRebuild.seasons[0].positions[0].match_share, 6.2);
  assert.deepEqual(impect.fetched, { 21: 4, 22: 4, 23: 2, 24: 2 });
});

test('stored options match the in-memory index they replace', async () => {
  const db = sharesDb();
  const its = IMPECT_ITERATIONS.map((i) => ({ id: i.id, season: i.season, competition: i.competition.name, type: i.competition.type }));
  // The old path: the player's iterations (oldest first), each folded from every squad's rows.
  const oldPath = (id) => {
    const mine = its.filter((i) => impect.scores[i.id].flat().some((r) => r.playerId === id)).reverse();
    return cardOptions(mine, new Map(mine.map((i) => [i.id, addShares(new Map(), impect.scores[i.id].flat()).get(id)])));
  };
  for (const id of [7, 8, 9, 10, 11, 404]) assert.deepEqual(await playerCardOptions(db, id), oldPath(id), `player ${id}`);
  assert.deepEqual(await playerCardOptions(db, 9), { seasons: [], default: null }, 'goalkeeper only');
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

test("a reclaimed card forgets the earlier attempt's picture", () => {
  const { db, add } = queueDb();
  const card = add('AM', 30);
  claimCard(db);
  db.run("UPDATE cards SET image = '7/old.png', started_at = datetime('now', '-16 minutes') WHERE id = ?", card);
  assert.equal(claimCard(db).id, card);
  assert.equal(db.get('SELECT image FROM cards WHERE id = ?', card).image, null);
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

test('progress notes: a fixed code and a sane match count, nothing else', () => {
  assert.deepEqual(cardProgress('fetching_events', 21), { code: 'fetching_events', matches: 21 });
  assert.deepEqual(cardProgress('fetching_events', 0), { code: 'fetching_events', matches: null });
  assert.deepEqual(cardProgress('fetching_events', 2.5), { code: 'fetching_events', matches: null });
  assert.deepEqual(cardProgress('fetching_events', '21'), { code: 'fetching_events', matches: null });
  assert.deepEqual(cardProgress('fetching_events', 5000), { code: 'fetching_events', matches: null });
  assert.equal(cardProgress('Traceback (most recent call last)', 21), null);
  assert.equal(cardProgress(undefined, undefined), null);
});

test("a reclaimed card forgets the earlier attempt's progress note", () => {
  const { db, add } = queueDb();
  const card = add('AM', 30);
  claimCard(db);
  db.run("UPDATE cards SET progress = 'fetching_events', progress_matches = 21, started_at = datetime('now', '-16 minutes') WHERE id = ?", card);
  assert.equal(claimCard(db).id, card);
  assert.deepEqual({ ...db.get('SELECT progress, progress_matches FROM cards WHERE id = ?', card) }, { progress: null, progress_matches: null });
});

test('an existing database gains the progress columns and keeps its cards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-cards-'));
  try {
    const file = join(dir, 'pine.db');
    const db = openDb(file);
    const player = Number(db.run("INSERT INTO players(name, impect_id) VALUES ('Test Player', 555)").lastInsertRowid);
    db.run("INSERT INTO cards(player_id, impect_id, iteration_id, position) VALUES (?, 555, 11, 'AM')", player);
    db.raw.exec('ALTER TABLE cards DROP COLUMN progress_matches; ALTER TABLE cards DROP COLUMN progress;');
    db.raw.close();
    const again = openDb(file);
    const cols = again.all('PRAGMA table_info(cards)').map((c) => c.name);
    assert.ok(cols.includes('progress') && cols.includes('progress_matches'));
    assert.equal(again.get('SELECT count(*) AS n FROM cards').n, 1);
    again.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failure codes outside the contract are stored as "failed"', () => {
  assert.equal(cardErrorCode('not_covered'), 'not_covered');
  assert.equal(cardErrorCode('render_failed'), 'render_failed');
  assert.equal(cardErrorCode('Traceback (most recent call last)'), 'failed');
  assert.equal(cardErrorCode(undefined), 'failed');
});

test('uploads are checked by their first bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert.equal(isPng(png), true);
  assert.equal(isPdf(png), false);
  assert.equal(isPdf(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(isPng(Buffer.from('%PDF-1.7\n')), false);
  assert.equal(isPng(Buffer.from('\x89PNG')), false, 'too short');
  assert.equal(isPng(Buffer.from('<html>not a png</html>')), false);
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
    // The PNG of the same card, saved the same second, sits beside it.
    assert.equal(saveCardFile(root, card, Buffer.from('png bytes'), when, 'png'), '7/20260924T140212Z-1916-AM.png');
    assert.deepEqual(readdirSync(join(root, '7')).sort(), ['20260924T140212Z-1916-AM.pdf', '20260924T140212Z-1916-AM.png']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
