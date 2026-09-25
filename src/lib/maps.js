// Pitch maps (the Maps tab). Staff ask for one player view: a league season and a card position. The
// card worker (a separate machine) claims the job over HTTP, builds the export from Impect match events
// and uploads it as JSON. PINE checks and trims the export, keeps it gzipped next to the database and
// hands it to the browser, which draws the two maps and filters the metrics without another request.
// A view keeps only its latest build: a rebuild replaces it, since the events behind it only grow.
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CARD_POSITIONS } from "./card_options.js";
import { cardErrorCode, cardFileName, cardProgress } from "./cards.js";

export const MAPS_SCHEMA = 1; // the export shape this PINE can draw; the worker's MAP_SCHEMA must match
export const MAX_MAPS_BYTES = 5 * 1024 * 1024;
export const DAILY_MAPS_LIMIT = 200; // builds requested across PINE per rolling 24 hours
export const OPEN_MAPS_PER_USER = 6; // queued or building at once, per staff member
const STALE_MINUTES = 15; // a running job untouched this long is handed out again
const MAX_ATTEMPTS = 3;
// Map jobs report the same fixed failure and progress codes as cards.
export const mapErrorCode = cardErrorCode;
export const mapProgress = cardProgress;

// The oldest queued job, or one stuck in 'running' (its worker died), marked running now. A job handed
// out MAX_ATTEMPTS times that is stuck again is failed, not retried forever.
export function claimMap(db) {
  const stale = `status = 'running' AND started_at < datetime('now', '-${STALE_MINUTES} minutes')`;
  db.run(`UPDATE maps SET status = 'failed', error = 'failed' WHERE ${stale} AND attempts >= ${MAX_ATTEMPTS}`);
  const job = db.get(
    `UPDATE maps SET status = 'running', started_at = datetime('now'), attempts = attempts + 1,
         progress = NULL, progress_matches = NULL
     WHERE id = (SELECT id FROM maps WHERE status = 'queued' OR (${stale})
                 ORDER BY requested_at, id LIMIT 1)
     RETURNING id, impect_id, iteration_id, position`);
  return job ? { ...job } : null;
}

/* ---------- checking an upload ---------- */
export class MapsError extends Error {}
const bad = (message) => { throw new MapsError(message); };

const GROUPS = ["CB", "FB", "DM", "CM", "AM", "W", "CF"];
const SIDES = ["use", "defend"];
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const CATALOG = /^[0-9a-f]{6,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Contour path data as the worker writes it ("M x,y L x,y ... Z"): numbers and M/L/Z only, so it is
// safe to put straight into an SVG attribute.
const PATH = /^M[0-9 .,LMZ-]*Z$/;
const MAX_METRICS = 100;
const MAX_POINTS = 250_000;
const MAX_PATH = 400_000;

const text = (v, max, what) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : bad(`${what} must be text of at most ${max} characters`));
const int = (v, what, max = 1e9) => (Number.isInteger(v) && v >= 0 && v <= max ? v : bad(`${what} must be a whole number`));
const round1 = (v) => Math.round(v * 10) / 10;

function points(list, what, budget) {
  if (!Array.isArray(list)) bad(`${what} must be a list of points`);
  budget.n += list.length;
  if (budget.n > MAX_POINTS) bad(`The export has more than ${MAX_POINTS} points`);
  return list.map((p) => {
    const [x, y] = Array.isArray(p) && p.length === 2 ? p : bad(`${what} has a point that isn't [x, y]`);
    // Pitch metres: 68 across, 105 long, with a little slack for rounding at the lines.
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || x > 69 || y < -1 || y > 106) bad(`${what} has a point off the pitch`);
    return [round1(x), round1(y)];
  });
}

function layer(v, what, budget) {
  if (!v || typeof v !== "object") bad(`${what} is missing`);
  const pts = points(v.points, `${what} points`, budget);
  if (int(v.n, `${what} n`) !== pts.length) bad(`${what}: n doesn't match its points`);
  const sparse = v.sparse === true;
  const paths = {};
  if (!sparse) {
    for (const mass of ["80", "50"]) {
      const list = v.paths?.[mass];
      if (!Array.isArray(list)) bad(`${what} has no ${mass}% contours`);
      paths[mass] = list.map((d) => (typeof d === "string" && d.length <= MAX_PATH && PATH.test(d) ? d : bad(`${what} has a malformed contour`)));
    }
  }
  return { n: pts.length, sparse, paths, points: pts };
}

// The export trimmed to exactly what the Maps tab draws, or a MapsError saying what is wrong. job is the
// maps row being finished: an export for another player, season or position is refused.
export function normalizeMaps(raw, job) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("Maps must be a JSON object");
  if (raw.schema !== MAPS_SCHEMA) bad(`Unsupported maps schema ${JSON.stringify(raw.schema)}; this PINE draws schema ${MAPS_SCHEMA}`);
  const who = raw.player && typeof raw.player === "object" ? raw.player : bad("The export has no player");
  if (who.impect_id !== job.impect_id || who.iteration !== job.iteration_id || raw.position !== job.position) {
    bad("These maps are for a different player, season or position than the job");
  }
  if (!GROUPS.includes(raw.group)) bad("Unknown position group");
  if (!(raw.position in CARD_POSITIONS)) bad("Unknown position");
  const budget = { n: 0 };
  const layers = Object.fromEntries(SIDES.map((side) => [side, layer(raw.layers?.[side], `The ${side} layer`, budget)]));
  if (!Array.isArray(raw.metrics) || !raw.metrics.length || raw.metrics.length > MAX_METRICS) bad(`The export needs 1 to ${MAX_METRICS} metrics`);
  const seen = new Set();
  const metrics = raw.metrics.map((m, i) => {
    if (!m || typeof m !== "object") bad(`Metric ${i + 1} isn't an object`);
    const key = typeof m.key === "string" && KEY.test(m.key) ? m.key : bad(`Metric ${i + 1} has a bad key`);
    if (seen.has(key)) bad(`Metric ${key} appears twice`);
    seen.add(key);
    if (!SIDES.includes(m.side)) bad(`Metric ${key} has no map`);
    const available = m.available === true;
    return {
      key, side: m.side, available,
      category: text(m.category, 40, `Metric ${key} category`),
      label: text(m.label, 60, `Metric ${key} label`),
      definition: text(m.definition, 300, `Metric ${key} definition`),
      points: available ? points(m.points, `Metric ${key}`, budget) : [],
    };
  });
  const usable = (side) => new Set(metrics.filter((m) => m.side === side && m.available).map((m) => m.key));
  const defaults = Object.fromEntries(SIDES.map((side) => {
    const ok = usable(side);
    const list = Array.isArray(raw.defaults?.[side]) ? raw.defaults[side] : [];
    return [side, [...new Set(list.filter((k) => ok.has(k)))].slice(0, 3)];
  }));
  const sample = raw.sample && typeof raw.sample === "object" ? raw.sample : bad("The export has no sample");
  const share = Number.isFinite(sample.match_share) && sample.match_share >= 0 ? Math.round(sample.match_share * 100) / 100 : bad("Match share must be a number");
  return {
    schema: MAPS_SCHEMA,
    catalog: typeof raw.catalog === "string" && CATALOG.test(raw.catalog) ? raw.catalog : bad("The export has no catalog id"),
    position: raw.position,
    group: raw.group,
    player: {
      impect_id: who.impect_id,
      iteration: who.iteration,
      name: text(who.name, 120, "Player name"),
      club: text(who.club, 120, "Club"),
      league: text(who.league, 40, "League"),
      season: int(who.season, "Season", 3000),
    },
    sample: {
      matches: int(sample.matches, "Matches", 1000),
      match_share: share,
      last_match: sample.last_match == null ? null : DATE.test(sample.last_match) ? sample.last_match : bad("Last match must be a date"),
    },
    excluded_coordinates: int(raw.excluded_coordinates ?? 0, "Excluded coordinates"),
    layers,
    metrics,
    defaults,
  };
}

/* ---------- files ---------- */
// Writes the trimmed export gzipped under a temporary name, then renames it. Returns the path relative
// to root (what the maps table stores) and the stored size.
export function saveMapsFile(root, map, data, when) {
  const dir = join(root, String(map.player_id));
  const name = cardFileName(when, map.iteration_id, map.position, "json.gz").replace(/Z-/, `Z-${map.id}-`);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, name))) throw new Error(`maps file ${name} already exists`);
  const buf = gzipSync(JSON.stringify(data));
  const tmp = join(dir, `.${name}.part`);
  writeFileSync(tmp, buf);
  renameSync(tmp, join(dir, name));
  return { file: `${map.player_id}/${name}`, bytes: buf.length };
}

// Files of builds a newer one replaced. One that is already gone is fine.
export function removeMapsFiles(root, files) {
  for (const f of files) {
    try { unlinkSync(join(root, f)); } catch (e) { if (e.code !== "ENOENT") console.warn(`couldn't remove maps file ${f}: ${e.message}`); }
  }
}
