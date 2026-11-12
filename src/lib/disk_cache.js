// Keeps expensive Impect-derived data (league-season cohorts, the player pool, playing time) on disk, which
// on Railway is the volume, so a deploy or restart doesn't throw away half a minute of downloads.
// Off until configureDiskCache is called: tests and scripts never touch the disk.
//
// Files are gzipped JSON (`name.json.gz`), about a sixth of the plain size. The volume is small: as plain
// JSON the cohorts alone ran to ~90 MB, and a full volume stops the database saving anything.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const MB = 1024 * 1024;
let dir = null;
let limits;
const freeBytes = () => {
  const fs = statfsSync(dir);
  return fs.bavail * fs.bsize;
};
const path = (name) => join(dir, `${name}.json.gz`);

// Also clears what earlier runs left behind: temp files from writes that failed (a full disk leaves them
// half-written) and plain .json copies from before compression. Everything here can be downloaded again.
export function configureDiskCache(where, {
  maxBytes = 128 * MB, reserveBytes = 32 * MB, availableBytes = freeBytes,
} = {}) {
  mkdirSync(where, { recursive: true });
  dir = where;
  limits = { maxBytes, reserveBytes, availableBytes };
  let freed = 0;
  for (const entry of readdirSync(where, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const f = entry.name;
    if (!f.endsWith(".tmp") && !f.endsWith(".json")) continue;
    try { freed += statSync(join(where, f)).size; unlinkSync(join(where, f)); } catch {}
  }
  if (freed) console.log(`[cache] cleared ${(freed / 1e6).toFixed(1)} MB of stale or uncompressed cache files`);
  makeDiskSpace();
}

// Only compressed, reproducible downloads in the configured cache are eligible.
// Oldest downloads go first. Durable files (database, snapshots, cards and maps)
// live outside this directory and are never candidates for eviction.
function trimCache(incomingCacheBytes, incomingFileBytes) {
  if (!dir) return true;
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".json.gz"))
    .map((f) => ({ name: f.name, ...statSync(join(dir, f.name)) }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((n, f) => n + f.size, 0);
  let available = limits.availableBytes();
  let freed = 0;
  const enough = () => total + incomingCacheBytes <= limits.maxBytes
    && available >= limits.reserveBytes + incomingFileBytes;
  for (const f of files) {
    if (enough()) break;
    try {
      unlinkSync(join(dir, f.name));
      total -= f.size;
      freed += f.size;
      available = limits.availableBytes();
    } catch (e) {
      console.warn(`[cache] couldn't evict ${f.name}: ${e.message}`);
    }
  }
  if (freed) console.log(`[cache] reclaimed ${(freed / MB).toFixed(1)} MB; ${(available / MB).toFixed(1)} MB free`);
  return enough();
}

// Reclaim disposable cache before a durable write, including while the app is
// already running. A full cache is not allowed to block a staff upload.
export function makeDiskSpace(bytes = 0) {
  return trimCache(0, bytes);
}

export function readDisk(name) {
  if (!dir) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(path(name))).toString("utf8"));
  } catch {
    return null; // missing or half-written: treat as not cached
  }
}

// When a cached file was saved (ms since epoch), or null. Cheap: it doesn't read the file.
export function diskSavedAt(name) {
  if (!dir) return null;
  try {
    return statSync(path(name)).mtimeMs;
  } catch {
    return null;
  }
}

// Written to a temporary file and renamed, so a crash mid-write never leaves a broken cache file; a failed
// write removes its temp file rather than leaving it to take up space.
export function writeDisk(name, value) {
  if (!dir) return;
  const file = path(name), tmp = `${file}.tmp`;
  try {
    const bytes = gzipSync(JSON.stringify(value));
    if (!trimCache(bytes.length, bytes.length)) return; // downloading cache is optional
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    console.warn(`[cache] couldn't write ${name}: ${e.message}`);
  }
}
