import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { hasLongThrow, longThrowOverride, LONG_THROW_RULE, longThrowSyncStatus, registerLongThrows, saveLongThrows } from '../src/lib/long_throw.js';
import { tmSyncFields } from '../src/lib/tm_sync.js';
import { mergePlayer } from '../src/lib/ncaa.js';

const snapshot = (extra = {}) => ({ schema_version: 1, rule_version: LONG_THROW_RULE,
  generated_at: '2026-11-01T12:00:00Z', players: [101], matches: 10, pending_matches: 0, ...extra });
const setup = (t) => { const db = openDb(':memory:'); t.after(() => db.raw.close()); return db; };

test('binary capability respects both overrides and Auto', () => {
  for (const detected of [0, 1]) {
    assert.equal(hasLongThrow({ long_throw_detected: detected, long_throw_override: null }), Boolean(detected));
    assert.equal(hasLongThrow({ long_throw_detected: detected, long_throw_override: 0 }), false);
    assert.equal(hasLongThrow({ long_throw_detected: detected, long_throw_override: 1 }), true);
  }
  for (const v of [undefined, '', 'true', 1, 0, {}, []]) assert.throws(() => longThrowOverride(v), /true, false or null/);
  assert.equal(longThrowOverride(false), 0);
  assert.equal(longThrowOverride(true), 1);
  assert.equal(longThrowOverride(null), null);
});

test('complete sync replaces old detections atomically and rejects stale or reduced coverage', (t) => {
  const db = setup(t);
  assert.deepEqual(saveLongThrows(db, snapshot()), { added: 1, removed: 0, players: 1 });
  assert.deepEqual(saveLongThrows(db, snapshot()), { added: 0, removed: 0, players: 1 });
  assert.equal(db.get('SELECT count(*) AS n FROM activity').n, 1);
  assert.deepEqual(saveLongThrows(db, snapshot({ players: [202], generated_at: '2026-11-02T12:00:00Z', pending_matches: 3 })),
    { added: 1, removed: 1, players: 1 });
  assert.equal(db.get('SELECT count(*) AS n FROM long_throw_players').n, 1);
  assert.equal(db.get('SELECT rule_version FROM long_throw_sync').rule_version, LONG_THROW_RULE);
  assert.throws(() => saveLongThrows(db, snapshot()), /older/);
  assert.throws(() => saveLongThrows(db, snapshot({ matches: 9, generated_at: '2026-11-03T12:00:00Z' })), /coverage/);
  for (const extra of [{ players: [3, 3] }, { players: ['101'] }, { players: [0] }, { rule_version: 'other' },
    { generated_at: 'tomorrow' }, { generated_at: '2999-01-01' }, { pending_matches: -1 }, { matches: 0 }]) {
    assert.throws(() => saveLongThrows(db, snapshot(extra)));
  }
  assert.equal(db.get('SELECT impect_id FROM long_throw_players').impect_id, 202);
  db.raw.exec("CREATE TRIGGER fail BEFORE INSERT ON long_throw_sync BEGIN SELECT RAISE(ABORT,'disk full'); END");
  assert.throws(() => saveLongThrows(db, snapshot({ players: [303], generated_at: '2026-11-03T12:00:00Z' })), /disk full/);
  assert.equal(db.get('SELECT impect_id FROM long_throw_players').impect_id, 202);
  assert.equal(longThrowSyncStatus(db, new Date('2026-11-05')).stale, true);
});

test('rule migration replaces v1 positives and preserves both manual overrides', (t) => {
  const db = setup(t);
  db.run("INSERT INTO players(id,name,impect_id,long_throw_override) VALUES (1,'Manual Yes',101,1),(2,'Manual No',202,0)");
  db.run('INSERT INTO long_throw_players(impect_id) VALUES (101)');
  db.run("INSERT INTO long_throw_sync(id,generated_at,matches,pending_matches,rule_version) VALUES (1,'2026-10-31T12:00:00Z',10,0,'long-throw-v1')");
  assert.throws(() => saveLongThrows(db, snapshot({ rule_version: 'long-throw-v1' })), /Unsupported/);
  assert.deepEqual(saveLongThrows(db, snapshot({ players: [202] })), { added: 1, removed: 1, players: 1 });
  for (const p of db.all('SELECT *, EXISTS(SELECT 1 FROM long_throw_players WHERE impect_id=players.impect_id) AS long_throw_detected FROM players')) {
    assert.equal(hasLongThrow(p), p.id === 1);
  }
  assert.deepEqual(saveLongThrows(db, snapshot({ players: [], generated_at: '2026-11-02T12:00:00Z' })),
    { added: 0, removed: 1, players: 0 });
  assert.equal(JSON.parse(db.get('SELECT detail FROM activity ORDER BY id DESC LIMIT 1').detail).removed, 1);
});

test('existing database migrates; flags and manual No survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-long-throws-'));
  try {
    const file = join(dir, 'pine.db'), old = openDb(file);
    old.run("INSERT INTO players(id,name) VALUES (1,'Example Player')");
    old.raw.exec('ALTER TABLE players DROP COLUMN long_throw_override');
    old.raw.exec('ALTER TABLE long_throw_sync DROP COLUMN rule_version');
    old.run("INSERT INTO long_throw_sync(id,generated_at,matches,pending_matches) VALUES (1,'2026-10-31T12:00:00Z',10,0)");
    old.raw.close();
    const db = openDb(file);
    assert.equal(db.get('SELECT long_throw_override FROM players').long_throw_override, null);
    assert.equal(db.get('SELECT rule_version FROM long_throw_sync').rule_version, 'long-throw-v1');
    saveLongThrows(db, snapshot());
    db.run('UPDATE players SET impect_id=101,long_throw_override=0 WHERE id=1');
    db.raw.close();
    const reopened = openDb(file);
    assert.equal(reopened.get('SELECT long_throw_override FROM players').long_throw_override, 0);
    assert.equal(reopened.get('SELECT count(*) AS n FROM long_throw_players').n, 1);
    assert.throws(() => reopened.run('UPDATE players SET long_throw_override=2'), /CHECK/);
    reopened.raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Transfermarkt cannot change flags; college merges preserve explicit No', (t) => {
  const fields = tmSyncFields({ long_throw_override: 0, tm_overrides: [] }, { name: 'Example', long_throw_override: 1 });
  assert.equal('long_throw_override' in fields, false);
  const db = setup(t);
  db.run("INSERT INTO players(id,name,long_throw_override) VALUES (1,'Example',null),(2,'Duplicate',0)");
  mergePlayer(db, 2, 1);
  assert.equal(db.get('SELECT long_throw_override FROM players WHERE id=1').long_throw_override, 0);
  db.run("INSERT INTO players(id,name,impect_id) VALUES (3,'Linked duplicate',101)");
  saveLongThrows(db, snapshot());
  mergePlayer(db, 3, 1);
  assert.equal(db.get('SELECT impect_id FROM players WHERE id=1').impect_id, 101);
  assert.equal(db.get('SELECT long_throw_override FROM players WHERE id=1').long_throw_override, 0);
});

test('worker routes reject staff credentials/unset tokens and validate before saving', async (t) => {
  const db = setup(t);
  for (const token of ['', 'test-token']) {
    const app = new Hono();
    registerLongThrows(app, { db, token, iterations: async () => [{ id: 1916, season: '2026' }, { id: 999, season: '2027' }, { id: 3, season: '2024' }] });
    const put = (headers = {}, data = snapshot()) => app.request('/api/worker/long-throws', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
    });
    assert.equal((await put()).status, 401);
    assert.equal((await put({ 'X-PINE': '1', 'X-PINE-Worker-Token': 'wrong' })).status, 401);
    const auth = { 'X-PINE': '1', 'X-PINE-Worker-Token': 'test-token' };
    assert.equal((await put(auth)).status, token ? 200 : 401);
    if (token) {
      assert.equal((await put(auth, snapshot({ players: [1.5] }))).status, 400);
      const config = await app.request('/api/worker/long-throws/config', { headers: auth });
      assert.deepEqual((await config.json()).iterations.map((i) => i.season), [2026, 2027]);
    }
  }
});
