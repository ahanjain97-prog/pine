// Keeps expensive Impect-derived data (league-season cohorts, the player pool) on disk, which on
// Railway is the volume, so a deploy or restart doesn't throw away half a minute of downloads.
// Off until configureDiskCache is called: tests and scripts never touch the disk.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let dir = null;

export function configureDiskCache(path) {
  mkdirSync(path, { recursive: true });
  dir = path;
}

export function readDisk(name) {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
  } catch {
    return null; // missing or half-written: treat as not cached
  }
}

// When a cached file was saved (ms since epoch), or null. Cheap: it doesn't parse the file.
export function diskSavedAt(name) {
  if (!dir) return null;
  try {
    return statSync(join(dir, `${name}.json`)).mtimeMs;
  } catch {
    return null;
  }
}

// Written to a temporary file and renamed, so a crash mid-write never leaves a broken cache file.
export function writeDisk(name, value) {
  if (!dir) return;
  const file = join(dir, `${name}.json`);
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.warn(`[cache] couldn't write ${name}: ${e.message}`);
  }
}
