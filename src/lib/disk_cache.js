// Keeps expensive Impect-derived data (league-season cohorts, the player pool, playing time) on disk, which
// on Railway is the volume, so a deploy or restart doesn't throw away half a minute of downloads.
// Off until configureDiskCache is called: tests and scripts never touch the disk.
//
// Files are gzipped JSON (`name.json.gz`), about a sixth of the plain size. The volume is small: as plain
// JSON the cohorts alone ran to ~90 MB, and a full volume stops the database saving anything.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

let dir = null;
const path = (name) => join(dir, `${name}.json.gz`);

// Also clears what earlier runs left behind: temp files from writes that failed (a full disk leaves them
// half-written) and plain .json copies from before compression. Everything here can be downloaded again.
export function configureDiskCache(where) {
  mkdirSync(where, { recursive: true });
  dir = where;
  let freed = 0;
  for (const f of readdirSync(where)) {
    if (!f.endsWith(".tmp") && !f.endsWith(".json")) continue;
    try { freed += statSync(join(where, f)).size; unlinkSync(join(where, f)); } catch {}
  }
  if (freed) console.log(`[cache] cleared ${(freed / 1e6).toFixed(1)} MB of stale or uncompressed cache files`);
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
    writeFileSync(tmp, gzipSync(JSON.stringify(value)));
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    console.warn(`[cache] couldn't write ${name}: ${e.message}`);
  }
}
