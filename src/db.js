import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE COLLATE NOCASE,
  clerk_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS players(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  birthdate TEXT, birthplace TEXT, height_cm INTEGER, foot TEXT,
  citizenship TEXT NOT NULL DEFAULT '[]',
  position TEXT, other_positions TEXT NOT NULL DEFAULT '[]',
  club TEXT, club_tm_id TEXT, club_logo_url TEXT, league TEXT, league_code TEXT,
  joined TEXT, contract_expires TEXT, loan_from TEXT, loan_contract_expires TEXT, agent TEXT,
  market_value_eur INTEGER, market_value_display TEXT, national_team TEXT,
  photo_url TEXT, shirt_number INTEGER,
  tm_id TEXT UNIQUE, tm_url TEXT, tm_synced_at TEXT,
  impect_id INTEGER UNIQUE, impect_squad TEXT, impect_competition TEXT,
  phys_keys TEXT NOT NULL DEFAULT '[]',
  phys_confirmed INTEGER NOT NULL DEFAULT 0,
  decision TEXT CHECK (decision IN ('pass','hold','fail')),
  decision_by INTEGER REFERENCES users(id), decision_at TEXT,
  summary TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS board_entries(
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY(player_id, role)
);
CREATE INDEX IF NOT EXISTS board_role ON board_entries(role, rank);
CREATE TABLE IF NOT EXISTS verdicts(
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','hold','fail')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(player_id, user_id)
);
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  context TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notes_player ON notes(player_id, created_at);
CREATE TABLE IF NOT EXISTS lists(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_id)
);
CREATE TABLE IF NOT EXISTS list_members(
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY(list_id, player_id)
);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function migrate(raw) {
  const userCols = new Set(raw.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
  if (!userCols.has("clerk_user_id")) raw.exec("ALTER TABLE users ADD COLUMN clerk_user_id TEXT");
  if (!userCols.has("status")) raw.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))");
  raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_clerk_user_id ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL");
}

// Thin wrapper so call sites don't depend on the driver (eases a later move to D1/Postgres).
export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  raw.exec(SCHEMA);
  migrate(raw);
  const db = {
    raw,
    all: (sql, ...p) => raw.prepare(sql).all(...p),
    get: (sql, ...p) => raw.prepare(sql).get(...p),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
    tx(fn) {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db;
}

export function logActivity(db, userId, playerId, action, detail) {
  db.run(
    "INSERT INTO activity(user_id, player_id, action, detail) VALUES (?,?,?,?)",
    userId ?? null,
    playerId ?? null,
    action,
    detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail)
  );
}
