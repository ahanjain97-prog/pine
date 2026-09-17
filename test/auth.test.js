import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { AuthError, resolveClerkUser } from "../src/auth.js";
import { openDb } from "../src/db.js";

function clerkUser({ id, email, firstName = "New", lastName = "Scout", invited = true }) {
  return {
    id,
    firstName,
    lastName,
    primaryEmailAddressId: "email_1",
    emailAddresses: [{ id: "email_1", emailAddress: email, verification: { status: "verified" } }],
    publicMetadata: invited ? { pineInvited: true } : {},
  };
}

test("an invited Clerk user is provisioned as local staff", () => {
  const db = openDb(":memory:");
  const user = resolveClerkUser(db, clerkUser({ id: "user_new", email: "Scout@Example.com" }));
  assert.equal(user.name, "New Scout");
  assert.equal(user.email, "scout@example.com");
  assert.equal(user.clerk_user_id, "user_new");
  assert.equal(user.is_admin, 0);
  assert.equal(user.status, "active");
});

test("first Clerk login attaches to a legacy user without changing ownership", () => {
  const db = openDb(":memory:");
  const legacyId = Number(db.run("INSERT INTO users(name, email) VALUES (?,?)", "Ford", "ford@example.com").lastInsertRowid);
  const playerId = Number(db.run("INSERT INTO players(name, created_by) VALUES (?,?)", "Example Player", legacyId).lastInsertRowid);
  db.run("INSERT INTO notes(player_id, user_id, body) VALUES (?,?,?)", playerId, legacyId, "Existing note");

  const user = resolveClerkUser(db, clerkUser({ id: "user_ford", email: "FORD@example.com", firstName: "Ford", lastName: "Smith" }));
  assert.equal(user.id, legacyId);
  assert.equal(user.clerk_user_id, "user_ford");
  assert.equal(db.get("SELECT user_id FROM notes WHERE body = 'Existing note'").user_id, legacyId);
  assert.equal(db.get("SELECT created_by FROM players WHERE id = ?", playerId).created_by, legacyId);
});

test("an uninvited, unknown Clerk user is rejected", () => {
  const db = openDb(":memory:");
  assert.throws(
    () => resolveClerkUser(db, clerkUser({ id: "user_unknown", email: "unknown@example.com", invited: false })),
    (e) => e instanceof AuthError && e.status === 403
  );
});

test("PINE_ADMIN_EMAIL bootstraps the first administrator", () => {
  const previous = process.env.PINE_ADMIN_EMAIL;
  process.env.PINE_ADMIN_EMAIL = "admin@example.com";
  try {
    const db = openDb(":memory:");
    const user = resolveClerkUser(db, clerkUser({ id: "user_admin", email: "ADMIN@example.com", invited: false }));
    assert.equal(user.is_admin, 1);
  } finally {
    if (previous === undefined) delete process.env.PINE_ADMIN_EMAIL;
    else process.env.PINE_ADMIN_EMAIL = previous;
  }
});

test("inactive staff cannot reconnect through Clerk", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO users(name, email, status) VALUES (?,?,?)", "Former Scout", "former@example.com", "inactive");
  assert.throws(
    () => resolveClerkUser(db, clerkUser({ id: "user_former", email: "former@example.com" })),
    (e) => e instanceof AuthError && e.status === 403
  );
});

test("opening an existing database adds Clerk identity columns in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "pine-auth-test-"));
  const file = join(dir, "pine.sqlite");
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, email TEXT UNIQUE COLLATE NOCASE, is_admin INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    old.prepare("INSERT INTO users(name, email, is_admin) VALUES (?,?,1)").run("Existing Admin", "admin@example.com");
    old.close();

    const db = openDb(file);
    const columns = new Set(db.all("PRAGMA table_info(users)").map((c) => c.name));
    assert(columns.has("clerk_user_id"));
    assert(columns.has("status"));
    assert.equal(db.get("SELECT name, status FROM users").name, "Existing Admin");
    assert.equal(db.get("SELECT name, status FROM users").status, "active");
    db.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
