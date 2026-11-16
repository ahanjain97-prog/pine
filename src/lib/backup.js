// Database snapshots. VACUUM INTO writes a consistent copy even while the app is running.
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";

const sqlPath = (p) => p.replace(/'/g, "''");

export function writeSnapshot(db, dir, label = new Date().toISOString().slice(0, 10)) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pine-${label}.sqlite.gz`);
  // Build off-volume: VACUUM needs an entire database's worth of scratch space.
  // Keep the last good backup until its compressed replacement is safely saved.
  const scratch = mkdtempSync(join(tmpdir(), 'pine-backup-'));
  try {
    const raw = join(scratch, 'snapshot.sqlite');
    db.raw.exec(`VACUUM INTO '${sqlPath(raw)}'`);
    saveCompressed(file, readFileSync(raw));
    // A backup made by an earlier release may have the same date.
    try { unlinkSync(join(dir, `pine-${label}.sqlite`)); } catch {}
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return file;
}

function saveCompressed(file, raw) {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, gzipSync(raw), { flag: 'wx', mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (!gunzipSync(readFileSync(tmp)).equals(raw)) throw new Error('Backup compression verification failed');
    renameSync(tmp, file);
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// Lossless migration: an old snapshot stays until a verified compressed copy is
// durable. A full disk leaves that original intact and retries on the next run.
export function compressSnapshots(dir) {
  let saved = 0;
  for (const s of listSnapshots(dir).filter(s => s.name.endsWith('.sqlite'))) {
    const file = join(dir, s.name);
    const raw = readFileSync(file);
    if (raw.subarray(0, 16).toString() !== 'SQLite format 3\0') continue;
    try {
      const compressed = `${file}.gz`;
      // Never replace a different backup that happens to share a date.
      try {
        if (!gunzipSync(readFileSync(compressed)).equals(raw)) continue;
      } catch (e) {
        if (e.code !== 'ENOENT') continue;
        saveCompressed(compressed, raw);
      }
      unlinkSync(file);
      saved += raw.length - statSync(compressed).size;
    } catch (e) {
      console.warn(`backup compression skipped: ${e.message}`);
    }
  }
  return saved;
}

export function listSnapshots(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && /^pine-\d{4}-\d{2}-\d{2}\.sqlite(?:\.gz)?$/.test(f.name))
      .map(f => f.name)
      .map((f) => ({ name: f, bytes: statSync(join(dir, f)).size, at: statSync(join(dir, f)).mtime.toISOString() }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

export function prune(dir, keep = 14) {
  const extra = listSnapshots(dir).slice(keep);
  for (const s of extra) {
    try { unlinkSync(join(dir, s.name)); } catch {}
  }
  return extra.length;
}

// One snapshot a day, plus one at boot so a fresh container is covered immediately.
export function startDailyBackups(db, dir, { keep = 14, everyMs = 24 * 60 * 60 * 1000 } = {}) {
  const run = () => {
    try {
      // Make room first, so a nearly full volume still gets today's snapshot; the count kept is the same.
      const removed = prune(dir, keep - 1);
      compressSnapshots(dir);
      const file = writeSnapshot(db, dir);
      console.log(`backup: ${file}${removed ? ` (pruned ${removed})` : ""}`);
    } catch (e) {
      console.warn("backup failed:", e.message);
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return timer;
}

// Downloads remain ordinary SQLite, with scratch space outside the persistent volume.
export function snapshotBuffer(db, dir) {
  const scratch = mkdtempSync(join(tmpdir(), 'pine-download-'));
  const file = join(scratch, 'snapshot.sqlite');
  try {
    db.raw.exec(`VACUUM INTO '${sqlPath(file)}'`);
    return readFileSync(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
