// Bounded recovery using the existing worker credential. No arbitrary paths,
// database downloads, staff content, or deletion of completed artifacts.
import { lstatSync, readdirSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tokenMatches } from '../auth.js';
import { compressSnapshots, listSnapshots } from './backup.js';

const DAY = 24 * 60 * 60 * 1000;
function files(root, prefix = '') {
  const out = [];
  let entries;
  try { entries = readdirSync(join(root, prefix), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const e of entries) {
    const name = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...files(root, name));
    else if (e.isFile()) out.push({ name, ...fileInfo(root, name) });
    // Symlinks are deliberately neither traversed nor cleanup candidates.
  }
  return out;
}
const fileInfo = (root, name) => {
  const s = lstatSync(join(root, name));
  return { bytes: s.size, modified: s.mtimeMs };
};
const group = name => name.includes('/') ? name.split('/')[0] : /^pine\.db(?:-|$)/.test(name) ? 'database' : 'other';
const disposable = (f, now) => {
  if (/^cache\/[^/]+\.(?:json(?:\.gz)?|tmp)$/.test(f.name)) return true;
  if (now - f.modified < DAY) return false;
  return /^backups\/download-\d+\.tmp\.sqlite$/.test(f.name)
    || /^backups\/pine-\d{4}-\d{2}-\d{2}\.sqlite\.gz\.tmp$/.test(f.name)
    || /^cards\/\d+\/\.[^/]+\.part$/.test(f.name)
    || /^cards\/\d+\/card-\d+-[a-f0-9]{64}\.snapshot\.json\.gz\.tmp$/.test(f.name);
};

export function storageReport(root, db) {
  const disk = statfsSync(root);
  const groups = {};
  const all = files(root);
  for (const f of all) {
    const k = group(f.name);
    groups[k] ??= { files: 0, bytes: 0 };
    groups[k].files++; groups[k].bytes += f.bytes;
  }
  const candidates = all.filter(f => disposable(f, Date.now()));
  return {
    schema: 1, free_bytes: disk.bavail * disk.bsize, total_bytes: disk.blocks * disk.bsize,
    free_inodes: disk.ffree, groups,
    disposable: { files: candidates.length, bytes: candidates.reduce((n, f) => n + f.bytes, 0) },
    backups: listSnapshots(join(root, 'backups')),
    cards: db.all(`SELECT id, impect_id, iteration_id, position, status, error, attempts, started_at
      FROM cards WHERE status IN ('queued','running') OR (status = 'failed' AND requested_at > datetime('now','-2 days')) ORDER BY id`),
  };
}

export function cleanStorage(root, now = Date.now()) {
  let removed = 0, bytes = 0;
  for (const f of files(root).filter(f => disposable(f, now))) {
    unlinkSync(join(root, f.name)); removed++; bytes += f.bytes;
  }
  return { removed_files: removed, removed_bytes: bytes, compressed_bytes_saved: compressSnapshots(join(root, 'backups')) };
}

export function registerStorage(app, { root, db, token }) {
  app.use('/api/worker/storage*', async (c, next) => {
    if (!tokenMatches(c.req.header('X-PINE-Worker-Token'), token)) return c.json({ error: 'Worker token missing or wrong' }, 401);
    c.header('Cache-Control', 'no-store');
    return next();
  });
  app.get('/api/worker/storage', c => c.json(storageReport(root, db)));
  app.post('/api/worker/storage/cleanup', c => c.json({ ...cleanStorage(root), storage: storageReport(root, db) }));
  // Retry only an existing generic failure; never create new requests or retry
  // explicit data/coverage failures. The original request and history remain.
  app.post('/api/worker/storage/cards/:id/retry', c => {
    const id = Number(c.req.param('id'));
    const card = Number.isSafeInteger(id) && id > 0 ? db.get('SELECT * FROM cards WHERE id = ?', id) : null;
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (card.status !== 'failed' || card.error !== 'failed') return c.json({ error: 'Only a generic failed card can be retried' }, 409);
    if (db.get("SELECT 1 FROM cards WHERE player_id = ? AND status IN ('queued','running')", card.player_id)) {
      return c.json({ error: 'Another card for this player is already in progress' }, 409);
    }
    db.run("UPDATE cards SET status = 'queued', error = NULL, attempts = 0, started_at = NULL WHERE id = ?", id);
    return c.json({ ok: true, id });
  });
}
