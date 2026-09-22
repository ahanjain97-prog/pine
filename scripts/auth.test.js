import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { checkPassword, createSetupLink, setupLinkUser, useSetupLink } from '../src/auth.js';

// Lockout counts live in the module, so each test uses its own email.
function staffDb(email = 'ford@example.com') {
  const db = openDb(':memory:');
  db.run("UPDATE users SET email = ? WHERE name = 'Ford'", email);
  return { db, ford: db.get("SELECT id FROM users WHERE name = 'Ford'").id };
}

test('a setup link sets a password once, then email + password signs in', () => {
  const { db, ford } = staffDb();
  assert.match(checkPassword(db, 'ford@example.com', 'anything').error, /sign-in link/);

  const { token } = createSetupLink(db, ford);
  assert.equal(setupLinkUser(db, token).name, 'Ford');
  assert.match(useSetupLink(db, token, 'short').error, /at least 8/);
  assert.equal(useSetupLink(db, token, 'pine-board-26').user.name, 'Ford');
  assert.match(useSetupLink(db, token, 'another-one').error, /expired or was already used/);

  const ok = checkPassword(db, 'FORD@example.com ', 'pine-board-26');
  assert.equal(ok.user.name, 'Ford');
  assert.equal(ok.user.password_hash, undefined);
  assert.ok(checkPassword(db, 'ford@example.com', 'wrong-password').error);
  assert.ok(checkPassword(db, 'nobody@example.com', 'pine-board-26').error);
  assert.match(db.get('SELECT password_hash FROM users WHERE id = ?', ford).password_hash, /^scrypt\$/);
});

test('a new link replaces the old one; expired links are refused', () => {
  const { db, ford } = staffDb();
  const first = createSetupLink(db, ford).token;
  const second = createSetupLink(db, ford).token;
  assert.equal(setupLinkUser(db, first), null);
  assert.equal(setupLinkUser(db, second).name, 'Ford');
  db.run('UPDATE setup_links SET expires_at = ?', Date.now() - 1);
  assert.equal(setupLinkUser(db, second), null);
});

test('repeated wrong passwords lock that email for a while', () => {
  const { db, ford } = staffDb('ford.lock@example.com');
  useSetupLink(db, createSetupLink(db, ford).token, 'pine-board-26');
  for (let i = 0; i < 8; i++) assert.match(checkPassword(db, 'ford.lock@example.com', 'nope-nope').error, /Wrong email/);
  assert.match(checkPassword(db, 'ford.lock@example.com', 'pine-board-26').error, /Too many/);
});
