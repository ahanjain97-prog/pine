import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { contextSample } from './fixtures/player-context.mjs';
import { contextFilters, playerContext, registerPlayerContext } from '../src/lib/player_context.js';


test('exports every saved source with authors, linked copies, full history, and no writes or cross-player evidence', t => {
  const db = contextSample(); t.after(() => db.raw.close());
  const before = db.get('SELECT total_changes() AS n').n;
  const result = playerContext(db, { board: 'big', role: 'FWD2' }, new Date('2026-11-18T12:00:00Z'));
  assert.equal(result.checked_at, '2026-11-18T12:00:00.000Z');
  assert.equal(result.pagination.total, 2);
  const p = result.players[0];
  assert.equal(p.player.id, 501);
  assert.equal(p.player.decision, 'hold');
  assert.equal(p.player.decision_by_name, 'Example Lead');
  assert.deepEqual(p.player.tm_overrides, ['club']);
  assert.equal(p.summary.body, 'Strong in the air');
  assert.equal(p.summary.updated_by, 'Example Lead');
  assert.deepEqual(p.verdicts.map(v => [v.author, v.verdict]), [['Example Lead', 'pass'], ['Example Scout', 'fail'], ['Example LS', 'hold']]);
  assert.equal(p.notes[0].context, 'Video: Example match');
  assert.equal(p.notes[0].review_note_id, 101);
  assert.equal(p.reviews[0].notes[0].staff_note_id, 101);
  assert.equal(p.reviews[0].assignees[0].name, 'Example Scout');
  assert.equal(p.reviews[1].notes[0].body, 'Watch again next month');
  assert.equal(p.reviews[2].notes[0].body, 'Withdrawn request reason');
  assert.equal(p.board_history[0].note, 'More useful as a target');
  assert.equal(p.college.length, 2);
  assert.equal(p.college[0].reports[0].created_by_name, 'Example LS');
  assert.equal(p.college[1].reports[0].author, 'External Scout');
  assert.deepEqual(p.college[1].reports[0].dates, ['2025-10-01']);
  assert.equal(p.college[1].boards.length, 1);
  assert.equal(p.l2.length, 1, 'prospect-linked League Two reports included');
  assert.equal(p.agent.notes, 'Contact follow-up');
  assert.equal(p.lists[0].name, 'Example Targets');
  assert.equal(p.activity.length, 49, 'no profile page limit of 40');
  assert.equal(p.activity.filter(a => a.hidden).length, 1);
  assert.deepEqual(p.activity.filter(a => a.action === 'set_verdict').map(a => a.detail.verdict), ['pass', 'fail']);
  assert.equal(JSON.stringify(p).includes('Other player only'), false);
  assert.equal(JSON.stringify(result).includes('password_hash'), false);
  assert.equal(db.get('SELECT total_changes() AS n').n, before);
  const role = result.roles.find(r => r.code === 'FWD2');
  assert.deepEqual([role.num, role.label, role.position_label], [2, 'Target', 'Forward']);
});

test('board filtering, pagination, off-board players, literal search and redirects', t => {
  const db = contextSample(); t.after(() => db.raw.close());
  assert.deepEqual(playerContext(db, { board: 'short', role: 'FWD2' }).players.map(p => p.player.id), [502], 'flag must be on FWD2');
  assert.deepEqual(playerContext(db, { board: 'ncaa' }).players.map(p => p.player.id), [501]);
  assert.equal(playerContext(db, { player_id: '504' }).players[0].player.name, 'Example Offboard');
  assert.equal(playerContext(db, { player_id: '500' }).players[0].player.id, 501);
  assert.equal(playerContext(db, { q: 'TARGET' }).pagination.total, 1);
  assert.equal(playerContext(db, { q: '%' }).pagination.total, 0, 'literal substring, not SQL wildcard');
  const first = playerContext(db, { board: 'big', role: 'FWD2', limit: '1' });
  assert.equal(first.pagination.next_offset, 1);
  const last = playerContext(db, { board: 'big', role: 'FWD2', limit: '1', offset: '1' });
  assert.equal(last.players[0].player.id, 502);
  assert.equal(last.pagination.next_offset, null);
  const empty = playerContext(db, { role: 'GK1' });
  assert.deepEqual(empty.players, []); assert.equal(empty.pagination.total, 0);
  assert.equal(playerContext(db, { limit: 1, offset: 100 }).pagination.next_offset, null);
  assert.throws(() => playerContext(db, { player_id: 9999 }), e => e.status === 404);
});

test('invalid and misspelled filters fail rather than expanding the query', () => {
  for (const input of [{ roles: 'FWD2' }, { board: '' }, { board: 'large' }, { role: 'AM2' },
    { role: '' }, { board: 'ncaa', role: 'FWD2' }, { q: '' }, { q: ' ' }, { q: 'a'.repeat(201) },
    { limit: '' }, { limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: '0x10' }, { player_id: '1.5' }, { player_id: 0 }]) {
    assert.throws(() => contextFilters(input), e => e.status === 400, JSON.stringify(input));
  }
});

test('endpoint refuses missing, wrong and unset keys; sends private no-store JSON', async t => {
  const db = contextSample(); t.after(() => db.raw.close());
  for (const token of ['fictional-agent', '']) {
    const app = new Hono(); registerPlayerContext(app, { db, token });
    for (const headers of [{}, { 'X-PINE-Agent-Token': 'wrong' }, { 'X-PINE-Agent-Token': 'fictional-agent' }, { 'X-PINE-Worker-Token': 'fictional-agent' }]) {
      const response = await app.request('/api/agent/player-context?board=big&role=FWD2', { headers });
      assert.equal(response.status, token && headers['X-PINE-Agent-Token'] === token ? 200 : 401);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    if (token) {
      for (const query of ['role=FWD2&role=LW1', 'roles=FWD2', 'limit=51']) {
        const response = await app.request(`/api/agent/player-context?${query}`, { headers: { 'X-PINE-Agent-Token': token } });
        assert.equal(response.status, 400);
      }
    }
  }
});
