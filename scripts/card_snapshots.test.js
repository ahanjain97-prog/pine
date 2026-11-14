import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, validateSnapshot, saveSnapshot, readSnapshot } from '../src/lib/card_snapshots.js';
import { openDb } from '../src/db.js';
import { claimCard } from '../src/lib/cards.js';

export const pdf = Buffer.from('%PDF-1.7 synthetic card\n');
export const card = { id: 9, player_id: 7, impect_id: 555, iteration_id: 1916, position: 'AM' };
export function demoSnapshot() {
  return { schema: 1, pdf_sha256: sha256(pdf), hop_commit: 'abcdef1', data_as_of: '2026-10-01', render_input: {
    schema_version: 16, id: 'player-555-1916-am', iteration: 1916,
    subject: { id: 555, focus_position: 'AM', profiles: [{ metrics: [{ metric: 'TEST', value: 0, pct: null }] }] },
    context: { history: [] }, events: { position: 'AM', use: [[1, 2]] }, provenance: { datasets: [] },
  } };
}

test('snapshots preserve the full render input and explicit missing/zero values', () => {
  const root = mkdtempSync(join(tmpdir(), 'pine-card-snapshot-'));
  try {
    const raw = demoSnapshot();
    const checked = validateSnapshot(raw, card);
    const file = saveSnapshot(root, card, checked);
    assert.deepEqual(readSnapshot(root, file), raw);
    assert.equal(saveSnapshot(root, card, checked), file, 'retry is idempotent');
    for (const change of [
      x => x.render_input.subject.id++, x => x.render_input.iteration++,
      x => x.render_input.events.position = 'CB', x => x.render_input.id = 'other',
      x => x.render_input.subject.focus_position = 'CB', x => x.render_input.schema_version = null,
      x => x.render_input.provenance = null, x => x.render_input.subject.profiles = [],
      x => x.pdf_sha256 = '../wrong', x => x.hop_commit = 'bad',
      x => x.render_input.context.value = Infinity,
    ]) {
      const invalid = structuredClone(raw); change(invalid);
      assert.throws(() => validateSnapshot(invalid, card));
    }
    const earlier = demoSnapshot(); earlier.render_input.schema_version = 1;
    assert.equal(validateSnapshot(earlier, card).schema, 1, 'historical render schemas remain readable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration keeps historical cards and reclaim clears the previous attempt snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'pine-card-migrate-')), file = join(root, 'pine.db');
  try {
    let db = openDb(file);
    const p = Number(db.run("INSERT INTO players(name) VALUES ('Synthetic Player')").lastInsertRowid);
    db.run("INSERT INTO cards(player_id, impect_id, iteration_id, position, status, file) VALUES (?,555,1916,'AM','done','old.pdf')", p);
    db.raw.exec('ALTER TABLE cards DROP COLUMN snapshot_file; ALTER TABLE cards DROP COLUMN snapshot_schema; ALTER TABLE cards DROP COLUMN snapshot_sha256;');
    db.raw.close(); db = openDb(file);
    assert.equal(db.get('SELECT file FROM cards').file, 'old.pdf');
    assert.equal(db.get('SELECT snapshot_file FROM cards').snapshot_file, null);
    const id = Number(db.run("INSERT INTO cards(player_id, impect_id, iteration_id, position, status, started_at, snapshot_file, snapshot_schema, snapshot_sha256) VALUES (?,555,1916,'AM','running',datetime('now','-16 minutes'),'stale.json.gz',16,'old')", p).lastInsertRowid);
    assert.equal(claimCard(db).id, id);
    assert.deepEqual({ ...db.get('SELECT snapshot_file, snapshot_schema, snapshot_sha256 FROM cards WHERE id = ?', id) }, { snapshot_file: null, snapshot_schema: null, snapshot_sha256: null });
    db.raw.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
