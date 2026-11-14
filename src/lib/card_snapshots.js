// Immutable render inputs paired with a specific PDF, including historical backfills.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeAtomically } from './cards.js';

export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export class SnapshotError extends Error {}
const bad = message => { throw new SnapshotError(message); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);

export function validateSnapshot(raw, card) {
  if (!object(raw) || raw.schema !== 1) bad('Unsupported card snapshot schema');
  if (!/^[a-f0-9]{64}$/.test(raw.pdf_sha256 || '')) bad('A PDF SHA-256 is required');
  if (raw.hop_commit !== null && !/^[a-f0-9]{7,40}$/i.test(raw.hop_commit || '')) bad('Invalid generator commit');
  if (raw.data_as_of !== null && !/^\d{4}-\d{2}-\d{2}$/.test(raw.data_as_of || '')) bad('Invalid data date');
  const r = raw.render_input;
  if (!object(r) || !Number.isSafeInteger(r.schema_version) || r.schema_version < 1) bad('Missing render schema version');
  if (r.subject?.id !== card.impect_id || r.iteration !== card.iteration_id ||
      r.id !== `player-${card.impect_id}-${card.iteration_id}-${card.position.toLowerCase()}` ||
      r.events?.position !== card.position ||
      (r.subject.focus_position != null && r.subject.focus_position !== card.position)) {
    bad('Snapshot belongs to a different player, season or position');
  }
  if (!Array.isArray(r.subject.profiles) || !r.subject.profiles.length || !object(r.context) || !object(r.provenance)) {
    bad('Incomplete card render input');
  }
  // Retain all renderer fields, including earlier schema versions. Bound structure and
  // reject numeric overflow rather than silently changing it into null on disk.
  let nodes = 0;
  function visit(x, depth = 0) {
    if (++nodes > 500000 || depth > 40) bad('Snapshot structure is too large');
    if (typeof x === 'number' && !Number.isFinite(x)) bad('Snapshot contains a non-finite number');
    if (x && typeof x === 'object') for (const v of Object.values(x)) visit(v, depth + 1);
  }
  visit(raw);
  const bytes = Buffer.from(JSON.stringify(raw));
  if (bytes.length > MAX_SNAPSHOT_BYTES) bad('Snapshot is over 10 MB');
  return { bytes, digest: sha256(bytes), schema: r.schema_version };
}

export function saveSnapshot(root, card, snapshot) {
  const stored = `${card.player_id}/card-${card.id}-${snapshot.digest}.snapshot.json.gz`;
  const file = join(root, stored);
  mkdirSync(join(root, String(card.player_id)), { recursive: true });
  if (!existsSync(file)) writeAtomically(`${file}.tmp`, file, gzipSync(snapshot.bytes));
  return stored;
}

export function readSnapshot(root, stored) {
  return JSON.parse(gunzipSync(readFileSync(join(root, stored))).toString('utf8'));
}
