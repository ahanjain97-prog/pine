import { logActivity } from '../db.js';
import { ROLES } from '../roles.js';
import { addRole, compactRanks, copyToRole, moveOnBoard, spotIn } from './board.js';

export const BOARD_SOURCES = {
  Search: ['Data screen', 'Video', 'NCAA database', 'Live', 'Other scouting'],
  Referral: ['Staff', 'Agent', 'Contact'],
};
export const BOARD_EXIT_REASONS = ['Not good enough on film', 'Data review', 'Too expensive', 'Re-signed', 'Signed elsewhere', 'Role filled', 'No longer a need', 'Other'];
const sources = Object.entries(BOARD_SOURCES).flatMap(([group, values]) => values.map((v) => `${group}: ${v}`));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, name) => {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 4000) fail(400, `${name} must be text of at most 4000 characters`);
  return value.trim() || null;
};

// The caller chooses the kind, actor and role from the actual transition, never from client claims.
export function validateBoardReason(kind, input) {
  if (kind === 'track' && input == null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'A written board reason is required');
  const reason = { source: text(input.source, 'Source'),
    why: text(input.why, 'Why'), exit_reason: text(input.exit_reason, 'Exit reason'), note: text(input.note, 'Note') };
  if (reason.source && !sources.includes(reason.source)) fail(400, 'Choose a valid source');
  if (kind === 'add' && !reason.source) fail(400, 'Source is required when adding a board role');
  if (['add', 'promote'].includes(kind) && !reason.why) fail(400, 'Why is required');
  if (['drop_back', 'take_off'].includes(kind)) {
    if (!BOARD_EXIT_REASONS.includes(reason.exit_reason)) fail(400, 'Choose an exit reason');
    if (reason.exit_reason === 'Other' && !reason.note) fail(400, 'A note is required for Other');
    reason.source = null; reason.why = null;
  } else { reason.exit_reason = null; reason.note = null; }
  return kind === 'track' && !reason.source && !reason.why ? null : reason;
}

export function recordBoardReason(db, playerId, role, kind, reason, userId) {
  if (!reason) return null;
  const id = Number(db.run(`INSERT INTO board_reasons(player_id,role,kind,source,why,exit_reason,note,user_id)
    VALUES (?,?,?,?,?,?,?,?)`, playerId, role, kind, reason.source, reason.why, reason.exit_reason, reason.note, userId).lastInsertRowid);
  if (kind === 'add' || kind === 'promote') db.run('UPDATE board_entries SET reason_id = ? WHERE player_id = ? AND role = ?', id, playerId, role);
  return id;
}

const entry = (db, playerId, role) => db.get('SELECT * FROM board_entries WHERE player_id = ? AND role = ?', playerId, role);
const checkRole = (role) => { if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) fail(400, `Unknown role ${role}`); };

export function addBoardRole(db, playerId, role, input, userId) {
  checkRole(role);
  return db.tx(() => {
    if (entry(db, playerId, role)) return false;
    const reason = validateBoardReason('add', input);
    addRole(db, playerId, role);
    recordBoardReason(db, playerId, role, 'add', reason, userId);
    logActivity(db, userId, playerId, 'added_role', { role, reason });
    return true;
  });
}

export function setBoardStar(db, playerId, role, on, input, userId) {
  checkRole(role);
  if (typeof on !== 'boolean') fail(400, 'On must be true or false');
  return db.tx(() => {
    const old = entry(db, playerId, role);
    if (!old) fail(400, 'Player is not on the Big Board in that role');
    if (Boolean(old.shortlist) === on) return false;
    const kind = on ? 'promote' : 'drop_back', reason = validateBoardReason(kind, input);
    db.run('UPDATE board_entries SET shortlist = ? WHERE player_id = ? AND role = ?', Number(on), playerId, role);
    recordBoardReason(db, playerId, role, kind, reason, userId);
    logActivity(db, userId, playerId, on ? 'shortlisted' : 'unshortlisted', { role, reason });
    return true;
  });
}

export function removeBoardRole(db, playerId, role, input, userId) {
  checkRole(role);
  return db.tx(() => {
    const old = entry(db, playerId, role);
    if (!old) return false;
    const reason = validateBoardReason('take_off', input);
    db.run('DELETE FROM board_entries WHERE player_id = ? AND role = ?', playerId, role);
    compactRanks(db, role);
    recordBoardReason(db, playerId, role, 'take_off', reason, userId);
    logActivity(db, userId, playerId, 'removed_role', { role, was_shortlisted: Boolean(old.shortlist), reason });
    return true;
  });
}

export function moveBoardCard(db, playerId, body, userId) {
  const { from_role: from = null, to_role: to, index, copy = false } = body;
  checkRole(to);
  if (from != null && (typeof from !== 'string' || !Object.hasOwn(ROLES, from))) fail(400, 'Choose a valid starting role');
  if (typeof copy !== 'boolean') fail(400, 'Copy must be true or false');
  return db.tx(() => {
    const origin = from ? entry(db, playerId, from) : null, target = entry(db, playerId, to);
    if (from && !origin) fail(400, 'Player is not in the starting role');
    if (copy && (!from || from === to)) fail(400, 'Pick a different role to duplicate into');
    // A genuine role transfer is exempt; an absent/fabricated origin cannot bypass add validation.
    const kind = copy ? (!target ? 'add' : !target.shortlist ? 'promote' : null) : !origin && !target ? 'add' : null;
    const reason = kind ? validateBoardReason(kind, body.reason) : null;
    const before = from ? spotIn(db, playerId, from) : null;
    const spot = copy ? copyToRole(db, playerId, to, index) : moveOnBoard(db, playerId, from, to, index);
    if (from && from !== to && !copy) compactRanks(db, from);
    if (kind) recordBoardReason(db, playerId, to, kind, reason, userId);
    if (copy || from !== to || before !== spot) logActivity(db, userId, playerId, copy ? 'copied_on_board' : 'moved_on_board',
      { from, to, spot, from_spot: before, ...(reason ? { reason } : {}) });
    return spot;
  });
}

export function boardHistory(db, playerId) {
  return db.all(`SELECT r.id, r.player_id, r.role, r.kind, r.source, r.why, r.exit_reason, r.note, r.user_id, r.created_at, u.name AS user
    FROM board_reasons r JOIN users u ON u.id = r.user_id
    WHERE r.player_id = ? ORDER BY r.created_at DESC, r.id DESC`, playerId);
}

export function registerBoardMoves(app, { db, getPlayer }) {
  const user = (c) => c.get('user') || fail(401, 'Not signed in');
  app.post('/api/board/move', async (c) => {
    const actor = user(c), body = await c.req.json(), p = getPlayer(body.player_id);
    moveBoardCard(db, p.id, body, actor.id);
    return c.json({ ok: true });
  });
  app.post('/api/board/shortlist', async (c) => {
    const actor = user(c), body = await c.req.json(), p = getPlayer(body.player_id);
    setBoardStar(db, p.id, body.role, body.on, body.reason, actor.id);
    return c.json({ player: getPlayer(p.id) });
  });
  app.post('/api/players/:id/roles', async (c) => {
    const actor = user(c), p = getPlayer(c.req.param('id')), body = await c.req.json();
    addBoardRole(db, p.id, body.role, body.reason, actor.id);
    return c.json({ player: getPlayer(p.id) });
  });
  app.delete('/api/players/:id/roles/:role', async (c) => {
    const actor = user(c), p = getPlayer(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    removeBoardRole(db, p.id, c.req.param('role'), body.reason, actor.id);
    return c.json({ player: getPlayer(p.id) });
  });
}
