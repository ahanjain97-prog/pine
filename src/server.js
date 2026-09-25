import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getCookie, setCookie } from "hono/cookie";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { createHash, timingSafeEqual } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { openDb, logActivity } from "./db.js";
import { checkPassword, createSetupLink, setupLinkUser, useSetupLink, startSession, logout, currentUser, tokenMatches } from "./auth.js";
import { POSITIONS, ROLES, DECISIONS, SPLIT_ROLES, IMPECT_POSITION_LABEL, suggestPosition, suggestListRole, resolveRole } from "./roles.js";
import { fetchTmPlayer, parseTmUrl, searchTmPlayers } from "./lib/transfermarkt.js";
import { TM_FIELDS, manualTmOverrides, releaseTmOverrides, tmConflicts, tmSyncFields } from "./lib/tm_sync.js";
import { loadPhysical, matchPhysical, repairKeys, resolveAutoLinks, searchPhysical, rowsByKeys, teamOverlap, meta as physMeta } from "./lib/physical.js";
import {
  impectConfigured, iterations as impectIterations, searchImpect, getImpectPlayer, matchImpect,
  shortLists as impectShortLists, shortListPlayerMeta,
} from "./lib/impect.js";
import { playerKpiCard } from "./lib/impect_kpi.js";
import { playerCardOptions } from "./lib/card_options.js";
import { MAX_CARD_BYTES, DAILY_CARD_LIMIT, cardErrorCode, cardProgress, claimCard, isPdf, isPng, saveCardFile, sqlTime } from "./lib/cards.js";
import {
  MAX_MAPS_BYTES, DAILY_MAPS_LIMIT, OPEN_MAPS_PER_USER, MapsError, claimMap, mapErrorCode, mapProgress, normalizeMaps,
  removeMapsFiles, saveMapsFile,
} from "./lib/maps.js";
import { startDailyBackups, snapshotBuffer, listSnapshots } from "./lib/backup.js";
import { runBulkMatch, matchState } from "./lib/tm_match.js";
import { ogTags, playerPreview, sitePreview } from "./lib/share.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const DB_FILE = process.env.PINE_DB || join(ROOT, "data", "pine.db");
// First boot on a new host: start from the snapshot in seed/ when the volume has no database yet.
const SEED_DB = join(ROOT, "seed", "pine-seed.sqlite");
if (!existsSync(DB_FILE) && existsSync(SEED_DB)) {
  mkdirSync(dirname(DB_FILE), { recursive: true });
  copyFileSync(SEED_DB, DB_FILE);
  console.log(`Seeded ${DB_FILE} from ${SEED_DB}`);
}
const db = openDb(DB_FILE);
const BACKUP_DIR = join(dirname(DB_FILE), "backups");
startDailyBackups(db, BACKUP_DIR);
// Player card PDFs, one folder per player, on the same volume as the database.
const CARDS_DIR = join(dirname(DB_FILE), "cards");
// Pitch map exports (gzipped JSON), one folder per player, likewise.
const MAPS_DIR = join(dirname(DB_FILE), "maps");
const PHYS_CACHE = join(ROOT, "data", "physical_cache.json");

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

const EDITABLE = [
  "name", "birthdate", "birthplace", "height_cm", "foot", "position", "club", "league", "joined", "contract_expires",
  "loan_from", "agent", "market_value_display", "national_team", "photo_url", "summary",
];
const JSON_COLS = ["citizenship", "other_positions", "phys_keys", "tm_overrides"];

function ageFrom(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate + "T00:00:00Z");
  if (Number.isNaN(+b)) return null;
  const now = new Date();
  let a = now.getUTCFullYear() - b.getUTCFullYear();
  if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

function hydrate(p) {
  if (!p) return p;
  for (const k of JSON_COLS) p[k] = JSON.parse(p[k] || "[]");
  if ("changed_by_json" in p) {
    p.changed_by = JSON.parse(p.changed_by_json || "[]");
    delete p.changed_by_json;
  }
  p.age = ageFrom(p.birthdate);
  if ("roles_json" in p) { p.roles = JSON.parse(p.roles_json || "[]").sort((a, b) => a.role.localeCompare(b.role)); delete p.roles_json; }
  if ("verdicts_json" in p) { p.verdicts = JSON.parse(p.verdicts_json || "{}"); delete p.verdicts_json; }
  return p;
}

const PLAYER_SELECT = `
  SELECT p.*,
    (SELECT json_group_array(json_object('role', b.role, 'rank', b.rank)) FROM board_entries b WHERE b.player_id = p.id) AS roles_json,
    (SELECT json_group_object(u.name, v.verdict) FROM verdicts v JOIN users u ON u.id = v.user_id WHERE v.player_id = p.id) AS verdicts_json,
    (SELECT count(*) FROM notes n WHERE n.player_id = p.id) AS note_count,
    (SELECT max(n.created_at) FROM notes n WHERE n.player_id = p.id) AS last_note_at,
    (SELECT json_group_array(DISTINCT a.user_id) FROM activity a
      WHERE a.player_id = p.id AND a.user_id IS NOT NULL AND a.action <> 'added_player') AS changed_by_json
  FROM players p`;

const getPlayer = (id) => hydrate(db.get(`${PLAYER_SELECT} WHERE p.id = ?`, Number(id))) || fail(404, "Player not found");

function insertPlayer(fields, userId, source) {
  const cols = Object.keys(fields);
  const vals = cols.map((k) => (JSON_COLS.includes(k) ? JSON.stringify(fields[k] ?? []) : fields[k] ?? null));
  const r = db.run(
    `INSERT INTO players(${cols.join(",")}, source, created_by) VALUES (${cols.map(() => "?").join(",")}, ?, ?)`,
    ...vals, source, userId
  );
  return Number(r.lastInsertRowid);
}

function updatePlayer(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  db.run(
    `UPDATE players SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    ...cols.map((k) => (JSON_COLS.includes(k) ? JSON.stringify(fields[k] ?? []) : fields[k] ?? null)),
    Number(id)
  );
}

function addRole(playerId, role) {
  if (!ROLES[role]) fail(400, `Unknown role ${role}`);
  const max = db.get("SELECT coalesce(max(rank), -1) AS m FROM board_entries WHERE role = ?", role).m;
  db.run("INSERT OR IGNORE INTO board_entries(player_id, role, rank) VALUES (?,?,?)", playerId, role, max + 1);
}

function moveOnBoard(playerId, fromRole, toRole, index) {
  if (!ROLES[toRole]) fail(400, `Unknown role ${toRole}`);
  db.tx(() => {
    if (fromRole && fromRole !== toRole) db.run("DELETE FROM board_entries WHERE player_id = ? AND role = ?", playerId, fromRole);
    const ids = db.all("SELECT player_id FROM board_entries WHERE role = ? AND player_id <> ? ORDER BY rank", toRole, playerId).map((r) => r.player_id);
    ids.splice(Math.max(0, Math.min(Number(index) || 0, ids.length)), 0, playerId);
    db.run("DELETE FROM board_entries WHERE role = ?", toRole);
    ids.forEach((pid, i) => db.run("INSERT INTO board_entries(player_id, role, rank) VALUES (?,?,?)", pid, toRole, i));
  });
  return spotIn(playerId, toRole);
}

// 0-based position of a player within a role (ranks can have gaps), or null if they aren't in it.
function spotIn(playerId, role) {
  const r = db.get(
    "SELECT (SELECT count(*) FROM board_entries o WHERE o.role = b.role AND o.rank < b.rank) AS spot FROM board_entries b WHERE b.player_id = ? AND b.role = ?",
    playerId, role);
  return r ? r.spot : null;
}

function compactRanks(role) {
  db.all("SELECT player_id FROM board_entries WHERE role = ? ORDER BY rank", role)
    .forEach((r, i) => db.run("UPDATE board_entries SET rank = ? WHERE player_id = ? AND role = ?", i, r.player_id, role));
}

// Physical + Impect links found automatically when a player is created or re-synced.
async function autoLink(playerId) {
  const p = getPlayer(playerId);
  const out = {};
  try {
    if (!p.phys_confirmed) {
      const phys = await loadPhysical(PHYS_CACHE);
      const taken = physKeysOfOthers(playerId);
      const keys = matchPhysical(phys, p).filter((m) => m.auto && !taken.has(m.key)).map((m) => m.key);
      if (keys.length) { updatePlayer(playerId, { phys_keys: keys }); out.physical = keys.length; }
    }
  } catch (e) { console.warn("physical auto-link failed:", e.message); }
  try {
    if (!p.impect_id && impectConfigured()) {
      const { best } = await matchImpect(p);
      if (best && !db.get("SELECT id FROM players WHERE impect_id = ?", best.impect_id)) {
        updatePlayer(playerId, { impect_id: best.impect_id, impect_squad: best.squad, impect_competition: best.competition });
        out.impect = best.impect_id;
      }
    }
  } catch (e) { console.warn("impect auto-link failed:", e.message); }
  return out;
}

function physKeysOfOthers(playerId) {
  return new Set(db.all("SELECT phys_keys FROM players WHERE id <> ?", playerId).flatMap((r) => JSON.parse(r.phys_keys || "[]")));
}

// Re-run physical auto-linking for every player whose links nobody has confirmed by hand, so new
// seasons on the physical site and matcher improvements reach existing players. Confirmed links are
// never touched, and rows they use are not handed to anyone else.
async function relinkPhysical() {
  const phys = await loadPhysical(PHYS_CACHE);
  const all = db.all("SELECT id, name, birthdate, club, loan_from, impect_squad, phys_keys, phys_confirmed FROM players");
  // Repair hand-confirmed links first: the site relabels a row's team when a player moves, and
  // nothing else would bring those rows back.
  let repaired = 0;
  for (const p of all.filter((x) => x.phys_confirmed)) {
    const { keys, changed } = repairKeys(phys, JSON.parse(p.phys_keys || "[]"));
    if (!changed) continue;
    db.run("UPDATE players SET phys_keys = ? WHERE id = ?", JSON.stringify(keys), p.id);
    p.phys_keys = JSON.stringify(keys);
    repaired += changed;
  }
  const confirmedKeys = new Set(all.filter((p) => p.phys_confirmed).flatMap((p) => JSON.parse(p.phys_keys || "[]")));
  const open = all.filter((p) => !p.phys_confirmed);
  const { links } = resolveAutoLinks(phys, open);
  let changed = 0;
  for (const p of open) {
    const keys = links.get(p.id).filter((k) => !confirmedKeys.has(k));
    if ([...keys].sort().join("\n") === JSON.parse(p.phys_keys || "[]").sort().join("\n")) continue;
    // Direct write: a background re-link shouldn't count as someone updating the player.
    db.run("UPDATE players SET phys_keys = ? WHERE id = ?", JSON.stringify(keys), p.id);
    changed++;
  }
  const linked = db.get("SELECT count(*) AS n FROM players WHERE phys_keys <> '[]'").n;
  console.log(`[physical] re-linked: ${changed} players changed, ${repaired} confirmed links repaired; ${linked}/${all.length} have physical data`);
  return { changed, repaired, linked, total: all.length };
}
setTimeout(() => relinkPhysical().catch((e) => console.warn("physical re-link failed:", e.message)), 20_000);
setInterval(() => relinkPhysical().catch((e) => console.warn("physical re-link failed:", e.message)), 6 * 60 * 60 * 1000);

// Write a fetched Transfermarkt profile onto a player (used by manual sync and the bulk matcher).
async function applyTmProfile(playerId, tm, userId, via, acceptFields = []) {
  const current = getPlayer(playerId);
  const tm_overrides = releaseTmOverrides(current.tm_overrides, acceptFields);
  const player = { ...current, tm_overrides };
  const conflicts = tmConflicts(player, tm);
  updatePlayer(playerId, { ...tmSyncFields(player, tm), tm_overrides });
  logActivity(db, userId, playerId, "linked_tm", { tm_id: tm.tm_id, ...(via ? { via } : {}) });
  await autoLink(playerId);
  return conflicts;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
// Public base URL for links we hand out (sign-in links, share links). APP_URL wins so links
// minted behind a proxy still point at the real host.
const siteOrigin = (c) => String(process.env.APP_URL || new URL(c.req.url).origin).replace(/\/+$/, "");

const app = new Hono();

app.onError((err, c) => {
  // Middleware errors such as the password prompt's 401 carry their own response and headers.
  if (err instanceof HTTPException) return err.getResponse();
  if (!(err instanceof HttpError)) console.error(err);
  return c.json({ error: err.message || "Server error", ...(err.extra || {}) }, err.status || 500);
});

// PINE_SITE_PASSWORD puts one shared password (browser prompt, any username) in front of the whole site.
if (process.env.PINE_SITE_PASSWORD) {
  const want = createHash("sha256").update(process.env.PINE_SITE_PASSWORD).digest();
  app.use("*", basicAuth({
    realm: "PINE",
    verifyUser: (_username, password) => timingSafeEqual(createHash("sha256").update(String(password)).digest(), want),
  }));
}

// PINE_AUTH=off skips sign-in: people pick which staff member they are in the header (default: first admin).
const AUTH_OFF = process.env.PINE_AUTH === "off";
const ACT_AS_COOKIE = "pine_as";
function actingUser(c) {
  const cols = "id, name, email, is_admin";
  const id = Number(getCookie(c, ACT_AS_COOKIE));
  return (id && db.get(`SELECT ${cols} FROM users WHERE id = ?`, id))
    || db.get(`SELECT ${cols} FROM users ORDER BY is_admin DESC, sort, id LIMIT 1`);
}
const resolveUser = (c) => (AUTH_OFF ? actingUser(c) : currentUser(db, c));

// scripts/pull-backup.sh fetches snapshots with PINE_BACKUP_TOKEN (sent as X-PINE-Backup-Token)
// instead of a staff sign-in. It opens /api/backup and nothing else.
const BACKUP_TOKEN = process.env.PINE_BACKUP_TOKEN || "";
const backupTokenOk = (c) => tokenMatches(c.req.header("X-PINE-Backup-Token"), BACKUP_TOKEN);
// The player card worker sends PINE_WORKER_TOKEN as X-PINE-Worker-Token. It opens /api/worker/* only,
// and those routes never accept a staff session instead.
const WORKER_TOKEN = process.env.PINE_WORKER_TOKEN || "";
// When the worker last called in at all, and about maps. It polls every 5 seconds, so the Maps tab can
// say when it's offline, or running a version from before maps.
const workerSeen = { any: null, maps: null };

// Auth gate + CSRF header for writes.
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("X-PINE") !== "1") return c.json({ error: "Bad request" }, 400);
  if (c.req.path.startsWith("/api/auth/")) return next();
  if (c.req.path.startsWith("/api/worker/")) {
    if (!tokenMatches(c.req.header("X-PINE-Worker-Token"), WORKER_TOKEN)) return c.json({ error: "Worker token missing or wrong" }, 401);
    workerSeen.any = new Date();
    if (c.req.path.startsWith("/api/worker/maps/")) workerSeen.maps = workerSeen.any;
    c.set("user", null);
    return next();
  }
  if (c.req.method === "GET" && c.req.path === "/api/backup" && backupTokenOk(c)) { c.set("user", null); return next(); }
  const user = resolveUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  c.set("user", user);
  return next();
});

/* ---------- auth ---------- */
app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json();
  const { user, error } = checkPassword(db, email, password);
  if (!user) return c.json({ error }, 401);
  startSession(db, c, user);
  logActivity(db, user.id, null, "signed_in");
  return c.json({ ok: true, user: { id: user.id, name: user.name } });
});
// Setup links (made by an admin on the Staff page): look one up, then use it to choose a password.
app.get("/api/auth/setup/:token", (c) => {
  const user = setupLinkUser(db, c.req.param("token"));
  if (!user) return c.json({ error: "This link has expired or was already used. Ask an admin for a new one." }, 404);
  return c.json({ user: { name: user.name, email: user.email } });
});
app.post("/api/auth/setup", async (c) => {
  const { token, password } = await c.req.json();
  const { user, error } = useSetupLink(db, token, password);
  if (!user) return c.json({ error }, 400);
  startSession(db, c, user);
  logActivity(db, user.id, null, "set_password");
  return c.json({ ok: true, user: { id: user.id, name: user.name } });
});
app.post("/api/auth/logout", (c) => { logout(db, c); return c.json({ ok: true }); });
app.get("/api/auth/me", (c) => c.json({ user: resolveUser(c) || null }));
app.post("/api/auth/act-as", async (c) => {
  if (!AUTH_OFF) return c.json({ error: "Sign-in is enabled" }, 400);
  const { user_id } = await c.req.json();
  const user = db.get("SELECT id, name FROM users WHERE id = ?", Number(user_id));
  if (!user) return c.json({ error: "Unknown staff member" }, 404);
  setCookie(c, ACT_AS_COOKIE, String(user.id), { path: "/", sameSite: "Lax", maxAge: 365 * 24 * 3600 });
  return c.json({ ok: true, user });
});

/* ---------- config ---------- */
app.get("/api/config", (c) =>
  c.json({
    positions: POSITIONS,
    roles: ROLES,
    decisions: DECISIONS,
    staff: db.all("SELECT id, name FROM users ORDER BY sort, id"),
    me: c.get("user"),
    auth: AUTH_OFF ? "off" : "email",
    impect: impectConfigured(),
  })
);
app.get("/api/changes", (c) => c.json({ version: db.get("SELECT coalesce(max(id), 0) AS v FROM activity").v }));

/* ---------- players ---------- */
app.get("/api/players", (c) => c.json({ players: db.all(`${PLAYER_SELECT} ORDER BY p.name COLLATE NOCASE`).map(hydrate) }));

app.get("/api/players/:id", (c) => {
  const player = getPlayer(c.req.param("id"));
  const staff = db.all("SELECT id, name FROM users ORDER BY sort, id").map((u) => {
    const v = db.get("SELECT verdict, updated_at FROM verdicts WHERE player_id = ? AND user_id = ?", player.id, u.id);
    return {
      user_id: u.id,
      name: u.name,
      verdict: v?.verdict || null,
      verdict_at: v?.updated_at || null,
      notes: db.all("SELECT id, context, body, created_at, updated_at FROM notes WHERE player_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC", player.id, u.id),
    };
  });
  const activity = db.all(
    `SELECT a.id, a.action, a.detail, a.created_at, u.name AS user FROM activity a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.player_id = ? ORDER BY a.id DESC LIMIT 40`, player.id);
  const lists = db.all("SELECT l.id, l.name, l.source FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.player_id = ?", player.id);
  const decision_by = player.decision_by ? db.get("SELECT name FROM users WHERE id = ?", player.decision_by)?.name : null;
  return c.json({ player: { ...player, decision_by_name: decision_by }, staff, activity, lists });
});

app.post("/api/tm/preview", async (c) => {
  const { url } = await c.req.json();
  const parsed = parseTmUrl(url);
  if (!parsed) fail(400, "That doesn't look like a Transfermarkt player link");
  const dup = db.get("SELECT id, name FROM players WHERE tm_id = ?", parsed.id);
  const profile = await fetchTmPlayer(url);
  const suggested = suggestPosition(profile.position, profile.foot);
  let physical = [];
  try { physical = matchPhysical(await loadPhysical(PHYS_CACHE), profile).slice(0, 6); } catch {}
  let impect = null;
  try { if (impectConfigured()) impect = (await matchImpect(profile)).best; } catch {}
  return c.json({ profile, duplicate: dup || null, suggested_position: suggested, physical, impect });
});

app.post("/api/players", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const roles = (body.roles || []).filter((r) => ROLES[r]);
  let fields, source;
  if (body.tm_url) {
    const parsed = parseTmUrl(body.tm_url) || fail(400, "Invalid Transfermarkt link");
    const dup = db.get("SELECT id, name FROM players WHERE tm_id = ?", parsed.id);
    if (dup) fail(409, `${dup.name} is already in PINE`, { player_id: dup.id });
    const tm = await fetchTmPlayer(body.tm_url);
    fields = { ...pick(tm, TM_FIELDS), citizenship: tm.citizenship, other_positions: tm.other_positions, tm_synced_at: new Date().toISOString() };
    source = "transfermarkt";
  } else if (body.impect_id) {
    const dup = db.get("SELECT id, name FROM players WHERE impect_id = ?", Number(body.impect_id));
    if (dup) fail(409, `${dup.name} is already in PINE`, { player_id: dup.id });
    const ip = (await getImpectPlayer(body.impect_id)) || fail(404, "Impect player not found");
    fields = {
      ...pick(ip, ["name", "birthdate", "birthplace", "height_cm", "foot", "citizenship", "impect_id"]),
      club: ip.squad, league: ip.competition, impect_squad: ip.squad, impect_competition: ip.competition,
    };
    source = "impect";
  } else {
    if (!String(body.name || "").trim()) fail(400, "Name is required");
    fields = pick(body, EDITABLE);
    fields.name = String(body.name).trim();
    source = "manual";
  }
  if (body.decision && DECISIONS.includes(body.decision)) Object.assign(fields, { decision: body.decision, decision_by: user.id, decision_at: new Date().toISOString() });
  const id = db.tx(() => {
    const pid = insertPlayer(fields, user.id, source);
    roles.forEach((r) => addRole(pid, r));
    logActivity(db, user.id, pid, "added_player", { name: fields.name, source, roles });
    return pid;
  });
  const linked = await autoLink(id);
  return c.json({ player: getPlayer(id), linked }, 201);
});

app.patch("/api/players/:id", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const fields = pick(await c.req.json(), EDITABLE);
  for (const k of Object.keys(fields)) if (typeof fields[k] === "string" && !fields[k].trim()) fields[k] = null;
  if (fields.height_cm != null) fields.height_cm = Number(fields.height_cm) || null;
  if ("name" in fields && !String(fields.name || "").trim()) fail(400, "Name is required");
  const edited = Object.keys(fields);
  fields.tm_overrides = manualTmOverrides(p, fields);
  updatePlayer(p.id, fields);
  logActivity(db, user.id, p.id, "edited_player", { fields: edited });
  return c.json({ player: getPlayer(p.id) });
});

app.delete("/api/players/:id", (c) => {
  const user = c.get("user");
  if (!user.is_admin) fail(403, "Only admins can delete players");
  const p = getPlayer(c.req.param("id"));
  const roles = p.roles.map((r) => r.role);
  db.tx(() => {
    logActivity(db, user.id, null, "deleted_player", { name: p.name, id: p.id });
    db.run("DELETE FROM players WHERE id = ?", p.id);
    roles.forEach(compactRanks);
  });
  return c.json({ ok: true });
});

app.post("/api/players/:id/refresh-tm", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const url = body.url || p.tm_url;
  const parsed = parseTmUrl(url) || fail(400, "Add a Transfermarkt link first");
  const dup = db.get("SELECT id, name FROM players WHERE tm_id = ? AND id <> ?", parsed.id, p.id);
  if (dup) fail(409, `That Transfermarkt profile belongs to ${dup.name}`, { player_id: dup.id });
  const tm = await fetchTmPlayer(url);
  const conflicts = await applyTmProfile(p.id, tm, user.id, null, Array.isArray(body.accept_fields) ? body.accept_fields : []);
  return c.json({ player: getPlayer(p.id), tm_conflicts: conflicts });
});

// Transfermarkt search for players added without a link (e.g. Impect imports), ranked by age/club/country agreement.
app.get("/api/players/:id/tm-candidates", async (c) => {
  const p = getPlayer(c.req.param("id"));
  const query = String(c.req.query("q") || p.name || "").trim();
  if (query.length < 2) return c.json({ query, candidates: [] });
  const taken = new Map(db.all("SELECT tm_id, id, name FROM players WHERE tm_id IS NOT NULL").map((r) => [r.tm_id, r]));
  const candidates = (await searchTmPlayers(query))
    .map((r) => {
      const reasons = [];
      if (p.age != null && r.age != null && Math.abs(r.age - p.age) <= 1) reasons.push("age");
      if (p.club && r.club && teamOverlap(p.club, r.club)) reasons.push("club");
      if (p.citizenship.length && r.citizenship.some((x) => p.citizenship.includes(x))) reasons.push("country");
      const other = taken.get(r.tm_id);
      return { ...r, reasons, in_pine: other && other.id !== p.id ? { id: other.id, name: other.name } : null };
    })
    .sort((a, b) => b.reasons.length - a.reasons.length);
  return c.json({ query, candidates });
});

/* ---------- decisions, verdicts, notes ---------- */
app.put("/api/players/:id/decision", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const { decision } = await c.req.json();
  if (decision != null && !DECISIONS.includes(decision)) fail(400, "Decision must be pass, hold or fail");
  updatePlayer(p.id, { decision: decision ?? null, decision_by: decision ? user.id : null, decision_at: decision ? new Date().toISOString() : null });
  logActivity(db, user.id, p.id, "set_decision", { decision: decision ?? null, previous: p.decision });
  return c.json({ player: getPlayer(p.id) });
});

app.put("/api/players/:id/verdict", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const { verdict } = await c.req.json();
  if (verdict == null) db.run("DELETE FROM verdicts WHERE player_id = ? AND user_id = ?", p.id, user.id);
  else if (!DECISIONS.includes(verdict)) fail(400, "Verdict must be pass, hold or fail");
  else db.run(
    "INSERT INTO verdicts(player_id, user_id, verdict) VALUES (?,?,?) ON CONFLICT(player_id, user_id) DO UPDATE SET verdict = excluded.verdict, updated_at = datetime('now')",
    p.id, user.id, verdict);
  db.run("UPDATE players SET updated_at = datetime('now') WHERE id = ?", p.id);
  logActivity(db, user.id, p.id, "set_verdict", { verdict: verdict ?? null });
  return c.json({ ok: true });
});

app.post("/api/players/:id/notes", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const { body, context } = await c.req.json();
  if (!String(body || "").trim()) fail(400, "Note is empty");
  const r = db.run("INSERT INTO notes(player_id, user_id, context, body) VALUES (?,?,?,?)", p.id, user.id, String(context || "").trim() || null, String(body).trim());
  db.run("UPDATE players SET updated_at = datetime('now') WHERE id = ?", p.id);
  logActivity(db, user.id, p.id, "added_note", { note_id: Number(r.lastInsertRowid) });
  return c.json({ ok: true, id: Number(r.lastInsertRowid) }, 201);
});

function ownNote(c) {
  const note = db.get("SELECT * FROM notes WHERE id = ?", Number(c.req.param("id"))) || fail(404, "Note not found");
  if (note.user_id !== c.get("user").id) fail(403, "You can only change your own notes");
  return note;
}
app.patch("/api/notes/:id", async (c) => {
  const note = ownNote(c);
  const { body, context } = await c.req.json();
  if (!String(body || "").trim()) fail(400, "Note is empty");
  db.run("UPDATE notes SET body = ?, context = ?, updated_at = datetime('now') WHERE id = ?", String(body).trim(), String(context || "").trim() || null, note.id);
  logActivity(db, note.user_id, note.player_id, "edited_note", { note_id: note.id });
  return c.json({ ok: true });
});
app.delete("/api/notes/:id", (c) => {
  const note = ownNote(c);
  db.run("DELETE FROM notes WHERE id = ?", note.id);
  logActivity(db, note.user_id, note.player_id, "deleted_note", { note_id: note.id });
  return c.json({ ok: true });
});

/* ---------- board ---------- */
app.post("/api/board/move", async (c) => {
  const user = c.get("user");
  const { player_id, from_role, to_role, index } = await c.req.json();
  const p = getPlayer(player_id);
  const fromSpot = from_role ? spotIn(p.id, from_role) : null;
  const spot = moveOnBoard(p.id, from_role || null, to_role, index);
  if (from_role && from_role !== to_role) compactRanks(from_role);
  // Dropping a card back where it was changes nothing, so it isn't logged.
  if (from_role !== to_role || fromSpot !== spot) {
    logActivity(db, user.id, p.id, "moved_on_board", { from: from_role || null, to: to_role, spot, from_spot: fromSpot });
  }
  return c.json({ ok: true });
});
app.post("/api/players/:id/roles", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const { role } = await c.req.json();
  addRole(p.id, role);
  logActivity(db, user.id, p.id, "added_role", { role });
  return c.json({ player: getPlayer(p.id) });
});
app.delete("/api/players/:id/roles/:role", (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const role = c.req.param("role");
  db.run("DELETE FROM board_entries WHERE player_id = ? AND role = ?", p.id, role);
  compactRanks(role);
  logActivity(db, user.id, p.id, "removed_role", { role });
  return c.json({ player: getPlayer(p.id) });
});

/* ---------- physical data ---------- */
app.get("/api/players/:id/physical", async (c) => {
  const p = getPlayer(c.req.param("id"));
  const phys = await loadPhysical(PHYS_CACHE);
  const linked = rowsByKeys(phys, p.phys_keys);
  const candidates = matchPhysical(phys, p).filter((m) => !p.phys_keys.includes(m.key)).slice(0, 8);
  return c.json({ meta: physMeta(phys), linked, candidates, confirmed: !!p.phys_confirmed });
});
app.put("/api/players/:id/physical", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const { keys } = await c.req.json();
  const phys = await loadPhysical(PHYS_CACHE);
  const valid = rowsByKeys(phys, Array.isArray(keys) ? keys : []).map((r) => r.key);
  updatePlayer(p.id, { phys_keys: valid, phys_confirmed: 1 });
  logActivity(db, user.id, p.id, "linked_physical", { rows: valid.length });
  return c.json({ ok: true, keys: valid });
});
app.get("/api/physical/search", async (c) => c.json({ rows: searchPhysical(await loadPhysical(PHYS_CACHE), c.req.query("q") || "") }));

/* ---------- impect ---------- */
app.get("/api/impect/iterations", async (c) => c.json({ iterations: await impectIterations() }));
app.get("/api/impect/search", async (c) => {
  const rows = await searchImpect(c.req.query("q") || "", { iterationId: c.req.query("iteration"), limit: Number(c.req.query("limit")) || 60 });
  const inPine = new Map(db.all("SELECT id, impect_id FROM players WHERE impect_id IS NOT NULL").map((r) => [r.impect_id, r.id]));
  return c.json({ players: rows.map((r) => ({ ...r, pine_id: inPine.get(r.impect_id) || null })) });
});
app.put("/api/players/:id/impect", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  const { impect_id } = await c.req.json();
  if (impect_id == null) {
    updatePlayer(p.id, { impect_id: null, impect_squad: null, impect_competition: null });
  } else {
    const ip = (await getImpectPlayer(impect_id)) || fail(404, "Impect player not found");
    const dup = db.get("SELECT id, name FROM players WHERE impect_id = ? AND id <> ?", ip.impect_id, p.id);
    if (dup) fail(409, `That Impect player is already linked to ${dup.name}`, { player_id: dup.id });
    updatePlayer(p.id, { impect_id: ip.impect_id, impect_squad: ip.squad, impect_competition: ip.competition });
  }
  logActivity(db, user.id, p.id, "linked_impect", { impect_id: impect_id ?? null });
  return c.json({ player: getPlayer(p.id) });
});
/* ---------- backups ---------- */
app.get("/api/backups", (c) => c.json({ snapshots: listSnapshots(BACKUP_DIR), dir: BACKUP_DIR }));
app.get("/api/backup", (c) => {
  const buf = snapshotBuffer(db, BACKUP_DIR);
  const user = c.get("user");
  logActivity(db, user?.id, null, "downloaded_backup", { bytes: buf.length, ...(user ? {} : { via: "backup script" }) });
  return new Response(buf, {
    headers: {
      "Content-Type": "application/x-sqlite3",
      "Content-Disposition": `attachment; filename="pine-${new Date().toISOString().slice(0, 10)}.sqlite"`,
      "Content-Length": String(buf.length),
    },
  });
});

/* ---------- bulk transfermarkt matching ---------- */
const unlinkedPlayers = () =>
  db.all("SELECT id, name, birthdate, club, citizenship FROM players WHERE tm_id IS NULL ORDER BY name COLLATE NOCASE")
    .map((p) => ({ ...p, citizenship: JSON.parse(p.citizenship || "[]"), age: ageFrom(p.birthdate) }));

app.get("/api/tm/match-all", (c) => c.json({ ...matchState(), unlinked: unlinkedPlayers().length }));
app.post("/api/tm/match-all", async (c) => {
  const user = c.get("user");
  const { limit = null } = await c.req.json().catch(() => ({}));
  const state = await runBulkMatch({
    players: unlinkedPlayers(),
    teamOverlap,
    isTaken: (tmId, playerId) => Boolean(db.get("SELECT id FROM players WHERE tm_id = ? AND id <> ?", String(tmId), playerId)),
    onLink: (player, profile) => applyTmProfile(player.id, profile, user.id, "bulk match"),
    limit: limit ? Number(limit) : null,
  });
  logActivity(db, user.id, null, "started_tm_match", { players: state.total });
  return c.json({ ...state, unlinked: unlinkedPlayers().length });
});

app.get("/api/impect/shortlists", async (c) => {
  const lists = await impectShortLists();
  const inPine = new Set(db.all("SELECT impect_id FROM players WHERE impect_id IS NOT NULL").map((r) => r.impect_id));
  const imported = new Set(db.all("SELECT external_id FROM lists WHERE source = 'impect'").map((r) => r.external_id));
  return c.json({
    lists: lists.map((l) => ({
      id: l.id, name: l.name, emoji: l.emoji, count: l.player_ids.length,
      in_pine: l.player_ids.filter((id) => inPine.has(id)).length,
      suggested_role: suggestListRole(l.name), imported: imported.has(l.id),
    })),
    split_roles: Object.fromEntries(Object.entries(SPLIT_ROLES).map(([k, v]) => [k, v.label])),
  });
});

// Adds every list player to PINE (skipping ones already there), records list membership, and places
// players on the board only the first time they join the list, so later manual board moves stick.
app.post("/api/impect/shortlists/:id/import", async (c) => {
  const user = c.get("user");
  const { role = null } = await c.req.json().catch(() => ({}));
  if (role && !ROLES[role] && !SPLIT_ROLES[role]) fail(400, `Unknown role ${role}`);
  const sl = (await impectShortLists()).find((l) => l.id === c.req.param("id")) || fail(404, "Short list not found in Impect");
  let meta = new Map();
  try { meta = await shortListPlayerMeta(sl.player_ids); } catch (e) { console.warn("short list meta failed:", e.message); }
  let listId = db.get("SELECT id FROM lists WHERE source = 'impect' AND external_id = ?", sl.id)?.id;
  if (listId) db.run("UPDATE lists SET name = ? WHERE id = ?", sl.name, listId);
  else listId = Number(db.run("INSERT INTO lists(name, source, external_id) VALUES (?,?,?)", sl.name, "impect", sl.id).lastInsertRowid);

  const out = { name: sl.name, created: 0, existing: 0, missing: 0, placed: 0 };
  const fresh = [];
  for (const impectId of sl.player_ids) {
    let row = db.get("SELECT id, foot FROM players WHERE impect_id = ?", impectId);
    if (row) out.existing++;
    else {
      const ip = await getImpectPlayer(impectId);
      if (!ip) { out.missing++; continue; }
      const pos = meta.get(impectId)?.position;
      const id = insertPlayer({
        ...pick(ip, ["name", "birthdate", "birthplace", "height_cm", "foot", "citizenship", "impect_id"]),
        position: pos ? IMPECT_POSITION_LABEL[pos] || null : null,
        club: ip.squad, league: ip.competition, impect_squad: ip.squad, impect_competition: ip.competition,
      }, user.id, "impect");
      row = { id, foot: ip.foot };
      fresh.push(id);
      out.created++;
      logActivity(db, user.id, id, "added_player", { name: ip.name, source: "impect", list: sl.name });
    }
    const joined = Number(db.run("INSERT OR IGNORE INTO list_members(list_id, player_id) VALUES (?,?)", listId, row.id).changes) > 0;
    const target = joined ? resolveRole(role, row.foot) : null;
    if (target && !db.get("SELECT 1 FROM board_entries WHERE player_id = ? AND role = ?", row.id, target)) {
      addRole(row.id, target);
      out.placed++;
    }
  }
  logActivity(db, user.id, null, "imported_list", out);
  for (const id of fresh) await autoLink(id);
  return c.json(out);
});

// Pooled and league KPI percentiles with a fixed qualification floor.
app.get("/api/players/:id/impect-kpis", async (c) => {
  const p = getPlayer(c.req.param("id"));
  if (!p.impect_id) fail(400, "Link this player to Impect first");
  return c.json(await playerKpiCard(p.impect_id, {
    iterationId: c.req.query("iteration") || null,
    position: c.req.query("position") || null,
    minShare: c.req.query("min_share") ? Number(c.req.query("min_share")) : undefined,
  }));
});

app.get("/api/players/:id/impect-candidates", async (c) => {
  const p = getPlayer(c.req.param("id"));
  return c.json(await matchImpect(p));
});

/* ---------- player cards (PDFs and their PNGs, rendered by the card worker) ---------- */
async function cardOptionsFor(p) {
  if (!impectConfigured()) fail(503, "Impect isn't configured on the server, so card seasons can't be looked up");
  try { return await playerCardOptions(p.impect_id); } catch (e) {
    console.warn("card options failed:", e.message);
    fail(502, `Couldn't load card seasons from Impect: ${e.message}`);
  }
}
// Everything but the stored file paths.
const CARD_SELECT = `SELECT c.id, c.iteration_id, c.competition, c.season, c.position, c.status, c.error,
    c.requested_at, c.started_at, c.generated_at, c.bytes, c.hop_commit, c.data_as_of, c.image IS NOT NULL AS has_image,
    c.progress, c.progress_matches,
    u.name AS requested_by_name
  FROM cards c LEFT JOIN users u ON u.id = c.requested_by`;

app.get("/api/players/:id/card-options", async (c) => {
  const p = getPlayer(c.req.param("id"));
  if (!p.impect_id) return c.json({ seasons: [], default: null, reason: "Link this player to Impect first." });
  return c.json(await cardOptionsFor(p));
});
app.get("/api/players/:id/cards", (c) => {
  const p = getPlayer(c.req.param("id"));
  return c.json({ cards: db.all(`${CARD_SELECT} WHERE c.player_id = ? ORDER BY c.requested_at DESC, c.id DESC`, p.id) });
});
app.post("/api/players/:id/cards", async (c) => {
  const user = c.get("user");
  if (!user.is_admin) fail(403, "Only admins can generate player cards");
  const p = getPlayer(c.req.param("id"));
  if (!p.impect_id) fail(400, "Link this player to Impect first");
  const { iteration_id, position } = await c.req.json().catch(() => ({}));
  const season = (await cardOptionsFor(p)).seasons.find((s) => s.iteration_id === Number(iteration_id));
  if (!season?.positions.some((o) => o.code === position)) fail(400, "A card isn't offered for that season and position");
  // Checked after the Impect lookup and before the insert, with no await in between, so two clicks can't both pass.
  if (db.get("SELECT 1 FROM cards WHERE player_id = ? AND status IN ('queued','running')", p.id)) {
    fail(409, "A card for this player is already queued or being generated");
  }
  if (db.get("SELECT count(*) AS n FROM cards WHERE requested_at > datetime('now', '-1 day')").n >= DAILY_CARD_LIMIT) {
    fail(429, `${DAILY_CARD_LIMIT} cards were requested across PINE in the last 24 hours; try again later`);
  }
  const id = Number(db.run(
    "INSERT INTO cards(player_id, impect_id, iteration_id, competition, season, position, tm_id, requested_by) VALUES (?,?,?,?,?,?,?,?)",
    p.id, p.impect_id, season.iteration_id, season.competition, season.season, position, p.tm_id || null, user.id).lastInsertRowid);
  logActivity(db, user.id, p.id, "requested_card", { card_id: id, season: season.season, competition: season.competition, position });
  return c.json({ card: db.get(`${CARD_SELECT} WHERE c.id = ?`, id) }, 201);
});
function doneCard(c) {
  const card = db.get("SELECT c.*, p.name FROM cards c JOIN players p ON p.id = c.player_id WHERE c.id = ?", Number(c.req.param("id")));
  if (card?.status !== "done" || !card.file) fail(404, "Card not found");
  return card;
}
function sendCardFile(stored, type, headers = {}) {
  const file = join(CARDS_DIR, stored);
  if (!existsSync(file)) fail(404, "This card's file is missing from the server");
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: { "Content-Type": type, "Content-Length": String(statSync(file).size), ...headers },
  });
}
app.get("/api/cards/:id/pdf", (c) => {
  const card = doneCard(c);
  const name = `${card.name} ${card.season} ${card.position} ${card.generated_at.slice(0, 10)}.pdf`;
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "");
  return sendCardFile(card.file, "application/pdf", {
    "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
});
// A finished card's picture never changes, so the browser can keep it.
app.get("/api/cards/:id/png", (c) => {
  const card = doneCard(c);
  if (!card.image) fail(404, "This card has no picture");
  return sendCardFile(card.image, "image/png", { "Cache-Control": "private, max-age=604800, immutable" });
});

// Card worker API (X-PINE-Worker-Token, checked in the /api gate above).
function runningCard(c) {
  const card = db.get("SELECT id, player_id, iteration_id, position, status FROM cards WHERE id = ?", Number(c.req.param("id"))) || fail(404, "Card not found");
  if (card.status !== "running") fail(409, `Card ${card.id} is ${card.status}, not running`);
  return card;
}
app.post("/api/worker/cards/claim", (c) => {
  const job = claimCard(db);
  return job ? c.json(job) : c.body(null, 204);
});
const cardBodyLimit = bodyLimit({ maxSize: MAX_CARD_BYTES, onError: (c) => c.json({ error: "Card file is over 10 MB" }, 413) });
// The PNG comes first and is optional; the PDF finishes the job.
app.put("/api/worker/cards/:id/png", cardBodyLimit, async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer());
  const card = runningCard(c);
  if (!isPng(buf)) fail(400, "That isn't a PNG");
  db.run("UPDATE cards SET image = ? WHERE id = ?", saveCardFile(CARDS_DIR, card, buf, new Date(), "png"), card.id);
  return c.json({ ok: true });
});
app.put("/api/worker/cards/:id/pdf", cardBodyLimit,
  async (c) => {
    const buf = Buffer.from(await c.req.arrayBuffer());
    const card = runningCard(c);
    if (!isPdf(buf)) fail(400, "That isn't a PDF");
    const commit = c.req.header("X-PINE-Card-Commit") || "";
    const asOf = c.req.header("X-PINE-Card-Data-As-Of") || "";
    const now = new Date();
    db.run(
      "UPDATE cards SET status = 'done', error = NULL, generated_at = ?, file = ?, bytes = ?, hop_commit = ?, data_as_of = ? WHERE id = ?",
      sqlTime(now), saveCardFile(CARDS_DIR, card, buf, now), buf.length,
      /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null, /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null, card.id);
    return c.json({ ok: true });
  });
// A note on why a running card is slower (a fixed code and a count), shown under "Generating".
app.post("/api/worker/cards/:id/progress", async (c) => {
  const { code, matches } = await c.req.json().catch(() => ({}));
  const card = runningCard(c);
  const note = cardProgress(code, matches) || fail(400, "Unknown progress code");
  db.run("UPDATE cards SET progress = ?, progress_matches = ? WHERE id = ?", note.code, note.matches, card.id);
  return c.json({ ok: true });
});
app.post("/api/worker/cards/:id/fail", async (c) => {
  const { code } = await c.req.json().catch(() => ({}));
  const card = runningCard(c);
  db.run("UPDATE cards SET status = 'failed', error = ? WHERE id = ?", cardErrorCode(code), card.id);
  return c.json({ ok: true });
});

/* ---------- pitch maps (built by the card worker from Impect events; drawn and filtered in the browser) ---------- */
const MAP_SELECT = `SELECT m.id, m.player_id, m.iteration_id, m.competition, m.season, m.position, m.status, m.error,
    m.requested_at, m.started_at, m.generated_at, m.data_as_of, m.catalog, m.progress, m.progress_matches,
    u.name AS requested_by_name
  FROM maps m LEFT JOIN users u ON u.id = m.requested_by`;
// The newest metric catalog any build has used: a build made with an older one lacks newer metrics.
const mapsMeta = () => ({
  latest_catalog: db.get("SELECT catalog FROM maps WHERE status = 'done' AND catalog IS NOT NULL ORDER BY generated_at DESC, id DESC LIMIT 1")?.catalog || null,
  worker_seen_at: workerSeen.any ? sqlTime(workerSeen.any) : null,
  maps_worker_seen_at: workerSeen.maps ? sqlTime(workerSeen.maps) : null,
});
const OPEN_MAP = "status IN ('queued','running')";

app.get("/api/players/:id/maps", (c) => {
  const p = getPlayer(c.req.param("id"));
  const maps = p.impect_id
    ? db.all(`${MAP_SELECT} WHERE m.player_id = ? AND m.impect_id = ? ORDER BY m.requested_at DESC, m.id DESC`, p.id, p.impect_id)
    : [];
  return c.json({ maps, ...mapsMeta() });
});
// The latest builds across PINE, for opening one without searching.
app.get("/api/maps/recent", (c) => c.json({
  maps: db.all(`SELECT m.id, m.player_id, p.name, p.club, p.photo_url, m.iteration_id, m.competition, m.season, m.position,
      m.generated_at, m.data_as_of
    FROM maps m JOIN players p ON p.id = m.player_id AND p.impect_id = m.impect_id
    WHERE m.status = 'done' ORDER BY m.generated_at DESC, m.id DESC LIMIT 12`),
}));
// Anyone signed in can build maps. Asking again for a view already waiting returns that job.
app.post("/api/players/:id/maps", async (c) => {
  const user = c.get("user");
  const p = getPlayer(c.req.param("id"));
  if (!p.impect_id) fail(400, "Link this player to Impect first");
  const { iteration_id, position } = await c.req.json().catch(() => ({}));
  const season = (await cardOptionsFor(p)).seasons.find((s) => s.iteration_id === Number(iteration_id));
  if (!season?.positions.some((o) => o.code === position)) fail(400, "Maps aren't offered for that season and position");
  // Checked after the Impect lookup and before the insert, with no await in between, so two clicks can't both pass.
  const open = db.get(`${MAP_SELECT} WHERE m.player_id = ? AND m.impect_id = ? AND m.iteration_id = ? AND m.position = ? AND m.${OPEN_MAP}`,
    p.id, p.impect_id, season.iteration_id, position);
  if (open) return c.json({ map: open, ...mapsMeta() });
  if (db.get(`SELECT count(*) AS n FROM maps WHERE requested_by = ? AND ${OPEN_MAP}`, user.id).n >= OPEN_MAPS_PER_USER) {
    fail(429, `You have ${OPEN_MAPS_PER_USER} maps waiting to build already; ask again once one is done`);
  }
  if (db.get("SELECT count(*) AS n FROM maps WHERE requested_at > datetime('now', '-1 day')").n >= DAILY_MAPS_LIMIT) {
    fail(429, `${DAILY_MAPS_LIMIT} maps were requested across PINE in the last 24 hours; try again later`);
  }
  const id = Number(db.run(
    "INSERT INTO maps(player_id, impect_id, iteration_id, competition, season, position, requested_by) VALUES (?,?,?,?,?,?,?)",
    p.id, p.impect_id, season.iteration_id, season.competition, season.season, position, user.id).lastInsertRowid);
  return c.json({ map: db.get(`${MAP_SELECT} WHERE m.id = ?`, id), ...mapsMeta() }, 201);
});
// A build's file never changes (a rebuild is a new id), so the browser keeps it.
app.get("/api/maps/:id/json", (c) => {
  const map = db.get("SELECT status, file FROM maps WHERE id = ?", Number(c.req.param("id")));
  if (map?.status !== "done" || !map.file) fail(404, "These maps aren't available; they may have been rebuilt");
  const file = join(MAPS_DIR, map.file);
  if (!existsSync(file)) fail(404, "These maps' file is missing from the server; build them again");
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: {
      "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip",
      "Content-Length": String(statSync(file).size), "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});

// Map worker API (X-PINE-Worker-Token, checked in the /api gate above).
function runningMap(c) {
  const map = db.get("SELECT id, player_id, impect_id, iteration_id, position, status FROM maps WHERE id = ?", Number(c.req.param("id")))
    || fail(404, "Maps job not found");
  if (map.status !== "running") fail(409, `Maps job ${map.id} is ${map.status}, not running`);
  return map;
}
app.post("/api/worker/maps/claim", (c) => {
  const job = claimMap(db);
  return job ? c.json(job) : c.body(null, 204);
});
const mapsBodyLimit = bodyLimit({ maxSize: MAX_MAPS_BYTES, onError: (c) => c.json({ error: "The maps export is over 5 MB" }, 413) });
// The export finishes the job and replaces the view's earlier builds and failures.
app.put("/api/worker/maps/:id/json", mapsBodyLimit, async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer());
  const map = runningMap(c);
  let data;
  try { data = normalizeMaps(JSON.parse(buf.toString("utf8")), map); } catch (e) {
    if (e instanceof SyntaxError) fail(400, "That isn't JSON");
    if (e instanceof MapsError) fail(400, e.message);
    throw e;
  }
  const commit = c.req.header("X-PINE-Maps-Commit") || "";
  const now = new Date();
  const saved = saveMapsFile(MAPS_DIR, map, data, now);
  const view = "player_id = ? AND iteration_id = ? AND position = ? AND id <> ? AND status IN ('done','failed')";
  const replaced = db.tx(() => {
    const old = db.all(`SELECT file FROM maps WHERE ${view} AND file IS NOT NULL`, map.player_id, map.iteration_id, map.position, map.id);
    db.run(`DELETE FROM maps WHERE ${view}`, map.player_id, map.iteration_id, map.position, map.id);
    db.run(
      "UPDATE maps SET status = 'done', error = NULL, generated_at = ?, file = ?, bytes = ?, hop_commit = ?, catalog = ?, data_as_of = ? WHERE id = ?",
      sqlTime(now), saved.file, saved.bytes, /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null, data.catalog, data.sample.last_match, map.id);
    return old.map((r) => r.file);
  });
  removeMapsFiles(MAPS_DIR, replaced);
  return c.json({ ok: true });
});
app.post("/api/worker/maps/:id/progress", async (c) => {
  const { code, matches } = await c.req.json().catch(() => ({}));
  const map = runningMap(c);
  const note = mapProgress(code, matches) || fail(400, "Unknown progress code");
  db.run("UPDATE maps SET progress = ?, progress_matches = ? WHERE id = ?", note.code, note.matches, map.id);
  return c.json({ ok: true });
});
// A failure keeps the view's last good build; only an earlier failure is replaced.
app.post("/api/worker/maps/:id/fail", async (c) => {
  const { code } = await c.req.json().catch(() => ({}));
  const map = runningMap(c);
  db.tx(() => {
    db.run("DELETE FROM maps WHERE player_id = ? AND iteration_id = ? AND position = ? AND id <> ? AND status = 'failed'",
      map.player_id, map.iteration_id, map.position, map.id);
    db.run("UPDATE maps SET status = 'failed', error = ? WHERE id = ?", mapErrorCode(code), map.id);
  });
  return c.json({ ok: true });
});

/* ---------- staff + activity ---------- */
app.get("/api/users", (c) => {
  const user = c.get("user");
  const cols = user.is_admin
    ? `id, name, email, is_admin, password_hash IS NOT NULL AS has_password,
       (SELECT max(expires_at) FROM setup_links l WHERE l.user_id = users.id AND l.expires_at > ${Date.now()}) AS link_expires_at`
    : "id, name, is_admin";
  return c.json({ users: db.all(`SELECT ${cols} FROM users ORDER BY sort, id`) });
});
// A one-time link that lets this person choose a password (or reset a forgotten one). The admin emails it
// from their own account (the Staff page opens a pre-written Gmail draft); PINE sends no email itself.
app.post("/api/users/:id/setup-link", (c) => {
  const user = c.get("user");
  if (!user.is_admin) fail(403, "Only admins can create sign-in links");
  const target = db.get("SELECT id, name, email FROM users WHERE id = ?", Number(c.req.param("id"))) || fail(404, "User not found");
  if (!target.email) fail(400, `Add an email for ${target.name} first; they sign in with it`);
  const { token, expires_at } = createSetupLink(db, target.id);
  const origin = siteOrigin(c);
  logActivity(db, user.id, null, "created_signin_link", { name: target.name });
  return c.json({ url: `${origin}/#/welcome/${token}`, expires_at, name: target.name, email: target.email, site: origin });
});
app.patch("/api/users/:id", async (c) => {
  const user = c.get("user");
  if (!user.is_admin) fail(403, "Only admins can manage staff");
  const target = db.get("SELECT * FROM users WHERE id = ?", Number(c.req.param("id"))) || fail(404, "User not found");
  const { email, is_admin } = await c.req.json();
  const e = email === undefined ? target.email : String(email || "").trim() || null;
  if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail(400, "That email doesn't look right");
  if (target.id === user.id && is_admin === false) fail(400, "You can't remove your own admin access");
  try {
    db.run("UPDATE users SET email = ?, is_admin = ? WHERE id = ?", e, is_admin === undefined ? target.is_admin : is_admin ? 1 : 0, target.id);
  } catch { fail(409, "Another staff member already uses that email"); }
  logActivity(db, user.id, null, "edited_staff", { name: target.name });
  return c.json({ ok: true });
});
app.post("/api/users", async (c) => {
  const user = c.get("user");
  if (!user.is_admin) fail(403, "Only admins can manage staff");
  const { name, email } = await c.req.json();
  if (!String(name || "").trim()) fail(400, "Name is required");
  const sort = db.get("SELECT coalesce(max(sort), 0) + 1 AS s FROM users").s;
  try {
    db.run("INSERT INTO users(name, email, sort) VALUES (?,?,?)", String(name).trim(), String(email || "").trim() || null, sort);
  } catch { fail(409, "That name or email is already on the staff list"); }
  logActivity(db, user.id, null, "added_staff", { name });
  return c.json({ ok: true }, 201);
});
app.get("/api/activity", (c) =>
  c.json({
    activity: db.all(
      `SELECT a.id, a.action, a.detail, a.created_at, u.name AS user, a.player_id, p.name AS player
       FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN players p ON p.id = a.player_id
       WHERE a.action <> 'signed_in' ORDER BY a.id DESC LIMIT ?`, Math.min(Number(c.req.query("limit")) || 60, 300)),
  })
);

/* ---------- static app ---------- */
// The page is never cached and points at versioned asset URLs, so a deploy can't leave a browser
// holding new JS with old CSS. Versioned assets are then cached hard.
const PUBLIC_DIR = join(ROOT, "public");
const ASSET_VERSION = createHash("sha1")
  .update(readFileSync(join(PUBLIC_DIR, "app.js")))
  .update(readFileSync(join(PUBLIC_DIR, "styles.css")))
  .digest("hex")
  .slice(0, 8);
const INDEX_HTML = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8")
  .replace('href="/styles.css"', `href="/styles.css?v=${ASSET_VERSION}"`)
  .replace('src="/app.js"', `src="/app.js?v=${ASSET_VERSION}"`);

app.use("/*", async (c, next) => {
  await next();
  if (!c.res) return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", c.req.query("v") === undefined ? "no-cache" : "public, max-age=31536000, immutable");
  c.res = new Response(c.res.body, { status: c.res.status, headers });
});
const page = (c, preview) => c.html(INDEX_HTML.replace("<!--og-->", ogTags(preview)));

app.get("/", (c) => page(c, sitePreview(siteOrigin(c))));
app.get("/index.html", (c) => page(c, sitePreview(siteOrigin(c))));
// The shareable form of a player link. The id is in the path, so this can answer a crawler with
// that player's preview tags; the app reads the same path and opens the profile. An unknown id
// still serves the app, which shows its own "Player not found". See src/lib/share.js.
app.get("/p/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = Number.isInteger(id) && id > 0
    ? db.get("SELECT id, name, birthdate, position, club, league, photo_url FROM players WHERE id = ?", id)
    : null;
  const origin = siteOrigin(c);
  return page(c, row ? playerPreview({ ...row, age: ageFrom(row.birthdate) }, origin) : sitePreview(origin));
});
app.use("/*", serveStatic({ root: relative(process.cwd(), PUBLIC_DIR) || "." }));

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port }, () => console.log(`PINE running on http://localhost:${port}`));
