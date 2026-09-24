// Player card jobs. Staff queue a card in PINE; the card worker (a separate machine) claims it over
// HTTP, renders it and uploads a PNG of it (shown on the player page) and then the PDF, which finishes
// the job. Every version is kept: files are never overwritten or deleted.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_CARD_BYTES = 10 * 1024 * 1024; // per file, PDF or PNG
export const DAILY_CARD_LIMIT = 30; // across PINE, per rolling 24 hours
const STALE_MINUTES = 15; // a running job untouched this long is handed out again
const MAX_ATTEMPTS = 3;
const ERROR_CODES = ["not_covered", "no_minutes", "position_unavailable", "goalkeeper", "data_missing", "render_failed", "failed"];

export const cardErrorCode = (code) => (ERROR_CODES.includes(code) ? code : "failed");
export const isPdf = (buf) => buf.subarray(0, 5).toString("latin1") === "%PDF-";
export const isPng = (buf) => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// The oldest queued job, or one stuck in 'running' (its worker died), marked running now.
// A card that has been handed out MAX_ATTEMPTS times and is stuck again is failed, not retried forever.
// An earlier attempt's PNG is forgotten (its file stays), so the picture always matches the PDF.
export function claimCard(db) {
  const stale = `status = 'running' AND started_at < datetime('now', '-${STALE_MINUTES} minutes')`;
  db.run(`UPDATE cards SET status = 'failed', error = 'failed' WHERE ${stale} AND attempts >= ${MAX_ATTEMPTS}`);
  const job = db.get(
    `UPDATE cards SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, image = NULL
     WHERE id = (SELECT id FROM cards WHERE status = 'queued' OR (${stale})
                 ORDER BY requested_at, id LIMIT 1)
     RETURNING id, impect_id, iteration_id, position, tm_id`);
  return job ? { ...job } : null;
}

const utc = (d) => d.toISOString().slice(0, 19); // 2026-09-24T14:02:12
export const sqlTime = (d) => utc(d).replace("T", " "); // matches datetime('now')
export const cardFileName = (d, iterationId, position, ext = "pdf") => `${utc(d).replace(/[-:]/g, "")}Z-${iterationId}-${position}.${ext}`;

// Writes under a temporary name, then renames, so a half-written file never looks like a card.
// Returns the path relative to root, which is what the cards table stores. ext is "pdf" for the card
// itself, "png" for the picture of it shown on the player page.
export function saveCardFile(root, card, buf, when, ext = "pdf") {
  const dir = join(root, String(card.player_id));
  const name = cardFileName(when, card.iteration_id, card.position, ext);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, name))) throw new Error(`card file ${name} already exists`);
  const tmp = join(dir, `.${name}.part`);
  writeFileSync(tmp, buf);
  renameSync(tmp, join(dir, name));
  return `${card.player_id}/${name}`;
}
