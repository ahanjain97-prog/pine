import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const COOKIE = "pine_session";
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

async function sendCodeEmail(email, code) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    console.log(`\n[PINE] Sign-in code for ${email}: ${code}  (set RESEND_API_KEY + MAIL_FROM to email it)\n`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: email,
      subject: `PINE sign-in code: ${code}`,
      text: `Your PINE sign-in code is ${code}. It expires in 10 minutes.`,
    }),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status})`);
  return true;
}

export async function requestCode(db, email) {
  const user = db.get("SELECT id, email FROM users WHERE email = ?", String(email || "").trim());
  const delivery = process.env.RESEND_API_KEY && process.env.MAIL_FROM ? "email" : "console";
  // Same response whether or not the address is on the staff list.
  if (!user) return { ok: true, delivery };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.run(
    "INSERT INTO login_codes(email, code_hash, expires_at, attempts) VALUES (?,?,?,0) " +
      "ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0",
    user.email,
    sha(code),
    Date.now() + CODE_TTL_MS
  );
  const emailed = await sendCodeEmail(user.email, code);
  const devShow = !emailed && process.env.PINE_DEV_SHOW_CODE === "1";
  return { ok: true, delivery, ...(devShow ? { dev_code: code } : {}) };
}

export function verifyCode(db, c, email, code) {
  const row = db.get("SELECT * FROM login_codes WHERE email = ?", String(email || "").trim());
  if (!row || row.expires_at < Date.now() || row.attempts >= MAX_ATTEMPTS) return null;
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(sha(String(code || "").trim()));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    db.run("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?", row.email);
    return null;
  }
  db.run("DELETE FROM login_codes WHERE email = ?", row.email);
  const user = db.get("SELECT * FROM users WHERE email = ?", row.email);
  if (!user) return null;
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
  return user;
}

export function logout(db, c) {
  const token = getCookie(c, COOKIE);
  if (token) db.run("DELETE FROM sessions WHERE token_hash = ?", sha(token));
  deleteCookie(c, COOKIE, { path: "/" });
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
