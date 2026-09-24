import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

// Sign-in is email + password. Nobody picks a password cold: an admin copies a one-time setup link
// from the Staff page and sends it to the person, who opens it and chooses their password.
// The same link resets a forgotten password.

const COOKIE = "pine_session";
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD = 8;
const MAX_FAILURES = 8; // wrong passwords per email per window, then locked until the window ends
const WINDOW_MS = 15 * 60 * 1000;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(String(password), salt, 64).toString("base64")}`;
}

function passwordMatches(stored, password) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  return timingSafeEqual(want, scryptSync(String(password), Buffer.from(salt, "base64"), want.length));
}
// Compared against when the email is unknown, so a miss costs the same time as a wrong password.
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

/* ---------- setup links ---------- */
export function createSetupLink(db, userId) {
  const token = randomBytes(24).toString("base64url");
  db.run("DELETE FROM setup_links WHERE user_id = ? OR expires_at < ?", userId, Date.now());
  db.run("INSERT INTO setup_links(token_hash, user_id, expires_at) VALUES (?,?,?)", sha(token), userId, Date.now() + LINK_TTL_MS);
  return { token, expires_at: Date.now() + LINK_TTL_MS };
}

export function setupLinkUser(db, token) {
  return db.get(
    "SELECT u.id, u.name, u.email, u.is_admin FROM setup_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ? AND l.expires_at > ?",
    sha(token), Date.now()
  ) || null;
}

// Returns { user } or { error }. The link works once.
export function useSetupLink(db, token, password) {
  if (String(password || "").length < MIN_PASSWORD) return { error: `Choose a password of at least ${MIN_PASSWORD} characters.` };
  const user = setupLinkUser(db, token);
  if (!user) return { error: "This link has expired or was already used. Ask an admin for a new one." };
  db.tx(() => {
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), user.id);
    db.run("DELETE FROM setup_links WHERE user_id = ?", user.id);
  });
  return { user };
}

/* ---------- password sign-in ---------- */
const failures = new Map(); // lower-cased email -> { n, resetAt }

// Returns { user } or { error }.
export function checkPassword(db, email, password) {
  const key = String(email || "").trim().toLowerCase();
  const now = Date.now();
  const f = failures.get(key);
  if (f && f.resetAt > now && f.n >= MAX_FAILURES) return { error: "Too many wrong attempts. Try again in 15 minutes." };
  const row = key ? db.get("SELECT id, name, email, is_admin, password_hash FROM users WHERE email = ?", key) : null;
  if (passwordMatches(row?.password_hash || DUMMY_HASH, password) && row?.password_hash) {
    failures.delete(key);
    const { password_hash, ...user } = row;
    return { user };
  }
  const rec = f && f.resetAt > now ? f : { n: 0, resetAt: now + WINDOW_MS };
  rec.n += 1;
  failures.set(key, rec);
  return { error: "Wrong email or password. If you haven't set a password yet, ask an admin for your sign-in link." };
}

/* ---------- sessions ---------- */
export function startSession(db, c, user) {
  const token = randomBytes(32).toString("base64url");
  db.run("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?,?,?)", sha(token), user.id, Date.now() + SESSION_TTL_MS);
  db.run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: String(process.env.APP_URL || "").startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function logout(db, c) {
  const token = getCookie(c, COOKIE);
  if (token) db.run("DELETE FROM sessions WHERE token_hash = ?", sha(token));
  deleteCookie(c, COOKIE, { path: "/" });
}

// Machine keys (PINE_BACKUP_TOKEN, PINE_WORKER_TOKEN): an unset key opens nothing. Hashing first
// makes the comparison constant-time whatever the lengths.
export function tokenMatches(got, want) {
  if (!want || !got) return false;
  const digest = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(digest(got), digest(want));
}

export function currentUser(db, c) {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  return (
    db.get(
      "SELECT u.id, u.name, u.email, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
      sha(token),
      Date.now()
    ) || null
  );
}
