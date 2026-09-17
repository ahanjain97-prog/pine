import { createClerkClient } from "@clerk/backend";

const USER_COLS = "id, name, email, clerk_user_id, status, is_admin";
let cachedClient = null;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function clerkConfigured() {
  return Boolean(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

export function clerkPublicConfig() {
  return {
    configured: clerkConfigured(),
    publishable_key: process.env.CLERK_PUBLISHABLE_KEY || null,
  };
}

function clerk() {
  if (!clerkConfigured()) throw new AuthError(503, "Clerk is not configured yet");
  if (!cachedClient) {
    cachedClient = createClerkClient({
      publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
      secretKey: process.env.CLERK_SECRET_KEY,
    });
  }
  return cachedClient;
}

function authorizedParties(request) {
  const configured = String(process.env.CLERK_AUTHORIZED_PARTIES || process.env.APP_URL || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (configured.length) return configured;
  return [new URL(request.url).origin];
}

function primaryVerifiedEmail(user) {
  const primary = user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId);
  if (!primary || primary.verification?.status !== "verified") return null;
  return String(primary.emailAddress || "").trim().toLowerCase() || null;
}

function preferredName(user, email) {
  const full = [user.firstName, user.lastName].map((s) => String(s || "").trim()).filter(Boolean).join(" ");
  return full || email.split("@")[0] || "Staff member";
}

export function uniqueUserName(db, requested, exceptId = null) {
  const base = String(requested || "").trim() || "Staff member";
  let name = base;
  let n = 2;
  while (db.get("SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id <> ?", name, exceptId ?? -1)) {
    name = `${base} (${n++})`;
  }
  return name;
}

// Connect a verified Clerk identity to the existing PINE user with the same email.
// Keeping the same local id preserves every historical note, verdict and activity row.
export function resolveClerkUser(db, clerkUser) {
  const email = primaryVerifiedEmail(clerkUser);
  if (!email) throw new AuthError(403, "Your Clerk account needs a verified email address");

  let user = db.get(`SELECT ${USER_COLS} FROM users WHERE clerk_user_id = ?`, clerkUser.id);
  if (user) {
    if (user.status !== "active") throw new AuthError(403, "Your PINE access has been deactivated");
    return user;
  }

  const invitedLocalId = Number(clerkUser.publicMetadata?.pineUserId) || null;
  user = invitedLocalId
    ? db.get(`SELECT ${USER_COLS} FROM users WHERE id = ? AND email = ?`, invitedLocalId, email)
    : null;
  user ||= db.get(`SELECT ${USER_COLS} FROM users WHERE email = ?`, email);
  const bootstrapAdmin = email === String(process.env.PINE_ADMIN_EMAIL || "").trim().toLowerCase();
  const invited = clerkUser.publicMetadata?.pineInvited === true;
  if (!user && !invited && !bootstrapAdmin) {
    throw new AuthError(403, "This account has not been invited to PINE");
  }
  if (user?.clerk_user_id && user.clerk_user_id !== clerkUser.id) {
    throw new AuthError(409, "That staff email is already connected to another account");
  }
  if (user?.status === "inactive") throw new AuthError(403, "Your PINE access has been deactivated");

  const name = uniqueUserName(db, preferredName(clerkUser, email), user?.id);
  if (user) {
    db.run(
      "UPDATE users SET name = ?, email = ?, clerk_user_id = ?, is_admin = CASE WHEN ? THEN 1 ELSE is_admin END WHERE id = ?",
      name, email, clerkUser.id, bootstrapAdmin ? 1 : 0, user.id
    );
  } else {
    const sort = db.get("SELECT coalesce(max(sort), -1) + 1 AS s FROM users").s;
    const r = db.run(
      "INSERT INTO users(name, email, clerk_user_id, status, is_admin, sort) VALUES (?,?,?,'active',?,?)",
      name, email, clerkUser.id, bootstrapAdmin ? 1 : 0, sort
    );
    user = { id: Number(r.lastInsertRowid) };
  }
  return db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, user.id);
}

export async function authenticateUser(db, request) {
  const state = await clerk().authenticateRequest(request, {
    authorizedParties: authorizedParties(request),
    acceptsToken: "session_token",
  });
  if (!state.isAuthenticated) return null;
  const { userId } = state.toAuth();
  if (!userId) return null;

  const local = db.get(`SELECT ${USER_COLS} FROM users WHERE clerk_user_id = ?`, userId);
  if (local) {
    if (local.status !== "active") throw new AuthError(403, "Your PINE access has been deactivated");
    return local;
  }
  return resolveClerkUser(db, await clerk().users.getUser(userId));
}

export async function createStaffInvitation(email, { ignoreExisting = false, localUserId = null } = {}) {
  return clerk().invitations.createInvitation({
    emailAddress: String(email || "").trim().toLowerCase(),
    ignoreExisting,
    publicMetadata: { pineInvited: true, ...(localUserId ? { pineUserId: Number(localUserId) } : {}) },
    notify: true,
  });
}

export async function listStaffInvitations() {
  const { data } = await clerk().invitations.getInvitationList({ limit: 100, orderBy: "-created_at" });
  return data
    .filter((i) => i.status === "pending" || i.status === "expired")
    .map((i) => ({ id: i.id, email: i.emailAddress, status: i.status, created_at: i.createdAt }));
}

async function findInvitation(id) {
  const { data } = await clerk().invitations.getInvitationList({ query: id, limit: 10 });
  return data.find((i) => i.id === id) || null;
}

export async function revokeStaffInvitation(id) {
  const invitation = await findInvitation(id);
  if (!invitation || invitation.status !== "pending") throw new AuthError(404, "Pending invitation not found");
  await clerk().invitations.revokeInvitation(id);
}

export async function resendStaffInvitation(id) {
  const invitation = await findInvitation(id);
  if (!invitation) throw new AuthError(404, "Invitation not found");
  if (invitation.status === "pending") await clerk().invitations.revokeInvitation(id);
  return createStaffInvitation(invitation.emailAddress, {
    ignoreExisting: true,
    localUserId: Number(invitation.publicMetadata?.pineUserId) || null,
  });
}

export async function setClerkUserActive(clerkUserId, active) {
  if (!clerkUserId) return;
  if (active) await clerk().users.unbanUser(clerkUserId);
  else await clerk().users.banUser(clerkUserId);
}

export async function updateClerkName(clerkUserId, name) {
  if (!clerkUserId) return;
  const parts = String(name).trim().split(/\s+/);
  await clerk().users.updateUser(clerkUserId, { firstName: parts.shift() || "", lastName: parts.join(" ") });
}

export function clerkErrorMessage(error) {
  return error?.errors?.[0]?.longMessage || error?.errors?.[0]?.message || error?.message || "Clerk request failed";
}
