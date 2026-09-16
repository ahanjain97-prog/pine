// Database snapshots. VACUUM INTO writes a consistent copy even while the app is running.
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const sqlPath = (p) => p.replace(/'/g, "''");

export function writeSnapshot(db, dir, label = new Date().toISOString().slice(0, 10)) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pine-${label}.sqlite`);
  try { unlinkSync(file); } catch {}
  db.raw.exec(`VACUUM INTO '${sqlPath(file)}'`);
  return file;
}

export function listSnapshots(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sqlite"))
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
      const file = writeSnapshot(db, dir);
      const removed = prune(dir, keep);
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

// A fresh copy for download; written to the snapshot dir under a temp name, read, then removed.
export function snapshotBuffer(db, dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `download-${Date.now()}.tmp.sqlite`);
  db.raw.exec(`VACUUM INTO '${sqlPath(file)}'`);
  const buf = readFileSync(file);
  try { unlinkSync(file); } catch {}
  return buf;
}
