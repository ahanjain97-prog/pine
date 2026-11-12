import { renderAnalysis } from "./analysis.js";
import { loadPlayingTimePanel } from "./playing-time.js";

// PINE front end: single page, no build step.
// Routes: #/board  #/short-board  #/ncaa[/database]  #/players  #/player/:id  #/impect  #/activity  #/staff
// Shared links come in as /p/:id, which the server rewrites to #/player/:id before this boots.

import { matchText, textMatch } from "./search.js";
import { stampSummary, SUMMARY_STAMP } from "./summary-stamp.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3l7 9h-3.5l6.2 8h-4.9l6.4 7.5H4.8l6.4-7.5H6.3l6.2-8H9z" fill="currentColor"/><rect x="14.5" y="27" width="3" height="3.5" fill="currentColor"/></svg>`;
// Physical-data position groups (player-physical-data): defensive and central mids are one pool, as in the KPI benchmarks.
const GRP_NAME = { CB: "centre backs", FB: "full backs", MID: "defensive & central mids", AM: "attacking mids", FWD: "forwards", GK: "goalkeepers" };

const S = {
  me: null, config: null, players: [], byId: new Map(), version: 0, pollTimer: null, dragging: null,
  board: { decision: "all", q: "", league: "" },
  table: null, // the Database tab's filters, loaded from this browser on first use (dbState)
  impect: { iteration: "", q: "" },
};

/* ---------- plumbing ---------- */
async function api(method, path, body) {
  const opt = { method, headers: { "X-PINE": "1" }, credentials: "same-origin" };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && S.me && !path.startsWith("/api/auth/")) showLogin("Your session ended. Sign in again.");
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2600);
}
const oops = (e) => toast(e?.message || String(e), true);

function toDate(s) {
  if (!s) return null;
  const str = String(s);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(str + "T12:00:00Z")
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str) ? new Date(str.replace(" ", "T") + "Z")
    : new Date(str);
  return Number.isNaN(+d) ? null : d;
}
const fmtDate = (s) => toDate(s)?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) || "";
const fmtDateTime = (s) => toDate(s)?.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) || "";
// KPI values arrive rounded to three decimals. Preserve that precision so small but real
// pXT/score values such as 0.011 are not presented as 0.0.
const fmtKpiNum = (x) => (x == null ? "" : (+x).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 3 }));
function relTime(s) {
  const d = toDate(s);
  if (!d) return "";
  const sec = (Date.now() - d) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 7 * 86400) return `${Math.floor(sec / 86400)}d ago`;
  return fmtDate(s);
}
function ageFrom(b) {
  const d = toDate(b);
  if (!d) return null;
  const n = new Date();
  let a = n.getFullYear() - d.getUTCFullYear();
  if (n.getMonth() < d.getUTCMonth() || (n.getMonth() === d.getUTCMonth() && n.getDate() < d.getUTCDate())) a--;
  return a;
}
const contractSoon = (s) => { const d = toDate(s); return !!d && d - Date.now() < 183 * 864e5; };
const fmtNum = (x) => (x == null ? "" : Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : (+x).toFixed(1));
const band = (v) => (v < 20 ? "var(--b0)" : v < 40 ? "var(--b1)" : v < 60 ? "var(--b2)" : v < 80 ? "var(--b3)" : "var(--b4)");

/* ---------- shared bits ---------- */
// Share a player the way people actually pass them around. On a phone that means the native share
// sheet (WhatsApp sits in it); everywhere else, a small panel with the message ready to copy or
// hand to WhatsApp. Both carry a line of context above the link, so the message reads on its own
// even before the preview unfurls. /p/<id> is the shareable form of #/player/<id>: the server can
// see the id there, so the preview names the player.
function shareMessage(p) {
  const who = [p.age, p.position, p.club].filter((x) => x != null && x !== "").join(", ");
  return { text: `${p.name}${who ? ` — ${who}` : ""} · PINE`, url: `${location.origin}/p/${p.id}` };
}

async function sharePlayer(p) {
  const { text, url } = shareMessage(p);
  if (navigator.share) {
    try { return await navigator.share({ title: p.name, text, url }); }
    catch (e) { if (e.name === "AbortError") return; } // anything else: fall through to the panel
  }
  const message = `${text}\n${url}`;
  const m = modal(`<header class="m-h"><h2>Share ${esc(p.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <p class="hint">The link unfurls in WhatsApp with ${esc(p.name)}'s name, photo and club.</p>
    <textarea id="share-text" rows="3" readonly>${esc(message)}</textarea>
    <div class="m-actions">
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(message)}" target="_blank" rel="noopener" data-close>Open WhatsApp</a>
      <button type="button" class="btn primary" id="share-copy">Copy</button>
    </div>`);
  const box = $("#share-text", m);
  box.focus();
  box.select();
  $("#share-copy", m).addEventListener("click", async () => {
    // The clipboard API needs a focused document, so leave the text selected when it refuses.
    try { await navigator.clipboard.writeText(message); toast("Link copied"); closeModal(); }
    catch { box.focus(); box.select(); toast("Press ⌘C to copy", true); }
  });
}

const roleInfo = (code) => S.config.roles[code];
const roleLabel = (code) => { const r = roleInfo(code); return r ? `${r.position} #${r.num} · ${r.label}` : String(code || ""); };
const roleShort = (code) => { const r = roleInfo(code); return r ? `${r.position} #${r.num}` : String(code || ""); };
const rankIn = (p, role) => p.roles.find((r) => r.role === role)?.rank ?? 1e9;
const playersInRole = (role) => S.players.filter((p) => p.roles.some((r) => r.role === role)).sort((a, b) => rankIn(a, role) - rankIn(b, role));
// Top targets keep the big board's order; the Short Board is that board filtered to them.
const isTopTarget = (p, role) => Boolean(p.roles.find((r) => r.role === role)?.shortlist);
const targetsInRole = (role) => playersInRole(role).filter((p) => isTopTarget(p, role));
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
// Initials sit on a colour picked from the name (blues, violets, pinks: never the pass/hold/fail green,
// amber or red), so players without a photo are easier to tell apart.
const AVATAR_HUES = [192, 205, 218, 232, 248, 264, 280, 296, 312, 328];
const avatarHue = (name) => AVATAR_HUES[[...String(name || "")].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATAR_HUES.length];
const photo = (p, size = "") => p.photo_url
  ? `<img class="ph ${size}" src="${esc(p.photo_url)}" alt="" loading="lazy" data-ini="${esc(initials(p.name))}" style="--av:${avatarHue(p.name)}">`
  : `<span class="ph ini ${size}" style="--av:${avatarHue(p.name)}">${esc(initials(p.name))}</span>`;
const decisionChip = (d, lg = false) => `<span class="dchip ${d ? "v-" + d : ""} ${lg ? "lg" : ""}">${d ? cap(d) : "Undecided"}</span>`;
const signedBadge = (p, lg = false) => p.is_signed ? `<span class="signed-badge ${lg ? "lg" : ""}"><span aria-hidden="true">✓</span> Signed</span>` : "";
const verdictChip = (v) => `<span class="dchip ${v ? "v-" + v : ""}">${v ? cap(v) : "No verdict"}</span>`;
const fact = (label, value, html = false) => (value == null || value === "" ? "" : `<div><dt>${esc(label)}</dt><dd>${html ? value : esc(value)}</dd></div>`);
function verdictDots(verdicts, wide = false) {
  // One dot per staff member with a Staff reports box (plus anyone else who has given this player a verdict).
  return `<span class="vdots ${wide ? "wide" : ""}">${S.config.staff.filter((s) => s.in_evals !== 0 || verdicts?.[s.name]).map((s) => {
    const v = verdicts?.[s.name];
    return `<i class="vdot ${v ? "v-" + v : ""}" title="${esc(s.name)}: ${v ? cap(v) : "no verdict"}"></i>`;
  }).join("")}</span>`;
}
function seg(current, attr) {
  return `<div class="seg" role="group">${S.config.decisions.map((d) =>
    `<button type="button" class="v-${d} ${current === d ? "on" : ""}" data-${attr}="${d}" aria-pressed="${current === d}">${cap(d)}</button>`).join("")}${
    current ? `<button type="button" data-${attr}="" title="Clear">Clear</button>` : ""}</div>`;
}
const matchDecision = (p, d) => d === "all" || (d === "none" ? !p.decision : p.decision === d);
const leaguesOf = () => [...new Set(S.players.map((p) => p.league).filter(Boolean))].sort();
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function modal(html, { wide = false } = {}) {
  closeModal();
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.id = "modal";
  bg.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(bg);
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) closeModal(); });
  bg.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeModal(); });
  return bg.firstElementChild;
}
const closeModal = () => { cancelBoardReason?.(); $("#modal")?.remove(); };

// Reasons are collected before the API write. A separate overlay preserves an Add player/picker form on cancel.
let cancelBoardReason = null;
function askBoardReason(kind, player, roles = [], context = '') {
  if (cancelBoardReason) return Promise.resolve(null);
  const exit = kind === 'drop_back' || kind === 'take_off';
  const titles = { add: 'Add to Big Board', promote: 'Promote to Short Board', drop_back: 'Drop back to Big Board', take_off: 'Remove from Big Board', track: 'Add to PINE' };
  const optional = kind === 'track';
  const previous = document.activeElement, parent = $('#modal');
  if (parent) parent.inert = true;
  const bg = document.createElement('div');
  bg.id = 'board-reason-modal'; bg.className = 'modal-bg board-reason-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="br-title" tabindex="-1">
    <header class="m-h"><h2 id="br-title">${titles[kind]}</h2><button type="button" class="icon-btn" data-br-cancel aria-label="Close">×</button></header>
    <p class="hint">${esc(player)}${roles.length ? ` · ${esc(roles.map(roleLabel).join(', '))}` : ''}${context ? `<br>${esc(context)}` : ''}</p>
    <form id="board-reason-form">
      ${exit ? `<label class="lbl" for="br-exit">Exit reason *</label><select id="br-exit" name="exit_reason" required><option value="">Choose an exit reason…</option>${S.config.board_reasons.exit_reasons.map(v=>`<option>${esc(v)}</option>`).join('')}</select>
        <label class="lbl" for="br-note">Note <span id="br-note-required">(optional)</span></label><textarea id="br-note" name="note" rows="3" maxlength="4000"></textarea>`
        : `${kind === 'add' || optional ? `<label class="lbl" for="br-source">Source ${optional ? '(optional)' : '*'}</label>
          <select id="br-source" name="source" ${optional ? '' : 'required'}><option value="">Choose a source…</option>${Object.entries(S.config.board_reasons.sources).map(([g,opts])=>`<optgroup label="${esc(g)}">${opts.map(v=>`<option value="${esc(g+': '+v)}">${esc(v)}</option>`).join('')}</optgroup>`).join('')}</select>` : ''}
        <label class="lbl" for="br-why">Why ${optional ? '(optional)' : '*'}</label><textarea id="br-why" name="why" rows="4" maxlength="4000" ${optional ? '' : 'required'} placeholder="Explain the board decision…"></textarea>`}
      <div class="m-actions"><button type="button" class="btn ghost" data-br-cancel>Cancel</button>${optional ? '<button type="button" class="btn" data-br-skip>Add without a reason</button>' : ''}<button type="submit" class="btn primary">${titles[kind]}</button></div>
    </form></div>`;
  document.body.appendChild(bg);
  return new Promise(resolve => {
    const done = value => {
      document.removeEventListener('keydown', keys, true);
      bg.remove(); if (parent) parent.inert = false;
      cancelBoardReason = null; if (previous?.isConnected) previous.focus();
      resolve(value);
    };
    const keys = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(null); }
      if (e.key === 'Tab') {
        const items = $$('button,input,select,textarea', bg).filter(el=>!el.disabled && el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    cancelBoardReason = () => done(null);
    document.addEventListener('keydown', keys, true);
    bg.addEventListener('click', e => {
      if (e.target === bg || e.target.closest('[data-br-cancel]')) done(null);
      else if (e.target.closest('[data-br-skip]')) done({});
    });
    $('#br-exit', bg)?.addEventListener('change', e => {
      const other = e.target.value === 'Other';
      $('#br-note', bg).required = other; $('#br-note-required', bg).textContent = other ? '*' : '(optional)';
    });
    $('#board-reason-form', bg).addEventListener('submit', e => {
      e.preventDefault();
      // HTML required also rejects empty values, but trimmed whitespace must not count as a written reason.
      const fields = Object.fromEntries([...new FormData(e.target)].map(([k,v])=>[k,String(v).trim()]));
      const why = $('#br-why', bg), note = $('#br-note', bg);
      for (const el of [why,note].filter(Boolean)) {
        el.setCustomValidity(el.required && !el.value.trim() ? 'Please write a reason.' : '');
        if (!el.reportValidity()) return;
      }
      done(fields);
    });
    for (const el of $$('textarea', bg)) el.addEventListener('input',()=>el.setCustomValidity(''));
    $('select,textarea', bg)?.focus();
  });
}

const boardMoveLabel = kind => ({ add: 'Added to Big Board', promote: 'Promoted to Short Board', drop_back: 'Dropped back from Short Board', take_off: 'Taken off Big Board', track: 'Added to PINE' })[kind] || kind;
function boardReasonDetails(r) {
  return [r.source, r.exit_reason, r.why ? `Why: ${r.why}` : '', r.note ? `Note: ${r.note}` : ''].filter(Boolean);
}
function boardReasonTooltip(p, role) {
  const r = p.roles.find(r=>r.role === role)?.reason;
  return r?.id ? boardReasonDetails(r).join('\n') : 'Added before reasons were required';
}
function boardHistoryHTML(rows) {
  if (!rows?.length) return '<p class="empty">No board reasons recorded yet. Earlier entries were added before reasons were required.</p>';
  return `<ol class="board-history">${rows.map(r=>`<li><div class="row"><b>${esc(r.user)}</b><time class="muted sm" datetime="${esc(r.created_at)}">${esc(fmtDateTime(r.created_at))}</time></div>
    <div>${esc(boardMoveLabel(r.kind))}${r.role ? ` · ${esc(roleLabel(r.role))}` : ''}</div>
    ${boardReasonDetails(r).map(line=>`<div class="board-history-detail">${esc(line)}</div>`).join('')}</li>`).join('')}</ol>`;
}

/* ---------- data sync ---------- */
async function reloadPlayers() {
  const { players } = await api("GET", "/api/players");
  S.players = players;
  S.byId = new Map(players.map((p) => [p.id, p]));
}
const APP_VERSION = new URL(import.meta.url).searchParams.get("v");
// A tab opened before a deploy keeps running the old code; say so rather than leave it quietly out of date.
function checkAppVersion(server) {
  if (!server || !APP_VERSION || server === APP_VERSION || S.staleNotified) return;
  S.staleNotified = true;
  const pill = $("#upd");
  pill.hidden = false;
  pill.innerHTML = `<button class="btn sm" type="button">PINE was updated · reload</button>`;
  $("button", pill).addEventListener("click", () => location.reload());
}
async function syncVersion() { try { const c = await api("GET", "/api/changes"); S.version = c.version; setReviewBadge(c.review_open); checkAppVersion(c.app); } catch {} }
async function refresh() {
  const keep = Object.fromEntries($$("#main [data-keep]").map((el) => [el.id, el.value]));
  const y = scrollY;
  await reloadPlayers();
  await render();
  for (const [id, v] of Object.entries(keep)) { const el = document.getElementById(id); if (el && !el.value) el.value = v; }
  scrollTo(0, y);
}
async function afterMutation() { await syncVersion(); await refresh(); }
function busyEditing() {
  const a = document.activeElement;
  if (a && a.closest("#main") && a.matches("input, textarea, select")) return true;
  return $$("#main textarea[data-draft]").some((t) => t.value.trim() !== (t.dataset.orig ?? "").trim());
}
async function poll() {
  if (!S.me || document.hidden) return;
  let v;
  try { const c = await api("GET", "/api/changes"); v = c.version; setReviewBadge(c.review_open); checkAppVersion(c.app); } catch { return; }
  if (v === S.version) return;
  S.version = v;
  if (S.dragging || busyEditing() || $("#modal") || $("#board-reason-modal")) { $("#upd").hidden = false; return; }
  await refresh();
}

/* ---------- login ---------- */
function loginCard(inner) {
  S.me = null;
  clearInterval(S.pollTimer);
  closeModal();
  $("#app").innerHTML = `<main class="login"><div class="login-card">
    <div class="brand-lg">${LOGO}<div><div class="wordmark">PINE</div><div class="tagline">Player Identification Network Evaluation</div></div></div>
    ${inner}
    <p class="err" id="login-err" hidden></p>
  </div></main>`;
  const err = $("#login-err");
  return (m) => { err.textContent = m; err.hidden = !m; };
}

function showLogin(msg) {
  const showErr = loginCard(`<form id="login">
      <label class="lbl" for="le">Staff email</label>
      <input id="le" type="email" required autocomplete="username" placeholder="you@example.com">
      <label class="lbl" for="lp">Password</label>
      <input id="lp" type="password" required autocomplete="current-password">
      <button class="btn primary" type="submit">Sign in</button>
      <p class="hint">First time, or forgot your password? Ask an admin for your sign-in link.</p>
    </form>`);
  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    showErr("");
    const btn = $("button", e.target);
    btn.disabled = true;
    try { await api("POST", "/api/auth/login", { email: $("#le").value.trim(), password: $("#lp").value }); boot(); }
    catch (e2) { showErr(e2.message); btn.disabled = false; }
  });
  if (msg) showErr(msg);
  $("#le").focus();
}

// #/welcome/<token>: the one-time link an admin sends. Choose a password, then you're signed in.
async function showWelcome(token) {
  let user;
  try { ({ user } = await api("GET", `/api/auth/setup/${encodeURIComponent(token)}`)); }
  catch (e) {
    const showErr = loginCard(`<p class="hint">Already set a password? <a href="#/board" id="to-login">Sign in</a>.</p>`);
    showErr(e.message);
    $("#to-login").addEventListener("click", (ev) => { ev.preventDefault(); location.hash = "#/board"; boot(); });
    return;
  }
  const showErr = loginCard(`<form id="welcome">
      <p class="hint">Welcome, <b>${esc(user.name)}</b>. Choose a password; from now on you sign in with your email and this password.</p>
      <label class="lbl" for="we">Email</label>
      <input id="we" type="email" autocomplete="username" value="${esc(user.email)}" readonly>
      <label class="lbl" for="wp">New password (at least 8 characters)</label>
      <input id="wp" type="password" required minlength="8" autocomplete="new-password">
      <label class="lbl" for="wp2">Type it again</label>
      <input id="wp2" type="password" required minlength="8" autocomplete="new-password">
      <button class="btn primary" type="submit">Set password and sign in</button>
    </form>`);
  $("#welcome").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("#wp").value !== $("#wp2").value) return showErr("The two passwords don't match.");
    showErr("");
    const btn = $("button", e.target);
    btn.disabled = true;
    try {
      await api("POST", "/api/auth/setup", { token, password: $("#wp").value });
      history.replaceState(null, "", "#/board");
      boot();
    } catch (e2) { showErr(e2.message); btn.disabled = false; }
  });
  $("#wp").focus();
}
const welcomeToken = () => (location.hash.match(/^#\/welcome\/([\w-]+)/) || [])[1];

/* ---------- shell + routing ---------- */
function renderShell() {
  $("#app").innerHTML = `
  <header class="top">
    <a class="brand" href="#/board"><img class="club-crest" src="/hop-crest.png?v=1" alt="Portland Hearts of Pine" width="31" height="36"><span class="brand-divider" aria-hidden="true"></span>${LOGO}<span class="wordmark">PINE</span><span class="tagline">Player Identification Network Evaluation</span></a>
    <nav class="nav" id="nav">
      <a href="#/board" data-v="board">Big Board</a>
      ${reviewRole() ? `<a href="#/war-room" data-v="war-room">War Room<span class="nav-badge" id="review-badge" ${S.reviewOpen ? "" : "hidden"}>${S.reviewOpen || ""}</span></a>` : ""}
      <a href="#/short-board" data-v="short-board">Short Board</a>
      <a href="#/ncaa" data-v="ncaa">NCAA</a>
      <a href="#/activity" data-v="activity">Activity</a>
      <button class="nav-trigger" id="operations-trigger" type="button" popovertarget="operations-menu" aria-controls="operations-menu" aria-expanded="false">Operations<span class="nav-caret" aria-hidden="true">▾</span></button>
      <div class="nav-menu" id="operations-menu" popover role="group" aria-label="Operations">
        <a href="#/players" data-v="players">Database</a>
        <a href="#/impect" data-v="impect">Impect</a>
        <a href="#/analysis" data-v="analysis">Analysis</a>
        ${S.me.is_admin ? `<a href="#/staff" data-v="staff">Staff</a>` : ""}
      </div>
    </nav>
    <div class="top-r">
      <div class="gsearch"><input id="gs" type="search" placeholder="Find a player  ( / )" autocomplete="off" aria-label="Find a player"><div class="gs-res" id="gs-res" hidden></div></div>
      <button class="btn primary" id="add-btn" type="button">+ Add player</button>
      ${S.config.auth === "off"
        ? `<label class="me" title="Notes, verdicts and changes are recorded under this name"><span class="avatar">${esc(S.me.name[0])}</span>
            <select id="act-as" aria-label="Acting as">${S.config.staff.map((s) => `<option value="${s.id}" ${s.id === S.me.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>`
        : `<details class="me-menu"><summary class="avatar" title="Signed in as ${esc(S.me.name)}" aria-label="Account">${esc(S.me.name[0])}</summary>
            <div class="me-pop"><div class="me-pop-name">${esc(S.me.name)}</div><button class="btn ghost sm" id="logout" type="button">Sign out</button></div></details>`}
    </div>
  </header>
  <div class="update-pill" id="upd" hidden><button class="btn sm" type="button">New changes from staff · refresh</button></div>
  <main id="main"></main>`;
  $("#add-btn").addEventListener("click", () => openAddPlayer());
  $("#logout")?.addEventListener("click", async () => { try { await api("POST", "/api/auth/logout", {}); } catch {} showLogin(); });
  if (!S.meMenuWired) { // once: clicking anywhere else closes the account menu
    S.meMenuWired = true;
    document.addEventListener("click", (e) => { const m = $(".me-menu[open]"); if (m && !m.contains(e.target)) m.open = false; });
  }
  $("#act-as")?.addEventListener("change", async (e) => {
    try {
      await api("POST", "/api/auth/act-as", { user_id: Number(e.target.value) });
      S.me = (await api("GET", "/api/auth/me")).user;
      S.config = await api("GET", "/api/config");
      renderShell();
      await render();
      toast(`Now working as ${S.me.name}`);
    } catch (err) { oops(err); }
  });
  $("#upd button").addEventListener("click", () => { $("#upd").hidden = true; refresh(); });
  wireNavMenus();
  wireGlobalSearch();
}

function closeNavMenus() {
  $$(".nav-menu:popover-open").forEach((menu) => menu.hidePopover());
}

function wireNavMenus() {
  $$("#nav .nav-trigger").forEach((trigger) => {
    const menu = document.getElementById(trigger.getAttribute("popovertarget"));
    // Native popovers sit above the scrolling phone nav and dismiss on click-away or Escape.
    menu.addEventListener("beforetoggle", (e) => {
      trigger.setAttribute("aria-expanded", String(e.newState === "open"));
      if (e.newState !== "open") return;
      const rect = trigger.getBoundingClientRect(), width = Math.min(200, innerWidth - 24);
      menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
      menu.style.top = `${rect.bottom + 8}px`;
    });
    menu.addEventListener("click", (e) => { if (e.target.closest("a")) menu.hidePopover(); });
  });
  $("#nav").addEventListener("scroll", closeNavMenus);
}

function wireGlobalSearch() {
  const inp = $("#gs"), box = $("#gs-res");
  let results = [], hl = 0;
  const draw = () => {
    box.hidden = !results.length;
    box.innerHTML = results.map((p, i) => `<a href="#/player/${p.id}" class="${i === hl ? "hl" : ""} ${p.is_signed ? "is-signed" : ""}">${photo(p)}<span class="ci">${nameWithMark(p)}<div class="csub">${esc([p.age, p.club].filter((x) => x != null && x !== "").join(" · "))}</div></span>${decisionChip(p.decision)}</a>`).join("");
  };
  inp.addEventListener("input", () => { const q = inp.value.trim(); results = q ? S.players.filter((p) => matchText(p, q)).slice(0, 8) : []; hl = 0; draw(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { hl = Math.min(hl + 1, results.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { hl = Math.max(hl - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && results[hl]) { location.hash = `#/player/${results[hl].id}`; inp.value = ""; results = []; draw(); inp.blur(); }
    else if (e.key === "Escape") { inp.value = ""; results = []; draw(); inp.blur(); }
  });
  inp.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("click", () => { inp.value = ""; results = []; draw(); inp.blur(); });
}

const setTitle = (s) => { document.title = s ? `${s} · PINE` : "PINE"; };

// A profile has two URLs: #/player/7, which the app navigates with, and /p/7, which is the one
// worth sharing -- a crawler never sees a #fragment, so only /p/7 can preview as the player.
// route() understands both, and render() then parks the address bar on /p/7, so the URL copied
// out of the browser is the one that previews properly.
function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (hash) {
    const [view, arg] = hash.split("/");
    // Tabs' old addresses: the Short Board was "shortlist", the War Room was "review".
    return { view: view === "shortlist" ? "short-board" : view === "review" ? "war-room" : view, arg };
  }
  const shared = location.pathname.match(/^\/p\/(\d+)/);
  return shared ? { view: "player", arg: shared[1] } : { view: "board", arg: undefined };
}

const canonicalUrl = ({ view, arg }) => (view === "player" ? `/p/${arg}` : arg ? `/#/${view}/${arg}` : `/#/${view}`);

async function render() {
  if (!S.me) return;
  const { view, arg } = route();
  $$("#nav a").forEach((a) => {
    a.classList.toggle("on", a.dataset.v === view || (view === "player" && a.dataset.v === "players"));
    if (a.dataset.v === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const inOperations = ["players", "player", "impect", "analysis", "staff"].includes(view);
  $("#operations-trigger").classList.toggle("on", inOperations);
  const link = $("#nav > .on"), nav = $("#nav");
  if (link && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = link.offsetLeft - nav.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2;
  $("#upd").hidden = !S.staleNotified; // the reload prompt stays up until they reload
  const views = { analysis: (main, arg) => renderAnalysis(main, arg, { api, setTitle }), board: renderBoard, "war-room": renderReview, "short-board": renderShortBoard, ncaa: renderNcaa, players: renderTable, player: renderPlayer, impect: renderImpect, activity: renderActivity, staff: renderStaff };
  // Pitch maps had their own tab for a day; its links now open the player's page, where the maps live.
  if (view === "maps") { location.hash = arg ? `#/player/${arg}` : "#/players"; return; }
  if (!views[view]) { location.hash = "#/board"; return; }
  // replaceState fires nothing, so this can't loop back into render().
  const want = canonicalUrl({ view, arg });
  if (location.pathname + location.hash !== want) history.replaceState(null, "", want);
  // The player view retitles itself once the profile loads.
  setTitle({ analysis: "Analysis", board: "Big Board", ncaa: "NCAA", players: "Database", impect: "Impect", activity: "Activity", staff: "Staff" }[view]);
  await views[view]($("#main"), arg);
}

/* ---------- big board ---------- */
function renderBoard(main) {
  const f = S.board;
  const onBoard = S.players.filter((p) => p.roles.length);
  const count = (d) => onBoard.filter((p) => p.decision === d).length;
  const decs = [["all", "All"], ["pass", "Pass"], ["hold", "Hold"], ["fail", "Fail"], ["none", "Undecided"]];
  main.innerHTML = `<div class="page">
    <div class="page-h">
      <div><h1>Big Board</h1>
        <div class="board-stats"><span><b>${onBoard.length}</b> on board</span><span><b>${count("pass")}</b> pass</span><span><b>${count("hold")}</b> hold</span><span><b>${count("fail")}</b> fail</span></div></div>
      <div class="spacer"></div>
      <div class="filters">
        <div class="seg" id="bf-dec">${decs.map(([k, l]) => `<button type="button" data-k="${k}" class="${k !== "all" && k !== "none" ? "v-" + k : ""} ${f.decision === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <select id="bf-league" aria-label="League"><option value="">All leagues</option>${leaguesOf().map((l) => `<option value="${esc(l)}" ${f.league === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <input id="bf-q" type="search" placeholder="Filter the board…" value="${esc(f.q)}" aria-label="Filter the board">
        ${legendHTML(false, S.config.review_after_days)}
      </div>
    </div>
    <div class="pitch-wrap"><div class="pitch">${S.config.positions.map((pos) => posBox(pos)).join("")}</div></div>
  </div>`;
  wireBoard(main.firstElementChild);
}

function renderShortBoard(main) {
  const targets = S.players.filter((p) => p.roles.some((r) => r.shortlist));
  const count = (d) => targets.filter((p) => p.decision === d).length;
  main.innerHTML = `<div class="page">
    <div class="page-h">
      <div><h1>Short Board</h1>
        <div class="board-stats"><span><b>${targets.length}</b> top target${targets.length === 1 ? "" : "s"}</span>
          <span><b>${count("pass")}</b> pass</span><span><b>${count("hold")}</b> hold</span><span><b>${count("fail")}</b> fail</span></div></div>
      <div class="spacer"></div>
      <div class="filters"><span class="muted sm">Star a player on the Big Board to add them here. Drag to reorder, or onto another role to move or duplicate them.</span>${legendHTML()}</div>
    </div>
    ${targets.length ? "" : `<p class="empty">No top targets yet. On the <a href="#/board">Big Board</a>, click the ☆ on a player's card to add them.</p>`}
    <div class="pitch-wrap"><div class="pitch">${S.config.positions.map((pos) => posBox(pos, true)).join("")}</div></div>
  </div>`;
  wireBoard(main.firstElementChild, { short: true });
}

// Board colour by line of the team: attack, midfield, defence, keeper. Kept clear of the pass/hold/fail
// colours, which stay reserved for decisions.
const POS_LINE = { FWD: "att", LW: "att", RW: "att", AM: "att", CM: "mid", CDM: "mid", LB: "def", RB: "def", LCB: "def", RCB: "def", GK: "gk" };
const BIG_BOARD_ROLE_TARGET = 20;
const SHORT_BOARD_ROLE_TARGET = 5;

function posBox(pos, targetsOnly = false) {
  const inRole = targetsOnly ? targetsInRole : playersInRole;
  const roleTarget = targetsOnly ? SHORT_BOARD_ROLE_TARGET : BIG_BOARD_ROLE_TARGET;
  const total = new Set(pos.roles.flatMap(([c]) => inRole(c).map((p) => p.id))).size;
  const line = POS_LINE[pos.code] || "def";
  return `<section class="pos" style="grid-area:${pos.area};--pc:var(--pc-${line});--pc-ink:var(--pc-${line}-ink)">
    <header class="pos-h"><span class="pos-code">${pos.code}</span><span class="pos-label">${esc(pos.label)}</span><span class="pos-n">${total}</span></header>
    <div class="lanes">${pos.roles.map(([code, label]) => {
      const list = inRole(code);
      const num = roleInfo(code).num;
      const aboveTarget = list.length > roleTarget;
      const count = `${list.length}/${roleTarget}`;
      return `<div class="lane">
        <div class="lane-h"><span class="lane-t" title="${esc(pos.code)} #${num}: ${esc(label)}"><b>#${num}</b>${esc(label)}</span><span class="lane-n${aboveTarget ? " over-target" : ""}">${count}</span>
          ${targetsOnly ? "" : `<button type="button" class="icon-btn" data-add-role="${code}" title="Add a player to ${esc(label)}" aria-label="Add a player to ${esc(pos.code)} ${esc(label)}">+</button>`}</div>
        <div class="lane-body" data-role="${code}" ${targetsOnly ? 'data-short="1"' : ""}>${list.map((p, i) => boardCard(p, code, targetsOnly, i)).join("")
          || `<div class="lane-empty">${targetsOnly ? "No top targets yet" : "Drop players here"}</div>`}</div>
      </div>`;
    }).join("")}</div>
  </section>`;
}

// Domestic = US citizen, from Transfermarkt citizenship (players not linked to Transfermarkt carry
// Impect's German country names). People from Puerto Rico and the other territories listed are US
// citizens. Green cards aren't on Transfermarkt and its citizenship is sometimes wrong, so Edit details
// can set the roster status by hand (roster_status), which wins over citizenship.
const US_CITIZENSHIPS = new Set(["United States", "Vereinigte Staaten", "Puerto Rico", "US Virgin Islands",
  "Amerikanische Jungferninseln", "Guam", "Northern Mariana Islands", "Nördliche Marianen"]);
const ROSTER_STATUSES = ["domestic", "international"];
const rosterFromCitizenship = (p) => (p.citizenship?.length ? (p.citizenship.some((c) => US_CITIZENSHIPS.has(c)) ? "domestic" : "international") : null);
// The USL League Two Top Prospects report's Player Status fills in when nothing else says.
const l2Status = (p) => (p.l2 || []).find((e) => e.status)?.status || null;
const rosterStatus = (p) => p.roster_status || rosterFromCitizenship(p) || l2Status(p);
function rosterBadge(p) {
  const status = rosterStatus(p);
  // No citizenship anywhere and none set by hand: flag it so someone fills it in (Edit details).
  if (!status) return `<span class="roster unk" title="Domestic or international? Not known yet: set it in Edit details">?</span>`;
  const dom = status === "domestic";
  const cit = (p.citizenship || []).join(", ");
  const why = p.roster_status ? `set manually${cit ? ` (citizenship: ${cit})` : ""}` : cit || "from the USL League Two Top Prospects report";
  return `<span class="roster ${dom ? "dom" : "intl"}" title="${dom ? "Domestic" : "International"}: ${esc(why)}">${dom ? "DOM" : "INTL"}</span>`;
}
// A report (staff note or PINE college report) added in the last week: a ✎ after the name, green if the latest is
// yours, blue if someone else's; hover for who and when.
const NEW_REPORT_DAYS = 7;
function newReportMark(p) {
  const r = p.last_report, at = r && toDate(r.at);
  if (!at || Date.now() - at > NEW_REPORT_DAYS * 864e5) return "";
  const mine = r.by === S.me.id;
  const who = mine ? "you" : S.config.staff.find((u) => u.id === r.by)?.name || "someone";
  return `<span class="newrpt ${mine ? "mine" : ""}" title="New report by ${esc(who)} · ${esc(relTime(r.at))}" aria-label="New report by ${esc(who)}">✎</span>`;
}
const longThrowBadge = (p) => p.has_long_throw ? `<span class="long-throw" role="img" aria-label="Long throw" title="Long throw · Rory Delap"><img src="/rory-delap-long-throw.png?v=1" alt="" width="56" height="56" aria-hidden="true"></span>` : "";
const nameWithMark = (p, cls = "nm") => `<span class="name-line"><span class="${cls}">${esc(p.name)}</span>${longThrowBadge(p)}${signedBadge(p)}${newReportMark(p)}</span>`;
// Picked for a USL League Two Top Prospects report: "L2 '26", or "L2 '25 '26" for both years.
const L2_TIER = { First: "Best XI", Second: "Second XI", Third: "Third XI", Fourth: "Fourth XI", Fifth: "Fifth XI" };
const l2Line = (e) => [e.year, L2_TIER[e.tier] || e.tier, e.position, e.club].filter(Boolean).join(" · ");
function l2Badge(entries) {
  if (!entries?.length) return "";
  const years = [...new Set(entries.map((e) => e.year))].sort();
  return `<span class="roster l2" title="USL League Two Top Prospects: ${esc(entries.map(l2Line).join("; "))}">L2${years.map((y) => `’${String(y).slice(-2)}`).join("")}</span>`;
}
// Cards show at most `max` tags, most important first; the rest fold into "+N", whose tooltip says what they are.
function tagRow(tags, max = 3) {
  const t = tags.filter(Boolean);
  if (t.length <= max) return t.join("");
  const rest = t.slice(max).map((h) => `${h.replace(/<[^>]+>/g, "")}: ${(h.match(/title="([^"]*)"/) || [])[1] || ""}`);
  return `${t.slice(0, max).join("")}<span class="roster more" title="${rest.join("&#10;")}">+${rest.length}</span>`;
}
// What the marks on a board mean, behind a "Key" button.
function legendHTML(ncaa = false, reviewAfterDays = null) {
  const item = (mark, text) => `<div class="lg-row"><span class="lg-mark">${mark}</span><span>${text}</span></div>`;
  return `<details class="legend"><summary class="btn">Key</summary><div class="lg-pop">
    ${item(`<span class="lg-stripe"></span>`, "Left stripe: the club decision (green pass, amber hold, red fail)")}
    ${item(signedBadge({ is_signed: true }), "Officially signed to Hearts of Pine; magenta frame on the player card")}
    ${reviewAfterDays != null ? item(`<span class="roster review">Review</span>`, `Review pill: no review in ${reviewAfterDays} days or more (never for players on the Short Board); the card shows days since last review in red`) : ""}
    ${ncaa ? item(`<span class="bbtag">BB</span>`, "On the Big Board, the college players being pursued; hover anyone else for + BB")
      : item(`<span class="vdots"><i class="vdot v-pass"></i><i class="vdot v-hold"></i><i class="vdot"></i></span>`, "Staff verdicts, one dot per person (shown once anyone has one)")}
    ${item("★", "Top target: on the Short Board")}
    ${item(longThrowBadge({ has_long_throw: true }), "Long throw")}
    ${item(`<span class="roster dom">DOM</span><span class="roster intl">INTL</span>`, "Domestic or international (US citizenship, or set by hand)")}
    ${item(`<span class="roster unk">?</span>`, "Roster status not known yet: set it in Edit details")}
    ${ncaa ? item(`<span class="grade g-a">B/A</span>`, "College grade, now / ceiling, coloured by the ceiling (A green, B blue, C amber, D red)")
      : item(`<span class="roster ncaa">B/B</span>`, "College player, showing their college grade (now / ceiling)")}
    ${item(`<span class="roster l2">L2’26</span>`, "Picked for that year's USL League Two Top Prospects report")}
    ${item(`<span class="newrpt">✎</span><span class="newrpt mine">✎</span>`, `New report in the last ${NEW_REPORT_DAYS} days (green: the latest is yours); hover for who`)}
    ${ncaa ? item(`<span class="rep rep-agent">AGT</span><span class="rep rep-none">NO AGT</span>`, "Represented by an agent, an advisor (ADV), or no one") : ""}
    ${item(`<span class="roster more">+1</span>`, "More tags: hover to see them")}
  </div></details>`;
}
// College players: their league is entered by hand, so anything naming NCAA ("NCAA", "NCAA D1") counts.
const isNcaa = (p) => /\bncaa\b/i.test(p.league || "");
// The lavender chip says college; when the college database grades the player, it shows the grade instead of "NCAA".
const ncaaBadge = (p) => (isNcaa(p) ? `<span class="roster ncaa" title="College (${esc(p.league.trim())})${p.college_grade ? `, college grade ${esc(p.college_grade)} (current/future)` : ""}">${p.college_grade ? esc(p.college_grade) : "NCAA"}</span>` : "");

// The number on a card is its place in the role: on the Big Board its big-board rank, on the Short Board
// its place among the top targets (spot), so the targets read 1, 2, 3 rather than 1, 5, 6, 10.
function boardCard(p, role, targetsOnly = false, spot = null) {
  const place = targetsOnly && spot != null ? spot : rankIn(p, role);
  const reviewed = toDate(p.last_review_at);
  const days = reviewed ? Math.floor((Date.now() - reviewed) / 864e5) : null;
  // Top targets (anyone on the Short Board) never get the review flag, on either board.
  const onShortBoard = (p.roles || []).some((r) => r.shortlist);
  const needsReview = Boolean(role && !onShortBoard && days != null && days >= S.config.review_after_days);
  // Outside tagRow's three-tag limit: Review must always remain visible.
  const review = needsReview ? `<span class="roster review" title="Last review ${days} days ago">Review</span>` : "";
  const heading = needsReview ? `<span class="review-heading">${nameWithMark(p)}${review}</span>` : nameWithMark(p);
  const reviewAge = needsReview ? `<span class="review-age">Last review ${days} days ago</span>` : "";
  // College clubs carry the school in brackets ("Indiana Hoosiers (Indiana University)"); the team name is enough here.
  const club = p.club && isNcaa(p) ? p.club.replace(/\s*\([^)]*\)\s*$/, "") : p.club;
  const sub = [p.age, club].filter((x) => x != null && x !== "").join(" · ") || p.position || "";
  const on = role ? isTopTarget(p, role) : false;
  // The whole card is a link, so the star is a span with a button role; the board's click handler
  // intercepts it before the link fires.
  const star = role ? `<span class="star ${on ? "on" : ""}" data-star="${role}" role="button" tabindex="0"
    aria-pressed="${on}" title="${on ? "Remove from the Short Board" : "Add to the Short Board as a top target"}">${on ? "★" : "☆"}</span>` : "";
  return `<a class="pcard ${needsReview ? "needs-review" : ""} ${p.is_signed ? "is-signed" : ""} ${p.decision ? "v-" + p.decision : ""}" href="#/player/${p.id}" draggable="true" data-pid="${p.id}" ${role ? `data-role="${role}" title="${esc(boardReasonTooltip(p, role))}"` : ""}>
    ${role ? `<span class="rank ${place < 3 ? "podium" : ""}">${place + 1}</span>` : ""}${photo(p)}
    <span class="ci">${heading}${reviewAge}<div class="nm-row"><span class="csub">${esc(sub)}</span>${tagRow([rosterBadge(p), ncaaBadge(p), l2Badge(p.l2)])}</div></span>${Object.keys(p.verdicts || {}).length ? verdictDots(p.verdicts) : ""}${star}</a>`;
}

// Star clicks and Enter/Space on a star, on either board.
function wireStars(root) {
  const toggle = async (el) => {
    const role = el.dataset.star, pid = Number(el.closest(".pcard").dataset.pid);
    el.classList.add("busy");
    try {
      const p = S.byId.get(pid), on = !isTopTarget(p, role);
      const reason = await askBoardReason(on ? 'promote' : 'drop_back', p.name, [role]);
      if (!reason) return;
      await api("POST", "/api/board/shortlist", { player_id: pid, role, on, reason });
      await afterMutation();
    } catch (err) { oops(err); } finally { el.classList.remove("busy"); }
  };
  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-star]");
    if (!el) return;
    e.preventDefault();
    toggle(el);
  });
  root.addEventListener("keydown", (e) => {
    const el = e.target.closest?.("[data-star]");
    if (!el || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    toggle(el);
  });
}

function applyBoardFilter(root) {
  const f = S.board;
  $$(".pcard", root).forEach((c) => {
    const p = S.byId.get(Number(c.dataset.pid));
    c.hidden = !(p && matchDecision(p, f.decision) && (!f.league || p.league === f.league) && matchText(p, f.q));
  });
}

// Where a drop lands in the role's big-board order. On the Short Board you only see the top targets,
// so "before this target" means "immediately before them on the big board", and a drop past the last
// one puts the player straight after it rather than behind every unstarred player.
function dropIndexFor(role, pid, beforePid, short) {
  const others = playersInRole(role).filter((p) => p.id !== pid);
  if (beforePid != null) {
    const at = others.findIndex((p) => p.id === beforePid);
    if (at >= 0) return at;
  }
  if (!short) return others.length;
  const lastTarget = others.filter((p) => isTopTarget(p, role)).pop();
  return lastTarget ? others.indexOf(lastTarget) + 1 : others.length;
}

// A top target dropped into another role on the Short Board: move them, or keep them in both roles
// (a top target in each). Already a top target there? Only moving makes sense.
function chooseMoveOrCopy(pid, from, to, index) {
  const p = S.byId.get(pid);
  const already = isTopTarget(p, to);
  const m = modal(`<header class="m-h"><h2>Move or duplicate?</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <p><b>${esc(p.name)}</b> is a top target at <b>${esc(roleLabel(from))}</b>. Put them at <b>${esc(roleLabel(to))}</b> by:</p>
    <div class="choice-list">
      <button type="button" class="choice" data-act="move"><b>Move</b><span>Take them off ${esc(roleShort(from))} and onto ${esc(roleShort(to))}.</span></button>
      <button type="button" class="choice" data-act="copy" ${already ? "disabled" : ""}><b>Duplicate</b>
        <span>${already ? `Already a top target at ${esc(roleShort(to))}.` : `Keep them at ${esc(roleShort(from))} and add them to ${esc(roleShort(to))} too.`}</span></button>
    </div>
    <div class="row end" style="margin-top:12px"><button type="button" class="btn ghost" data-close>Cancel</button></div>`);
  $("[data-act='move']", m).focus();
  m.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]:not([disabled])")?.dataset.act;
    if (!act) return;
    try {
      let reason;
      if (act === "copy") {
        reason = await askBoardReason(p.roles.some(r=>r.role === to) ? 'promote' : 'add', p.name, [to], 'Duplicate as a top target, keeping the original role.');
        if (!reason) return;
      }
      await api("POST", "/api/board/move", { player_id: pid, from_role: from, to_role: to, index, copy: act === "copy", reason });
      closeModal();
      await afterMutation();
      toast(act === "copy" ? `${p.name} is a top target at ${roleShort(to)} too` : `Moved ${p.name} to ${roleShort(to)}`);
    } catch (err) { oops(err); }
  });
}

function cardAfter(zone, y) {
  return $$(".pcard:not(.dragging)", zone).filter((c) => !c.hidden)
    .find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
}

function wireBoard(root, { short = false } = {}) {
  wireStars(root);
  if (!short) {
    applyBoardFilter(root);
    $("#bf-dec", root).addEventListener("click", (e) => {
      const b = e.target.closest("button[data-k]");
      if (!b) return;
      S.board.decision = b.dataset.k;
      $$("#bf-dec button", root).forEach((x) => x.classList.toggle("on", x === b));
      applyBoardFilter(root);
    });
    $("#bf-league", root).addEventListener("change", (e) => { S.board.league = e.target.value; applyBoardFilter(root); });
    $("#bf-q", root).addEventListener("input", (e) => { S.board.q = e.target.value; applyBoardFilter(root); });
  }
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-add-role]");
    if (b) { e.preventDefault(); openRolePicker(b.dataset.addRole); }
  });
  // On the Short Board a card can go to any role's lane; dropping it into a different role asks whether
  // to move the player or keep them in both (see chooseMoveOrCopy).
  wireCardDrag(root, ".lane-body", (zone, card, before) => {
    const pid = Number(card.dataset.pid), from = card.dataset.role || null;
    const index = dropIndexFor(zone.dataset.role, pid, before ? Number(before.dataset.pid) : null, Boolean(zone.dataset.short));
    if (zone.dataset.short && from && from !== zone.dataset.role) { chooseMoveOrCopy(pid, from, zone.dataset.role, index); return null; }
    return api("POST", "/api/board/move", { player_id: pid, from_role: from, to_role: zone.dataset.role, index });
  });
}

// Drag a card into a lane (a marker shows where it will land) or onto the tray. `zones` selects the drop
// targets; onDrop(zone, card, cardBelow) returns the request to make, if any, and the page refreshes after.
function wireCardDrag(root, zones, onDrop) {
  let marker = null;
  const clear = () => { marker?.remove(); marker = null; $$(".over", root).forEach((x) => x.classList.remove("over")); };
  root.addEventListener("dragstart", (e) => {
    const card = e.target.closest?.(".pcard[draggable]");
    if (!card) return;
    S.dragging = { pid: Number(card.dataset.pid), el: card };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.pid);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  root.addEventListener("dragend", () => { S.dragging?.el?.classList.remove("dragging"); S.dragging = null; clear(); });
  root.addEventListener("dragover", (e) => {
    if (!S.dragging) return;
    const zone = e.target.closest(zones);
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!zone.classList.contains("over")) { $$(".over", root).forEach((x) => x.classList.remove("over")); zone.classList.add("over"); }
    if (!zone.matches("[data-tray]")) {
      marker ??= Object.assign(document.createElement("div"), { className: "drop-marker" });
      const before = cardAfter(zone, e.clientY);
      if (before) zone.insertBefore(marker, before); else zone.appendChild(marker);
    } else marker?.remove();
  });
  root.addEventListener("dragleave", (e) => {
    const zone = e.target.closest?.(zones);
    if (zone && !zone.contains(e.relatedTarget)) { zone.classList.remove("over"); if (marker && zone.contains(marker)) marker.remove(); }
  });
  root.addEventListener("drop", async (e) => {
    if (!S.dragging) return;
    const zone = e.target.closest(zones);
    if (!zone) return;
    e.preventDefault();
    const card = S.dragging.el;
    const before = zone.matches("[data-tray]") ? null : cardAfter(zone, e.clientY);
    clear();
    S.dragging = null;
    card.classList.remove("dragging");
    const req = onDrop(zone, card, before);
    if (!req) return;
    try { await req; await afterMutation(); } catch (err) { oops(err); }
  });
}

function openRolePicker(role) {
  const m = modal(`<header class="m-h"><h2>Add to ${esc(roleLabel(role))}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="row"><input id="rp-q" type="search" placeholder="Search players already in PINE…" style="flex:1"><button type="button" class="btn primary" id="rp-new">+ New from Transfermarkt</button></div>
    <div class="picker-list" id="rp-list"></div>`);
  const draw = () => {
    const q = $("#rp-q", m).value.trim();
    const list = S.players.filter((p) => !p.roles.some((r) => r.role === role) && matchText(p, q)).slice(0, 60);
    $("#rp-list", m).innerHTML = list.map((p) => `<button type="button" class="pcard ${p.is_signed ? "is-signed" : ""} ${p.decision ? "v-" + p.decision : ""}" data-pick="${p.id}">${photo(p)}
      <span class="ci">${nameWithMark(p)}<div class="csub">${esc([p.position, p.club].filter(Boolean).join(" · "))}</div></span>
      ${p.roles.length ? `<span class="chip">${esc(p.roles.map((r) => roleShort(r.role)).join(", "))}</span>` : ""}</button>`).join("")
      || `<p class="empty">No matching players. Add a new one from Transfermarkt.</p>`;
  };
  $("#rp-q", m).addEventListener("input", draw);
  draw();
  $("#rp-q", m).focus();
  m.addEventListener("click", async (e) => {
    if (e.target.closest("#rp-new")) return openAddPlayer({ role });
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    try {
      const reason = await askBoardReason('add', S.byId.get(Number(b.dataset.pick)).name, [role]);
      if (!reason) return;
      await api("POST", `/api/players/${b.dataset.pick}/roles`, { role, reason }); closeModal(); toast("Added to the board"); await afterMutation(); } catch (err) { oops(err); }
  });
}

/* ---------- add / edit player ---------- */
function rolePicker(host, { position = null, selected = [] } = {}) {
  const st = { position: position || S.config.positions[0].code, selected: new Set(selected) };
  const draw = () => {
    const pos = S.config.positions.find((p) => p.code === st.position);
    host.innerHTML = `<label class="lbl">Big board role(s)</label>
      <div class="rp">
        <select class="rp-pos" aria-label="Position">${S.config.positions.map((p) => `<option value="${p.code}" ${p.code === st.position ? "selected" : ""}>${p.code} · ${esc(p.label)}</option>`).join("")}</select>
        <div class="rp-roles">${pos.roles.map(([c, l], i) => `<button type="button" class="toggle ${st.selected.has(c) ? "on" : ""}" data-role="${c}">#${i + 1} ${esc(l)}</button>`).join("")}</div>
      </div>
      <div class="rp-sel">${[...st.selected].map((c) => `<span class="chip">${esc(roleLabel(c))}<button type="button" data-rm="${c}" aria-label="Remove ${esc(roleLabel(c))}">×</button></span>`).join("") || `<span class="muted sm">No role picked. You can add one later.</span>`}</div>`;
  };
  host.addEventListener("change", (e) => { if (e.target.matches(".rp-pos")) { st.position = e.target.value; draw(); } });
  host.addEventListener("click", (e) => {
    const t = e.target.closest("[data-role]");
    if (t) { const c = t.dataset.role; st.selected.has(c) ? st.selected.delete(c) : st.selected.add(c); draw(); }
    const r = e.target.closest("[data-rm]");
    if (r) { st.selected.delete(r.dataset.rm); draw(); }
  });
  draw();
  return st;
}

function decisionPicker(host) {
  const st = { value: null };
  const draw = () => { host.innerHTML = `<label class="lbl">Club decision (optional)</label>${seg(st.value, "dp")}`; };
  host.addEventListener("click", (e) => { const b = e.target.closest("[data-dp]"); if (b) { st.value = b.dataset.dp || null; draw(); } });
  draw();
  return st;
}

function previewHTML(d) {
  const p = d.profile;
  const phys = d.physical.filter((x) => x.auto);
  return `${d.duplicate ? `<div class="banner warn"><b>${esc(d.duplicate.name)}</b> is already in PINE. <a href="#/player/${d.duplicate.id}" data-close>Open profile →</a></div>` : ""}
    <div class="pv">${photo(p, "lg")}
      <div style="min-width:0;flex:1">
        <h3>${esc(p.name)}</h3>
        <div class="p-sub">${esc([p.position, p.club, p.league].filter(Boolean).join(" · "))}</div>
        <dl class="facts">
          ${fact("Age", p.birthdate ? `${ageFrom(p.birthdate)} (${fmtDate(p.birthdate)})` : null)}
          ${fact("Height", p.height_cm ? `${p.height_cm} cm` : null)}
          ${fact("Foot", cap(p.foot))}
          ${fact("Citizenship", p.citizenship.join(", "))}
          ${fact("Contract", fmtDate(p.contract_expires))}
          ${fact("Market value", p.market_value_display)}
          ${fact("Agent", p.agent)}
        </dl>
        <div class="matches">
          <span class="match ${phys.length ? "ok" : ""}">Physical data: ${phys.length ? `${phys.length} season row${phys.length > 1 ? "s" : ""} found` : "no match"}</span>
          <span class="match ${d.impect ? "ok" : ""}">Impect: ${d.impect ? esc([d.impect.competition, d.impect.season, d.impect.squad].filter(Boolean).join(" · ")) : "no confident match"}</span>
        </div>
      </div>
    </div>
    ${d.duplicate ? "" : `<div class="assign"><div class="rp-host"></div><div class="dec-host"></div><div class="college-host"></div>
      <div class="m-actions" style="margin-top:0"><button type="button" class="btn primary" id="tm-save">Add to PINE</button></div></div>`}`;
}

// The college part of Add player: an NCAA board spot and a first report (grade, class, school), for college players.
const collegeAddHTML = (school, board) => `<div class="college-add"><div class="lbl">College scouting</div>
  <p class="hint">Optional. A grade and report here give them a college profile, like the imported players.</p>
  ${collegeFormHTML({}, { school: school || "", board: board || "" })}</div>`;
async function saveCollegeExtras(player, host) {
  const form = host?.querySelector(".college-add");
  if (!form) return;
  const pos = form.querySelector("[name=ncaa_position]")?.value;
  if (pos) await api("POST", "/api/ncaa/move", { player_id: player.id, position: pos, index: null });
  const fields = Object.fromEntries([...form.querySelectorAll("[name]")].filter((el) => el.name !== "ncaa_position").map((el) => [el.name, el.value]));
  if (fields.grade_present || fields.body?.trim()) await api("POST", `/api/players/${player.id}/college/reports`, fields);
}

function openAddPlayer({ role = null, url = "", college = false } = {}) {
  const pos = role ? roleInfo(role).position : null;
  const m = modal(`<header class="m-h"><h2>Add a player</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="tabs" role="tablist"><button type="button" class="on" data-tab="tm">Transfermarkt link</button><button type="button" data-tab="manual">Manual entry</button></div>
    <div data-pane="tm">
      <form id="tm-form" class="row"><input id="tm-url" type="url" required placeholder="https://www.transfermarkt.com/…/profil/spieler/…" style="flex:1" value="${esc(url)}" aria-label="Transfermarkt link"><button class="btn primary" type="submit">Fetch</button></form>
      <p class="hint" style="margin-top:6px">Paste any Transfermarkt player page. Profile info is pulled right away, and physical data and Impect are matched automatically.</p>
      <div id="tm-out"></div>
    </div>
    <div data-pane="manual" hidden>
      <form id="man-form">
        <div class="form-grid">
          <div><label class="lbl" for="mf-name">Name *</label><input id="mf-name" name="name" required></div>
          <div><label class="lbl" for="mf-pos">Position</label><input id="mf-pos" name="position" placeholder="e.g. Centre-Back"></div>
          <div><label class="lbl" for="mf-club">Club</label><input id="mf-club" name="club"></div>
          <div><label class="lbl" for="mf-league">League</label><input id="mf-league" name="league" value="${college ? "NCAA" : ""}"></div>
          <div><label class="lbl" for="mf-dob">Date of birth</label><input id="mf-dob" name="birthdate" type="date"></div>
          <div><label class="lbl" for="mf-foot">Foot</label><select id="mf-foot" name="foot"><option value="">Unknown</option><option>right</option><option>left</option><option>both</option></select></div>
        </div>
        <div class="assign"><div class="rp-host"></div><div class="dec-host"></div><div class="college-host"></div></div>
        <div class="m-actions"><button class="btn primary" type="submit">Add to PINE</button></div>
      </form>
    </div>`, { wide: true });

  m.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (!t) return;
    $$("[data-tab]", m).forEach((b) => b.classList.toggle("on", b === t));
    $$("[data-pane]", m).forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
  });

  const created = async (player) => {
    closeModal();
    toast(`${player.name} added to PINE`);
    await syncVersion();
    await reloadPlayers();
    location.hash = `#/player/${player.id}`;
  };

  const manPane = $('[data-pane="manual"]', m);
  const manRoles = rolePicker($(".rp-host", manPane), { position: pos, selected: role ? [role] : [] });
  const manDec = decisionPicker($(".dec-host", manPane));
  // The college fields appear once the league says NCAA (or straight away from the NCAA page).
  const manCollege = $(".college-host", manPane);
  const showManCollege = () => {
    const on = isNcaa({ league: $("#mf-league", m).value });
    if (on && !manCollege.firstChild) manCollege.innerHTML = collegeAddHTML($("#mf-club", m).value, pos || "");
    manCollege.hidden = !on;
  };
  $("#mf-league", m).addEventListener("input", showManCollege);
  showManCollege();
  $("#man-form", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries([...e.target.querySelectorAll(".form-grid [name]")].map((el) => [el.name, el.value]));
    try {
      const roles = [...manRoles.selected];
      const reason = await askBoardReason(roles.length ? 'add' : 'track', fields.name, roles);
      if (!reason) return;
      const r = await api("POST", "/api/players", { ...fields, roles, decision: manDec.value, reason });
      if (!manCollege.hidden) await saveCollegeExtras(r.player, manCollege).catch(oops);
      await created(r.player);
    } catch (err) { oops(err); }
  });

  let lastUrl = "";
  const doFetch = async () => {
    const u = $("#tm-url", m).value.trim();
    if (!u || u === lastUrl) return;
    lastUrl = u;
    const out = $("#tm-out", m);
    out.innerHTML = `<div class="loading">Pulling from Transfermarkt…</div>`;
    try {
      const d = await api("POST", "/api/tm/preview", { url: u });
      out.innerHTML = previewHTML(d);
      if (d.duplicate) return;
      const rp = rolePicker($(".rp-host", out), { position: pos || d.suggested_position, selected: role ? [role] : [] });
      const dp = decisionPicker($(".dec-host", out));
      const collegeHost = $(".college-host", out);
      if (college || isNcaa({ league: d.profile.league })) {
        collegeHost.innerHTML = collegeAddHTML((d.profile.club || "").replace(/\s*\([^)]*\)\s*$/, ""), pos || d.suggested_position || "");
      }
      $("#tm-save", out).addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Adding…";
        try {
          const roles = [...rp.selected];
          const reason = await askBoardReason(roles.length ? 'add' : 'track', d.profile.name, roles);
          if (!reason) { btn.disabled = false; btn.textContent = "Add to PINE"; return; }
          const r = await api("POST", "/api/players", { tm_url: u, roles, decision: dp.value, reason });
          await saveCollegeExtras(r.player, collegeHost).catch(oops);
          await created(r.player);
        } catch (err) { btn.disabled = false; btn.textContent = "Add to PINE"; oops(err); }
      });
    } catch (err) {
      lastUrl = "";
      out.innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  };
  $("#tm-form", m).addEventListener("submit", (e) => { e.preventDefault(); lastUrl = ""; doFetch(); });
  $("#tm-url", m).addEventListener("paste", () => setTimeout(doFetch, 0));
  if (url) doFetch(); else $("#tm-url", m).focus();
}

function openEditPlayer(p) {
  const F = [
    ["name", "Name", "text"], ["position", "Position", "text"], ["club", "Club", "text"], ["league", "League", "text"],
    ["birthdate", "Date of birth", "date"], ["birthplace", "Birthplace", "text"], ["height_cm", "Height (cm)", "number"],
    ["foot", "Foot", "text"], ["contract_expires", "Contract expires", "date"], ["joined", "Joined", "date"],
    ["loan_from", "On loan from", "text"], ["agent", "Agent", "text"], ["market_value_display", "Market value", "text"],
    ["national_team", "National team", "text"], ["photo_url", "Photo URL", "url"],
  ];
  const auto = rosterFromCitizenship(p);
  const m = modal(`<header class="m-h"><h2>Edit ${esc(p.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <form id="ep"><div class="form-grid">${F.map(([k, l, t]) => `<div><label class="lbl" for="ep-${k}">${l}</label><input id="ep-${k}" name="${k}" type="${t}" value="${esc(p[k] ?? "")}"></div>`).join("")}
      <div><label class="lbl" for="ep-roster_status">Roster status</label><select id="ep-roster_status" name="roster_status">
        <option value="">${auto ? `Auto: ${cap(auto)}` : "Auto (no citizenship)"}</option>
        ${ROSTER_STATUSES.map((s) => `<option value="${s}" ${p.roster_status === s ? "selected" : ""}>${cap(s)}</option>`).join("")}
      </select></div>
      <div><label class="lbl" for="ep-long_throw_override">Long throw</label><select id="ep-long_throw_override" name="long_throw_override">
        <option value="" ${p.long_throw_override == null ? "selected" : ""}>Auto: ${p.long_throw_detected ? "Yes" : "No"}</option>
        <option value="1" ${p.long_throw_override === 1 ? "selected" : ""}>Yes</option>
        <option value="0" ${p.long_throw_override === 0 ? "selected" : ""}>No</option>
      </select><p class="hint">Yes or No overrides automatic detection. Auto: No means no qualifying throw has been observed.</p></div></div>
    <p class="hint" style="margin-top:10px">Roster status follows citizenship unless you pick Domestic or International, e.g. for a green-card holder.${p.tm_id ? " Manual changes are preserved when you sync from Transfermarkt later." : ""}</p>
    <div class="m-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`, { wide: true });
  $("#ep", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.target));
    fields.long_throw_override = fields.long_throw_override === "" ? null : fields.long_throw_override === "1";
    try { await api("PATCH", `/api/players/${p.id}`, fields); closeModal(); toast("Saved"); await afterMutation(); } catch (err) { oops(err); }
  });
}

const TM_FIELD_LABELS = {
  name: "Name", birthdate: "Date of birth", birthplace: "Birthplace", height_cm: "Height", foot: "Foot",
  position: "Position", club: "Club", league: "League", joined: "Joined", contract_expires: "Contract expires",
  loan_from: "On loan from", agent: "Agent", market_value_display: "Market value", national_team: "National team",
  photo_url: "Photo URL",
};
const tmValue = (value) => value == null || value === "" ? "Not listed" : String(value);

function openTmConflicts(playerId, conflicts) {
  const m = modal(`<header class="m-h"><h2>Manual details preserved</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <p class="hint">Select any values you want to restore from Transfermarkt. Unchecked fields will keep their manual values.</p>
    <form id="tm-conflicts"><div class="tm-conflicts">${conflicts.map((c) => `<label class="tm-conflict">
      <input type="checkbox" name="field" value="${esc(c.field)}">
      <span><b>${esc(TM_FIELD_LABELS[c.field] || c.field)}</b><small>Manual: ${esc(tmValue(c.current))}</small><small>Transfermarkt: ${esc(tmValue(c.transfermarkt))}</small></span>
    </label>`).join("")}</div>
    <div class="m-actions"><button type="button" class="btn ghost" data-close>Keep manual values</button><button class="btn primary" type="submit">Use selected Transfermarkt values</button></div></form>`);
  $("#tm-conflicts", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = new FormData(e.target).getAll("field");
    if (!fields.length) return toast("Select at least one field", true);
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true;
    btn.textContent = "Updating…";
    try {
      await api("POST", `/api/players/${playerId}/refresh-tm`, { accept_fields: fields });
      closeModal();
      toast("Selected fields restored from Transfermarkt");
      await afterMutation();
    } catch (err) { btn.disabled = false; btn.textContent = "Use selected Transfermarkt values"; oops(err); }
  });
}

/* ---------- database table ---------- */
// Where the players off the boards live, so it's built for finding people: quick views by board status, labelled
// filters (position group, age, league, roster, contract, value, verdicts, exit reason…), removable chips for
// what's on, and sorting on every column with blanks last. The filters and sort are remembered in this browser.

// Transfermarkt's and hand-typed positions ("Centre-Back", "Right Center Back", "CB") into one group each; a
// player with no recognisable position falls back to his Big Board role.
const POS_GROUPS = [
  ["GK", "GK", /goal|keeper|^gk$/],
  ["CB", "CB", /cent(re|er)[- ]?back|^[lr]?cb$|^defender$/],
  ["FB", "FB", /\bback\b|wing[- ]?back|^[lr]w?b$/],
  ["AM", "AM", /attacking|^c?am$|second striker/],
  ["MID", "DM/CM", /defensive|central mid|^midfield(er)?$|^c?dm$|^cm$/],
  ["W", "W", /wing|(left|right) mid|^[lr][wm]$/],
  ["ST", "ST", /forward|striker|^attack$|^fwd$|^st$|^cf$/],
];
const ROLE_POS_GROUP = { GK: "GK", LCB: "CB", RCB: "CB", LB: "FB", RB: "FB", CDM: "MID", CM: "MID", AM: "AM", LW: "W", RW: "W", FWD: "ST" };
function posGroup(p) {
  const s = String(p.position || "").trim().toLowerCase();
  const hit = s && POS_GROUPS.find(([, , re]) => re.test(s));
  if (hit) return hit[0];
  const role = p.roles?.[0] && roleInfo(p.roles[0].role);
  return (role && ROLE_POS_GROUP[role.position]) || null;
}
const posGroupLabel = (g) => POS_GROUPS.find(([k]) => k === g)?.[1] || "";
// League names are typed several ways; one name each for filtering and sorting (college conferences count as NCAA).
const LEAGUE_ALIASES = { USLC: "USL Championship", USL1: "USL League One", "MLS NP": "MLS Next Pro", MLSNP: "MLS Next Pro" };
const leagueName = (p) => (isNcaa(p) ? "NCAA" : LEAGUE_ALIASES[(p.league || "").trim()] || (p.league || "").trim());

const DB_VIEWS = [
  ["all", "Everyone", () => true],
  ["off", "Off the boards", (p) => !p.roles.length && !p.ncaa_board],
  ["removed", "Removed from the Big Board", (p) => !p.roles.length && Boolean(p.last_exit)],
  ["bb", "Big Board", (p) => p.roles.length > 0],
  ["sb", "Short Board", (p) => p.roles.some((r) => r.shortlist)],
  ["ncaa", "NCAA board", (p) => Boolean(p.ncaa_board)],
  ["signed", "Signed", (p) => p.is_signed],
];
const thisYear = () => new Date().getFullYear();
const DB_CONTRACT = [
  ["y0", () => `Ends by Dec ${thisYear()}`, (d) => d && d <= `${thisYear()}-12-31`],
  ["y1", () => `Ends by Dec ${thisYear() + 1}`, (d) => d && d <= `${thisYear() + 1}-12-31`],
  ["none", () => "No contract date", (d) => !d],
];
const DB_VALUE = [
  ["100", "Up to €100k", (v) => v != null && v <= 1e5], ["250", "Up to €250k", (v) => v != null && v <= 2.5e5],
  ["500", "Up to €500k", (v) => v != null && v <= 5e5], ["1000", "Up to €1m", (v) => v != null && v <= 1e6],
  ["none", "No value listed", (v) => v == null],
];
const DB_VERDICT = [
  ["pass", "Someone passed", (p) => Object.values(p.verdicts || {}).includes("pass")],
  ["hold", "Someone held", (p) => Object.values(p.verdicts || {}).includes("hold")],
  ["fail", "Someone failed", (p) => Object.values(p.verdicts || {}).includes("fail")],
  ["none", "No verdicts yet", (p) => !Object.keys(p.verdicts || {}).length],
  ["notme", "No verdict from me", (p) => !(p.verdicts || {})[S.me.name]],
];
const DB_ROSTER = [["", "Any"], ["domestic", "DOM"], ["international", "INTL"], ["unknown", "?"]];
const DB_DEFAULTS = { view: "all", q: "", pos: [], ageMin: "", ageMax: "", leagues: [], roster: "", contract: "", value: "", verdict: "",
  decision: "all", foot: "", heightMin: "", exit: "", boardPos: "", reports: "", addedBy: [], changedBy: [], sort: "updated_at", dir: -1, more: false };
const DB_KEY = "pine.database.v2";
const dbState = () => (S.table ||= (() => { try { return { ...DB_DEFAULTS, ...JSON.parse(localStorage.getItem(DB_KEY) || "{}") }; } catch { return { ...DB_DEFAULTS }; } })());
const saveDbState = () => { try { localStorage.setItem(DB_KEY, JSON.stringify(S.table)); } catch {} };

const STATUS_RANK = (p) => (p.roles.some((r) => r.shortlist) ? 0 : p.roles.length ? 1 : p.ncaa_board ? 2 : p.last_exit ? 3 : 4);
// Each column's sort key; null sorts last whichever way the column runs.
const COLS = [
  { k: "name", l: "Player", sort: (p) => p.name.toLowerCase() },
  { k: "pos", l: "Pos", sort: (p) => { const i = POS_GROUPS.findIndex(([g]) => g === posGroup(p)); return i < 0 ? null : i; } },
  { k: "age", l: "Age", sort: (p) => p.age ?? null },
  { k: "height_cm", l: "Ht", sort: (p) => p.height_cm ?? null, desc: true },
  { k: "club", l: "Club", sort: (p) => (p.club ? p.club.toLowerCase() : null) },
  { k: "league", l: "League", sort: (p) => leagueName(p).toLowerCase() || null },
  { k: "board", l: "Board", sort: (p) => STATUS_RANK(p) * 1000 + (p.roles[0]?.rank ?? 999) },
  { k: "contract_expires", l: "Contract", sort: (p) => p.contract_expires || null },
  { k: "market_value_eur", l: "Value", sort: (p) => p.market_value_eur ?? null, desc: true },
  { k: "decision", l: "Decision", sort: (p) => ({ pass: 0, hold: 1, fail: 2 })[p.decision] ?? null },
  { k: "verdicts", l: "Staff", sort: (p) => { const v = Object.values(p.verdicts || {}); return v.length ? -(v.filter((x) => x === "pass").length * 100 + v.filter((x) => x === "hold").length) : null; } },
  { k: "reports", l: "Reports", sort: (p) => p.last_report?.at || null, desc: true },
  { k: "updated_at", l: "Updated", sort: (p) => p.updated_at || null, desc: true },
];

// Everything but the view tab, so each tab can show how many players it holds under the other filters.
function dbMatches(p, f) {
  const age = p.age, h = p.height_cm, d = p.contract_expires ? String(p.contract_expires).slice(0, 10) : null;
  const roster = rosterStatus(p) || "unknown";
  return textMatch(f.q, p.name, p.club, p.league, leagueName(p), p.position, (p.citizenship || []).join(" "), p.agent)
    && (!f.pos.length || f.pos.includes(posGroup(p)))
    && (f.ageMin === "" || (age != null && age >= Number(f.ageMin))) && (f.ageMax === "" || (age != null && age <= Number(f.ageMax)))
    && (!f.leagues.length || f.leagues.includes(leagueName(p)))
    && (!f.roster || roster === f.roster)
    && (!f.contract || DB_CONTRACT.find(([k]) => k === f.contract)?.[2](d))
    && (!f.value || DB_VALUE.find(([k]) => k === f.value)?.[2](p.market_value_eur ?? null))
    && (!f.verdict || DB_VERDICT.find(([k]) => k === f.verdict)?.[2](p))
    && matchDecision(p, f.decision)
    && (!f.foot || p.foot === f.foot)
    && (f.heightMin === "" || (h != null && h >= Number(f.heightMin)))
    && (!f.exit || (!p.roles.length && p.last_exit?.exit_reason === f.exit))
    && (!f.boardPos || (f.boardPos === "none" ? !p.roles.length : p.roles.some((r) => roleInfo(r.role)?.position === f.boardPos)))
    && (!f.reports || (f.reports === "yes" ? p.note_count > 0 || p.last_report : !p.note_count && !p.last_report))
    && (!f.changedBy.length || (p.changed_by || []).some((id) => f.changedBy.includes(Number(id))))
    && (!f.addedBy.length || f.addedBy.includes(Number(p.created_by)));
}
function tableFiltered() {
  const f = dbState();
  const view = (DB_VIEWS.find(([k]) => k === f.view) || DB_VIEWS[0])[2];
  const col = COLS.find((c) => c.k === f.sort) || COLS[0];
  const name = (p) => p.name.toLowerCase();
  return S.players.filter((p) => view(p) && dbMatches(p, f)).map((p) => [p, col.sort(p)]).sort(([a, x], [b, y]) => {
    if (x == null || y == null) return x == null && y == null ? name(a).localeCompare(name(b)) : x == null ? 1 : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * f.dir || name(a).localeCompare(name(b));
  }).map(([p]) => p);
}

// The filters that are on, as chips that each clear their own filter.
function dbActiveChips(f) {
  const staff = (ids) => S.config.staff.filter((s) => ids.includes(s.id)).map((s) => s.name).join(", ");
  const few = (list, one) => (list.length <= 2 ? list.join(", ") : `${list.length} ${one}`);
  return [
    f.q && ["q", `“${f.q}”`],
    f.pos.length && ["pos", `Position: ${f.pos.map(posGroupLabel).join(", ")}`],
    (f.ageMin !== "" || f.ageMax !== "") && ["age", f.ageMin !== "" && f.ageMax !== "" ? `Age ${f.ageMin}–${f.ageMax}` : f.ageMin !== "" ? `Age ${f.ageMin}+` : `Age up to ${f.ageMax}`],
    f.leagues.length && ["leagues", `League: ${few(f.leagues, "leagues")}`],
    f.roster && ["roster", { domestic: "Domestic", international: "International", unknown: "Roster status unknown" }[f.roster]],
    f.contract && ["contract", DB_CONTRACT.find(([k]) => k === f.contract)?.[1]()],
    f.value && ["value", DB_VALUE.find(([k]) => k === f.value)?.[1]],
    f.verdict && ["verdict", DB_VERDICT.find(([k]) => k === f.verdict)?.[1]],
    f.decision !== "all" && ["decision", `Decision: ${f.decision === "none" ? "Undecided" : cap(f.decision)}`],
    f.foot && ["foot", `${cap(f.foot)} foot`],
    f.heightMin !== "" && ["heightMin", `${f.heightMin} cm+`],
    f.exit && ["exit", `Removed: ${f.exit}`],
    f.boardPos && ["boardPos", f.boardPos === "none" ? "Not on the Big Board" : `Big Board: ${f.boardPos}`],
    f.reports && ["reports", f.reports === "yes" ? "Has reports" : "No reports"],
    f.addedBy.length && ["addedBy", `Added by ${staff(f.addedBy)}`],
    f.changedBy.length && ["changedBy", `Changed by ${staff(f.changedBy)}`],
  ].filter(Boolean);
}
const DB_CLEAR = { age: ["ageMin", "ageMax"] };

function renderTable(main) {
  const f = dbState();
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  const field = (label, control, cls = "") => `<div class="db-f ${cls}"><span class="db-l">${label}</span>${control}</div>`;
  // A dropdown of checkboxes (leagues, staff), the selection kept in an array on f.
  const pick = (id, key, label, options) => {
    const sel = f[key];
    const shown = sel.length ? (sel.length <= 2 ? options.filter((o) => sel.includes(o.v)).map((o) => o.short || o.l).join(", ") : `${sel.length} selected`) : label;
    return `<details class="coach-filter db-pick" id="${id}" data-key="${key}">
      <summary title="${esc(shown)}"><span>${esc(shown)}</span></summary>
      <div class="coach-filter-menu">
        <div class="coach-filter-h"><b>${esc(label)}</b><button type="button" class="btn link sm" data-clear ${sel.length ? "" : "disabled"}>Clear</button></div>
        ${options.map((o) => `<label><input type="checkbox" value="${esc(o.v)}" ${sel.includes(o.v) ? "checked" : ""}> <span>${esc(o.l)}</span>${o.n != null ? `<span class="muted sm db-n">${o.n}</span>` : ""}</label>`).join("")}
      </div></details>`;
  };
  const leagueCounts = new Map();
  for (const p of S.players) { const l = leagueName(p); if (l) leagueCounts.set(l, (leagueCounts.get(l) || 0) + 1); }
  const leagues = [...leagueCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l, n]) => ({ v: l, l, n }));
  const staffOpts = S.config.staff.map((s) => ({ v: s.id, l: s.name }));
  const decs = [["all", "Any"], ["pass", "Pass"], ["hold", "Hold"], ["fail", "Fail"], ["none", "Undecided"]];

  main.innerHTML = `<div class="page db-page">
    <div class="page-h"><div><h1>Database</h1><div class="sub" id="t-count"></div></div><div class="spacer"></div>
      <button type="button" class="btn" id="t-csv" title="Download the players shown, with these filters and this order">Export CSV</button></div>
    <div class="db-views" role="tablist" id="t-views"></div>
    <section class="panel db-filters">
      <input id="tf-q" class="db-q" type="search" placeholder="Search name, club, league, nationality or agent…" value="${esc(f.q)}" aria-label="Search players">
      <div class="db-grid">
        ${field("Position", `<div class="db-chips" id="tf-pos">${POS_GROUPS.map(([g, l]) => `<button type="button" data-pos="${g}" class="${f.pos.includes(g) ? "on" : ""}" aria-pressed="${f.pos.includes(g)}">${l}</button>`).join("")}</div>`, "wide")}
        ${field("Age", `<div class="db-range"><input type="number" id="tf-age-min" min="14" max="45" placeholder="Min" value="${esc(f.ageMin)}" aria-label="Minimum age"><span>–</span><input type="number" id="tf-age-max" min="14" max="45" placeholder="Max" value="${esc(f.ageMax)}" aria-label="Maximum age"></div>`)}
        ${field("League", pick("tf-leagues", "leagues", "All leagues", leagues))}
        ${field("Roster", `<div class="seg" id="tf-roster">${DB_ROSTER.map(([k, l]) => `<button type="button" data-v="${k}" class="${f.roster === k ? "on" : ""}" title="${k ? { domestic: "Domestic", international: "International", unknown: "Not known yet" }[k] : "Anyone"}">${l}</button>`).join("")}</div>`)}
        ${field("Contract", `<select id="tf-contract" aria-label="Contract"><option value="">Any</option>${DB_CONTRACT.map(([k, l]) => opt(k, l(), f.contract)).join("")}</select>`)}
        ${field("Value", `<select id="tf-value" aria-label="Market value"><option value="">Any</option>${DB_VALUE.map(([k, l]) => opt(k, l, f.value)).join("")}</select>`)}
        ${field("Staff verdicts", `<select id="tf-verdict" aria-label="Staff verdicts"><option value="">Any</option>${DB_VERDICT.map(([k, l]) => opt(k, l, f.verdict)).join("")}</select>`)}
        ${field("Club decision", `<select id="tf-dec" aria-label="Club decision">${decs.map(([k, l]) => opt(k, l, f.decision)).join("")}</select>`)}
        <div class="db-more" ${f.more ? "" : "hidden"}>
          ${field("Foot", `<select id="tf-foot" aria-label="Foot"><option value="">Any</option>${["left", "right", "both"].map((k) => opt(k, cap(k), f.foot)).join("")}</select>`)}
          ${field("Min height", `<input type="number" id="tf-height" min="150" max="210" placeholder="cm" value="${esc(f.heightMin)}" aria-label="Minimum height in cm">`)}
          ${field("Removed for", `<select id="tf-exit" aria-label="Exit reason"><option value="">Any reason</option>${S.config.board_reasons.exit_reasons.map((r) => opt(r, r, f.exit)).join("")}</select>`)}
          ${field("Big Board role", `<select id="tf-board" aria-label="Big Board position"><option value="">Any</option>${opt("none", "Not on the Big Board", f.boardPos)}${S.config.positions.map((p) => opt(p.code, `${p.code} · ${p.label}`, f.boardPos)).join("")}</select>`)}
          ${field("Reports", `<select id="tf-reports" aria-label="Reports"><option value="">Any</option>${opt("yes", "Has reports", f.reports)}${opt("no", "No reports yet", f.reports)}</select>`)}
          ${field("Added by", pick("tf-added-by", "addedBy", "Anyone", staffOpts))}
          ${field("Changed by", pick("tf-changed-by", "changedBy", "Anyone", staffOpts))}
        </div>
      </div>
      <div class="db-foot"><button type="button" class="btn link sm" id="tf-more">${f.more ? "Fewer filters" : "More filters"}</button>
        <div class="db-active" id="tf-active"></div></div>
    </section>
    <div class="table-wrap db-table"><table class="grid">
      <thead><tr>${COLS.map((c) => `<th data-sort="${c.k}" class="${f.sort === c.k ? "sorted" + (f.dir > 0 ? " asc" : "") : ""}" aria-sort="${f.sort === c.k ? (f.dir > 0 ? "ascending" : "descending") : "none"}">${c.l}</th>`).join("")}</tr></thead>
      <tbody id="t-body"></tbody>
    </table></div>
  </div>`;
  const root = main.firstElementChild;
  const exitTitle = (x) => [`Removed from ${roleLabel(x.role)}`, S.config.staff.find((s) => s.id === x.by)?.name, fmtDate(x.at), x.note && `Note: ${x.note}`].filter(Boolean).join(" · ");
  const row = (p) => {
    const g = posGroup(p), roster = rosterStatus(p);
    // College clubs carry the school in brackets; the team name is enough here (the full name shows on hover).
    const club = p.club && isNcaa(p) ? p.club.replace(/\s*\([^)]*\)\s*$/, "") : p.club || "";
    return `<tr class="${p.is_signed ? "is-signed" : ""}" data-href="#/player/${p.id}">
      <td class="name"><div class="db-name">${photo(p)}<div>${nameWithMark(p)}<div class="csub">${esc(p.position || "")}${p.foot ? ` · ${esc(cap(p.foot))}` : ""}
        ${roster ? `<span class="roster ${roster === "domestic" ? "dom" : "intl"}">${roster === "domestic" ? "DOM" : "INTL"}</span>` : ""}${l2Badge(p.l2)}</div></div></div></td>
      <td>${g ? `<span class="db-pos">${esc(posGroupLabel(g))}</span>` : ""}</td>
      <td>${p.age ?? ""}</td>
      <td>${p.height_cm ?? ""}</td>
      <td class="db-clip" title="${esc(p.club || "")}">${esc(club)}</td>
      <td class="db-clip" title="${esc(p.league || "")}">${esc(leagueName(p))}</td>
      <td class="db-board">${p.roles.map((r) => `<span class="chip ${r.shortlist ? "sb-chip" : ""}" title="${esc(roleLabel(r.role))}, rank ${r.rank + 1}${r.shortlist ? " · Short Board" : ""}">${r.shortlist ? "★ " : ""}${esc(roleShort(r.role))} <b>${r.rank + 1}</b></span>`).join("")}${p.ncaa_board
        ? `<span class="chip ncaa-chip" title="NCAA board, ${esc(p.ncaa_board.position)} rank ${p.ncaa_board.rank + 1}">NCAA ${esc(p.ncaa_board.position)} <b>${p.ncaa_board.rank + 1}</b></span>` : ""}${!p.roles.length && p.last_exit
        ? `<span class="db-exit" title="${esc(exitTitle(p.last_exit))}">Removed · ${esc(p.last_exit.exit_reason || "")}</span>` : ""}</td>
      <td class="${contractSoon(p.contract_expires) ? "warn" : ""}" title="${esc(fmtDate(p.contract_expires))}">${esc(toDate(p.contract_expires)?.toLocaleDateString("en-US", { month: "short", year: "numeric" }) || "")}</td>
      <td>${esc(p.market_value_display || "")}</td>
      <td>${p.decision ? decisionChip(p.decision) : ""}</td>
      <td>${verdictDots(p.verdicts)}</td>
      <td>${p.note_count ? `<b>${p.note_count}</b>` : ""}${p.last_report ? `<span class="muted"> ${p.note_count ? "· " : ""}${esc(relTime(p.last_report.at))}</span>` : ""}</td>
      <td class="muted">${relTime(p.updated_at)}</td>
    </tr>`;
  };
  const draw = () => {
    saveDbState();
    const list = tableFiltered();
    const others = S.players.filter((p) => dbMatches(p, f));
    $("#t-views", root).innerHTML = DB_VIEWS.map(([k, l, test]) => `<button type="button" role="tab" data-view="${k}" aria-selected="${f.view === k}" class="${f.view === k ? "on" : ""}">${esc(l)}<span class="db-vn">${others.filter(test).length}</span></button>`).join("");
    const col = COLS.find((c) => c.k === f.sort) || COLS[0];
    $("#t-count", root).textContent = `${list.length} of ${S.players.length} players · sorted by ${col.l.toLowerCase()} ${f.dir > 0 ? "↑" : "↓"}`;
    const chips = dbActiveChips(f);
    $("#tf-active", root).innerHTML = chips.length ? `${chips.map(([k, l]) => `<button type="button" class="db-chip" data-clear-key="${k}" title="Remove this filter">${esc(l)}<span aria-hidden="true">×</span></button>`).join("")}<button type="button" class="btn link sm" id="tf-clear">Clear all</button>` : `<span class="muted sm">No filters on</span>`;
    $("#t-body", root).innerHTML = list.map(row).join("") || `<tr><td colspan="${COLS.length}" class="empty-state">${S.players.length ? "No players match. Remove a filter above, or try another tab." : "No players yet. Click “+ Add player” and paste a Transfermarkt link."}</td></tr>`;
  };
  draw();

  const set = (key, value) => { f[key] = value; draw(); };
  $("#tf-q", root).addEventListener("input", (e) => set("q", e.target.value));
  for (const [id, key] of [["tf-age-min", "ageMin"], ["tf-age-max", "ageMax"], ["tf-height", "heightMin"]]) $(`#${id}`, root).addEventListener("input", (e) => set(key, e.target.value.trim()));
  for (const [id, key] of [["tf-contract", "contract"], ["tf-value", "value"], ["tf-verdict", "verdict"], ["tf-dec", "decision"], ["tf-foot", "foot"], ["tf-exit", "exit"], ["tf-board", "boardPos"], ["tf-reports", "reports"]])
    $(`#${id}`, root).addEventListener("change", (e) => set(key, e.target.value));
  $("#tf-pos", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-pos]");
    if (!b) return;
    const on = !f.pos.includes(b.dataset.pos);
    f.pos = on ? [...f.pos, b.dataset.pos] : f.pos.filter((x) => x !== b.dataset.pos);
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    draw();
  });
  $("#tf-roster", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    $$("#tf-roster button", root).forEach((x) => x.classList.toggle("on", x === b));
    set("roster", b.dataset.v);
  });
  for (const pickEl of $$(".db-pick", root)) {
    const key = pickEl.dataset.key, numeric = key !== "leagues";
    const update = () => {
      const labels = $$("input:checked", pickEl).map((i) => i.closest("label").querySelector("span").textContent);
      const shown = labels.length ? (labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`) : key === "leagues" ? "All leagues" : "Anyone";
      $("summary span", pickEl).textContent = shown;
      $("summary", pickEl).title = shown;
      $("[data-clear]", pickEl).disabled = !labels.length;
      draw();
    };
    pickEl.addEventListener("change", (e) => {
      const input = e.target.closest("input[type=checkbox]");
      if (!input) return;
      const v = numeric ? Number(input.value) : input.value;
      f[key] = input.checked ? [...f[key], v] : f[key].filter((x) => x !== v);
      update();
    });
    $("[data-clear]", pickEl).addEventListener("click", () => { f[key] = []; $$("input", pickEl).forEach((i) => (i.checked = false)); update(); });
  }
  $("#tf-more", root).addEventListener("click", (e) => {
    f.more = !f.more;
    $(".db-more", root).hidden = !f.more;
    e.target.textContent = f.more ? "Fewer filters" : "More filters";
    saveDbState();
  });
  // Clearing redraws the page so every control shows its reset value; the search box keeps focus if it was in it.
  $("#tf-active", root).addEventListener("click", (e) => {
    const chip = e.target.closest("[data-clear-key]");
    if (!chip && !e.target.closest("#tf-clear")) return;
    const keys = chip ? DB_CLEAR[chip.dataset.clearKey] || [chip.dataset.clearKey] : Object.keys(DB_DEFAULTS).filter((k) => !["view", "sort", "dir", "more"].includes(k));
    for (const k of keys) f[k] = structuredClone(DB_DEFAULTS[k]);
    saveDbState();
    renderTable(main);
  });
  $("#t-views", root).addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) set("view", b.dataset.view); });
  $("thead", root).addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    if (f.sort === th.dataset.sort) f.dir *= -1; else { f.sort = th.dataset.sort; f.dir = COLS.find((c) => c.k === f.sort)?.desc ? -1 : 1; }
    $$("th", root).forEach((x) => {
      x.className = x.dataset.sort === f.sort ? "sorted" + (f.dir > 0 ? " asc" : "") : "";
      x.setAttribute("aria-sort", x.dataset.sort === f.sort ? (f.dir > 0 ? "ascending" : "descending") : "none");
    });
    draw();
  });
  $("#t-body", root).addEventListener("click", (e) => { const tr = e.target.closest("tr[data-href]"); if (tr) location.hash = tr.dataset.href; });
  $("#t-csv", root).addEventListener("click", () => exportCsv(tableFiltered()));
}

function exportCsv(list) {
  const cols = ["name", "age", "birthdate", "position", "position_group", "foot", "height_cm", "roster", "club", "league", "contract_expires", "market_value_display",
    "decision", "roles", "removed", "verdicts", "note_count", "last_report", "agent", "tm_url"];
  const val = (p, k) => k === "roles" ? p.roles.map((r) => `${roleShort(r.role)} rank ${r.rank + 1}${r.shortlist ? " (Short Board)" : ""}`).join("; ")
    : k === "verdicts" ? Object.entries(p.verdicts || {}).map(([n, v]) => `${n}: ${v}`).join("; ")
    : k === "position_group" ? posGroupLabel(posGroup(p)) : k === "roster" ? rosterStatus(p) || "" : k === "league" ? leagueName(p)
    : k === "removed" ? (!p.roles.length && p.last_exit ? `${p.last_exit.exit_reason || ""}${p.last_exit.note ? ` (${p.last_exit.note})` : ""}` : "")
    : k === "last_report" ? (p.last_report?.at || "").slice(0, 10) : p[k] ?? "";
  const csv = [cols.join(","), ...list.map((p) => cols.map((k) => `"${String(val(p, k)).replace(/"/g, '""')}"`).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `pine-players-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- player page ---------- */
async function renderPlayer(main, idArg) {
  const id = Number(idArg);
  if (main.dataset.pid !== String(id)) main.innerHTML = `<div class="page"><div class="loading">Loading…</div></div>`;
  main.dataset.pid = String(id);
  let d;
  try { d = await api("GET", `/api/players/${id}`); } catch (e) {
    main.innerHTML = `<div class="page"><div class="empty-state">${esc(e.message)}. <a href="#/board">Back to the board</a></div></div>`;
    return;
  }
  if (route().view !== "player" || Number(route().arg) !== id) return;
  const p = d.player;
  if (p.id !== id) { location.replace(`/p/${p.id}`); return; }
  setTitle(p.name);
  const counts = { pass: 0, hold: 0, fail: 0 };
  d.staff.forEach((s) => s.verdict && counts[s.verdict]++);
  const pending = d.staff.filter((s) => !s.verdict).length;
  const verdictMap = Object.fromEntries(d.staff.filter((s) => s.verdict).map((s) => [s.name, s.verdict]));

  main.innerHTML = `<div class="page">
    <button type="button" class="back" id="back">← Back</button>
    <section class="panel p-head ${p.is_signed ? "is-signed" : ""}">
      ${photo(p, "xl")}
      <div style="min-width:0">
        <div class="p-name-row"><h1>${esc(p.name)}</h1>${longThrowBadge(p)}${p.shirt_number ? `<span class="shirt">#${p.shirt_number}</span>` : ""}${signedBadge(p, true)}${decisionChip(p.decision, true)}</div>
        <div class="p-sub">${p.club_logo_url ? `<img class="club-logo" src="${esc(p.club_logo_url)}" alt="">` : ""}${esc([p.position, p.club, p.league].filter(Boolean).join(" · "))}</div>
        <dl class="facts">
          ${fact("Age", p.age != null ? `${p.age} <span class="muted">(${esc(fmtDate(p.birthdate))})</span>` : null, true)}
          ${fact("Height", p.height_cm ? `${p.height_cm} cm` : null)}
          ${fact("Foot", cap(p.foot))}
          ${fact("Citizenship", p.citizenship.join(", "))}
          ${fact("Roster status", rosterStatus(p) ? `${cap(rosterStatus(p))}${p.roster_status ? ` <span class="muted">(set manually)</span>`
              : !rosterFromCitizenship(p) ? ` <span class="muted">(USL L2 report)</span>`
              : l2Status(p) && l2Status(p) !== rosterStatus(p) ? ` <span class="warn" title="Citizenship says ${esc(rosterStatus(p))}; the USL League Two Top Prospects report lists ${esc(l2Status(p))}">· L2 report says ${esc(cap(l2Status(p)))}</span>` : ""}`
            : `<span class="warn">Unknown</span> <span class="muted">· set it in Edit details</span>`, true)}
          ${fact("USL L2 Top Prospects", p.l2?.length ? p.l2.map((e) => esc(l2Line(e))).join("<br>") : null, true)}
          ${fact("Other positions", p.other_positions.join(", "))}
          ${fact("Contract expires", p.contract_expires ? `<span class="${contractSoon(p.contract_expires) ? "warn" : ""}">${esc(fmtDate(p.contract_expires))}</span>` : null, true)}
          ${fact("Joined", fmtDate(p.joined))}
          ${fact("On loan from", p.loan_from)}
          ${fact("Market value", p.market_value_display)}
          ${fact("Agent", p.agent ? esc(p.agent) : `<span class="muted">Not listed${p.tm_url ? " on Transfermarkt" : ""}</span>`, true)}
          ${fact("National team", p.national_team)}
          ${fact("Birthplace", p.birthplace)}
        </dl>
        <div class="p-links">
          ${p.tm_url
            ? `<a class="btn sm" href="${esc(p.tm_url)}" target="_blank" rel="noopener">Transfermarkt ↗</a><button type="button" class="btn sm ghost" id="sync-tm">Sync from Transfermarkt</button>${p.tm_synced_at ? `<span class="muted sm">Synced ${esc(relTime(p.tm_synced_at))}</span>` : ""}`
            : `<form id="link-tm" class="row"><input type="url" required placeholder="Paste a Transfermarkt link to pull info" aria-label="Transfermarkt link"><button class="btn sm" type="submit">Link</button></form>`}
          <button type="button" class="btn sm ghost" id="share-p">Share</button>
          <button type="button" class="btn sm ghost" id="edit-p">Edit details</button>
          <button type="button" class="btn sm ghost" id="mark-reviewed">Mark reviewed</button>
          ${reviewRole() ? `<button type="button" class="btn sm ghost" data-rv-player="watch">Watch</button>` : ""}
          ${reviewRole() === "scout" ? `<button type="button" class="btn sm ghost" data-rv-player="sb_review">Send to ${esc(reviewLead()?.name || "the lead")}</button>` : ""}
          ${canAssign() ? `<button type="button" class="btn sm ghost" data-rv-player="assignment">${esc(assignLabel())}</button>` : ""}
          ${S.me.is_admin ? `<button type="button" class="btn sm ghost danger" id="del-p">Delete</button>` : ""}
        </div>
      </div>
      <aside class="p-decision">
        <div class="lbl">Signing status</div>
        <button type="button" class="btn sm signing-toggle ${p.is_signed ? "on" : ""}" id="toggle-signed" aria-pressed="${p.is_signed}">${p.is_signed ? "✓ Signed · remove status" : "Mark as signed"}</button>
        <div class="lbl">Club decision</div>
        ${seg(p.decision, "decision")}
        <div class="muted sm">${p.decision ? `Set by ${esc(p.decision_by_name || "unknown")} · ${esc(relTime(p.decision_at))}` : "No decision yet"}</div>
        <div class="lbl" style="margin:6px 0 0">Staff verdicts</div>
        <div class="consensus">${["pass", "hold", "fail"].map((k) => `<span class="cons c-${k}"><b>${counts[k]}</b> ${cap(k)}</span>`).join("")}<span class="cons"><b>${pending}</b> Pending</span></div>
        ${verdictDots(verdictMap, true)}
      </aside>
    </section>

    <div class="p-grid">
      <div class="p-main">
        <section class="panel" id="summary-panel" aria-labelledby="summary-heading">
          <header class="panel-h"><h2 id="summary-heading">Summary</h2><span class="muted sm">Shared club summary</span></header>
          <div id="summary-view">
            ${summaryViewHTML(p.summary, p.summary_updated)}
          </div>
          <form id="summary-form" hidden>
            <label class="lbl" for="summary">Club summary</label>
            <textarea id="summary" rows="5" data-draft data-orig="${esc(p.summary || "")}" aria-describedby="summary-hint" placeholder="Overall summary, fit, next steps… (what you add is dated and signed when you save)">${esc(p.summary || "")}</textarea>
            <div class="summary-actions row"><span class="muted sm" id="summary-hint">${p.summary?.trim() ? "Editing summary" : "New summary"} · not saved yet</span><span class="spacer"></span>
              <button type="button" class="btn sm ghost" id="cancel-summary">Cancel</button><button type="submit" class="btn sm primary" id="save-summary" disabled>Save summary</button></div>
          </form>
          <div class="banner warn summary-delete" id="summary-delete" hidden>
            <p>Delete the shared summary? Everyone will see an empty summary.</p>
            <div class="row end"><button type="button" class="btn sm ghost" id="keep-summary">Keep summary</button><button type="button" class="btn sm danger" id="confirm-delete-summary">Delete summary</button></div>
          </div>
          <p class="banner err" id="summary-error" role="alert" hidden></p>
        </section>
        ${collegePanel(d)}
        <section class="panel"><header class="panel-h"><h2>Staff reports</h2></header>${evalsHTML(d.staff)}</section>
      </div>
      <div class="p-side">
        ${p.tm_url ? "" : `<section class="panel" id="tm-panel"><header class="panel-h"><h2>Transfermarkt</h2></header><div class="loading sm">Searching Transfermarkt…</div></section>`}
        <section class="panel"><header class="panel-h"><h2>Big board</h2></header>${rolesPanel(p)}</section>
        <section class="panel" id="board-history"><header class="panel-h"><h2>Board history</h2></header>${boardHistoryHTML(d.board_history)}</section>
        ${ncaaBoardPanel(p, d)}
        ${d.lists.length ? `<section class="panel"><header class="panel-h"><h2>Lists</h2></header><div class="row">${d.lists.map((l) => `<span class="chip">${esc(l.name)}</span>`).join("")}</div></section>` : ""}
        <section class="panel" id="impect-panel"><header class="panel-h"><h2>Impect</h2></header><div class="loading sm">Loading…</div></section>
        <section class="panel"><header class="panel-h"><h2>History</h2></header>${historyHTML(d.activity)}</section>
      </div>
    <section class="panel analytics" id="analytics">
      <header class="an-head">
        <div class="an-tabs" role="tablist">${anTabs(p).map(([k, label], i) =>
          `<button type="button" role="tab" id="an-${k}-tab" aria-controls="${k}-panel" data-an-tab="${k}" class="${i ? "" : "on"}" aria-selected="${i ? "false" : "true"}">${label}</button>`).join("")}</div>
        <div class="an-ctx" id="an-ctx"></div>
      </header>
      ${anTabs(p).map(([k], i) => `<div class="an-body" role="tabpanel" aria-labelledby="an-${k}-tab" id="${k}-panel" ${i ? "hidden" : ""}><div class="loading sm">Loading…</div></div>`).join("")}
    </section>
    <section class="panel playing-time" id="playing-time-panel"><header class="panel-h"><h2>Playing time</h2></header><div class="loading sm">Loading…</div></section>
    </div>
  </div>`;
  const root = main.firstElementChild;
  wirePlayer(root, d);
  fitPlayerGrid(root);
  loadPlayingTimePanel($("#playing-time-panel", root), p, api);
  if (!p.tm_url) loadTmPanel(root, p);
  loadImpectPanel(root, p);
  wireAnalytics(root, p);
}

/* ---------- MLS NEXT Pro graduation gates ---------- */
function gateRow(g, d) {
  const pct = g.id === "packing" || g.id === "ball_wins";
  // Floor display values: 49.99 must never look like a passing P50.
  const floor1 = (n) => (Math.floor(n * 10) / 10).toFixed(1);
  const value = g.value == null ? "—" : pct ? `P${floor1(g.value)}` : Math.floor(g.value).toLocaleString();
  const threshold = pct ? "P50 or higher" : g.id === "age" ? "22 or older" : "2,000+ minutes";
  const label = { met: "✓ Met", below: "× Below", unavailable: "Unavailable", not_applicable: "Not applicable" }[g.status];
  let detail = "";
  if (g.status === "not_applicable") detail = "Goalkeepers use three gates";
  else if (g.value == null) detail = "No data available";
  else if (g.id === "age") detail = d.age_today == null ? "" : `${d.age_today} today`;
  else {
    const gap = Math.abs(g.value - g.threshold);
    const gapLabel = pct ? (gap < 0.1 && gap > 0 ? "<0.1" : gap.toFixed(1)) : (gap < 1 && gap > 0 ? "<1" : Math.floor(gap).toLocaleString());
    detail = `${gapLabel} ${pct ? "points" : "minutes"} ${g.status === "met" ? "above" : "below"}`;
    if (gap === 0) detail = "At the threshold";
  }
  return `<tr><th scope="row">${esc(g.label)}<small>Gate: ${threshold}</small></th>
    <td class="gates-value">${g.status === "not_applicable" ? "—" : value}<small>${esc(detail)}</small></td>
    <td><span class="gates-result gates-${g.status}">${label}</span></td></tr>`;
}
async function loadGatesPanel(root, p) {
  const el = $("#gates-panel", root), badge = $(".gates-badge", root);
  try {
    const d = await api("GET", `/api/players/${p.id}/mlsnp-gates`);
    if (!el.isConnected) return;
    if (!d.eligible) { el.innerHTML = '<p class="empty">These gates apply to current MLS NEXT Pro players.</p>'; badge.textContent = "—"; return; }
    badge.textContent = `${d.met}/${d.total}${d.provisional || d.unavailable ? "*" : ""}`;
    badge.setAttribute("aria-label", `${d.met} of ${d.total} gates met${d.unavailable ? `; ${d.unavailable} unavailable` : ""}${d.provisional ? "; provisional" : ""}`);
    const below = d.gates.filter((g) => g.status === "below").map((g) => g.label);
    const summary = [below.length ? `${below.join(", ")} below the gate${below.length > 1 ? "s" : ""}.` : "",
      d.unavailable ? `${d.unavailable} unavailable.` : "", !below.length && !d.unavailable ? "All applicable gates met." : ""].filter(Boolean).join(" ");
    el.innerHTML = `<div class="gates-content">
      <header class="gates-heading"><div><h2>${d.met} of ${d.total} gates met${d.provisional ? " · provisional" : ""}</h2><p class="muted sm">${esc(summary)}</p></div>
        <span class="muted sm">${esc(d.seasons.join(" / ") || "Awaiting data")}${d.group ? ` · ${esc(d.group)} peers` : ""}</span></header>
      <div class="gates-context muted sm"><span>Projected move: <b>${esc(fmtDate(d.move_date))}</b></span><span>MLSNP sample: <b>${d.sample_minutes == null ? "Unavailable" : `${Math.floor(d.sample_minutes).toLocaleString()} min`}</b></span></div>
      ${d.warnings.length ? `<div class="banner sm gates-warnings">${d.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : ""}
      <table class="gates-table"><thead><tr><th>Gate</th><th>Player</th><th>Result</th></tr></thead><tbody>${d.gates.map((g) => gateRow(g, d)).join("")}</tbody></table>
      <div class="gates-context gates-freshness muted sm"><span>Matches through <b>${d.data_as_of ? esc(fmtDate(d.data_as_of)) : "unavailable"}</b></span>
        <span>Calculated <b>${d.generated_at ? esc(fmtDateTime(d.generated_at)) : "not yet"}</b></span></div>
      <details class="gates-definitions"><summary>Gate definitions &amp; sources</summary>
        <p><b>Packing and ball wins:</b> the study's MLS NEXT Pro positional percentiles, weighted by match shares across seasons in the 365 days before the projected move. Reference players have at least 5 match shares; each metric needs 10 valid peers. Midfielders share the MID group. These differ from the pooled KPI profile.</p>
        <p><b>Total pro minutes:</b> recorded MLS, MLS NEXT Pro, USL Championship and USL League One minutes before the move. Overseas minutes are excluded. Impect covers match-level minutes; ASA fills historical league-seasons without Impect coverage.</p>
        <p><b>Age:</b> assessed on the projected move date using the exact birthday${d.birthdate ? ` (${esc(fmtDate(d.birthdate))})` : ""}. Goalkeepers have three gates; ball wins does not apply.</p>
        <p>Rule set: ${esc(d.rule_version)}${d.source_commit ? ` · source ${esc(d.source_commit.slice(0, 8))}` : ""}. Gate results are separate from the club decision and staff reports.</p>
        ${d.sources.length ? `<ul>${d.sources.map((s) => `<li>${esc(s.name)} · fetched ${esc(fmtDateTime(s.fetched_at))}${s.stale ? " · stale" : ""}</li>`).join("")}</ul>` : ""}
      </details></div>`;
  } catch (e) {
    if (!el.isConnected) return;
    badge.textContent = "—";
    badge.setAttribute("aria-label", "Gates unavailable");
    el.innerHTML = `<div class="banner err sm">Couldn't load gates: ${esc(e.message)}</div><button class="btn sm" type="button" data-retry-gates>Retry</button>`;
    $("[data-retry-gates]", el).addEventListener("click", () => loadGatesPanel(root, p));
  }
}

/* ---------- impect KPI profile ---------- */
// The five colour bands, in words.
const tier = (v) => (v < 20 ? "Bottom 20%" : v < 40 ? "Below average" : v < 60 ? "Average" : v < 80 ? "Above average" : "Top 20%");
const byPercentile = (a, b) => (b.percentile ?? -1) - (a.percentile ?? -1);
const wholePct = (v) => (v == null ? null : Math.round(v));
// Percentile bar; the tick at its midpoint (CSS) marks the median peer.
// Defending overall's bar also shades where his true level likely sits (an 80% range), with the likely level marked.
const kpiRangeBar = (pct, o) => !o ? kpiBar(pct) : `<span class="kpi-bar kpi-bar-range">${pct == null ? "" : `<span style="width:${Math.max(2, pct)}%;background:${band(pct)}"></span>`}<i class="kpi-range" style="left:${o.low}%;width:${Math.max(1, o.high - o.low)}%"></i><i class="kpi-likely" style="left:${o.expected}%"></i></span>`;
// Style categories describe a role rather than rank quality, so their bars are neutral rather than red-to-green.
const kpiBar = (pct, neutral = false) => `<span class="kpi-bar">${pct == null ? "" : `<span style="width:${Math.max(2, pct)}%;background:${neutral ? "var(--muted)" : band(pct)}"></span>`}</span>`;

function kpiMetric(m, neutral = false) {
  const pct = wholePct(m.percentile);
  const label = `${m.label}${m.inverted ? " ↓" : ""}`;
  return `<div class="kpi-m">
    <span class="kpi-m-l" title="${esc([label, m.meaning || m.definition].filter(Boolean).join(" — "))}">${esc(label)}</span>
    <span class="kpi-m-v">${m.value == null ? `<span class="muted">no data</span>` : `<b>${fmtKpiNum(m.value)}</b>`}${m.league_median == null ? "" : ` <span class="muted">median ${fmtKpiNum(m.league_median)}</span>`}</span>
    ${kpiBar(pct, neutral)}<b class="kpi-m-p">${pct ?? "–"}</b><span class="kpi-m-lg">${wholePct(m.league_percentile) ?? "–"}</span>
  </div>`;
}

function kpiCategory(c, d) {
  const pct = wholePct(c.percentile);
  const neutral = c.phase === "defstyle";
  const peers = `${d.position_label.toLowerCase()}s`;
  const league = d.iteration.short;
  const kinds = d.metric_kinds.map((k) => ({ ...k, rows: c.components.filter((m) => m.kind === k.id).sort(byPercentile) }))
    .filter((k) => k.rows.length);
  const foot = c.composite
    ? `The overall score averages its ${c.components.length} Defending categories equally and ranks against ${c.peer_count} ${esc(peers)}; across the back six it predicted fewer goals conceded better than any single measure.`
    : `The category score averages its ${c.components.length} metrics, flipped where lower is better, and ranks against ${c.peer_count} ${esc(peers)}.`;
  return `<li class="${c.composite ? "kpi-headline" : ""}"><details>
    <summary><span class="kpi-name" title="${esc(`Study category: ${c.name}`)}">${esc(c.label)}${c.outlook ? `<small class="kpi-outlook" title="One season of defending stats is about half signal (its reliability here is ${c.outlook.reliability}), so the score is pulled toward the median: this is where his true level likely sits among peers (80% range).">Likely level ${c.outlook.expected} · range ${c.outlook.low}–${c.outlook.high}</small>` : ""}</span>${c.composite ? kpiRangeBar(pct, c.outlook) : kpiBar(pct, neutral)}<b>${pct ?? "–"}</b><span class="kpi-chev" aria-hidden="true"></span></summary>
    <div class="kpi-detail">
      <p class="kpi-about">${pct == null || neutral ? "" : `<span class="kpi-tier" style="--c:${band(pct)}">${tier(pct)}</span>`}${c.description ? `<span>${esc(c.description)}</span>` : ""}</p>
      <div class="kpi-m kpi-mh"><span>${c.composite ? "Category" : "Metric"}</span><span>${c.composite ? "Score" : `Value · ${esc(league)} median`}</span><span>vs ${d.peer_count} ${esc(peers)}</span><span>Pct</span>
        <span title="${esc(`Percentile against ${d.iteration.competition} ${peers} only`)}">${esc(league)}</span></div>
      ${kinds.map((k) => `<h4 class="kpi-kind">${esc(k.name)} <span>${esc(k.note)}</span></h4>${k.rows.map((m) => kpiMetric(m, neutral)).join("")}`).join("")}
      <p class="kpi-foot">${foot}
        Against ${esc(d.iteration.competition)} ${esc(peers)} alone (${c.league_peer_count}) it ranks ${wholePct(c.league_percentile) ?? "–"}.</p>
    </div>
  </details></li>`;
}

function kpiPhase(ph, d) {
  // The headline (Defending overall) leads its section; the rest are ranked by percentile.
  const cats = d.categories.filter((c) => c.phase === ph.id).sort((x, y) => (y.composite ? 1 : 0) - (x.composite ? 1 : 0) || byPercentile(x, y));
  // Defending style is context, not a ranking: one line, opened for the detail.
  if (ph.id === "defstyle") {
    return `<section class="kpi-group kpi-style"><details>
      <summary><span class="kpi-phase-inline"><b>${esc(ph.name)}</b> ${cats.map((c) => `${esc(c.label)} ${wholePct(c.percentile) ?? "–"}`).join(" · ")}</span><span class="muted sm">${esc(ph.desc)}</span><span class="kpi-chev" aria-hidden="true"></span></summary>
      <ol class="kpi-list">${cats.map((c) => kpiCategory(c, d)).join("")}</ol>
    </details></section>`;
  }
  return `<section class="kpi-group">
    <div class="kpi-phase"><h3>${esc(ph.name)}</h3>${ph.desc ? `<span>${esc(ph.desc)}</span>` : ""}</div>
    <ol class="kpi-list">${cats.map((c) => kpiCategory(c, d)).join("")}</ol>
  </section>`;
}

// The five latest entries; older ones fold away so History doesn't outgrow the page beside it.
function historyHTML(activity) {
  // A note's entry shows the start of what it said, as Activity does.
  const snip = (a) => (a.snippet ? `<div class="act-snip">${a.snippet_context ? `<b>${esc(a.snippet_context)}</b> · ` : ""}${esc(a.snippet)}${a.snippet.length >= 200 ? "…" : ""}</div>` : "");
  const li = (a) => `<li><span><span><b>${esc(actor(a))}</b> ${describe(a, true)}</span>${snip(a)}</span><span class="when" title="${esc(fmtDateTime(a.created_at))}">${esc(relTime(a.created_at))}</span></li>`;
  if (!activity.length) return `<ul class="feed"><li class="empty">No history yet.</li></ul>`;
  const rest = activity.slice(5);
  return `<ul class="feed">${activity.slice(0, 5).map(li).join("")}</ul>${rest.length
    ? `<details class="more-history"><summary>${rest.length} earlier</summary><ul class="feed">${rest.map(li).join("")}</ul></details>` : ""}`;
}

/* ---------- analytics tabs: one season and position for the KPI profile, pitch maps and card ---------- */
const AN_TABS = [["kpi", "KPI profile"], ["physical", "Physical"], ["maps", "Pitch maps"], ["card", "Player card"]];
// Only the Physical tab works without an Impect link.
const anTabs = (p) => [...(p.impect_id ? AN_TABS : AN_TABS.filter(([k]) => k === "physical")),
  ...(p.mlsnp_gates_eligible ? [["gates", 'MLS NEXT Pro gates <span class="gates-badge" aria-label="Gates loading">…</span>']] : [])];
// Physical data has its own seasons and teams, so the Impect season/position picker hides on that tab.
const AN_USES_PICKER = new Set(["kpi", "maps", "card"]);
// Card position -> KPI benchmark group. The KPI reference pools both flanks, so LW and RW are one group,
// and defensive and central midfielders are one group (MID).
const KPI_GROUP = { CB: "CB", LB: "FB", RB: "FB", DM: "MID", CM: "MID", AM: "AM", LW: "W", RW: "W", CF: "ST" };
// sel is null when Impect can't offer any season and position (a goalkeeper, say): each panel then
// falls back to driving itself.
const an = { sel: null, seasons: [], handlers: {}, loaded: new Set(), kpiShown: null };
const anSeason = () => an.seasons.find((s) => s.iteration_id === an.sel?.iteration_id);
const anOffers = (x, seasons = an.seasons) =>
  seasons.some((s) => s.iteration_id === x?.iteration_id && s.positions.some((o) => o.code === x.position));

async function wireAnalytics(root, p) {
  Object.assign(an, { sel: null, seasons: [], handlers: {}, loaded: new Set(), kpiShown: null });
  const ctx = $("#an-ctx", root);
  const tabs = $$("[data-an-tab]", root);
  // A tab's panel is only fetched the first time it is opened; pitch maps in particular are heavy.
  const show = (key) => {
    for (const b of tabs) {
      const on = b.dataset.anTab === key;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      $(`#${b.dataset.anTab}-panel`, root).hidden = !on;
    }
    ctx.hidden = !AN_USES_PICKER.has(key);
    if (an.loaded.has(key)) return;
    an.loaded.add(key);
    ({ kpi: loadKpiPanel, physical: loadPhysicalPanel, card: loadCardPanel, maps: loadMapsPanel, gates: loadGatesPanel })[key](root, p);
  };
  for (const b of tabs) b.addEventListener("click", () => show(b.dataset.anTab));
  // The first tab opens straight away; the KPI profile doesn't wait for the season list.
  show(tabs[0].dataset.anTab);
  // This small stored snapshot also supplies the badge while another tab is open.
  if (p.mlsnp_gates_eligible) { an.loaded.add("gates"); loadGatesPanel(root, p); }
  if (!p.impect_id) return;

  ctx.innerHTML = `<span class="loading sm">Seasons…</span>`;
  let opts = null;
  try { opts = await playerSeasons(p.id); } catch { /* each panel reports the failure itself */ }
  if (!root.isConnected) return;
  if (!opts?.seasons.length) { ctx.innerHTML = ""; return; }
  an.seasons = opts.seasons;
  // Keep whatever the KPI tab is already showing when the picker offers it, so it doesn't reload.
  const k = an.kpiShown;
  const same = k && opts.seasons.find((x) => x.iteration_id === k.iteration_id)?.positions.find((o) => KPI_GROUP[o.code] === k.group);
  an.sel = same ? { iteration_id: k.iteration_id, position: same.code } : { ...opts.default };
  drawAnCtx(ctx);
  $("#analytics", root).classList.add("has-ctx");
  if (!same) an.handlers.kpi?.({ ...an.sel });
}

function drawAnCtx(ctx) {
  const season = anSeason();
  ctx.innerHTML = `<select id="an-season" aria-label="Season">${an.seasons.map((s) =>
      `<option value="${s.iteration_id}" ${s.iteration_id === an.sel.iteration_id ? "selected" : ""}>${esc(s.season)} · ${esc(s.competition)}</option>`).join("")}</select>
    <select id="an-pos" aria-label="Position">${season.positions.map((o) =>
      `<option value="${o.code}" ${o.code === an.sel.position ? "selected" : ""}>${o.code} · ${esc(o.label)} · ${o.match_share.toFixed(1)} matches</option>`).join("")}</select>`;
  $("#an-season", ctx).addEventListener("change", (e) => {
    an.sel.iteration_id = Number(e.target.value);
    an.sel.position = anSeason().positions[0].code;
    drawAnCtx(ctx);
    anChanged();
  });
  $("#an-pos", ctx).addEventListener("change", (e) => { an.sel.position = e.target.value; anChanged(); });
}

const anChanged = () => { for (const fn of Object.values(an.handlers)) fn?.({ ...an.sel }); };

function loadKpiPanel(root, p) {
  const el = $("#kpi-panel", root);
  // The tab strip names the panel; only a fallback season picker (no shared one) goes up here.
  const head = (extra = "") => (extra ? `<div class="an-actions">${extra}</div>` : "");
  let ticket = 0;
  const draw = async (iterationId, position) => {
    const mine = ++ticket;
    el.innerHTML = `${head()}<div class="loading sm">Scoring against the pooled positional benchmark…</div>`;
    let d;
    const qs = new URLSearchParams();
    if (iterationId) qs.set("iteration", iterationId);
    if (position) qs.set("position", position);
    const q = qs.toString();
    try { d = await api("GET", `/api/players/${p.id}/impect-kpis${q ? `?${q}` : ""}`); } catch (e) {
      if (mine === ticket) el.innerHTML = `${head()}<div class="banner err sm">${esc(e.message)}</div>`;
      return;
    }
    if (mine !== ticket || !el.isConnected) return; // a newer season or position was picked meanwhile
    an.kpiShown = d.empty ? null : { iteration_id: d.iteration.id, group: d.position };
    const picker = (d.available_iterations || []).length < 2 ? ""
      : `<select id="kpi-it" aria-label="Season">${d.available_iterations.map((i) => `<option value="${i.id}" ${d.iteration?.id === i.id ? "selected" : ""}>${esc(i.competition)} ${esc(i.season)}</option>`).join("")}</select>`;
    if (d.empty) {
      el.innerHTML = `${head(picker)}<p class="empty">${esc(d.reason)}</p>`;
    } else {
      const peers = `${d.position_label.toLowerCase()}s`;
      el.innerHTML = `${head(picker)}
        <div class="kpi-ctx">
          <b>${esc([d.position_label, d.squad, `${d.minutes.toLocaleString()} min`].filter(Boolean).join(" · "))}</b>
          <span class="muted">vs ${d.peer_count} ${esc(peers)} · ${esc(d.benchmark_competitions.join(", "))} · ${esc(d.iteration.season)}</span>
          <button type="button" class="kpi-how-btn" aria-expanded="false" aria-controls="kpi-how">How this is scored</button>
        </div>
        <div class="kpi-how" id="kpi-how" hidden>
          <p>Percentiles rank this player against <b>${d.peer_count}</b> ${esc(peers)} with ${d.min_share_used}+ match shares at the position in ${esc(d.benchmark_competitions.join(" + "))}, ${esc(d.iteration.season)}.
            Each metric is standardised within its own league before the leagues are pooled, so league-wide differences in output don't tilt the ranks.</p>
          <p>A category's score is the equal-weight average of its metrics' z-scores, fitted only on qualified peers and flipped where lower is better (marked ↓); each metric belongs to one category.
            Values are Impect rates per match share; ratios and scores are shown as supplied. Medians and the ${esc(d.iteration.short)} column use ${esc(d.iteration.competition)} ${esc(peers)} only.</p>
          ${d.phases.some((ph) => ph.id === "defending") ? `<p><b>Defending</b> is judged on what predicted fewer goals conceded across the back six: for players who changed clubs, did the new club concede fewer goals than the season before? (2022–25, confirmed on 2026.) That's possession-adjusted ball winning, second balls and how high he wins the ball, plus aerial defending for centre-backs and pressing for full-backs and midfielders. <b>Defending overall</b> averages them equally. Counts are scaled for his team's possession.
            One season of these stats is only about half signal, so Defending overall also shows his <b>likely level</b>: the score pulled toward the median by how much it repeats season to season at that sample, with an 80% range (the shaded band).
            <b>Defending style</b> (duels, workload, Impect's regain value) describes how much and how he defends; those measures didn't predict goals conceded, so read them as role, not quality.</p>` : ""}
          <p>Transfers count once in the reference, using their largest qualified league sample. Oldest reference fetch: ${esc(new Date(d.cohort_built_at).toLocaleString())}. Cached for up to 12 hours.</p>
        </div>
        ${(d.positions || []).length < 2 ? "" : `<div class="kpi-positions" role="group" aria-label="Position benchmarked"><span class="muted sm">Benchmark as</span>${d.positions.map((o) =>
          `<button type="button" class="${o.group === d.position ? "on" : ""}${o.eligible ? "" : " thin"}" data-kpi-pos="${esc(o.group)}" aria-pressed="${o.group === d.position}"
            title="${esc(o.impect_positions.map((x) => `${x.name.replace(/_/g, " ").toLowerCase()} ${x.match_share}`).join(", "))}${o.eligible ? "" : " (below the minimum)"}">${esc(o.label)} <span>· ${o.match_share} matches</span></button>`).join("")}</div>`}
        ${!d.eligible ? `<p class="banner warn">Small sample: ${d.match_share} matches (${d.minutes.toLocaleString()} min) at this position, below the ${d.min_share_used} required for the reference group. Percentiles are shown but are less reliable.</p>` : ""}
        ${d.missing_benchmark_competitions?.length ? `<p class="sm muted">Unavailable for this season: ${esc(d.missing_benchmark_competitions.join(", "))}.</p>` : ""}
        <div class="kpi-axis" aria-hidden="true"><span></span><span class="kpi-scale"><span>0</span><span>50<span class="kpi-scale-m"> · median</span></span><span>100</span></span></div>
        ${d.phases.map((ph) => kpiPhase(ph, d)).join("")}
        <p class="sm muted" style="margin:10px 0 0">Percentile against the benchmark; the tick marks the median ${esc(d.position_label.toLowerCase())}. Open a category for its metrics.</p>`;
    }
    $("#kpi-it", el)?.addEventListener("change", (e) => draw(e.target.value, null));
    el.querySelectorAll("[data-kpi-pos]").forEach((b) => b.addEventListener("click", () => draw(d.iteration?.id, b.dataset.kpiPos)));
    $(".kpi-how-btn", el)?.addEventListener("click", (e) => {
      const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
      e.currentTarget.setAttribute("aria-expanded", String(open));
      $("#kpi-how", el).hidden = !open;
    });
  };
  an.handlers.kpi = (sel) => draw(sel.iteration_id, KPI_GROUP[sel.position] || null);
  if (an.sel) an.handlers.kpi(an.sel); else draw();
}

/* ---------- transfermarkt suggestions (players added without a link) ---------- */
function tmCand(r) {
  return `<div class="cand">${photo(r)}
    <span class="ci"><a href="${esc(r.url)}" target="_blank" rel="noopener"><b>${esc(r.name)}</b></a>${r.age != null ? ` · ${r.age}` : ""}
      <div class="muted sm">${esc([r.position, r.club, r.citizenship.join(" / ")].filter(Boolean).join(" · "))}</div>
      ${r.reasons.length ? `<span class="why">${r.reasons.map((x) => `<span>${esc(x)}</span>`).join("")}</span>` : ""}</span>
    ${r.in_pine ? `<a class="sm" href="#/player/${r.in_pine.id}" title="Already linked to ${esc(r.in_pine.name)}">In PINE</a>` : `<button type="button" class="btn sm" data-tm-link="${esc(r.url)}">Link</button>`}</div>`;
}

function loadTmPanel(root, p) {
  const el = $("#tm-panel", root);
  const head = `<header class="panel-h"><h2>Transfermarkt</h2></header><p class="empty">Not linked yet. Link the matching profile to pull in club, contract, agent and market value.</p>`;
  const draw = async (q) => {
    el.innerHTML = `${head}<div class="loading sm">Searching Transfermarkt…</div>`;
    let d;
    try { d = await api("GET", `/api/players/${p.id}/tm-candidates${q ? `?q=${encodeURIComponent(q)}` : ""}`); } catch (e) {
      el.innerHTML = `${head}<div class="banner err sm">${esc(e.message)}</div>`;
      return;
    }
    el.innerHTML = `${head}<div>${d.candidates.slice(0, 8).map(tmCand).join("") || `<p class="empty">No Transfermarkt results for “${esc(d.query)}”.</p>`}</div>
      <form class="row" id="tm-q-form" style="margin-top:8px"><input type="search" name="q" value="${esc(d.query)}" style="flex:1" aria-label="Search Transfermarkt"><button class="btn sm" type="submit">Search</button></form>`;
    $("#tm-q-form", el).addEventListener("submit", (e) => { e.preventDefault(); draw(e.target.elements.q.value.trim()); });
  };
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tm-link]");
    if (!b) return;
    b.disabled = true;
    b.textContent = "Linking…";
    try { await api("POST", `/api/players/${p.id}/refresh-tm`, { url: b.dataset.tmLink }); toast("Linked to Transfermarkt"); await afterMutation(); } catch (err) {
      oops(err);
      b.disabled = false;
      b.textContent = "Link";
    }
  });
  draw("");
}

function rolesPanel(p) {
  const rows = p.roles.map((r) => {
    const n = playersInRole(r.role).length || 1;
    return `<div class="role-row"><span class="chip">${esc(roleLabel(r.role))}</span><span class="muted sm">Rank <b>${r.rank + 1}</b> of ${n}</span><span class="spacer"></span>
      <button type="button" class="icon-btn star-btn ${r.shortlist ? "on" : ""}" data-role-star="${r.role}" aria-pressed="${Boolean(r.shortlist)}"
        title="${r.shortlist ? "On the Short Board as a top target" : "Add to the Short Board as a top target"}" aria-label="Top target at ${esc(roleLabel(r.role))}">${r.shortlist ? "★" : "☆"}</button>
      <button type="button" class="icon-btn" data-role-move="${r.role}:-1" title="Move up" aria-label="Move up" ${r.rank === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="icon-btn" data-role-move="${r.role}:1" title="Move down" aria-label="Move down" ${r.rank >= n - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="icon-btn" data-role-rm="${r.role}" title="Remove from this role" aria-label="Remove from this role">×</button></div>`;
  }).join("");
  const options = S.config.positions.map((pos) => {
    const opts = pos.roles.filter(([c]) => !p.roles.some((r) => r.role === c));
    return opts.length ? `<optgroup label="${esc(pos.code)} · ${esc(pos.label)}">${opts.map(([c, l]) => `<option value="${c}">${esc(roleShort(c))} · ${esc(l)}</option>`).join("")}</optgroup>` : "";
  }).join("");
  return `${rows || `<p class="empty">Not on the big board yet.</p>`}
    <div class="add-role"><select id="add-role-sel" aria-label="Add to a role"><option value="">Add to a role…</option>${options}</select><button type="button" class="btn sm" id="add-role-btn">Add</button></div>`;
}

// Everyone's box: yours first, then anyone with a verdict or a note, then the rest. "Hide empty" folds the boxes of
// staff who haven't weighed in into one line; the choice is remembered in this browser.
const hideEmptyEvals = () => { try { return localStorage.getItem("pine.hideEmptyEvals") === "1"; } catch { return false; } };
function evalsHTML(staff) {
  const active = staff.filter((s) => s.user_id === S.me.id || s.verdict || s.notes.length || s.board_notes?.length)
    .sort((a, b) => (b.user_id === S.me.id) - (a.user_id === S.me.id));
  const quiet = staff.filter((s) => !active.includes(s));
  const names = quiet.map((s) => s.name);
  const list = names.length <= 3 ? names.join(", ").replace(/, ([^,]*)$/, " and $1") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
  const hide = hideEmptyEvals();
  return `<div class="evals">${active.map(evalHTML).join("")}${hide ? "" : quiet.map(evalHTML).join("")}</div>${quiet.length ? `
    <p class="evals-quiet muted sm">${hide ? `No verdict or notes yet from ${esc(list)}.` : `${quiet.length} with no verdict or notes yet.`}
      <button type="button" class="btn link sm" data-toggle-empty>${hide ? "Show them" : "Hide empty"}</button></p>` : ""}`;
}

function evalHTML(s) {
  const mine = s.user_id === S.me.id;
  // Their notes and their board reasons, newest first.
  const items = [...s.notes.map((n) => ["note", n]), ...(s.board_notes || []).map((r) => ["board", r])]
    .sort(([, a], [, b]) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return `<article class="eval ${mine ? "mine" : ""}">
    <header class="eval-h"><span class="avatar">${esc(s.name[0])}</span><b>${esc(s.name)}</b>${mine ? `<span class="you">You</span>` : ""}${mine ? seg(s.verdict, "verdict") : verdictChip(s.verdict)}</header>
    ${mine ? `<form class="note-form" id="note-form">
      <input name="context" id="nf-ctx" data-keep placeholder="Context, e.g. Live vs Richmond 9/12, video, trial" aria-label="Note context">
      <textarea name="body" id="nf-body" data-keep data-draft data-orig="" rows="3" placeholder="Add your notes on this player…" aria-label="Note"></textarea>
      <div class="row end"><button class="btn sm primary" type="submit">Add note</button></div></form>` : ""}
    <div class="notes">${items.length ? items.map(([kind, n]) => (kind === "board" ? boardNoteHTML(n) : noteHTML(n, mine))).join("") : `<p class="empty">${mine ? "No notes from you yet." : `No notes from ${esc(s.name)} yet.`}</p>`}</div>
  </article>`;
}

// A reason written moving the player on or off the boards, from his board history: shown in the author's box, not
// editable here (the board history keeps it), and not counted as a report.
function boardNoteHTML(r) {
  const where = r.role ? ` · ${roleLabel(r.role)}` : "";
  const what = { take_off: `Removed from the Big Board${where}`, drop_back: `Taken off the Short Board${where}`, add: `Added to the Big Board${where}`,
    promote: `Put on the Short Board${where}`, track: "Added to PINE" }[r.kind] || "Board";
  const body = [r.exit_reason && `<b>${esc(r.exit_reason)}</b>`, r.why && esc(r.why), r.note && esc(r.note)].filter(Boolean).join(" · ");
  return `<div class="note board-note" title="From the board history">
    <div class="note-ctx">${esc(what)}${r.source ? ` · ${esc(r.source)}` : ""}</div>
    ${body ? `<div class="note-body">${body}</div>` : ""}
    <div class="note-meta"><span title="${esc(fmtDateTime(r.created_at))}">${esc(relTime(r.created_at))}</span></div>
  </div>`;
}

function noteHTML(n, mine) {
  return `<div class="note" data-note="${n.id}">
    ${n.context ? `<div class="note-ctx">${esc(n.context)}</div>` : ""}
    <div class="note-body">${esc(n.body)}</div>
    <div class="note-meta"><span title="${esc(fmtDateTime(n.created_at))}">${esc(relTime(n.created_at))}${n.updated_at !== n.created_at ? " · edited" : ""}</span>
      ${mine ? `<button type="button" data-note-edit="${n.id}">Edit</button><button type="button" data-note-del="${n.id}">Delete</button>` : ""}</div>
  </div>`;
}

const summaryWithStamps = (summary) => esc(summary).replace(SUMMARY_STAMP, (_, date, who) => `<span class="sum-stamp">${date} · ${who}</span>`);

function summaryViewHTML(summary, updated = null) {
  const when = updated?.at ? `Updated ${relTime(updated.at)}${updated.by ? ` by ${updated.by}` : ""}` : "✓ Saved";
  return summary?.trim() ? `<div class="summary-body">${summaryWithStamps(summary)}</div>
    <div class="summary-actions row"><span class="summary-status sm" ${updated?.at ? `title="${esc(fmtDateTime(updated.at))}"` : ""}>${esc(when)}</span><span class="spacer"></span>
      <button type="button" class="btn sm" id="edit-summary">Edit</button><button type="button" class="btn sm ghost danger" id="delete-summary">Delete</button></div>`
    : `<div class="summary-empty"><p class="muted">No summary yet.</p><button type="button" class="btn sm" id="edit-summary">Add summary</button></div>`;
}

function wireSummary(root, p) {
  const panel = $("#summary-panel", root), form = $("#summary-form", panel), input = $("#summary", panel);
  const view = $("#summary-view", panel), removal = $("#summary-delete", panel), error = $("#summary-error", panel);
  const save = $("#save-summary", panel);
  let busy = false;
  const updateSave = () => { save.disabled = busy || !input.value.trim() || input.value.trim() === (p.summary || "").trim(); };
  const closeEditor = () => {
    input.value = input.dataset.orig = p.summary || "";
    form.hidden = true;
    removal.hidden = true;
    error.hidden = true;
    view.hidden = false;
    updateSave();
    $("#edit-summary", panel).focus();
  };
  const persist = async (summary) => {
    if (busy) return;
    busy = true;
    error.hidden = true;
    panel.setAttribute("aria-busy", "true");
    $$("button", panel).forEach((b) => { b.disabled = true; });
    input.readOnly = true;
    const action = summary === null ? $("#confirm-delete-summary", panel) : save;
    action.textContent = summary === null ? "Deleting…" : "Saving…";
    try {
      const result = await api("PATCH", `/api/players/${p.id}`, { summary: summary === null ? null : stampSummary(p.summary, summary, S.me.name) });
      p.summary = result.player.summary;
      p.summary_updated = { at: new Date().toISOString(), by: S.me.name };
      const cached = S.byId.get(p.id);
      if (cached) cached.summary = p.summary;
      view.innerHTML = summaryViewHTML(p.summary, p.summary_updated);
      closeEditor();
      toast(summary === null ? "Summary deleted" : "Summary saved");
    } catch (err) {
      error.textContent = `Couldn't ${summary === null ? "delete" : "save"} the summary. ${err.message}`;
      error.hidden = false;
      return;
    } finally {
      busy = false;
      panel.removeAttribute("aria-busy");
      input.readOnly = false;
      $$("button", panel).forEach((b) => { b.disabled = false; });
      save.textContent = "Save summary";
      $("#confirm-delete-summary", panel).textContent = "Delete summary";
      updateSave();
    }
    // Saving the shared summary must not throw away an unfinished staff note.
    if (busyEditing()) { $("#upd").hidden = false; return; }
    try { await afterMutation(); $("#edit-summary")?.focus({ preventScroll: true }); }
    catch (err) { oops(err); }
  };
  input.addEventListener("input", updateSave);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!save.disabled) persist(input.value.trim());
  });
  panel.addEventListener("click", (e) => {
    const id = e.target.closest("button")?.id;
    if (busy) return;
    if (id === "edit-summary") {
      view.hidden = true;
      form.hidden = false;
      removal.hidden = error.hidden = true;
      $("#summary-hint", panel).textContent = `${p.summary?.trim() ? "Editing summary" : "New summary"} · not saved yet`;
      updateSave();
      input.focus();
    }
    if (id === "cancel-summary" || id === "keep-summary") closeEditor();
    if (id === "delete-summary") {
      removal.hidden = false;
      error.hidden = true;
      $("#keep-summary", panel).focus();
    }
    if (id === "confirm-delete-summary") persist(null);
  });
}

// The KPI and playing-time panels sit under the staff reports, beside the sidebar, so a tall sidebar leaves no gap
// above them; when the sidebar is the shorter column they span the full width instead. Re-checked whenever either
// column changes height (the Impect, Transfermarkt and history panels load after the page).
function fitPlayerGrid(root) {
  const grid = $(".p-grid", root), main = $(".p-main", root), side = $(".p-side", root);
  if (!grid || !main || !side || !window.ResizeObserver) return;
  // Up to 60px taller still counts as short: a sliver of gap beats a squeezed KPI block.
  const fit = () => grid.isConnected ? grid.classList.toggle("side-short", side.offsetHeight <= main.offsetHeight + 60) : ro.disconnect();
  const ro = new ResizeObserver(fit);
  ro.observe(main); ro.observe(side);
  fit();
}

function wirePlayer(root, d) {
  wireSummary(root, d.player);
  const p = d.player;
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t || t.closest("#physical-panel, #impect-panel")) return;
    try {
      if (t.id === "back") { if (history.length > 1) history.back(); else location.hash = "#/board"; return; }
      if (t.dataset.rvPlayer) {
        if (await reviewSendDialog(p, t.dataset.rvPlayer)) await afterMutation();
        return;
      }
      if (t.id === "mark-reviewed") {
        t.disabled = true;
        try {
          await api("POST", `/api/players/${p.id}/review`);
          toast("Player marked reviewed");
          return await afterMutation();
        } finally { t.disabled = false; }
      }
      if (t.id === "toggle-signed") {
        t.disabled = true;
        try {
          await api("PUT", `/api/players/${p.id}/signing`, { signed: !p.is_signed });
          toast(p.is_signed ? "Signed status removed" : "Player marked as signed");
          return await afterMutation();
        } finally { t.disabled = false; }
      }
      if (t.dataset.decision !== undefined) { await api("PUT", `/api/players/${p.id}/decision`, { decision: t.dataset.decision || null }); return await afterMutation(); }
      if (t.dataset.verdict !== undefined) { await api("PUT", `/api/players/${p.id}/verdict`, { verdict: t.dataset.verdict || null }); return await afterMutation(); }
      if (t.id === "sync-tm") {
        t.disabled = true;
        t.textContent = "Syncing…";
        const result = await api("POST", `/api/players/${p.id}/refresh-tm`, {});
        toast("Synced from Transfermarkt");
        await afterMutation();
        if (result.tm_conflicts?.length) openTmConflicts(p.id, result.tm_conflicts);
        return;
      }
      if (t.id === "share-p") return sharePlayer(p);
      if (t.id === "edit-p") return openEditPlayer(p);
      if (t.id === "del-p") {
        if (!confirm(`Delete ${p.name}, including every note and verdict? This can't be undone.`)) return;
        await api("DELETE", `/api/players/${p.id}`);
        await syncVersion();
        await reloadPlayers();
        toast("Player deleted");
        location.hash = "#/players";
        return;
      }
      if (t.id === "add-role-btn") {
        const role = $("#add-role-sel", root).value;
        if (!role) return;
        const reason = await askBoardReason('add', p.name, [role]);
        if (!reason) return;
        await api("POST", `/api/players/${p.id}/roles`, { role, reason });
        return await afterMutation();
      }
      if (t.dataset.roleStar) {
        const role = t.dataset.roleStar;
        const on = !p.roles.find((r) => r.role === role)?.shortlist;
        const reason = await askBoardReason(on ? 'promote' : 'drop_back', p.name, [role]);
        if (!reason) return;
        await api("POST", "/api/board/shortlist", { player_id: p.id, role, on, reason });
        return await afterMutation();
      }
      if (t.dataset.roleRm) {
        const reason = await askBoardReason('take_off', p.name, [t.dataset.roleRm]);
        if (!reason) return;
        await api("DELETE", `/api/players/${p.id}/roles/${t.dataset.roleRm}`, { reason });
        return await afterMutation();
      }
      if (t.dataset.roleMove) {
        const [role, dir] = t.dataset.roleMove.split(":");
        await api("POST", "/api/board/move", { player_id: p.id, from_role: role, to_role: role, index: rankIn(p, role) + Number(dir) });
        return await afterMutation();
      }
      if (t.id === "ncaa-add-btn") {
        await api("POST", "/api/ncaa/move", { player_id: p.id, position: $("#ncaa-pos-sel", root).value, index: null });
        return await afterMutation();
      }
      if (t.dataset.ncaaMove) {
        await api("POST", "/api/ncaa/move", { player_id: p.id, position: d.ncaa.position, index: d.ncaa.spot + Number(t.dataset.ncaaMove) });
        return await afterMutation();
      }
      if (t.id === "ncaa-rm") { await api("DELETE", `/api/ncaa/board/${p.id}`); return await afterMutation(); }
      if (t.dataset.toggleEmpty !== undefined) {
        try { localStorage.setItem("pine.hideEmptyEvals", hideEmptyEvals() ? "0" : "1"); } catch {}
        return render();
      }
      if (t.id === "college-add" || t.id === "college-cancel") {
        const f = $("#college-form", root);
        f.hidden = t.id === "college-cancel";
        if (!f.hidden) f.querySelector("[name=grade_present]").focus(); else f.reset();
        return;
      }
      if (t.dataset.reportEdit) {
        const r = d.college.reports.find((x) => x.id === Number(t.dataset.reportEdit));
        const el = $(`[data-report="${r.id}"]`, root);
        el.innerHTML = `<form class="college-edit" data-id="${r.id}">${collegeFormHTML(r)}
          <div class="row end"><button type="button" class="btn sm ghost" data-report-cancel>Cancel</button><button type="submit" class="btn sm primary">Save</button></div></form>`;
        return;
      }
      if (t.dataset.reportCancel !== undefined) return render();
      if (t.dataset.reportDel) {
        if (!confirm("Delete this report? The player's grade is worked out again from the rest.")) return;
        await api("DELETE", `/api/college/reports/${t.dataset.reportDel}`);
        return await afterMutation();
      }
      if (t.id === "college-unlink") {
        if (!confirm(`Unlink the college profile “${d.college.name}” (${d.college.school || d.college.team || "college"}) from ${p.name}? It won't be matched to them again.`)) return;
        await api("DELETE", `/api/ncaa/prospects/${encodeURIComponent(d.college.key)}/link`);
        return await afterMutation();
      }
      if (t.dataset.noteEdit) return editNote(root, d, Number(t.dataset.noteEdit));
      if (t.dataset.noteDel) {
        if (!confirm("Delete this note?")) return;
        await api("DELETE", `/api/notes/${t.dataset.noteDel}`);
        return await afterMutation();
      }
    } catch (err) {
      oops(err);
      if (t.id === "sync-tm") { t.disabled = false; t.textContent = "Sync from Transfermarkt"; }
    }
  });
  $("#note-form", root)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = $("button[type=submit]", f);
    const body = f.elements.body.value.trim();
    if (!body) return;
    btn.disabled = true;
    try {
      await api("POST", `/api/players/${p.id}/notes`, { body, context: f.elements.context.value });
      f.elements.body.value = "";
      f.elements.context.value = "";
      toast("Note added");
      await afterMutation();
    } catch (err) { oops(err); btn.disabled = false; }
  });
  root.addEventListener("submit", async (e) => {
    const f = e.target.closest("#college-form, .college-edit");
    if (!f) return;
    e.preventDefault();
    const btn = $("button[type=submit]", f);
    btn.disabled = true;
    try {
      if (f.id === "college-form") await api("POST", `/api/players/${p.id}/college/reports`, collegeFormData(f));
      else await api("PUT", `/api/college/reports/${f.dataset.id}`, collegeFormData(f));
      toast("Report saved");
      await afterMutation();
    } catch (err) { oops(err); btn.disabled = false; }
  });
  $("#link-tm", root)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("POST", `/api/players/${p.id}/refresh-tm`, { url: $("input", e.target).value }); toast("Linked to Transfermarkt"); await afterMutation(); } catch (err) { oops(err); }
  });
}

function editNote(root, d, id) {
  const n = d.staff.flatMap((s) => s.notes).find((x) => x.id === id);
  const el = $(`[data-note="${id}"]`, root);
  if (!n || !el) return;
  el.innerHTML = `<form class="note-form">
    <input name="context" value="${esc(n.context || "")}" placeholder="Context" aria-label="Note context">
    <textarea name="body" rows="4" data-draft data-orig="${esc(n.body)}" aria-label="Note">${esc(n.body)}</textarea>
    <div class="row end"><button type="button" class="btn sm ghost" data-cancel>Cancel</button><button class="btn sm primary" type="submit">Save</button></div></form>`;
  const f = $("form", el);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("PATCH", `/api/notes/${id}`, { body: f.elements.body.value, context: f.elements.context.value }); await afterMutation(); } catch (err) { oops(err); }
  });
  $("[data-cancel]", f).addEventListener("click", () => { f.elements.body.dataset.orig = f.elements.body.value; refresh(); });
  f.elements.body.focus();
}

/* ---------- physical panel ---------- */
function bar(label, pct, raw, { format = fmtNum, title = label } = {}) {
  return `<div class="bar"><span class="bl" title="${esc(title)}">${esc(label)}${raw != null ? ` <span class="raw">${format(raw)}</span>` : ""}</span>
    <span class="track"><span class="fill" style="width:${Math.max(2, pct)}%;--c:${band(pct)}"></span></span><span class="bv">${pct}</span></div>`;
}

// The physical metrics that say most about the player himself, as the physical database rates them:
// how well each repeats season to season for the same player, and how much of it his club explains.
// Volume, accel/decel and max speed describe the team or don't repeat, so they stay in the full list.
const PHYS_KEY = [
  ["Player capability", [
    ["Sprint Count Per 90", 0.49, 12, "The least club-explained number on the card."],
    ["Sprinting Distance Per 90 (+25)", 0.45, 12, "Top-end volume he brings himself, not the system."],
    ["HSR Count Per 90", 0.40, 14, "Individual, but the softest repeatability of the sprint family."],
  ]],
  ["Mixed", [
    ["High Intensity Count Per 90", 0.45, 17, "Bursts above 20 km/h. Part player, part system."],
    ["High Intensity Distance Per 90", 0.43, 18, "HSR and sprint distance combined, so it inherits both."],
    ["Running Distance Per 90 (15-20)", 0.42, 16, "Middle-gear volume. Part player, part role."],
    ["HSR Distance Per 90 (20-25)", 0.41, 17, "Carries much the same signal as HSR count."],
  ]],
];

function physKeyBars(r, meta) {
  const at = new Map(meta.metrics.map((m, j) => [m.l, j]));
  return PHYS_KEY.map(([reads, metrics]) => {
    const bars = metrics.filter(([l]) => at.has(l)).map(([l, rep, team, why]) =>
      bar(l.replace(" Per 90", ""), r.pct[at.get(l)], r.raw[at.get(l)],
        { title: `${l}: ${why} Repeatability ${rep.toFixed(2)}, team share ${team}%.` }));
    return bars.length ? `<div class="bars-h">${reads}</div>${bars.join("")}` : "";
  }).join("");
}

function physCard(r, meta, open) {
  const pool = `${r.pool} ${GRP_NAME[r.grp] || r.grp}`;
  return `<details class="phys" ${open ? "open" : ""}>
    <summary><div style="min-width:0"><b>${esc(r.season)} · ${esc(r.team)}</b><div class="muted sm">${esc(r.league)} · ${esc(r.pos)} · ${r.mins} min${r.mp ? ` · ${r.mp} apps` : ""}</div></div>
      <span class="pct-pill" style="--c:${band(r.overall)}" title="Average percentile across all 14 metrics">${r.overall}</span></summary>
    <div class="inner">
      ${r.pool < 10 ? `<div class="banner warn sm">Only ${pool} in this pool, too few for percentiles to mean much.</div>`
        : r.pool < 20 ? `<div class="banner warn sm">Small pool (${pool}). Read the percentiles loosely.</div>`
        : `<div class="muted sm">Percentile vs ${pool} in ${esc(r.league)} ${esc(r.season)}</div>`}
      <div class="bars group">${physKeyBars(r, meta)}</div>
      <details class="more"><summary>All 14 metrics</summary><div class="bars">${meta.metrics.map((m, j) => bar(m.l, r.pct[j], r.raw[j])).join("")}</div></details>
      <a class="sm" href="${esc(r.link)}" target="_blank" rel="noopener">Open full physical card ↗</a>
    </div>
  </details>`;
}

const PHYS_REASON = { name: "name", "name-close": "similar name", "surname-only": "surname only", age: "age", club: "club", "age-mismatch": "age differs" };
function physCand(r, checked) {
  return `<label class="cand"><input type="checkbox" value="${esc(r.key)}" ${checked ? "checked" : ""}>
    <span class="ci"><b>${esc(r.name)}</b> · ${esc(r.team)}<div class="muted sm">${esc(r.league)} ${esc(r.season)} · ${esc(r.pos)} · age ${r.age} · ${r.mins} min</div></span>
    ${r.reasons ? `<span class="why">${r.reasons.map((x) => `<span class="${x === "age-mismatch" ? "bad" : x === "surname-only" ? "warn" : ""}">${esc(PHYS_REASON[x] || x)}</span>`).join("")}</span>` : ""}</label>`;
}

async function loadPhysicalPanel(root, p) {
  const el = $("#physical-panel", root);
  let d;
  try { d = await api("GET", `/api/players/${p.id}/physical`); } catch (e) {
    el.innerHTML = `<p class="empty">Couldn't load physical data: ${esc(e.message)}</p>`;
    return;
  }
  const draw = (editing) => {
    const shown = new Set([...d.linked, ...d.candidates].map((r) => r.key));
    el.innerHTML = `<div class="an-actions">${d.linked.length && !d.confirmed ? `<span class="muted sm">Auto-matched</span>` : ""}
      <button type="button" class="btn sm ghost" data-phys-toggle>${editing ? "Cancel" : d.linked.length ? "Change links" : "Link"}</button></div>
      ${editing ? `<p class="hint">Tick every season row that belongs to this player.</p>
          <div>${d.linked.map((r) => physCand(r, true)).join("")}${d.candidates.map((r) => physCand(r, false)).join("")}${!shown.size ? `<p class="empty">No name matches. Search below.</p>` : ""}</div>
          <input type="search" id="phys-q" placeholder="Search by name or team…" style="width:100%;margin-top:8px" aria-label="Search physical database">
          <div id="phys-res"></div>
          <div class="row end" style="margin-top:10px"><button type="button" class="btn sm primary" data-phys-save>Save links</button></div>`
        : d.linked.length ? `<div class="phys-grid">${d.linked.map((r) => physCard(r, d.meta, true)).join("")}</div>`
        : `<p class="empty">No physical data linked.${d.candidates.length ? ` ${d.candidates.length} possible match${d.candidates.length > 1 ? "es" : ""}; click Link to review.` : " The physical database covers MLS NEXT Pro, USL Championship, USL League One and CPL players with 600+ minutes."}</p>`}
      <p class="sm muted" style="margin:8px 0 0"><a href="${esc(d.meta.site)}" target="_blank" rel="noopener">Physical database ↗</a></p>`;
    const q = $("#phys-q", el);
    q?.addEventListener("input", debounce(async () => {
      const res = $("#phys-res", el);
      if (q.value.trim().length < 2) { res.innerHTML = ""; return; }
      try {
        const { rows } = await api("GET", `/api/physical/search?q=${encodeURIComponent(q.value.trim())}`);
        res.innerHTML = rows.filter((r) => !shown.has(r.key)).map((r) => physCand(r, false)).join("") || `<p class="empty">No results.</p>`;
      } catch (err) { oops(err); }
    }));
  };
  draw(false);
  el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-phys-toggle]")) return draw(!$("[data-phys-save]", el));
    if (!e.target.closest("[data-phys-save]")) return;
    const keys = $$("input[type=checkbox]:checked", el).map((x) => x.value);
    try { await api("PUT", `/api/players/${p.id}/physical`, { keys }); toast("Physical data links saved"); await afterMutation(); } catch (err) { oops(err); }
  });
}

/* ---------- impect panel ---------- */
function impCand(x) {
  return `<div class="cand"><span class="ci"><b>${esc(x.name)}</b>${x.birthdate ? ` · ${esc(fmtDate(x.birthdate))}` : ""}
    <div class="muted sm">${esc([x.squad, x.competition, x.season].filter(Boolean).join(" · "))}</div></span>
    ${x.confidence === "high" ? `<span class="why"><span>name + dob</span></span>` : ""}
    ${x.pine_id ? `<a class="sm" href="#/player/${x.pine_id}">In PINE</a>${x.can_merge && S.me.is_admin ? `<button type="button" class="btn sm" data-imp-merge="${x.pine_id}">Combine profiles</button>` : ""}` : `<button type="button" class="btn sm" data-imp-link="${x.impect_id}">Link</button>`}</div>`;
}

async function loadImpectPanel(root, p) {
  const el = $("#impect-panel", root);
  const head = `<header class="panel-h"><h2>Impect</h2>${p.impect_id ? `<button type="button" class="btn sm ghost" data-imp-unlink>Unlink</button>` : ""}</header>`;
  if (!S.config.impect) { el.innerHTML = `${head}<p class="empty">Impect credentials aren't configured on the server.</p>`; return; }
  if (p.impect_id) {
    el.innerHTML = `${head}<dl class="kv"><dt>Impect ID</dt><dd>${p.impect_id}</dd>${p.impect_squad ? `<dt>Squad</dt><dd>${esc(p.impect_squad)}</dd>` : ""}${p.impect_competition ? `<dt>Competition</dt><dd>${esc(p.impect_competition)}</dd>` : ""}</dl>`;
  } else {
    el.innerHTML = `${head}<div class="loading sm">Looking for this player in Impect…</div>`;
    let c;
    try { c = await api("GET", `/api/players/${p.id}/impect-candidates`); } catch (e) {
      el.innerHTML = `${head}<p class="empty">Couldn't reach Impect: ${esc(e.message)}</p>`;
      return;
    }
    el.innerHTML = `${head}<p class="empty">Not linked to an Impect player.</p>
      <div>${c.candidates.map(impCand).join("")}</div>
      <input type="search" id="imp-q" placeholder="Search Impect players by name…" style="width:100%;margin-top:8px" aria-label="Search Impect players">
      <div id="imp-res"></div>`;
    const q = $("#imp-q", el);
    q.addEventListener("input", debounce(async () => {
      const res = $("#imp-res", el);
      if (q.value.trim().length < 2) { res.innerHTML = ""; return; }
      try {
        const { players } = await api("GET", `/api/impect/search?q=${encodeURIComponent(q.value.trim())}&limit=12`);
        res.innerHTML = players.map(impCand).join("") || `<p class="empty">No results.</p>`;
      } catch (err) { oops(err); }
    }, 300));
  }
  el.addEventListener("click", async (e) => {
    const merge = e.target.closest("[data-imp-merge]");
    if (merge) {
      merge.disabled = true;
      try {
        const result = await api("POST", `/api/players/${p.id}/merge-impect`, { into_id: Number(merge.dataset.impMerge) });
        toast("Profiles combined; existing board position and scouting data kept");
        location.replace(`/p/${result.player.id}`);
      } catch (err) { merge.disabled = false; oops(err); }
      return;
    }
    const link = e.target.closest("[data-imp-link]");
    const unlink = e.target.closest("[data-imp-unlink]");
    if (!link && !unlink) return;
    try {
      await api("PUT", `/api/players/${p.id}/impect`, { impect_id: link ? Number(link.dataset.impLink) : null });
      toast(link ? "Linked to Impect" : "Unlinked from Impect");
      await afterMutation();
    } catch (err) { oops(err); }
  });
}

/* ---------- player card (a PDF the card worker renders, shown as its PNG; every version is kept) ---------- */
const CARD_FAILED = {
  not_covered: "This season isn't in the card data yet.",
  no_minutes: "The card data has no minutes for this player in this season.",
  position_unavailable: "The card data doesn't have this position for this player in this season.",
  goalkeeper: "Goalkeepers don't have a player card.",
  data_missing: "Some of the data this card needs is missing.",
  render_failed: "The card couldn't be drawn.",
  failed: "The card couldn't be generated.",
};
const cardFailed = (c) => CARD_FAILED[c.error] || CARD_FAILED.failed;
// Why a running card is slower, from the worker's progress note. Impect events take about 3 s a match.
const cardNote = (c) => {
  if (c.status !== "running" || c.progress !== "fetching_events") return "";
  const n = c.progress_matches;
  const what = n ? `event data for ${n} match${n === 1 ? "" : "es"}` : "match event data";
  const wait = !n ? "" : n * 3 < 45 ? ", under a minute" : `, about ${Math.round((n * 3) / 60)} min`;
  return `<p class="card-line muted">${esc(`Downloading ${what} from Impect first${wait}. Later cards reuse it.`)}</p>`;
};
const cardOpen = (c) => c.status === "queued" || c.status === "running";
const cardPdf = (c, label, cls = "btn sm") => `<a class="${cls}" href="/api/cards/${c.id}/pdf" target="_blank" rel="noopener">${label}</a>`;
const cardImg = (c) => c.has_image ? `<a class="card-img" href="/api/cards/${c.id}/pdf" target="_blank" rel="noopener" title="Open the PDF">
  <img src="/api/cards/${c.id}/png" width="1600" height="1088" decoding="async" alt="${esc(`Player card: ${c.position}, ${c.season} ${c.competition}`)}"></a>` : "";
const cardPick = new Map(); // player id -> last season/position picked, kept across re-renders
// The seasons and positions a player's card and maps can be made for. Both panels ask as the page loads,
// so they share one Impect lookup (a failed one isn't kept).
const seasonsAsked = new Map(); // player id -> { at, promise }
function playerSeasons(id) {
  const hit = seasonsAsked.get(id);
  if (hit && Date.now() - hit.at < 60e3) return hit.promise;
  const promise = api("GET", `/api/players/${id}/card-options`);
  promise.catch(() => seasonsAsked.delete(id));
  seasonsAsked.set(id, { at: Date.now(), promise });
  return promise;
}
let cardTimer = null;

async function loadCardPanel(root, p) {
  const el = $("#card-panel", root);
  const head = "";
  let cards, opts;
  try {
    ({ cards } = await api("GET", `/api/players/${p.id}/cards`));
    opts = await playerSeasons(p.id);
  } catch (e) {
    // Impect unreachable: say so, but keep finished cards one click away.
    el.innerHTML = `${head}<div class="banner err sm">${esc(e.message)}</div>${(cards || []).filter((c) => c.status === "done").map((c) =>
      `<div class="card-line"><span>${esc(`${c.position} · ${c.season} · ${fmtDateTime(c.generated_at)}`)}</span><span class="spacer"></span>${cardPdf(c, "Open ↗")}</div>`).join("")}`;
    return;
  }
  if (!el.isConnected) return;
  if (!opts.seasons.length) { el.innerHTML = `${head}<p class="empty">No outfield Impect minutes to build a card from.</p>`; return; }

  // The season and position come from the tab strip above; cardPick remembers the last one seen.
  const offered = (x) => anOffers(x, opts.seasons);
  const first = [an.sel, cardPick.get(p.id)].find(offered) || opts.default;
  const sel = { ...first };
  el.innerHTML = `${S.me.is_admin ? `<div class="an-actions"><button type="button" class="btn sm" id="card-go"></button></div>` : ""}
    <div id="card-body"></div>`;
  const body = $("#card-body", el), go = $("#card-go", el);
  const drawBody = () => {
    const mine = cards.filter((c) => c.iteration_id === sel.iteration_id && c.position === sel.position);
    const done = mine.filter((c) => c.status === "done");
    const failed = mine[0]?.status === "failed" ? mine[0] : null;
    const open = cards.find(cardOpen);
    body.innerHTML = `
      ${open ? `<p class="card-line"><span class="dchip v-hold">${open.status === "queued" ? "Queued" : "Generating"}</span>
        <span class="muted sm">${esc(`${open.position} · ${open.season} ${open.competition} · ${open.status === "queued" ? `requested ${relTime(open.requested_at)}` : `started ${relTime(open.started_at)}`}`)}</span></p>
        ${cardNote(open)}` : ""}
      ${failed ? `<div class="banner err sm">${esc(cardFailed(failed))}</div>` : ""}
      ${done.length ? `<div class="card-line"><span>Generated <b>${esc(fmtDateTime(done[0].generated_at))}</b>${done[0].data_as_of
          ? ` <span class="muted card-asof">· data through ${esc(fmtDate(done[0].data_as_of))}</span>` : ""}</span><span class="spacer"></span>${cardPdf(done[0], "Open PDF ↗")}</div>
        ${cardImg(done[0])}`
        : open || failed ? "" : `<p class="empty">No card for this season and position yet.</p>`}
      ${done.length > 1 ? `<div class="card-older"><div class="lbl">Earlier versions</div><ul>${done.slice(1).map((c) =>
        `<li><span>${esc(fmtDateTime(c.generated_at))}</span>${cardPdf(c, "Open", "")}</li>`).join("")}</ul></div>` : ""}`;
    // A missing picture falls back to the Open PDF button above it.
    $("img", body)?.addEventListener("error", (e) => e.target.parentElement.remove());
    if (!go) return;
    go.textContent = failed ? "Try again" : done.length ? "Regenerate" : "Generate";
    go.classList.toggle("primary", !done.length);
    go.disabled = Boolean(open);
  };
  // Poll while a card is queued or generating; stop once none are, or when the panel is gone
  // (a re-render's new panel owns the timer from then on).
  const watch = () => {
    if (!el.isConnected) return;
    clearTimeout(cardTimer);
    if (!cards.some(cardOpen)) return;
    cardTimer = setTimeout(async () => {
      let fresh;
      try { ({ cards: fresh } = await api("GET", `/api/players/${p.id}/cards`)); } catch { return watch(); }
      if (!el.isConnected) return;
      for (const c of fresh) {
        const was = cards.find((x) => x.id === c.id);
        if (!was || !cardOpen(was) || cardOpen(c)) continue;
        if (c.status === "done") toast(`Player card ready: ${c.position}, ${c.season}`);
        else toast(`Player card failed: ${cardFailed(c)}`, true);
      }
      cards = fresh;
      drawBody();
      watch();
    }, 3000);
  };
  an.handlers.card = (next) => {
    if (!offered(next)) { body.innerHTML = `<p class="empty">No player card for this season and position.</p>`; return; }
    Object.assign(sel, next);
    cardPick.set(p.id, { ...sel });
    drawBody();
  };
  go?.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const { card } = await api("POST", `/api/players/${p.id}/cards`, sel);
      cards = [card, ...cards];
      cardPick.set(p.id, { ...sel });
      await syncVersion(); // your own request needn't trigger the "new changes" refresh
      drawBody();
      watch();
    } catch (err) { oops(err); go.disabled = false; }
  });
  drawBody();
  watch();
}

/* ---------- pitch maps (a player page panel): the card's two maps, with up to three chosen metrics on each ---------- */
const MAP_SIDES = { use: "In attack", defend: "Defensive actions" };
const MAP_SHADE = { use: "#76518e", defend: "#b06127" };
// The glyph of each pick on a map. The first two are the card's, and a map opens on the card's two
// metrics, so it first looks like the card; the third exists only here.
const MAP_GLYPHS = {
  use: [["dot", "#276e91"], ["triangle", "#e6ad2f"], ["square", "#c2474f"]],
  defend: [["dot", "#14705b"], ["cross", "#2b4a72"], ["diamond", "#8a4fb0"]],
};
const MAP_FAILED = {
  not_covered: "This season isn't in the event data yet.",
  no_minutes: "The event data has no minutes for this player in this season.",
  position_unavailable: "The event data doesn't have this position for this player in this season.",
  goalkeeper: "Goalkeepers don't have pitch maps.",
  data_missing: "Some of the data these maps need is missing.",
  render_failed: "The maps couldn't be built.",
  failed: "The maps couldn't be built.",
};
const PITCH_VIEWBOX = "-1.5 -2.6 71 110.2"; // the 68 x 105 m pitch plus its goals
const mapOpen = (m) => m.status === "queued" || m.status === "running";
const mapFailed = (m) => MAP_FAILED[m.error] || MAP_FAILED.failed;
const mapsPick = new Map(); // player id -> the season and position last viewed
const mapsJson = new Map(); // build id -> its export; a build never changes
let mapsTimer = null;
const r2 = (v) => Math.round(v * 100) / 100;

// Picks per position group and map: three slots, each a metric key or null; the slot sets the glyph.
// Kept in this browser, so the metrics chosen for one centre-back carry over to the next.
const MAP_PICKS_KEY = "pine.mapPicks";
const picksMemory = {};
function storedPicks() {
  try { return { ...picksMemory, ...JSON.parse(localStorage.getItem(MAP_PICKS_KEY) || "{}") }; } catch { return picksMemory; }
}
function storePicks(group, picks) {
  picksMemory[group] = picks;
  try { localStorage.setItem(MAP_PICKS_KEY, JSON.stringify({ ...storedPicks(), [group]: picks })); } catch {}
}
const cardPicks = (data, side) => [0, 1, 2].map((i) => data.defaults[side][i] || null);
function picksFor(data) {
  const mine = storedPicks()[data.group] || {};
  return Object.fromEntries(["use", "defend"].map((side) => {
    const ok = new Set(data.metrics.filter((m) => m.side === side && m.available).map((m) => m.key));
    const want = Array.isArray(mine[side]) ? mine[side] : cardPicks(data, side);
    const seen = new Set();
    return [side, [0, 1, 2].map((i) => {
      const k = want[i];
      if (!k || !ok.has(k) || seen.has(k)) return null;
      seen.add(k);
      return k;
    })];
  }));
}

function glyph(shape, x, y, color, s = 1) {
  const r = r2(1.1 * s), X = r2(x), Y = r2(y), w = r2(0.25 * s);
  if (shape === "dot") return `<circle cx="${X}" cy="${Y}" r="${r2(0.9 * s)}" fill="${color}" fill-opacity=".85" stroke="#fff" stroke-width="${w}"/>`;
  if (shape === "triangle") return `<path d="M${X},${r2(Y - r)}l${r},${r2(2 * r)}h${-r2(2 * r)}Z" fill="${color}" stroke="#624815" stroke-width="${r2(0.3 * s)}"/>`;
  if (shape === "cross") {
    return `<path d="M${r2(X - r)},${r2(Y - r)}L${r2(X + r)},${r2(Y + r)}M${r2(X - r)},${r2(Y + r)}L${r2(X + r)},${r2(Y - r)}" stroke="${color}" stroke-width="${r2(0.55 * s)}" stroke-linecap="round" fill="none"/>`;
  }
  if (shape === "square") {
    const h = r2(0.8 * s);
    return `<rect x="${r2(X - h)}" y="${r2(Y - h)}" width="${r2(2 * h)}" height="${r2(2 * h)}" fill="${color}" stroke="#fff" stroke-width="${w}"/>`;
  }
  return `<path d="M${X},${r2(Y - r)}L${r2(X + r)},${Y}L${X},${r2(Y + r)}L${r2(X - r)},${Y}Z" fill="${color}" stroke="#fff" stroke-width="${w}"/>`;
}
const glyphIcon = (side, slot, size = 14) => {
  const [shape, color] = MAP_GLYPHS[side][slot];
  return `<svg class="glyph" viewBox="-1.7 -1.7 3.4 3.4" width="${size}" height="${size}" aria-hidden="true">${glyph(shape, 0, 0, color)}</svg>`;
};
// The card's pitch: 68 x 105 m, attacking upward, goals outside the lines.
const PITCH_LINES = (() => {
  const c = "#8b8d83";
  const box = (x, y, w, h, stroke = c, sw = 0.3) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
  return box(0, 0, 68, 105, c, 0.35) + `<line x1="0" y1="52.5" x2="68" y2="52.5" stroke="${c}" stroke-width=".3"/>`
    + `<circle cx="34" cy="52.5" r="9.15" fill="none" stroke="${c}" stroke-width=".3"/>`
    + [0, 88.5].map((y) => box(13.84, y, 40.32, 16.5)).join("") + [0, 99.5].map((y) => box(24.84, y, 18.32, 5.5)).join("")
    + [11, 94].map((y) => `<circle cx="34" cy="${y}" r=".35" fill="${c}"/>`).join("")
    + [-1.6, 105].map((y) => box(30.34, y, 7.32, 1.6, "#626d61")).join("");
})();
// One map's drawing in pitch metres: the shading (or each action, when sparse), the lines, then the
// chosen metrics in slot order. clip must be unique in the document.
function pitchInner(data, side, slots, clip) {
  const layer = data.layers[side], c = MAP_SHADE[side];
  let s = `<defs><clipPath id="${clip}"><rect width="68" height="105"/></clipPath></defs><rect width="68" height="105" fill="#f3f2ec"/><g clip-path="url(#${clip})">`;
  if (layer.sparse) s += layer.points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.3" fill="${c}" stroke="#fff" stroke-width=".35"/>`).join("");
  else {
    s += ["80", "50"].map((mass) => layer.paths[mass].map((d) => mass === "80"
      ? `<path d="${d}" fill="${c}" fill-opacity=".1" stroke="${c}" stroke-opacity=".3" stroke-width=".3"/>`
      : `<path d="${d}" fill="${c}" fill-opacity=".25" stroke="${c}" stroke-width=".7"/>`).join("")).join("");
  }
  s += `</g>${PITCH_LINES}`;
  slots.forEach((key, i) => {
    const m = key && data.metrics.find((x) => x.key === key);
    const [shape, color] = MAP_GLYPHS[side][i];
    if (m) s += m.points.map(([x, y]) => glyph(shape, x, y, color)).join("");
  });
  return s;
}
const sameSlots = (a, b) => a.every((k, i) => k === b[i]);
const actions = (n) => `${n.toLocaleString()} action${n === 1 ? "" : "s"}`;

function mapBox(data, side, slots) {
  const layer = data.layers[side];
  const mine = data.metrics.filter((m) => m.side === side);
  const full = slots.every(Boolean);
  const chosen = slots.map((k) => k && mine.find((m) => m.key === k));
  const legend = chosen.map((m, i) => (m ? `<span class="lg">${glyphIcon(side, i)}<span class="lg-l">${esc(m.label)}</span><b>${m.points.length.toLocaleString()}</b></span>` : "")).join("");
  const described = chosen.filter(Boolean).map((m) => `${m.label} ${m.points.length}`).join(", ");
  return `<section class="map-box" data-side="${side}">
    <header class="map-h"><span class="map-swatch" style="background:${MAP_SHADE[side]}"></span><h3>${MAP_SIDES[side]}</h3>
      <span class="muted sm">${actions(layer.n)}${layer.sparse ? " · sparse" : ""}</span>
      <button type="button" class="btn sm ghost" data-reset="${side}" ${sameSlots(slots, cardPicks(data, side)) ? "disabled" : ""} title="Go back to the two metrics the player card shows for this position">Card's metrics</button></header>
    <div class="map-body">
      <figure class="map-fig">
        <svg class="pitch-svg" viewBox="${PITCH_VIEWBOX}" role="img" aria-label="${esc(`${MAP_SIDES[side]}, ${actions(layer.n)}${described ? `, showing ${described}` : ""}`)}">${pitchInner(data, side, slots, `clip-${side}`)}</svg>
        <figcaption class="map-legend">${legend || `<span class="muted">No metrics chosen</span>`}</figcaption>
      </figure>
      <div class="map-metrics" role="group" aria-label="${esc(MAP_SIDES[side])} metrics">
        ${[...new Set(mine.map((m) => m.category))].map((cat) => `<div class="mm-cat"><div class="lbl">${esc(cat)}</div>${mine.filter((m) => m.category === cat).map((m) => {
          const slot = slots.indexOf(m.key), on = slot >= 0, off = !m.available || (!on && full);
          const why = !m.available ? " Not in this player's event data." : !on && full ? " Three are chosen; clear one first." : "";
          return `<label class="mm${on ? " on" : ""}${off ? " off" : ""}" title="${esc(m.definition + why)}">
            <input type="checkbox" data-metric="${esc(m.key)}" data-side="${side}"${on ? " checked" : ""}${off ? " disabled" : ""}>
            <span class="mm-g">${on ? glyphIcon(side, slot) : ""}</span><span class="mm-l">${esc(m.label)}</span>
            <span class="mm-n">${m.available ? m.points.length.toLocaleString() : "n/a"}</span></label>`;
        }).join("")}</div>`).join("")}
      </div>
    </div>
  </section>`;
}

// A standalone picture of both maps for a report or a message: header, maps, legends.
function mapsExportSvg(data, picks) {
  const W = 1000, PW = 420, PH = r2((PW * 110.2) / 71), top = 132, cols = [50, 530];
  const legendY = top + PH + 34, H = legendY + 3 * 26 + 44;
  const who = data.player, when = data.sample.last_match ? ` · data through ${fmtDate(data.sample.last_match)}` : "";
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`
    + `<rect width="${W}" height="${H}" fill="#faf8f1"/>`
    + `<text x="50" y="62" font-size="32" font-weight="700" fill="#13201a">${esc(who.name)}</text>`
    + `<text x="50" y="92" font-size="16" fill="#44524b">${esc(`${who.club} · ${who.league} ${who.season} · ${data.position}`)}</text>`
    + `<text x="950" y="92" font-size="13" fill="#75817a" text-anchor="end">${esc(`${data.sample.matches} matches${when}`)}</text>`;
  ["use", "defend"].forEach((side, i) => {
    const x = cols[i];
    s += `<text x="${x}" y="${top - 12}" font-size="14" font-weight="700" letter-spacing="1.2" fill="${MAP_SHADE[side]}">${MAP_SIDES[side].toUpperCase()}</text>`
      + `<text x="${x + PW}" y="${top - 12}" font-size="12" fill="#75817a" text-anchor="end">${actions(data.layers[side].n)}</text>`
      + `<svg x="${x}" y="${top}" width="${PW}" height="${PH}" viewBox="${PITCH_VIEWBOX}">${pitchInner(data, side, picks[side], `png-clip-${side}`)}</svg>`;
    picks[side].forEach((key, j) => {
      const m = key && data.metrics.find((x2) => x2.key === key);
      if (!m) return;
      const y = legendY + j * 26;
      s += `<svg x="${x}" y="${y - 13}" width="17" height="17" viewBox="-1.7 -1.7 3.4 3.4">${glyph(MAP_GLYPHS[side][j][0], 0, 0, MAP_GLYPHS[side][j][1])}</svg>`
        + `<text x="${x + 26}" y="${y}" font-size="14" fill="#13201a">${esc(m.label)}</text>`
        + `<text x="${x + PW}" y="${y}" font-size="14" font-weight="700" fill="#13201a" text-anchor="end">${m.points.length.toLocaleString()}</text>`;
    });
  });
  s += `<text x="50" y="${H - 22}" font-size="12" fill="#75817a">Open play only · attacking upward · shading holds 50% and 80% of the player's actions on each map · Impect event data</text>`
    + `<text x="950" y="${H - 22}" font-size="12" font-weight="700" fill="#1f5a3e" text-anchor="end">PINE · Hearts of Pine</text>`;
  return { svg: s + "</svg>", W, H };
}
async function downloadMapsPng(data, picks) {
  const { svg, W, H } = mapsExportSvg(data, picks);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0, W, H);
  const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
  if (!blob) throw new Error("The picture couldn't be made in this browser");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${data.player.name} ${data.player.season} ${data.position} pitch maps.png`.replace(/[\\/:*?"<>|]/g, "");
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function mapsStatusHTML(view, { done, open, failed }, meta) {
  const out = [];
  if (open) {
    const queued = open.status === "queued";
    out.push(`<p class="card-line"><span class="dchip v-hold">${queued ? "Queued" : "Building"}</span><span class="muted sm">${esc(queued ? `requested ${relTime(open.requested_at)}` : `started ${relTime(open.started_at)}`)}</span></p>`);
    if (!queued && open.progress === "fetching_events") {
      const n = open.progress_matches;
      const wait = !n ? "" : n * 3 < 45 ? ", under a minute" : `, about ${Math.round((n * 3) / 60)} min`;
      out.push(`<p class="card-line muted sm">${esc(`Downloading event data for ${n ? `${n} match${n === 1 ? "" : "es"}` : "its matches"} from Impect first${wait}. Later maps and cards reuse it.`)}</p>`);
    }
    // The builder polls every 5 seconds; say why a job is still waiting after half a minute.
    const seen = toDate(meta.worker_seen_at), mapsSeen = toDate(meta.maps_worker_seen_at);
    const recent = (d) => d && Date.now() - d < 60e3;
    const waited = Date.now() - (toDate(open.requested_at) || Date.now());
    if (queued && waited > 30e3) {
      if (!recent(seen)) {
        out.push(`<div class="banner warn sm">The map builder ${seen ? `last checked in ${esc(relTime(meta.worker_seen_at))}` : "hasn't checked in since PINE last restarted"}. It runs on the club's Mac mini, so these maps will build once it's back online.</div>`);
      } else if (!recent(mapsSeen)) {
        out.push(`<div class="banner warn sm">The builder on the club's Mac mini is running but isn't taking map jobs yet. It needs a restart to pick up pitch maps; until then these maps wait in the queue.</div>`);
      } else if (waited > 60e3) out.push(`<p class="card-line muted sm">Waiting for the builder to finish another job first.</p>`);
    }
  }
  if (failed) out.push(`<div class="banner err sm">${esc(mapFailed(failed))}${done ? " The last good build is shown." : ""}</div>`);
  if (done) {
    out.push(`<p class="card-line muted sm">${esc(`Built ${fmtDateTime(done.generated_at)}${done.data_as_of ? ` · data through ${fmtDate(done.data_as_of)}` : ""}`)}</p>`);
    if (meta.latest_catalog && done.catalog && done.catalog !== meta.latest_catalog) {
      out.push(`<div class="banner info sm">Metrics have been added since these maps were built. Rebuild them to include the new ones.</div>`);
    } else if (!open && Number(view.season) >= new Date().getFullYear() && Date.now() - toDate(done.generated_at) > 7 * 864e5) {
      out.push(`<div class="banner info sm">${esc(`Built ${relTime(done.generated_at)}, so later matches aren't in it. Rebuild to bring it up to date.`)}</div>`);
    }
  }
  return out.join("");
}

// Seasons and positions from the builds alone, for when Impect can't be reached to list them.
function mapViewsFromBuilds(maps) {
  const seasons = new Map();
  for (const m of maps.filter((x) => x.status === "done")) {
    const s = seasons.get(m.iteration_id) || { iteration_id: m.iteration_id, competition: m.competition, season: m.season, positions: [] };
    if (!s.positions.some((o) => o.code === m.position)) s.positions.push({ code: m.position, label: m.position });
    seasons.set(m.iteration_id, s);
  }
  return [...seasons.values()];
}

async function loadMapsPanel(root, p) {
  const el = $("#maps-panel", root);
  const head = (button = "") => `<p class="an-sub">Where their open-play actions happen</p>${button ? `<div class="an-actions">${button}</div>` : ""}`;
  const [optsRes, listRes] = await Promise.allSettled([playerSeasons(p.id), api("GET", `/api/players/${p.id}/maps`)]);
  if (!el.isConnected) return;
  if (listRes.status === "rejected") { el.innerHTML = `${head()}<div class="banner err sm">${esc(listRes.reason.message)}</div>`; return; }
  let list = listRes.value;
  const opts = optsRes.status === "fulfilled" ? optsRes.value : null;
  const views = opts ? opts.seasons : mapViewsFromBuilds(list.maps);
  if (!views.length) {
    el.innerHTML = `${head()}${opts ? `<p class="empty">No outfield Impect minutes in our leagues to map.</p>`
      : `<div class="banner err sm">${esc(optsRes.reason.message)}</div><p class="empty">Nothing has been built for this player yet.</p>`}`;
    return;
  }
  el.innerHTML = `${head(`<button type="button" class="btn sm" id="maps-go" hidden></button>
      <button type="button" class="btn sm" id="maps-png" disabled title="Save both maps with the chosen metrics as a picture">Download PNG</button>`)}
    <div class="maps-status" id="maps-status"></div>
    <div id="maps-body"></div>`;
  const go = $("#maps-go", el), png = $("#maps-png", el);
  const status = $("#maps-status", el), body = $("#maps-body", el);
  // The season and position come from the tab strip above, unless only built maps are known.
  const offered = (x) => anOffers(x, views);
  const lastBuilt = list.maps.find((m) => m.status === "done");
  const sel = { ...([an.sel, mapsPick.get(p.id), lastBuilt && { iteration_id: lastBuilt.iteration_id, position: lastBuilt.position }].find(offered)
    || opts?.default || { iteration_id: views[0].iteration_id, position: views[0].positions[0].code }) };
  const season = () => views.find((v) => v.iteration_id === sel.iteration_id);
  let shown = null; // the build on screen, so polling doesn't redraw it
  let ticket = 0;
  const state = () => {
    const mine = list.maps.filter((m) => m.iteration_id === sel.iteration_id && m.position === sel.position);
    return { done: mine.find((m) => m.status === "done"), open: mine.find(mapOpen), failed: mine[0]?.status === "failed" ? mine[0] : null };
  };
  const drawStatus = () => {
    const st = state();
    const outdated = st.done && list.latest_catalog && st.done.catalog && st.done.catalog !== list.latest_catalog;
    status.innerHTML = (opts ? "" : `<div class="banner warn sm">Seasons can't be listed right now (${esc(optsRes.reason.message)}), so only built maps are shown.</div>`)
      + mapsStatusHTML(season(), st, list);
    go.hidden = !opts;
    go.disabled = Boolean(st.open);
    go.textContent = st.open ? "Building…" : st.done ? "Rebuild" : st.failed ? "Try again" : "Build maps";
    go.classList.toggle("primary", !st.done || Boolean(outdated));
    return st;
  };
  const showMaps = (data) => {
    const picks = picksFor(data);
    png.disabled = false;
    png.onclick = async () => {
      png.disabled = true;
      try { await downloadMapsPng(data, picks); } catch (err) { oops(err); }
      png.disabled = false;
    };
    const ms = data.sample.match_share;
    body.innerHTML = `<p class="maps-meta">${esc(`${data.player.league} ${data.player.season} · ${data.position} · ${data.sample.matches} match${data.sample.matches === 1 ? "" : "es"}, ${ms.toFixed(1)} match shares`)}</p>
      <div class="maps-grid">${["use", "defend"].map((side) => mapBox(data, side, picks[side])).join("")}</div>
      <p class="maps-note muted sm">Open play only; set pieces are left out. Attacking upward. The darker shading holds half of the player's actions on that map and the lighter shading four fifths; with 20 or fewer, each action is a dot. Up to three metrics per map; hover one for its definition.</p>`;
    const repaint = (side, focusKey) => {
      const old = $(`.map-box[data-side="${side}"]`, body);
      const scroll = $(".map-metrics", old).scrollTop;
      old.outerHTML = mapBox(data, side, picks[side]);
      const box = $(`.map-box[data-side="${side}"]`, body);
      $(".map-metrics", box).scrollTop = scroll;
      if (focusKey) $(`input[data-metric="${focusKey}"]`, box)?.focus();
      storePicks(data.group, picks);
    };
    body.onchange = (e) => {
      const box = e.target.closest("input[data-metric]");
      if (!box) return;
      const slots = picks[box.dataset.side], key = box.dataset.metric;
      if (box.checked) {
        const free = slots.indexOf(null);
        if (free < 0) { box.checked = false; return; }
        slots[free] = key;
      } else slots[slots.indexOf(key)] = null;
      repaint(box.dataset.side, key);
    };
    body.onclick = (e) => {
      const side = e.target.closest("[data-reset]")?.dataset.reset;
      if (!side) return;
      picks[side] = cardPicks(data, side);
      repaint(side);
    };
  };
  const draw = async () => {
    mapsPick.set(p.id, { ...sel });
    const { done, open, failed } = drawStatus();
    if (done?.id === shown) return;
    const mine = ++ticket;
    shown = done?.id ?? null;
    png.disabled = true;
    body.onchange = body.onclick = null;
    if (!done) {
      body.innerHTML = open ? `<p class="empty">Building these maps. They'll appear here when they're ready; you can leave this page meanwhile.</p>`
        : failed ? "" : `<p class="empty">No maps for this season and position yet. Build them with the button above; it usually takes under a minute.</p>`;
      return;
    }
    let data = mapsJson.get(done.id);
    if (!data) {
      body.innerHTML = `<div class="loading sm">Loading maps…</div>`;
      try { data = await api("GET", `/api/maps/${done.id}/json`); } catch (e) {
        if (mine === ticket && el.isConnected) { shown = null; body.innerHTML = `<div class="banner err sm">${esc(e.message)}</div>`; }
        return;
      }
      mapsJson.set(done.id, data);
      if (mapsJson.size > 40) mapsJson.delete(mapsJson.keys().next().value);
      if (mine !== ticket || !el.isConnected) return;
    }
    showMaps(data);
  };
  // Poll while any of this player's maps are waiting or building; stop when none are, or when the panel
  // is gone (a re-render's new panel owns the timer from then on).
  const watch = () => {
    if (!el.isConnected) return;
    clearTimeout(mapsTimer);
    if (!list.maps.some(mapOpen)) return;
    mapsTimer = setTimeout(async () => {
      let fresh;
      try { fresh = await api("GET", `/api/players/${p.id}/maps`); } catch { return watch(); }
      if (!el.isConnected) return;
      for (const m of fresh.maps) {
        const was = list.maps.find((x) => x.id === m.id);
        if (!was || !mapOpen(was) || mapOpen(m)) continue;
        if (m.status === "done") toast(`Maps ready: ${m.position}, ${m.season}`);
        else toast(`Maps for ${m.position}, ${m.season} failed: ${mapFailed(m)}`, true);
      }
      list = fresh;
      draw();
      watch();
    }, 2500);
  };
  an.handlers.maps = (next) => {
    if (!offered(next)) { status.innerHTML = ""; body.innerHTML = `<p class="empty">No pitch maps for this season and position.</p>`; go.hidden = true; png.disabled = true; return; }
    Object.assign(sel, next);
    shown = null;
    draw();
  };
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const res = await api("POST", `/api/players/${p.id}/maps`, sel);
      list = { ...list, ...res, maps: [res.map, ...list.maps.filter((m) => m.id !== res.map.id)] };
      draw();
      watch();
    } catch (err) { oops(err); go.disabled = false; }
  });
  draw();
  watch();
}

/* ---------- impect page ---------- */
async function renderImpect(main) {
  main.innerHTML = `<div class="page" style="max-width:1200px">
    <div class="page-h"><div><h1>Impect</h1><div class="sub">Import your Impect Scouting short lists, or browse every player in your Impect competitions and add them to PINE.</div></div></div>
    <section class="panel" id="sl-panel"><header class="panel-h"><h2>Scouting short lists</h2></header><div class="loading sm">Loading short lists…</div></section>
    <section class="panel" id="tm-match"><header class="panel-h"><h2>Transfermarkt matching</h2></header><div class="loading sm">Loading…</div></section>
    <section class="panel">
      <header class="panel-h"><h2>Browse Impect players</h2></header>
      <div class="filters">
        <select id="ib-it" aria-label="Competition"><option value="">All competitions</option></select>
        <input id="ib-q" type="search" placeholder="Search by name…" value="${esc(S.impect.q)}" style="min-width:240px" aria-label="Search by name">
        <span class="spacer"></span>
        <button type="button" class="btn primary sm" id="ib-add" disabled>Add selected</button>
      </div>
      <div id="ib-res" style="margin-top:10px"><p class="empty">Search by name or pick a competition. The first search loads every player from Impect, which can take up to a minute.</p></div>
    </section>
    <section class="panel" id="ic-panel"><header class="panel-h"><h2>Impect data in PINE</h2></header><div class="loading sm">Loading…</div></section>
  </div>`;
  const root = main.firstElementChild;
  loadShortLists(root);
  loadTmMatch(root);
  loadImpectCache(root);

  try {
    const { iterations } = await api("GET", "/api/impect/iterations");
    $("#ib-it", root).insertAdjacentHTML("beforeend", iterations.map((it) => `<option value="${it.id}" ${String(S.impect.iteration) === String(it.id) ? "selected" : ""}>${esc(it.competition)} ${esc(it.season)}</option>`).join(""));
  } catch (e) {
    $("#ib-res", root).innerHTML = `<div class="banner err">Couldn't reach Impect: ${esc(e.message)}</div>`;
    return;
  }

  let rows = [];
  const drawRows = () => {
    const res = $("#ib-res", root);
    res.innerHTML = rows.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th></th><th>Player</th><th>Age</th><th>Squad</th><th>Competition</th><th>Foot</th><th>Height</th><th></th></tr></thead><tbody>
      ${rows.map((x) => `<tr style="cursor:default">
        <td>${x.pine_id ? "" : `<input type="checkbox" data-sel="${x.impect_id}" aria-label="Select ${esc(x.name)}">`}</td>
        <td><b>${esc(x.name)}</b><div class="csub">${esc(fmtDate(x.birthdate))}</div></td>
        <td>${ageFrom(x.birthdate) ?? ""}</td><td>${esc(x.squad || "")}</td><td>${esc([x.competition, x.season].filter(Boolean).join(" "))}</td>
        <td>${esc(cap(x.foot))}</td><td>${x.height_cm ? `${x.height_cm} cm` : ""}</td>
        <td>${x.pine_id ? `<a href="#/player/${x.pine_id}">In PINE</a>` : `<button type="button" class="btn sm" data-add="${x.impect_id}">Add</button>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="empty">No players found.</p>`;
    $("#ib-add", root).disabled = true;
  };
  const search = async () => {
    S.impect.q = $("#ib-q", root).value.trim();
    S.impect.iteration = $("#ib-it", root).value;
    if (!S.impect.q && !S.impect.iteration) return;
    $("#ib-res", root).innerHTML = `<div class="loading">Searching Impect…</div>`;
    try {
      const qs = new URLSearchParams({ q: S.impect.q, iteration: S.impect.iteration, limit: "250" });
      rows = (await api("GET", `/api/impect/search?${qs}`)).players;
      drawRows();
    } catch (e) { $("#ib-res", root).innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  };
  $("#ib-q", root).addEventListener("input", debounce(search, 350));
  $("#ib-it", root).addEventListener("change", search);
  if (S.impect.q || S.impect.iteration) search();

  const addMany = async (ids) => {
    let ok = 0;
    for (const id of ids) {
      try { await api("POST", "/api/players", { impect_id: id }); ok++; } catch (err) { if (err.status !== 409) oops(err); }
    }
    toast(`Added ${ok} player${ok === 1 ? "" : "s"} to PINE`);
    await afterMutation();
  };
  root.addEventListener("change", (e) => { if (e.target.matches("[data-sel]")) $("#ib-add", root).disabled = !$$("[data-sel]:checked", root).length; });
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-add]");
    if (b) { b.disabled = true; return addMany([Number(b.dataset.add)]); }
    if (e.target.closest("#ib-add")) { e.target.disabled = true; return addMany($$("[data-sel]:checked", root).map((x) => Number(x.dataset.sel))); }
  });
}

// What PINE has saved from Impect, how old it is, and (admins) a button to download it all again.
async function loadImpectCache(root) {
  const el = $("#ic-panel", root);
  const when = (t) => (t ? relTime(new Date(t).toISOString()) : "never");
  let timer = null;
  const draw = async () => {
    let d;
    try { d = await api("GET", "/api/impect/cache"); } catch (e) {
      el.innerHTML = `<header class="panel-h"><h2>Impect data in PINE</h2></header><div class="banner err sm">${esc(e.message)}</div>`;
      return;
    }
    if (!el.isConnected) return;
    const r = d.refresh;
    const total = d.leagues.length + 1; // the league seasons plus the player pool
    const status = (x) => (x.downloading ? `<span class="dchip v-hold">Downloading</span>`
      : x.saved_at ? `<span class="muted">Saved ${esc(when(x.saved_at))}</span>` : `<span class="warn">Not saved yet</span>`);
    el.innerHTML = `<header class="panel-h"><h2>Impect data in PINE</h2>
        ${S.me.is_admin ? `<button type="button" class="btn sm ${r.running ? "" : "primary"}" id="ic-go" ${r.running ? "disabled" : ""}>${r.running ? "Refreshing…" : "Refresh all now"}</button>` : ""}</header>
      <p class="hint">PINE keeps its own copy of every league season below, so KPI profiles, player cards and pitch maps load
        without waiting on Impect. The current season is downloaded again every 6 hours and finished seasons weekly;
        <b>Refresh all now</b> downloads everything straight away, which takes two or three minutes.</p>
      ${r.running ? `<p class="banner">${r.forced ? "Refreshing" : "Scheduled refresh running"}: ${esc(r.current || "starting")} · ${r.done.length} of ${total} done.</p>`
        : r.finished_at && r.forced ? `<p class="sm muted">Last refresh finished ${esc(when(r.finished_at))}: ${r.done.length} of ${total} downloaded${r.failed.length
          ? `, <span class="warn">${r.failed.length} failed (${esc(r.failed.map((x) => x.name).join(", "))})</span>` : ""}.</p>` : ""}
      <div class="table-wrap"><table class="grid"><thead><tr><th>League</th><th>Season</th><th>Impect data</th></tr></thead><tbody>
        ${d.leagues.map((x) => `<tr style="cursor:default"><td>${esc(x.competition)}</td><td>${esc(x.season)}${x.current ? ` <span class="chip">current</span>` : ""}</td><td>${status(x)}</td></tr>`).join("")}
        <tr style="cursor:default"><td>Player pool</td><td class="muted">all</td><td>${status(d.pool)} <span class="muted sm">· search and matching</span></td></tr>
      </tbody></table></div>
      <p class="hint" id="long-throw-sync">Long-throw flags: ${!d.long_throws ? "awaiting first background sync." : `${d.long_throws.stale ? '<span class="warn">Update overdue</span> · ' : ""}updated ${esc(when(d.long_throws.generated_at))}${d.long_throws.pending_matches ? ` · ${d.long_throws.pending_matches} matches awaiting data; retried next run` : ""}.`} Refreshed nightly by the analysis worker, separately from Refresh all now.</p>
      ${d.not_kept.length ? `<p class="sm muted" style="margin:8px 0 0">Not kept: ${esc(d.not_kept.join(", "))}. Cup games are left out of the KPI benchmarks, so nothing uses them.</p>` : ""}`;
    $("#ic-go", el)?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { await api("POST", "/api/impect/cache/refresh"); toast("Refreshing Impect data in the background"); } catch (err) { oops(err); }
      draw();
    });
    clearTimeout(timer);
    if (r.running) timer = setTimeout(draw, 3000);
  };
  draw();
}

async function loadShortLists(root) {
  const el = $("#sl-panel", root);
  const head = (extra = "") => `<header class="panel-h"><h2>Scouting short lists</h2>${extra}</header>`;
  let data;
  try { data = await api("GET", "/api/impect/shortlists"); } catch (e) {
    el.innerHTML = `${head()}<div class="banner info">Couldn't load short lists from Impect Scouting: ${esc(e.message)}</div>`;
    return;
  }
  const roleOptions = (sel) => `<option value="">Don't add to the board</option>
    <optgroup label="Centre backs, split by foot">${Object.entries(data.split_roles).map(([k, l]) => `<option value="${k}" ${sel === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</optgroup>
    ${S.config.positions.map((pos) => `<optgroup label="${esc(pos.code)} · ${esc(pos.label)}">${pos.roles.map(([c, l]) => `<option value="${c}" ${sel === c ? "selected" : ""}>${esc(roleShort(c))} · ${esc(l)}</option>`).join("")}</optgroup>`).join("")}`;
  if (!data.lists.length) { el.innerHTML = `${head()}<p class="empty">No short lists found in your Impect Scouting account.</p>`; return; }
  el.innerHTML = `${head(`<button type="button" class="btn sm primary" id="sl-all">Import all lists</button>`)}
    <p class="hint" style="margin:-4px 0 10px">Players new to a list are placed on the board in the role you pick. Syncing again adds anyone new and never removes players or undoes your board moves.</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>List</th><th>Players</th><th>In PINE</th><th>Board role</th><th></th></tr></thead><tbody>
    ${data.lists.map((l) => `<tr style="cursor:default" data-sl="${esc(l.id)}">
      <td>${l.emoji ? `${esc(l.emoji)} ` : ""}<b>${esc(l.name)}</b></td><td>${l.count}</td><td>${l.in_pine}</td>
      <td><select data-sl-role aria-label="Board role for ${esc(l.name)}">${roleOptions(l.suggested_role)}</select></td>
      <td><button type="button" class="btn sm ${l.imported ? "" : "primary"}" data-sl-import>${l.imported ? "Sync" : "Import"}</button></td></tr>`).join("")}
    </tbody></table></div>`;

  const importOne = async (tr) => {
    const b = $("[data-sl-import]", tr);
    b.disabled = true;
    b.textContent = "Importing…";
    try {
      // No reason prompt: PINE records "Imported from the Impect list …" as the board reason for every spot.
      const role = $("[data-sl-role]", tr).value || null;
      return await api("POST", `/api/impect/shortlists/${encodeURIComponent(tr.dataset.sl)}/import`, { role });
    }
    finally { b.disabled = false; b.textContent = "Sync"; }
  };
  el.addEventListener("click", async (e) => {
    const one = e.target.closest("[data-sl-import]");
    const all = e.target.closest("#sl-all");
    if (!one && !all) return;
    const rows = one ? [one.closest("tr")] : $$("tr[data-sl]", el);
    const sum = { created: 0, existing: 0, missing: 0, placed: 0 };
    if (all) all.disabled = true;
    try {
      for (const [i, tr] of rows.entries()) {
        if (all) all.textContent = `Importing ${i + 1} of ${rows.length}…`;
        const r = await importOne(tr);
        if (!r) { if (all) { all.disabled = false; all.textContent = "Import all lists"; } return; }
        for (const k of Object.keys(sum)) sum[k] += r[k] || 0;
      }
      const label = rows.length === 1 ? `${$("b", rows[0]).textContent}: ` : "";
      toast(`${label}${sum.created} new player${sum.created === 1 ? "" : "s"}, ${sum.placed} placed on the board${sum.missing ? `, ${sum.missing} not found` : ""}`);
      await afterMutation();
    } catch (err) {
      oops(err);
      if (all) { all.disabled = false; all.textContent = "Import all lists"; }
    }
  });
}

/* ---------- database backups (staff page) ---------- */
async function loadBackups(root) {
  const el = $("#bk-list", root);
  if (!el) return;
  try {
    const { snapshots } = await api("GET", "/api/backups");
    el.className = "";
    el.innerHTML = snapshots.length
      ? `<table class="grid"><thead><tr><th>Snapshot</th><th>Size</th><th>Written</th></tr></thead><tbody>${snapshots
          .map((b) => `<tr style="cursor:default"><td>${esc(b.name)}</td><td>${(b.bytes / 1024).toFixed(0)} KB</td><td class="muted">${esc(relTime(b.at))}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p class="empty">No snapshots yet; the first is written when the server starts.</p>`;
  } catch (e) {
    el.className = "";
    el.innerHTML = `<div class="banner err sm">${esc(e.message)}</div>`;
  }
}

/* ---------- bulk transfermarkt matching (impect page) ---------- */
let tmMatchTimer = null;
async function loadTmMatch(root) {
  const el = $("#tm-match", root);
  if (!el) return;
  const head = `<header class="panel-h"><h2>Transfermarkt matching</h2></header>`;
  const draw = (d) => {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    const counts = `<span class="match ok">${d.linked} linked</span><span class="match">${d.unsure} need a look</span><span class="match">${d.no_match} no match</span>${d.failed ? `<span class="match">${d.failed} failed</span>` : ""}`;
    el.innerHTML = `${head}
      <p class="hint" style="margin:-4px 0 10px"><b>${d.unlinked}</b> player${d.unlinked === 1 ? "" : "s"} have no Transfermarkt profile, mostly Impect imports.
        Matching searches Transfermarkt by name and links only when the date of birth agrees, so nothing is guessed.
        It runs about one player every five seconds and keeps going if you leave this page.</p>
      ${d.running
        ? `<div class="prog" title="${d.done} of ${d.total}"><span style="width:${pct}%"></span></div>
           <div class="row" style="margin-top:8px"><span class="muted sm">${d.done} of ${d.total}${d.current ? ` · checking ${esc(d.current)}` : ""}</span><span class="spacer"></span>${counts}</div>`
        : `<div class="row">${d.unlinked ? `<button type="button" class="btn primary sm" id="tm-start">Match ${d.unlinked} players to Transfermarkt</button>` : `<span class="muted sm">Every player is linked.</span>`}
           ${d.total ? `<span class="spacer"></span>${counts}` : ""}</div>
           ${d.stopped_reason ? `<div class="banner warn sm" style="margin-top:8px">${esc(d.stopped_reason)}</div>` : ""}`}
      ${d.results?.length
        ? `<div class="match-results">${[...d.results].reverse().map((r) => `<div class="mr mr-${r.outcome}"><a href="#/player/${r.id}">${esc(r.player)}</a> <span class="muted">${esc(r.detail)}</span></div>`).join("")}</div>`
        : ""}`;
    $("#tm-start", el)?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { draw({ ...(await api("POST", "/api/tm/match-all", {})), unlinked: d.unlinked }); poll(); } catch (err) { oops(err); e.target.disabled = false; }
    });
  };
  const poll = async () => {
    clearTimeout(tmMatchTimer);
    try {
      const d = await api("GET", "/api/tm/match-all");
      draw(d);
      if (d.running) tmMatchTimer = setTimeout(poll, 3000);
      else if (d.finished_at) await reloadPlayers();
    } catch {}
  };
  poll();
}

/* ---------- NCAA: the college scouting database and the position-ranked NCAA board ---------- */
// College grades read current/future: "C/B" is a C player now with a B ceiling. Badges take their colour
// from the future grade, which is what the college database ranks by.
const gradeTone = (g) => ({ A: "g-a", B: "g-b", C: "g-c", D: "g-d" })[String(g || "").split("/").pop().trim()[0]] || "";
const gradeBadge = (g, cls = "") => (g ? `<span class="grade ${gradeTone(g)} ${cls}" title="College grade ${esc(g)}${g.includes("/") ? " (current/future)" : ""}">${esc(g)}</span>` : "");
const CLASS_SHORT = { freshman: "Fr", sophomore: "So", junior: "Jr", senior: "Sr", "grad student": "Grad", gr: "Grad", "5th year": "5th" };
// Classes are worked out per season on the server (classForYear, as the college scouting site does): the live
// board shows this season's, a past board that season's. "Junior" -> "Jr", "R-Sophomore" -> "R-So".
function classShort(c) {
  if (!c) return "";
  const [, redshirt, rest] = String(c).trim().match(/^(r-)?(.*)$/i);
  return (redshirt ? "R-" : "") + (CLASS_SHORT[rest.toLowerCase()] || rest);
}
const CLASS_ORDER = ["Freshman", "R-Freshman", "Sophomore", "R-Sophomore", "Junior", "R-Junior", "Senior", "R-Senior", "Grad Student", "5th Year"];
const REPRESENTATION = [["unknown", "Unknown"], ["none", "No agent"], ["advisor", "Advisor"], ["agent", "Agent"]];
const repLabel = (r) => (REPRESENTATION.find(([k]) => k === r) || REPRESENTATION[0])[1];
function repChip(a) {
  const r = a?.representation;
  if (!r || r === "unknown") return "";
  const who = [a.agent, a.agency].filter(Boolean).join(", ");
  return `<span class="rep rep-${r}" title="${esc(r === "none" ? "No agent or advisor" : `${repLabel(r)}${who ? `: ${who}` : ""}`)}">${{ none: "NO AGT", advisor: "ADV", agent: "AGT" }[r]}</span>`;
}

// The NCAA board uses the Big Board's pitch formation, in college purple, with one ranked list per position.
// A star on the NCAA board acts on the player's Big Board role in that position, else their first role.
const starRole = (p, pos) => (p.roles.find((r) => roleInfo(r.role)?.position === pos) || p.roles[0])?.role || null;

S.ncaa = { q: "", grade: "", rep: "", bb: "", dbYear: "", sort: "grade", dir: -1 };
const BB_FILTER = [["", "Big Board or not"], ["on", "On the Big Board"], ["off", "Not on the Big Board"]];
const GRADE_FILTER = [["", "Any grade"], ["A", "A ceiling"], ["B", "B ceiling"], ["C", "C ceiling"], ["D", "D ceiling"]];
const gradeMatch = (g, want) => !want || gradeTone(g) === `g-${want.toLowerCase()}`;

// One row on the live board (or, without a position, in the tray below it).
// Being on the Big Board is what makes a college player a priority: those rows carry a BB tag (and the Short
// Board star); everyone else gets "+ BB", which adds them at the role their college scouting suggests.
function ncaaRow(p, pos, i, d) {
  const x = d.info[p.id];
  const sub = [classShort(x?.class_now), x?.school || x?.team || p.club].filter(Boolean).join(" · ") || p.position || "";
  const onBB = p.roles.length > 0;
  const role = pos && onBB ? starRole(p, pos) : null;
  const on = role ? isTopTarget(p, role) : false;
  const star = role ? `<span class="star ${on ? "on" : ""}" data-star="${role}" role="button" tabindex="0" aria-pressed="${on}"
    title="${on ? `Top target at ${esc(roleShort(role))}; click to take off the Short Board` : `Add to the Short Board as a top target at ${esc(roleShort(role))}`}">${on ? "★" : "☆"}</span>` : "";
  const suggest = d.bb_role?.[p.id];
  const bb = onBB ? `<span class="bbtag" title="On the Big Board: ${esc(p.roles.map((r) => `${roleLabel(r.role)} (rank ${r.rank + 1})`).join(", "))}">BB</span>` : "";
  // Last in the row's tags: it's hidden until hover, and shouldn't leave a gap before the others.
  const addBB = !onBB && suggest ? `<span class="addbb" data-add-bb="${suggest}" role="button" tabindex="0" title="Add to the Big Board at ${esc(roleLabel(suggest))}">+ BB</span>` : "";
  return `<a class="pcard nrow ${p.is_signed ? "is-signed" : ""} ${onBB ? "is-bb" : ""} ${p.decision ? "v-" + p.decision : ""}" href="#/player/${p.id}" draggable="true" data-pid="${p.id}" ${pos ? `data-pos="${pos}"` : ""}
      data-q="${esc([p.name, sub, p.club].join(" "))}" data-grade="${esc(x?.grade || "")}" data-rep="${esc(d.agents[p.id]?.representation || "unknown")}" data-bb="${onBB ? "on" : "off"}">
    <span class="nrank ${i != null && i < 3 ? "lead" : ""}">${i != null ? i + 1 : ""}</span>
    <span class="nmain">${nameWithMark(p, "nname")}
      <span class="nsubrow"><span class="nsub">${esc(sub)}</span><span class="ntags">${tagRow([bb, l2Badge(p.l2), rosterBadge(p), repChip(d.agents[p.id])])}${addBB}</span></span></span>
    ${star}${gradeBadge(x?.grade)}</a>`;
}

// One row on an earlier year's board: a prospect, who may or may not be in PINE.
function pastRow(x, i) {
  const p = x.player_id && S.byId.get(x.player_id);
  const sub = [classShort(x.class_then), x.school || x.team].filter(Boolean).join(" · ");
  return `<a class="nrow past ${p?.is_signed ? "is-signed" : ""} ${p?.decision ? "v-" + p.decision : ""}" ${p ? `href="#/player/${p.id}"` : `href="#" data-prospect="${esc(x.key)}"`}
      data-q="${esc([x.name, sub, x.status].join(" "))}" data-grade="${esc(x.grade || "")}" title="${p ? "Open the PINE profile" : "Read the reports"}">
    <span class="nrank ${i < 3 ? "lead" : ""}">${i + 1}</span>
    <span class="nmain">${p ? nameWithMark({ ...p, name: x.name }, "nname") : `<span class="nname">${esc(x.name)}</span>`}
      <span class="nsubrow"><span class="nsub">${esc(sub)}</span><span class="ntags">${l2Badge(x.l2)}${x.status ? `<span class="nnow" title="Where now">${esc(x.status)}</span>` : ""}</span></span></span>
    ${gradeBadge(x.grade)}</a>`;
}

function ncaaPitch(rowsFor, live) {
  return `<div class="pitch-wrap"><div class="pitch npitch">${S.config.positions.map((pos) => {
    const rows = rowsFor(pos.code);
    if (!live && !rows.length) return "";
    const line = POS_LINE[pos.code] || "def";
    return `<section class="ncol" style="grid-area:${pos.area};--pc:var(--pc-${line});--pc-ink:var(--pc-${line}-ink)">
      <header class="ncol-h"><span class="pos-code">${pos.code}</span><span class="pos-label">${esc(pos.label)}</span><span class="pos-n">${rows.length}</span></header>
      <div class="ncol-body" ${live ? `data-ncaa-pos="${pos.code}"` : ""}>${rows.join("") || `<div class="lane-empty">${live ? "Drop players here" : "Nobody ranked"}</div>`}</div>
    </section>`;
  }).join("")}</div></div>`;
}

async function renderNcaa(main, arg) {
  const view = arg === "database" ? "database" : "board";
  const year = /^\d{4}$/.test(arg || "") ? Number(arg) : null;
  if (!$(".ncaa-page", main)) main.innerHTML = `<div class="page"><div class="loading">Loading…</div></div>`;
  let d;
  try { d = await api("GET", `/api/ncaa${year ? `?year=${year}` : ""}`); } catch (e) {
    main.innerHTML = `<div class="page"><div class="empty-state">${esc(e.message)}. <a href="#/ncaa">Back to the NCAA board</a></div></div>`;
    return;
  }
  if (route().view !== "ncaa" || (route().arg || "") !== (arg || "")) return;
  const live = view === "board" && !d.past;
  const shownYear = live ? d.live_year : year;
  const f = S.ncaa;
  const onLive = live ? Object.values(d.board).flat().length : 0;
  const stats = view === "database"
    ? `<span><b>${d.prospects}</b> prospects</span><span><b>${d.reports}</b> reports</span>`
    : live ? `<span><b>${onLive}</b> on the ${shownYear ?? ""} board</span><span><b>${Object.values(d.board).flat().filter((id) => S.byId.get(id)?.roles.length).length}</b> on the Big Board</span><span><b>${d.prospects}</b> prospects</span><span><b>${d.reports}</b> reports</span>`
    : `<span><b>${Object.values(d.past).flat().length}</b> on the ${year} board</span><span><b>${Object.values(d.past).flat().filter((x) => x.player_id).length}</b> in PINE</span>`;
  const years = view === "database" ? [["", "All years"], ...d.years.map((y) => [String(y), String(y)])] : d.years.map((y) => [String(y), String(y)]);
  const yearOn = (y) => (view === "database" ? f.dbYear === y : String(shownYear) === y);
  const note = view === "database" ? "Every prospect in the college scouting database. Click a row for the reports."
    : live ? "Live board: drag to re-rank or move between positions; drag to the tray to take a player off. BB marks players on the Big Board (☆ adds them to the Short Board); hover anyone else for + BB."
    : `The ${year} board as the college scouting database ranked it. Read-only; open a player for their reports.`;
  main.innerHTML = `<div class="page ncaa-page">
    <header class="nhero">
      <div class="nhero-t"><span class="nhero-mark">NCAA</span><h1>College ${view === "database" ? "Database" : "Board"}</h1>
        <div class="nhero-stats">${stats}${d.imported_at ? `<span title="${esc(fmtDateTime(d.imported_at))}">Imported ${esc(relTime(d.imported_at))}</span>` : ""}</div></div>
      <div class="nviews" role="tablist">${[["board", "Board"], ["database", "College database"]].map(([k, l]) =>
        `<button type="button" role="tab" data-view="${k}" class="${view === k ? "on" : ""}" aria-selected="${view === k}">${l}</button>`).join("")}</div>
    </header>
    <div class="nbar">
      <div class="nyears" role="tablist" aria-label="Year">${years.map(([y, l]) =>
        `<button type="button" data-year="${y}" class="${yearOn(y) ? "on" : ""}">${l}${view === "board" && Number(y) === d.live_year ? `<span class="nlive">Live</span>` : ""}</button>`).join("")}</div>
      <div class="spacer"></div>
      <div class="filters">
        <input id="nf-q" type="search" placeholder="Search players, schools…" value="${esc(f.q)}" aria-label="Search">
        <select id="nf-grade" aria-label="Grade">${GRADE_FILTER.map(([k, l]) => `<option value="${k}" ${f.grade === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${live ? `<select id="nf-bb" aria-label="Big Board">${BB_FILTER.map(([k, l]) => `<option value="${k}" ${f.bb === k ? "selected" : ""}>${l}</option>`).join("")}</select>` : ""}
        ${live ? `<select id="nf-rep" aria-label="Representation">${[["", "Any representation"], ...REPRESENTATION].map(([k, l]) => `<option value="${k}" ${f.rep === k ? "selected" : ""}>${l}</option>`).join("")}</select>` : ""}
        ${view === "board" ? legendHTML(true) : ""}
        <button type="button" class="btn primary" id="ncaa-add" title="Add a college player from a Transfermarkt link or by hand, with a grade and report">+ Add college player</button>
        ${S.me.is_admin ? `<button type="button" class="btn" id="ncaa-import" title="Pull the latest grades, reports and boards from the college scouting repository">Re-import</button>` : ""}
      </div>
    </div>
    <p class="nnote">${note}</p>
    <div id="ncaa-body"></div>
  </div>`;
  const root = main.firstElementChild;
  $(".nviews", root).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) location.hash = b.dataset.view === "database" ? "#/ncaa/database" : "#/ncaa";
  });
  $(".nyears", root).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-year]");
    if (!b) return;
    if (view === "database") { f.dbYear = b.dataset.year; $$(".nyears button", root).forEach((x) => x.classList.toggle("on", x === b)); root.dispatchEvent(new Event("ncaa-filter")); return; }
    location.hash = Number(b.dataset.year) === d.live_year ? "#/ncaa" : `#/ncaa/${b.dataset.year}`;
  });
  const changed = () => root.dispatchEvent(new Event("ncaa-filter"));
  $("#nf-q", root).addEventListener("input", (e) => { f.q = e.target.value; changed(); });
  $("#nf-grade", root).addEventListener("change", (e) => { f.grade = e.target.value; changed(); });
  $("#nf-rep", root)?.addEventListener("change", (e) => { f.rep = e.target.value; changed(); });
  $("#nf-bb", root)?.addEventListener("change", (e) => { f.bb = e.target.value; changed(); });
  $("#ncaa-add", root).addEventListener("click", () => openAddPlayer({ college: true }));
  $("#ncaa-import", root)?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Importing…";
    try {
      const st = await api("POST", "/api/ncaa/import", {});
      toast(`Imported ${st.prospects} prospects and ${st.reports} reports${st.created ? `; ${st.created} new player${st.created === 1 ? "" : "s"}` : ""}`);
      await afterMutation();
    } catch (err) { oops(err); e.target.disabled = false; e.target.textContent = "Re-import"; }
  });
  if (view === "database") return ncaaDatabase(root, d);
  const body = $("#ncaa-body", root);
  if (live) {
    const onBoard = new Set(Object.values(d.board).flat());
    const off = S.players.filter((p) => isNcaa(p) && !onBoard.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
    body.innerHTML = `${ncaaPitch((code) => (d.board[code] || []).filter((id) => S.byId.has(id)).map((id, i) => ncaaRow(S.byId.get(id), code, i, d)), true)}
      <section class="ntray"><header class="ntray-h"><h3>College players not on the ${d.live_year ?? ""} board</h3><span>${off.length} · drag onto a position, or drag a row here to take it off</span></header>
        <div class="ntray-body" data-tray="1">${off.map((p) => ncaaRow(p, null, null, d)).join("") || `<p class="empty">Every NCAA player in PINE is on the board.</p>`}</div></section>`;
    wireStars(body);
    const addBB = async (el) => {
      const p = S.byId.get(Number(el.closest(".nrow").dataset.pid)), role = el.dataset.addBb;
      el.classList.add("busy");
      try {
        const reason = await askBoardReason('add', p.name, [role]);
        if (!reason) return;
        await api("POST", `/api/players/${p.id}/roles`, { role, reason });
        toast(`${p.name} is on the Big Board at ${roleLabel(role)}`);
        await afterMutation();
      } catch (err) { oops(err); } finally { el.classList.remove("busy"); }
    };
    body.addEventListener("click", (e) => { const el = e.target.closest("[data-add-bb]"); if (el) { e.preventDefault(); addBB(el); } });
    body.addEventListener("keydown", (e) => {
      const el = e.target.closest?.("[data-add-bb]");
      if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); addBB(el); }
    });
    wireCardDrag(body, ".ncol-body[data-ncaa-pos], [data-tray]", (zone, card, before) => {
      const pid = Number(card.dataset.pid);
      if (zone.dataset.ncaaPos) {
        const others = (d.board[zone.dataset.ncaaPos] || []).filter((id) => id !== pid);
        const at = before ? others.indexOf(Number(before.dataset.pid)) : -1;
        return api("POST", "/api/ncaa/move", { player_id: pid, position: zone.dataset.ncaaPos, index: at >= 0 ? at : others.length });
      }
      return card.dataset.pos ? api("DELETE", `/api/ncaa/board/${pid}`) : null;
    });
  } else {
    body.innerHTML = ncaaPitch((code) => (d.past[code] || []).map(pastRow), false);
    body.addEventListener("click", (e) => {
      const a = e.target.closest("[data-prospect]");
      if (a) { e.preventDefault(); openProspect(a.dataset.prospect); }
    });
  }
  // Filtering hides rows but keeps their rank, as on the Big Board.
  const filter = () => $$(".nrow", body).forEach((r) => {
    r.hidden = !(textMatch(f.q, r.dataset.q) && gradeMatch(r.dataset.grade, f.grade)
      && (!live || ((!f.rep || r.dataset.rep === f.rep) && (!f.bb || r.dataset.bb === f.bb))));
  });
  root.addEventListener("ncaa-filter", filter);
  filter();
}

const PROSPECT_COLS = [
  { k: "name", l: "Player" }, { k: "position", l: "Pos" }, { k: "class", l: "Class" }, { k: "school", l: "School" },
  { k: "grade", l: "Grade" }, { k: "years", l: "Scouted" }, { k: "status", l: "Where now" }, { k: "reports", l: "Reports" }, { k: "board", l: "Board" },
];
async function ncaaDatabase(root, d) {
  const f = S.ncaa, body = $("#ncaa-body", root);
  body.innerHTML = `<div class="loading">Loading the college database…</div>`;
  let prospects;
  try { ({ prospects } = await api("GET", "/api/ncaa/prospects")); } catch (e) { body.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  // The live board's order is PINE's (players dragged since the import); earlier years are as imported.
  const live = {};
  for (const [pos, ids] of Object.entries(d.board || {})) ids.forEach((id, i) => (live[id] = { position: pos, rank: i }));
  // The class in the season being looked at: the chosen year, or this season for all years.
  const classIn = (x) => x.classes?.[f.dbYear || d.live_year] ?? x.class;
  const boardOf = (x) => {
    const y = f.dbYear ? Number(f.dbYear) : Math.max(...Object.keys(x.boards).map(Number), 0) || null;
    if (!y) return null;
    const spot = y === d.live_year ? live[x.player_id] || x.boards[y] : x.boards[y];
    return spot ? { year: y, ...spot } : null;
  };
  const key = {
    name: (x) => x.name.toLowerCase(), position: (x) => x.position || "", class: (x) => CLASS_ORDER.indexOf(classIn(x)), school: (x) => (x.school || x.team || "").toLowerCase(),
    grade: (x) => x.grade_val ?? -1, years: (x) => Math.max(0, ...x.years), status: (x) => (x.status || "").toLowerCase(), reports: (x) => x.reports,
    board: (x) => { const b = boardOf(x); return b ? b.year * -1000 + b.rank : 1e9; },
  };
  body.innerHTML = `<div class="ntable-wrap"><table class="ntable">
      <thead><tr>${PROSPECT_COLS.map((c) => `<th data-sort="${c.k}">${c.l}</th>`).join("")}</tr></thead><tbody id="pt-body"></tbody>
    </table></div><p class="nnote" id="pt-count" style="margin-top:10px"></p>`;
  const draw = () => {
    const list = prospects.filter((x) => gradeMatch(x.grade, f.grade) && (!f.dbYear || x.boards[f.dbYear] || (Number(f.dbYear) === d.live_year && live[x.player_id]))
      && textMatch(f.q, x.name, x.school, x.team, x.status, x.country));
    const k = key[f.sort] || key.grade;
    list.sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0) * f.dir || a.name.localeCompare(b.name));
    $$("th[data-sort]", body).forEach((th) => { th.className = th.dataset.sort === f.sort ? "sorted" + (f.dir > 0 ? " asc" : "") : ""; });
    $("#pt-count", body).textContent = `${list.length} of ${prospects.length} prospects${f.dbYear ? ` on the ${f.dbYear} board` : ""}`;
    $("#pt-body", body).innerHTML = list.map((x) => {
      const p = x.player_id && S.byId.get(x.player_id), b = boardOf(x);
      return `<tr data-key="${esc(x.key)}">
        <td><div class="name-line">${p ? nameWithMark({ ...p, name: x.name }, "nname") : `<span class="nname">${esc(x.name)}</span>`} ${l2Badge(x.l2)}</div><div class="nsub">${p ? `<a href="#/player/${p.id}">In PINE</a>` : esc(x.country || "")}</div></td>
        <td>${esc(x.position || "")}</td><td>${esc(classShort(classIn(x)))}</td><td>${esc(x.school || x.team || "")}</td>
        <td>${gradeBadge(x.grade)}</td><td>${esc(x.years.join(", "))}</td><td>${x.status ? `<span class="nnow">${esc(x.status)}</span>` : ""}</td><td>${x.reports || ""}</td>
        <td>${b ? `<span class="nspot">${f.dbYear ? "" : `<i>${b.year}</i>`}${esc(b.position)} <b>${b.rank + 1}</b></span>` : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="${PROSPECT_COLS.length}" class="empty-state">No prospects match these filters.</td></tr>`;
  };
  draw();
  root.addEventListener("ncaa-filter", draw);
  $("thead", body).addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    if (f.sort === th.dataset.sort) f.dir *= -1; else { f.sort = th.dataset.sort; f.dir = ["grade", "years", "reports", "board"].includes(f.sort) ? -1 : 1; }
    draw();
  });
  $("#pt-body", body).addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-key]");
    if (tr) openProspect(tr.dataset.key);
  });
}

// Grades, facts and every report for one prospect: the college panel on a profile, and the database's pop-up.
function collegeFacts(x) {
  const pos = [...new Set([x.position, ...(x.positions || [])].filter(Boolean))].join(", ");
  return `<dl class="facts">
    ${fact("Current / future", x.grade_present || x.grade_future ? `${gradeBadge(x.grade_present)} / ${gradeBadge(x.grade_future)}` : null, true)}
    ${fact("School", x.school || x.team)}
    ${fact("Class", x.class_now ? `${esc(x.class_now)}${x.class_year ? ` (${x.class_year})` : ""}${x.class && x.class !== x.class_now && x.year
      ? ` <span class="muted">· ${esc(x.class)} when last scouted, ${x.year}</span>` : ""}` : null, true)}
    ${fact("Position", pos)}
    ${fact("Foot", x.foot)}
    ${fact("Country", x.country)}
    ${fact("Scouted", (x.years || []).join(", "))}
    ${fact("Boards", Object.entries(x.boards || {}).sort(([a], [b]) => b - a).map(([y, b]) => `${y} ${b.position} #${b.rank + 1}`).join(" · "))}
    ${fact("Where now", x.status)}
  </dl>`;
}
// Reports written in PINE (origin "pine") can be changed by their author or an admin; imported ones can't.
const canEditReport = (r) => r.origin === "pine" && (r.created_by === S.me.id || S.me.is_admin);
function reportHTML(r) {
  const when = r.dates?.length ? r.dates.join(", ") : r.year;
  const head = [when, r.match, r.source].filter((v) => v != null && v !== "").map((v) => esc(String(v))).join(" · ");
  const edit = canEditReport(r) ? `<button type="button" class="btn link sm" data-report-edit="${r.id}">Edit</button><button type="button" class="btn link sm danger" data-report-del="${r.id}">Delete</button>` : "";
  return `<article class="report" data-report="${r.id}">
    <header class="report-h">${gradeBadge(r.grade)}<span class="report-t">${head || "Report"}</span>${r.class ? `<span class="chip">${esc(r.class)}</span>` : ""}${r.role_name ? `<span class="chip">${esc(r.role_name)}</span>` : ""}${r.author ? `<span class="muted sm">${esc(r.author)}${r.origin === "pine" ? " · PINE" : ""}</span>` : ""}${edit}</header>
    ${r.body ? `<div class="report-body">${esc(r.body)}</div>` : ""}
  </article>`;
}
function reportsHTML(reports, shown = 3) {
  if (!reports.length) return `<p class="empty">No written reports.</p>`;
  const rest = reports.slice(shown);
  return `<div class="reports">${reports.slice(0, shown).map(reportHTML).join("")}</div>${rest.length
    ? `<details class="more-reports"><summary>${rest.length} more report${rest.length === 1 ? "" : "s"}</summary><div class="reports">${rest.map(reportHTML).join("")}</div></details>` : ""}`;
}

// The college report form: on the player page (add / edit) and in Add player for college players. Grades are the
// college database's scale, current then future ("C" now, "B" ceiling); the profile's grade is its best report's.
function collegeFormHTML(v = {}, { school = null, board = null } = {}) {
  const C = S.config.college;
  const opt = (list, cur, blank) => `<option value="">${blank}</option>${list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("")}`;
  const now = new Date(); // local date: in the evening UTC is already tomorrow
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const [mm, dd, yy] = (v.dates?.[0] || "").split("/");
  return `<div class="college-form">
    ${board != null ? `<label>NCAA board<select name="ncaa_position"><option value="">Not on the NCAA board</option>${S.config.positions.map((pos) =>
      `<option value="${pos.code}" ${pos.code === board ? "selected" : ""}>${pos.code} · ${esc(pos.label)}</option>`).join("")}</select></label>` : ""}
    <label>Grade now<select name="grade_present">${opt(C.grades.slice().reverse(), v.grade_present, "—")}</select></label>
    <label>Ceiling<select name="grade_future">${opt(C.grades.slice().reverse(), v.grade_future, "Same as now")}</select></label>
    <label>Class<select name="class">${opt(C.classes, v.class, "—")}</select></label>
    ${school != null ? `<label>School<input name="school" value="${esc(school)}" placeholder="Their club if left blank"></label>` : ""}
    <label>Date<input name="date" type="date" value="${yy ? `${yy}-${mm}-${dd}` : today}"></label>
    <label>Seen<select name="source">${opt(C.sources, v.source, "—")}</select></label>
    <label class="wide">Match<input name="match" value="${esc(v.match || "")}" placeholder="e.g. Duke vs UNC"></label>
    <label class="wide">Report<textarea name="body" rows="4" data-draft data-orig="${esc(v.body || "")}" placeholder="What you saw: strengths, weaknesses, projection…">${esc(v.body || "")}</textarea></label>
  </div>`;
}
const collegeFormData = (form) => Object.fromEntries([...new FormData(form)].filter(([k]) => k !== "ncaa_position"));
const collegeFormFilled = (form) => Boolean(form.querySelector("[name=grade_present]")?.value || form.querySelector("[name=body]")?.value.trim());
async function openProspect(key) {
  const m = modal(`<div class="loading">Loading…</div>`, { wide: true });
  try {
    const { prospect: x } = await api("GET", `/api/ncaa/prospects/${encodeURIComponent(key)}`);
    m.innerHTML = `<header class="m-h"><h2>${esc(x.name)}</h2>${gradeBadge(x.grade, "lg")}<button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
      ${collegeFacts(x)}
      <div class="row" style="margin:12px 0">${x.player_id ? `<a class="btn sm" href="#/player/${x.player_id}" data-close>Open PINE profile</a>` : `<span class="muted sm">Not in PINE: only players on the current college board are added.</span>`}</div>
      ${reportsHTML(x.reports, 99)}`;
  } catch (e) { m.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

// On a profile: the college database's grades and reports (when the player is in it) ...
function collegePanel(d) {
  const x = d.college, p = d.player;
  if (!x && !isNcaa(p)) return "";
  // A pro on the Short Board is judged as a pro: reports from his college days aren't shown (they stay on the NCAA side).
  if (!isNcaa(p) && (p.roles || []).some((r) => r.shortlist)) return "";
  const school = x ? (x.origin === "pine" ? x.school || "" : null) : (p.club || "").replace(/\s*\([^)]*\)\s*$/, "");
  return `<section class="panel college" id="college-panel">
    <header class="panel-h"><h2>College scouting</h2>${x ? `${gradeBadge(x.grade, "lg")}<span class="muted sm">${x.reports.length} report${x.reports.length === 1 ? "" : "s"}</span>` : ""}
      <button type="button" class="btn sm" id="college-add">+ Add report</button>
      ${x && x.origin !== "pine" ? `<button type="button" class="btn link sm" id="college-unlink" title="The college profile was matched by name. Unlink it if it's a different player.">Not this player?</button>` : ""}</header>
    <form id="college-form" class="college-new" hidden data-school="${esc(school ?? "")}">${collegeFormHTML({ class: x?.class_now }, { school })}
      <div class="row end"><button type="button" class="btn sm ghost" id="college-cancel">Cancel</button><button type="submit" class="btn sm primary">Save report</button></div></form>
    ${x ? `${collegeFacts(x)}${reportsHTML(x.reports)}` : `<p class="empty">No college scouting yet. Add a report with a grade and it shows on the NCAA board like the imported players.</p>`}
  </section>`;
}
// ... their spot on the NCAA board ...
function ncaaBoardPanel(p, d) {
  const s = d.ncaa;
  if (!s?.position && !isNcaa(p)) return ""; // a pro with college reports from an old class isn't offered the board
  const at = s?.position || s?.suggest || "";
  return `<section class="panel"><header class="panel-h"><h2>NCAA board</h2><a class="btn sm ghost" href="#/ncaa">Open board</a></header>
    ${s?.position ? `<div class="role-row"><span class="chip">${esc(s.position)}</span><span class="muted sm">Rank <b>${s.spot + 1}</b> of ${s.of}</span><span class="spacer"></span>
      <button type="button" class="icon-btn" data-ncaa-move="-1" title="Move up" aria-label="Move up" ${s.spot === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="icon-btn" data-ncaa-move="1" title="Move down" aria-label="Move down" ${s.spot >= s.of - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="icon-btn" id="ncaa-rm" title="Take off the NCAA board" aria-label="Take off the NCAA board">×</button></div>`
      : `<p class="empty">Not on the NCAA board.</p>`}
    <div class="add-role"><select id="ncaa-pos-sel" aria-label="NCAA board position">${S.config.positions.map((pos) =>
      `<option value="${pos.code}" ${pos.code === at ? "selected" : ""}>${pos.code} · ${esc(pos.label)}</option>`).join("")}</select>
      <button type="button" class="btn sm" id="ncaa-add-btn">${s?.position ? "Move to position" : "Add to NCAA board"}</button></div>
  </section>`;
}

/* ---------- activity + staff ---------- */
// Who did it. The backup script downloads with its own key, not as a staff member.
const actor = (a) => a.user || (a.action === "downloaded_backup" && /backup script/.test(a.detail || "") ? "Backup script"
  : ["imported_college", "linked_big_board", "unlinked_big_board", "merged_player", "linked_tm", "synced_long_throws"].includes(a.action) ? "PINE" : "Someone");

function describe(a, onPlayerPage = false) {
  const move = describeMove(a, onPlayerPage);
  let reason;
  try { reason = JSON.parse(a.detail || '{}').reason; } catch {}
  return move + (reason ? `<span class="board-reason-detail">${boardReasonDetails(reason).map(esc).join(' · ')}</span>` : '');
}
function describeMove(a, onPlayerPage = false) {
  let d = {};
  try { d = a.detail ? JSON.parse(a.detail) : {}; } catch {}
  const who = onPlayerPage ? "this player" : a.player_id ? `<a href="#/player/${a.player_id}">${esc(a.player || "a player")}</a>` : esc(d.name || "a player");
  const chip = (v) => `<span class="dchip v-${esc(v)}">${esc(cap(v))}</span>`;
  switch (a.action) {
    case "added_player": return `added ${who}${d.list ? ` from the Impect list “${esc(d.list)}”` : d.source === "transfermarkt" ? " from Transfermarkt" : d.source === "impect" ? " from Impect" : ""}`;
    case "synced_long_throws": return `updated long-throw flags`;
    case "imported_college": return `imported the college scouting database: ${d.prospects ?? 0} prospects, ${d.reports ?? 0} reports${d.created ? `, ${d.created} new player${d.created === 1 ? "" : "s"}` : ""}${d.boarded ? `, ${d.boarded} added to the NCAA board` : ""}${d.big_board ? `, ${d.big_board} added to the Big Board` : ""}`;
    case "merged_player": return `merged the college import “${esc(d.name)}” into ${who}, the same player already in PINE`;
    case "combined_profiles": return `combined a duplicate Transfermarkt profile into ${who}, keeping the connected data and board position`;
    case "unlinked_big_board": return `took ${d.count} college player${d.count === 1 ? "" : "s"} it had added back off the Big Board (the NCAA board marks who is on it)`;
    case "linked_big_board": return `put ${d.count} NCAA board player${d.count === 1 ? "" : "s"} on the Big Board at their position`;
    case "moved_on_ncaa_board": return d.from && d.from !== d.to
      ? `moved ${who} from ${esc(d.from)} to spot ${d.spot + 1} at ${esc(d.to)} on the NCAA board`
      : `${d.from ? "moved" : "put"} ${who} ${d.from ? "to" : "at"} spot ${d.spot + 1} at ${esc(d.to)} on the NCAA board`;
    case "removed_from_ncaa_board": return `took ${who} off the NCAA board${d.position ? ` (${esc(d.position)})` : ""}`;
    case "unlinked_college": return `unlinked the college profile “${esc(d.name)}” from ${who}`;
    case "added_college_report": return `added a college report on ${who}`;
    case "edited_college_report": return `edited a college report on ${who}`;
    case "deleted_college_report": return `deleted a college report on ${who}`;
    case "updated_agent": return `updated agent details for ${who}${d.representation && d.representation !== "unknown" ? ` (${esc(repLabel(d.representation).toLowerCase())})` : ""}`;
    case "set_decision": return d.decision ? `set the club decision on ${who} to ${chip(d.decision)}` : `cleared the club decision on ${who}`;
    case "set_signed": return d.signed ? `marked ${who} as signed to Hearts of Pine` : `removed the signed status from ${who}`;
    case "set_verdict": return d.verdict ? `marked ${who} ${chip(d.verdict)}` : `cleared their verdict on ${who}`;
    case "added_note": return `added a note on ${who}`;
    case "edited_note": return `edited a note on ${who}`;
    case "marked_reviewed": return `marked ${who} reviewed`;
    case "review_watch": return `added ${who} to their watch list`;
    case "review_sb_review": return `sent ${who} to ${esc(d.to || "the lead")} for a Short Board decision`;
    case "review_assignment": return `asked ${esc(d.to || "a scout")} to review ${who}`;
    case "review_resolved": return {
      added_sb: `put ${who} on the Short Board from review${d.role ? ` (${esc(roleLabel(d.role))})` : ""}`,
      added_bb: `added ${who} to the Big Board from review${d.role ? ` (${esc(roleLabel(d.role))}${d.spot != null ? `, #${d.spot + 1}` : ""})` : ""}`,
      moved_bb: `moved ${who} on the Big Board from review${d.role ? ` (${esc(roleLabel(d.role))}${d.spot != null ? `, to #${d.spot + 1}` : ""})` : ""}`,
      not_sb: `decided ${who} isn't for the Short Board for now`,
      reviewed: `reviewed ${who}${d.verdict ? ` ${chip(d.verdict)}` : ""}`,
      declined: `declined to review ${who}`,
      removed: d.kind === "watch" ? `took ${who} off their watch list` : `withdrew the review of ${who}`,
    }[d.outcome] || `updated the review of ${who}`;
    case "deleted_note": return `deleted a note on ${who}`;
    case "moved_on_board": {
      // Older entries only have the requested index; newer ones record the spot before and after (0-based).
      const spot = d.spot ?? d.index;
      const role = esc(roleLabel(d.to));
      if (d.from === d.to && d.from_spot != null && spot != null) {
        return `moved ${who} ${spot < d.from_spot ? "up" : "down"} from spot ${d.from_spot + 1} to spot ${spot + 1} in ${role}`;
      }
      return `moved ${who} to ${spot != null ? `spot ${spot + 1} in ` : ""}${role}${d.from && d.from !== d.to ? ` from ${esc(roleShort(d.from))}` : ""}`;
    }
    case "added_role": return `added ${who} to ${esc(roleLabel(d.role))}${d.via === "ncaa" ? " (from the NCAA board)" : ""}`;
    case "shortlisted": return `made ${who} a top target at ${esc(roleLabel(d.role))}`;
    case "copied_on_board": return `made ${who} a top target at ${esc(roleLabel(d.to))} too${d.spot != null ? ` (spot ${d.spot + 1})` : ""}, keeping them at ${esc(roleShort(d.from))}`;
    case "unshortlisted": return `took ${who} off the Short Board at ${esc(roleLabel(d.role))}`;
    case "removed_role": return `removed ${who} from ${esc(roleLabel(d.role))}`;
    case "synced_tm": return `synced ${who} from Transfermarkt`;
    case "linked_tm": return `linked ${who} to Transfermarkt${d.via === "college match" ? " (matched by name and school, for their DOM / INTL)" : ""}`;
    case "linked_physical": return `updated physical data links for ${who}`;
    case "linked_impect": return d.impect_id ? `linked ${who} to Impect` : `unlinked ${who} from Impect`;
    case "requested_card": return `requested a player card for ${who} (${esc(d.position)}, ${esc(d.season)} ${esc(d.competition)})`;
    case "edited_player": return `edited details for ${who}${d.long_throw && d.long_throw.previous !== d.long_throw.value
      ? ` · long throw: ${d.long_throw.value == null ? "Auto" : d.long_throw.value ? "Yes" : "No"}` : ""}`;
    case "deleted_player": return `deleted ${esc(d.name || "a player")}`;
    case "bulk_deleted_players": return `deleted ${d.count} players nobody had placed on the Big Board or NCAA board`;
    case "imported_list": return `imported the Impect list “${esc(d.name)}” (${d.created ?? 0} new)`;
    case "refreshed_impect": return "refreshed all the Impect data";
    case "downloaded_backup": return d.via ? "saved its daily copy of the database" : "downloaded a copy of the database";
    case "edited_staff": return `updated staff member ${esc(d.name)}`;
    case "added_staff": return `added staff member ${esc(d.name)}`;
    case "created_signin_link": return `created a sign-in link for ${esc(d.name)}`;
    case "set_password": return "set their PINE password";
    default: return esc(String(a.action).replace(/_/g, " "));
  }
}

/* ---------- Activity: grouped by player ---------- */
// Notes and college reports are reports: marked "Your report" when you wrote them, "<Name>'s report" otherwise.
const REPORT_ACTIONS = new Set(["added_note", "edited_note", "added_college_report", "edited_college_report"]);
const isReport = (a) => REPORT_ACTIONS.has(a.action);
S.activity = { q: "", reports: false, who: "", backups: false, open: new Set() };

function dayLabel(s) {
  const d = toDate(s), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
const isNewReport = (a) => a.action === "added_note" || a.action === "added_college_report";
const reportTag = (a) => (!isNewReport(a) ? `<span class="rtag edit">Report edited</span>`
  : a.user_id === S.me.id ? `<span class="rtag new mine">✎ Your new report</span>` : `<span class="rtag new">✎ New report · ${esc(actor(a))}</span>`);

function activityEntry(a, inGroup) {
  const snip = a.snippet ? `<div class="act-snip">${a.snippet_context ? `<b>${esc(a.snippet_context)}</b> · ` : ""}${esc(a.snippet)}${a.snippet.length >= 200 ? "…" : ""}</div>` : "";
  return `<li class="${isReport(a) ? "is-report" : ""} ${isNewReport(a) ? `is-new-report ${a.user_id === S.me.id ? "mine" : ""}` : ""}"><span class="avatar">${esc(actor(a)[0])}</span>
    <span class="act-main"><span><b>${esc(actor(a))}</b> ${isReport(a) ? reportTag(a) : ""}${inGroup ? describe(a, true) : describe(a)}</span>${snip}</span>
    <span class="when" title="${esc(fmtDateTime(a.created_at))}">${esc(relTime(a.created_at))}</span></li>`;
}

function activityGroup(g) {
  const p = g.player_id && S.byId.get(g.player_id);
  const latest = g.items[0];
  const reports = g.items.filter(isNewReport); // the header marks new reports; edits show inside
  // One marker per report author, yours first.
  const authors = [...new Map(reports.map((a) => [a.user_id, a])).values()].sort((a, b) => (b.user_id === S.me.id) - (a.user_id === S.me.id));
  const people = [...new Set(g.items.map(actor))];
  // Verdicts lead the header: each person's latest pass / hold / fail on the player, then whatever happened last.
  const verdictOf = (a) => { try { return JSON.parse(a.detail || "{}").verdict || null; } catch { return null; } };
  const byPerson = new Map();
  if (g.player_id) for (const a of g.items) if (a.action === "set_verdict" && !byPerson.has(a.user_id)) byPerson.set(a.user_id, a);
  const verdicts = [...byPerson.values()].filter(verdictOf);
  const latestLine = `<b>${esc(actor(latest))}</b> ${g.player_id ? describe(latest, true) : describe(latest)}`;
  const headline = !verdicts.length || (verdicts.length === 1 && verdicts[0] === latest) ? latestLine
    : `<span class="act-verdicts">${verdicts.map((a) => `<span><b>${esc(actor(a))}</b> <span class="dchip v-${esc(verdictOf(a))}">${esc(cap(verdictOf(a)))}</span></span>`).join("")}</span>${
      verdicts.includes(latest) ? "" : `<span class="act-then">${latestLine}</span>`}`;
  const title = g.player_id
    ? `<a href="#/player/${g.player_id}">${esc(p?.name || g.name || "A player")}</a>${p?.club ? `<span class="muted sm">${esc(isNcaa(p) ? p.club.replace(/\s*\([^)]*\)\s*$/, "") : p.club)}</span>` : ""}`
    : `<span>General</span><span class="muted sm">imports, staff and PINE</span>`;
  return `<details class="act-group" data-key="${g.key}" ${S.activity.open.has(g.key) ? "open" : ""}>
    <summary class="act-h">
      ${p ? photo(p) : `<span class="act-ico">${g.player_id ? "?" : "P"}</span>`}
      <span class="act-title"><span class="act-name">${title}</span>
        <span class="act-latest">${headline}</span></span>
      <span class="act-badges">${authors.slice(0, 3).map(reportTag).join("")}${authors.length > 3 ? `<span class="rtag">+${authors.length - 3}</span>` : ""}</span>
      <span class="act-meta"><span><b>${g.items.length}</b> update${g.items.length === 1 ? "" : "s"}</span><span class="muted">${esc(people.slice(0, 3).join(", "))}${people.length > 3 ? ` +${people.length - 3}` : ""} · ${esc(relTime(latest.created_at))}</span></span>
    </summary>
    <ul class="feed">${g.items.map((a) => activityEntry(a, Boolean(g.player_id))).join("")}</ul>
  </details>`;
}

async function renderActivity(main) {
  const f = S.activity;
  main.innerHTML = `<div class="page" style="max-width:1000px">
    <div class="page-h"><div><h1>Activity</h1><div class="sub" id="act-count"></div></div><div class="spacer"></div>
      <div class="filters">
        <input id="af-q" type="search" placeholder="Find a player…" value="${esc(f.q)}" aria-label="Find a player">
        <div class="seg" id="af-kind"><button type="button" data-k="all" class="${f.reports ? "" : "on"}">Everything</button><button type="button" data-k="reports" class="${f.reports ? "on" : ""}">Reports only</button></div>
        <select id="af-who" aria-label="Who"><option value="">Anyone</option>${S.config.staff.map((u) => `<option value="${u.id}" ${String(u.id) === f.who ? "selected" : ""}>${esc(u.name)}</option>`).join("")}<option value="pine" ${f.who === "pine" ? "selected" : ""}>PINE (automatic)</option></select>
        <label class="act-toggle"><input type="checkbox" id="af-backups" ${f.backups ? "checked" : ""}> Backups</label>
        <button type="button" class="btn sm ghost" id="af-expand">Expand all</button>
      </div></div>
    <div id="act-body"><div class="loading">Loading…</div></div>
  </div>`;
  const root = main.firstElementChild, body = $("#act-body", root);
  let activity;
  try { ({ activity } = await api("GET", "/api/activity?limit=1000")); } catch (e) { body.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const draw = () => {
    const q = f.q.trim().toLowerCase();
    const items = activity.filter((a) => (f.backups || a.action !== "downloaded_backup") && (!f.reports || isReport(a))
      && (!f.who || (f.who === "pine" ? !a.user_id : String(a.user_id) === f.who)));
    // Player groups hold all of that player's updates and sit under the day of the latest; other updates are a
    // "General" group per day.
    const groups = new Map();
    for (const a of items) {
      const key = a.player_id ? `p${a.player_id}` : `g${toDate(a.created_at).toDateString()}`;
      if (!groups.has(key)) groups.set(key, { key, player_id: a.player_id, name: a.player, items: [] });
      groups.get(key).items.push(a);
    }
    const shown = [...groups.values()].filter((g) => !q || (g.player_id && String(S.byId.get(g.player_id)?.name || g.name || "").toLowerCase().includes(q)));
    $("#act-count", root).textContent = `${shown.length} player${shown.length === 1 ? "" : "s"} and groups · ${items.length} updates (last ${activity.length} shown)`;
    let day = null, html = "";
    for (const g of shown) {
      const d = dayLabel(g.items[0].created_at);
      if (d !== day) { html += `${day ? "</div>" : ""}<h3 class="act-day">${esc(d)}</h3><div class="act-list">`; day = d; }
      html += activityGroup(g);
    }
    body.innerHTML = html ? `${html}</div>` : `<p class="empty">${f.reports ? "No reports match." : "Nothing matches."}</p>`;
  };
  draw();
  body.addEventListener("toggle", (e) => {
    const d = e.target.closest?.(".act-group");
    if (d) { if (d.open) f.open.add(d.dataset.key); else f.open.delete(d.dataset.key); }
  }, true);
  $("#af-q", root).addEventListener("input", (e) => { f.q = e.target.value; draw(); });
  $("#af-kind", root).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b) return;
    f.reports = b.dataset.k === "reports";
    $$("#af-kind button", root).forEach((x) => x.classList.toggle("on", x === b));
    draw();
  });
  $("#af-who", root).addEventListener("change", (e) => { f.who = e.target.value; draw(); });
  $("#af-backups", root).addEventListener("change", (e) => { f.backups = e.target.checked; draw(); });
  $("#af-expand", root).addEventListener("click", (e) => {
    const all = $$(".act-group", body), open = !all.every((d) => d.open);
    all.forEach((d) => (d.open = open));
    e.target.textContent = open ? "Collapse all" : "Expand all";
  });
}

function signInStatus(u) {
  if (u.has_password) return `<span class="dchip v-pass">Password set</span>`;
  if (u.link_expires_at) return `<span class="dchip v-hold" title="Expires ${esc(fmtDate(new Date(u.link_expires_at).toISOString()))}">Link sent, not used yet</span>`;
  return `<span class="chip">Not set up</span>`;
}

function signInEmail(link, reset) {
  const first = String(link.name).split(" ")[0];
  return {
    subject: reset ? "Reset your PINE password" : "Your PINE sign-in link",
    body: [
      `Hi ${first},`,
      "",
      reset ? "Here's a link to choose a new PINE password:" : "Here's your link to set up your PINE login:",
      link.url,
      "",
      `Open it, choose a password, and you're in. After that, sign in at ${link.site} with ${link.email} and your password.`,
      "",
      "The link works once and expires in 7 days.",
      "",
      S.me.name,
    ].join("\n"),
  };
}

async function renderStaff(main) {
  if (!S.me.is_admin) { location.hash = "#/board"; return; }
  const { users } = await api("GET", "/api/users");
  main.innerHTML = `<div class="page" style="max-width:1000px">
    <div class="page-h"><div><h1>Staff</h1><div class="sub">Everyone ticked under <b>Reports</b> gets their own box in Staff reports and a verdict dot on every player (anyone unticked still shows where they've written something). To let someone sign in, or to reset a forgotten password,
      click <b>Email sign-in link</b>: a Gmail draft opens, addressed to them with their link, and you press Send. They open the link, choose a password, and from then on sign in with their email and that password.
      A link works once and expires after 7 days.</div></div></div>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Name</th><th>Sign-in email</th><th>Sign-in</th><th>Admin</th><th>Reports</th><th title="Who has the War Room: the lead decides the Short Board and assigns reviews; scouts send players up; an assigner assigns reviews too, and the lead decides on them">War Room</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr data-uid="${u.id}" data-has-password="${u.has_password ? 1 : 0}" style="cursor:default"><td><b>${esc(u.name)}</b></td>
        <td><input type="email" value="${esc(u.email || "")}" placeholder="Add an email to let ${esc(u.name)} sign in" style="width:260px" aria-label="${esc(u.name)} email"></td>
        <td>${signInStatus(u)}</td>
        <td><input type="checkbox" name="is_admin" ${u.is_admin ? "checked" : ""} ${u.id === S.me.id ? "disabled" : ""} aria-label="${esc(u.name)} is admin"></td>
        <td><input type="checkbox" name="in_evals" ${u.in_evals ? "checked" : ""} aria-label="${esc(u.name)} has a Staff reports box"></td>
        <td><select name="review_role" aria-label="${esc(u.name)} War Room role">${[["", "—"], ["lead", "Lead"], ["scout", "Scout"], ["assigner", "Assigner"]].map(([v, l]) =>
          `<option value="${v}" ${(u.review_role || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
        <td class="staff-actions"><button type="button" class="btn sm" data-save-user>Save</button>
          <button type="button" class="btn sm primary" data-link-user>${u.has_password ? "Email new link" : "Email sign-in link"}</button></td></tr>`).join("")}
    </tbody></table></div>
    <p class="hint" id="link-out" hidden></p>
    <section class="panel" style="margin-top:14px"><header class="panel-h"><h2>Add a staff member</h2></header>
      <form id="add-user" class="row"><input name="name" placeholder="Name" required aria-label="Name"><input name="email" type="email" placeholder="Email" aria-label="Email"><button class="btn primary" type="submit">Add</button></form></section>
    <section class="panel" style="margin-top:14px" id="bk-panel">
      <header class="panel-h"><h2>Database backup</h2><a class="btn sm primary" href="/api/backup" download>Download now</a></header>
      <p class="hint">A snapshot is written on the server every day and the last 14 are kept. Download one any time; it opens in any SQLite tool.</p>
      <div id="bk-list" class="loading sm">Loading…</div>
    </section>
  </div>`;
  const root = main.firstElementChild;
  loadBackups(root);
  root.addEventListener("click", async (e) => {
    const saveBtn = e.target.closest("[data-save-user]");
    const linkBtn = e.target.closest("[data-link-user]");
    if (!saveBtn && !linkBtn) return;
    const tr = e.target.closest("tr");
    try {
      if (saveBtn) {
        await api("PATCH", `/api/users/${tr.dataset.uid}`, { email: $("input[type=email]", tr).value, is_admin: $("input[name=is_admin]", tr).checked,
          in_evals: $("input[name=in_evals]", tr).checked, review_role: $("select[name=review_role]", tr).value || null });
        S.config = await api("GET", "/api/config"); // the War Room follows the team
        renderShell(); await render();
        toast("Staff member saved");
        return;
      }
      // Open the tab inside the click so it isn't treated as a popup; it's pointed at Gmail below.
      const tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
      let link;
      try {
        const emailInput = $("input[type=email]", tr);
        if (emailInput.value.trim() !== emailInput.defaultValue.trim()) {
          await api("PATCH", `/api/users/${tr.dataset.uid}`, { email: emailInput.value });
          emailInput.defaultValue = emailInput.value;
        }
        link = await api("POST", `/api/users/${tr.dataset.uid}/setup-link`);
      } catch (err) { tab?.close(); throw err; }
      const mail = signInEmail(link, tr.dataset.hasPassword === "1");
      const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(link.email)}&su=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
      const mailto = `mailto:${encodeURIComponent(link.email)}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
      if (tab) tab.location.href = gmail;
      const out = $("#link-out", root);
      out.hidden = false;
      out.innerHTML = `${tab ? "A Gmail draft to" : "Your browser blocked the Gmail tab. Email"} <b>${esc(link.name)}</b> (${esc(link.email)})${tab ? " opened in a new tab; press Send." : " with one of these:"}
        <a href="${esc(gmail)}" target="_blank" rel="noopener">Open the Gmail draft</a> ·
        <a href="${esc(mailto)}">Use my email app</a> ·
        <button type="button" class="btn link" id="copy-link">Copy the link</button>
        <input readonly value="${esc(link.url)}" style="width:100%;margin-top:4px" aria-label="Sign-in link for ${esc(link.name)}">`;
      $("#copy-link", out).addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(link.url); toast("Link copied"); } catch { $("input", out).select(); }
      });
      $("td:nth-child(3)", tr).innerHTML = signInStatus({ link_expires_at: link.expires_at });
    } catch (err) { oops(err); }
  });
  $("#add-user", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/users", Object.fromEntries(new FormData(e.target)));
      S.config = await api("GET", "/api/config");
      toast("Staff member added");
      await renderStaff(main);
    } catch (err) { oops(err); }
  });
}

/* ---------- boot ---------- */
async function boot() {
  if (welcomeToken()) return showWelcome(welcomeToken());
  try { S.me = (await api("GET", "/api/auth/me")).user; } catch { return showLogin(); }
  if (!S.me) return showLogin();
  try {
    S.config = await api("GET", "/api/config");
    await reloadPlayers();
    await syncVersion();
  } catch (e) {
    $("#app").innerHTML = `<div class="empty-state">Couldn't load PINE: ${esc(e.message)}</div>`;
    return;
  }
  renderShell();
  await render();
  clearInterval(S.pollTimer);
  S.pollTimer = setInterval(poll, 15000);
  // Checks pause while the tab is in the background; coming back checks at once, so the War Room count is current.
  if (!S.visibilityWired) { S.visibilityWired = true; document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); }); }
}

// hashchange alone isn't enough: stepping back or forward between /p/7 and a #/view changes the
// path as well as the fragment, which is a popstate, not a hashchange. replaceState fires neither,
// so canonicalising the URL in render() can't loop back in here.
const onNavigate = () => {
  if (welcomeToken()) return showWelcome(welcomeToken());
  closeNavMenus();
  closeModal();
  render().then(() => scrollTo(0, 0));
};
window.addEventListener("hashchange", onNavigate);
window.addEventListener("popstate", onNavigate);
window.addEventListener("resize", closeNavMenus);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#modal")) closeModal();
  if (e.key === "/" && S.me && !e.target.matches("input, textarea, select") && !$("#modal") && !$("#board-reason-modal")) { e.preventDefault(); $("#gs")?.focus(); }
});
// Pasting a Transfermarkt link anywhere on the page opens "Add player".
document.addEventListener("paste", (e) => {
  if (!S.me || e.target.matches?.("input, textarea") || $("#modal") || $("#board-reason-modal")) return;
  const t = (e.clipboardData?.getData("text") || "").trim();
  if (/transfermarkt\.[a-z.]+\/.+\/spieler\/\d+/i.test(t)) openAddPlayer({ url: t });
});
// Broken photo -> initials; broken club logo -> hide.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img?.tagName !== "IMG") return;
  if (img.classList.contains("club-logo")) { img.remove(); return; }
  if (img.classList.contains("ph")) {
    const s = document.createElement("span");
    s.className = `${img.className} ini`;
    s.style.cssText = img.style.cssText; // keeps its initials colour
    s.textContent = img.dataset.ini || "?";
    img.replaceWith(s);
  }
}, true);

boot();

/* ---------- Review: the lead's Short Board decisions, assignments, and watch lists ---------- */
// The review team (users.review_role, set on the Staff page): the lead decides the Short Board and assigns scouts
// players to review; scouts send players up; an assigner (Bobby) assigns players as the lead does, and the lead decides
// on them. Everyone on it keeps a private watch list. Server: review_queue.js.
const reviewRole = () => S.config.review_team?.find((u) => u.id === S.me?.id)?.role || null;
const canAssign = () => ["lead", "assigner"].includes(reviewRole());
const reviewLead = () => S.config.review_team?.find((u) => u.role === "lead") || null;
const reviewScouts = () => (S.config.review_team || []).filter((u) => u.role === "scout");
const TM_LINK = /transfermarkt\.[a-z.]+\/.+\/spieler\/\d+/i;

// The count is kept so the nav shows it however it's drawn: boot fetches it before the nav exists.
function setReviewBadge(n) {
  S.reviewOpen = n || 0;
  const b = $("#review-badge");
  if (!b) return;
  b.hidden = !n;
  b.textContent = n || "";
}

const RV_STATUS = { added_sb: ["On the Short Board", "pass"], added_bb: ["Added to the Big Board", "pass"], moved_bb: ["Moved on the Big Board", "pass"],
  not_sb: ["Not for the Short Board", "fail"], reviewed: ["Reviewed", "pass"],
  declined: ["Declined", "hold"], removed: ["Withdrawn", ""] };

function reviewPlayerHead(p) {
  const sb = p.roles.some((r) => r.shortlist);
  return `<div class="rv-player">${photo(p)}<div class="rv-who"><a href="#/player/${p.id}">${nameWithMark(p)}</a>
    <div class="csub">${esc([p.position, p.club, p.age != null ? `${p.age}` : null].filter(Boolean).join(" · "))}</div></div>
    ${sb ? `<span class="rv-tag sb" title="On the Short Board">SB</span>` : p.roles.length ? `<span class="rv-tag" title="On the Big Board">BB</span>` : ""}</div>`;
}

const rvWhen = (s) => `<span title="${esc(fmtDateTime(s))}">${esc(relTime(s))}</span>`;

// One row per item: the player, where it came from and the latest note, the actions; the note thread folds open.
function reviewCard(item, actions, always = false) {
  const p = S.byId.get(item.player_id);
  if (!p) return "";
  // An assignment both scouts answered is settled for them but still waits on the lead: it reads as open until he decides.
  const settled = item.status !== "open" && !item.awaiting_lead;
  const [label, tone] = settled ? RV_STATUS[item.status] || [item.status, ""] : [];
  const others = (item.assignees || []).filter((x) => x.user_id !== S.me.id).map((x) => x.name);
  // An assignment reads "To the scouts" for whoever sent it, "From Bobby, to the scouts" for the lead when someone else did.
  const route = item.kind === "sb_review" ? `From ${esc(item.from_name)}` : item.kind === "assignment"
    ? (canAssign() ? `${item.from_user === S.me.id ? "To" : `From ${esc(item.from_name)}, to`} ${esc(item.to_name)}`
      : `From ${esc(item.from_name)}${others.length ? `, with ${esc(others.join(" and "))}` : ""}`) : "Watching";
  // Each scout's answer on a shared assignment. A settled one is credited by these, not by whoever answered last.
  const shared = item.kind === "assignment" && item.assignees?.length;
  const answers = shared ? `<div class="rv-answers">${item.assignees.map((x) =>
    `<span class="rv-answer ${x.status} ${x.status === "open" && x.nudged_at && !settled ? "nudged" : ""}">${esc(x.user_id === S.me.id ? "You" : x.name)}: ${x.status === "open" ? (settled ? "no answer" : "to review")
      : x.status === "reviewed" ? `reviewed${p.verdicts?.[x.name] ? ` (${esc(cap(p.verdicts[x.name]))})` : ""}` : "declined"}${
      x.status === "open" && x.nudged_at && !settled ? ` · nudged${x.user_id === S.me.id && x.nudged_by_name ? ` by ${esc(x.nudged_by_name)}` : ""} ${esc(relTime(x.nudged_at))}` : ""}</span>`).join("")}</div>` : "";
  // Who settled it: the lead for a withdrawal or his Short Board / Big Board call; otherwise the scouts' answers say it.
  const by = shared && !["removed", "added_sb", "added_bb", "moved_bb", "not_sb"].includes(item.status) ? "" : esc(item.resolved_by_name || "");
  const last = item.notes.at(-1);
  return `<article class="rv-row ${settled ? "settled" : ""}" data-item="${item.id}" data-player="${p.id}">
    ${reviewPlayerHead(p)}
    <div class="rv-info">
      <div class="rv-route">${route} · ${rvWhen(item.created_at)}${settled ? ` <span class="dchip ${tone ? "v-" + tone : ""}">${esc(label)}</span>
        <span class="muted">${by ? `${by} · ` : ""}${rvWhen(item.resolved_at)}</span>` : ""}</div>
      ${last ? `<div class="rv-last"><b>${esc(last.user_name)}:</b> ${esc(last.body)}</div>` : `<div class="rv-last muted">No notes</div>`}
      ${answers}
    </div>
    <div class="rv-actions">${settled && !always ? "" : actions}${verdictDots(p.verdicts)}</div>
    <details class="rv-thread"><summary>${item.notes.length ? `${item.notes.length} note${item.notes.length === 1 ? "" : "s"}` : "Add a note"}</summary>
      ${item.notes.length ? `<ol class="rv-notes">${item.notes.map((n) => `<li><b>${esc(n.user_name)}</b> ${esc(n.body)}<span class="when">${rvWhen(n.created_at)}${n.updated_at ? ` · edited ${rvWhen(n.updated_at)}` : ""}</span></li>`).join("")}</ol>` : ""}
      ${settled ? "" : `<form class="rv-note-form"><input name="body" maxlength="4000" placeholder="Add a note…" aria-label="Add a note"><button class="btn sm" type="submit">Add</button></form>`}
    </details>
  </article>`;
}

// Suggested (both scouts passed): a row with a Send button, before anything has been created.
function reviewSuggestion(p) {
  return `<article class="rv-row" data-player="${p.id}">${reviewPlayerHead(p)}
    <div class="rv-info"><div class="rv-route">${reviewScouts().map((s) => esc(s.name)).join(" and ")} both passed</div></div>
    <div class="rv-actions"><button type="button" class="btn sm primary" data-rv-send>Send to ${esc(reviewLead()?.name || "the lead")}</button>${verdictDots(p.verdicts)}</div></article>`;
}

function reviewAddForm(role) {
  const lead = reviewLead()?.name || "the lead";
  return `<form class="rv-add" id="rv-add" autocomplete="off">
    <div class="rv-find"><input id="rv-q" data-keep placeholder="Search PINE or paste a Transfermarkt link" aria-label="Player">
      <div class="gs-res" id="rv-res" hidden></div></div>
    <input id="rv-note" placeholder="Why? (optional)" maxlength="4000" aria-label="Note">
    <div class="rv-add-btns"><button class="btn" type="submit" data-rv-target="watch">Watch</button>
      ${role === "scout" ? `<button class="btn primary" type="submit" data-rv-target="sb_review">Send to ${esc(lead)}</button>` : ""}
      ${canAssign() ? `<button class="btn primary" type="submit" data-rv-target="assignment">${esc(assignLabel())}</button>` : ""}</div>
  </form>`;
}

S.review = { tab: null };

async function renderReview(main) {
  const role = reviewRole();
  setTitle("War Room");
  if (!role) { main.innerHTML = `<div class="page"><p class="empty">The War Room is for the review team (set on the Staff page).</p></div>`; return; }
  if (!main.querySelector(".rv-page")) main.innerHTML = `<div class="page"><div class="loading">Loading…</div></div>`;
  const d = await api("GET", "/api/review");
  const lead = reviewLead(), leadName = lead?.name || "the lead";
  const open = (i) => i.status === "open";
  const sb = d.items.filter((i) => i.kind === "sb_review"), asg = d.items.filter((i) => i.kind === "assignment");
  const watch = d.items.filter((i) => i.kind === "watch" && open(i));
  const rows = (list, actions, always = false) => list.map((i) => reviewCard(i, actions(i), always)).join("");
  const watchActions = () => [
    ...(canAssign() ? [`<button type="button" class="btn sm" data-rv-assign="1">${esc(assignLabel())}</button>`] : []),
    role === "scout" ? `<button type="button" class="btn sm" data-rv-send>Send to ${esc(leadName)}</button>` : "",
    `<button type="button" class="btn sm ghost" data-rv-resolve="removed" title="Remove from your watch list">Remove</button>`].join("");
  const myAnswer = (i) => i.assignees?.find((x) => x.user_id === S.me.id)?.status;
  const lastMove = (i) => [i.created_at, ...(i.assignees || []).map((x) => x.resolved_at)].filter(Boolean).sort().at(-1);
  // Settled items that need nothing more from anyone.
  const history = d.items.filter((i) => i.kind !== "watch" && !i.awaiting_lead && !open(i));
  let tabs;
  if (role === "lead") {
    tabs = [
      // What the scouts sent up, and his assignments once a scout has answered: newest first, one call each.
      { id: "decide", label: "Decisions", list: [...sb.filter(open), ...asg.filter((i) => i.awaiting_lead)].sort((a, b) => (lastMove(b) > lastMove(a) ? 1 : -1)),
        urgent: true, empty: "Nothing waiting for a decision.",
        html: (l) => rows(l, (i) => decisionActions(S.byId.get(i.player_id)), true) },
      { id: "watch", label: "Watch list", list: watch, empty: "Your watch list is empty. Add players with the bar above.", html: (l) => rows(l, watchActions) },
      { id: "assigned", label: "Assigned out", list: asg.filter(open), empty: "No reviews out with the scouts.",
        html: (l) => rows(l, (i) => `${nudgeButton(i)}<button type="button" class="btn sm ghost" data-rv-resolve="removed">Withdraw</button>`) },
      { id: "history", label: "History", list: history, empty: "Nothing settled in the last 30 days.", html: (l) => rows(l, () => "") },
    ];
  } else if (role === "assigner") {
    // What he assigned (the server sends nothing else): out with the scouts, then waiting on the lead's call.
    const scoutNames = reviewScouts().map((x) => x.name).join(" and ") || "the scouts";
    tabs = [
      { id: "assigned", label: `Out with ${scoutNames}`, list: asg.filter(open), empty: `Nothing you've assigned is out with ${scoutNames}.`,
        html: (l) => rows(l, (i) => `${nudgeButton(i)}<button type="button" class="btn sm ghost" data-rv-resolve="removed">Withdraw</button>`) },
      { id: "lead", label: `With ${leadName}`, list: asg.filter((i) => i.awaiting_lead).sort((a, b) => (lastMove(b) > lastMove(a) ? 1 : -1)),
        empty: `Nothing you've assigned is waiting on ${leadName}'s decision.`, html: (l) => rows(l, () => "", true) },
      { id: "watch", label: "Watch list", list: watch, empty: "Your watch list is empty. Add players with the bar above.", html: (l) => rows(l, watchActions) },
      { id: "history", label: "History", list: history, empty: "Nothing settled in the last 30 days.", html: (l) => rows(l, () => "") },
    ];
  } else {
    const sent = new Set(sb.map((i) => i.player_id));
    const ready = d.suggestions.filter((id) => !sent.has(id)).map((id) => S.byId.get(id)).filter(Boolean);
    // Assignments every scout has answered, now waiting for the lead's call.
    const withLead = asg.filter((i) => i.awaiting_lead).sort((a, b) => (lastMove(b) > lastMove(a) ? 1 : -1));
    // Assignments you've answered that still wait on the other scout: nudge them from here.
    const others = reviewScouts().filter((x) => x.id !== S.me.id).map((x) => x.name).join(" and ") || "the other scouts";
    const waitingOn = asg.filter((i) => open(i) && myAnswer(i) && myAnswer(i) !== "open").sort((a, b) => (lastMove(b) > lastMove(a) ? 1 : -1));
    // Yours to review, any you've been nudged on first.
    const myNudge = (i) => i.assignees?.find((x) => x.user_id === S.me.id)?.nudged_at || "";
    const toReview = asg.filter((i) => open(i) && myAnswer(i) === "open").sort((a, b) => (myNudge(b) > myNudge(a) ? 1 : myNudge(b) < myNudge(a) ? -1 : 0));
    const heading = (t, n) => `<h3 class="rv-sub">${esc(t)} <span class="muted">${n}</span></h3>`;
    tabs = [
      { id: "assigned", label: "Assigned to you", list: toReview, urgent: true, empty: "Nothing assigned to you to review.",
        html: (l) => rows(l, () => `<button type="button" class="btn sm primary" data-rv-review>Review</button><button type="button" class="btn sm" data-rv-resolve="declined">Decline</button>`) },
      { id: "waiting", label: `Waiting on ${others}`, list: waitingOn, empty: `Nothing you've answered is waiting on ${others}.`,
        html: (l) => rows(l, nudgeButton) },
      { id: "ready", label: `Ready for ${leadName}`, list: [...withLead, ...ready],
        empty: `Nothing waiting on ${leadName}: no reviews back with him, and no players ${reviewScouts().map((x) => x.name).join(" and ")} have both passed to send.`,
        html: () => `${withLead.length ? `${heading(`Reviewed, waiting on ${leadName}'s Short Board decision`, withLead.length)}${rows(withLead, () => "", true)}` : ""}${
          ready.length ? `${heading(`Both passed, not sent to ${leadName} yet`, ready.length)}${ready.map(reviewSuggestion).join("")}` : ""}` },
      { id: "sent", label: `Sent to ${leadName}`, list: sb.filter(open), empty: `Nothing waiting with ${leadName}.`,
        html: (l) => rows(l, (i) => (i.from_user === S.me.id ? `<button type="button" class="btn sm ghost" data-rv-resolve="removed" data-rv-withdraw title="Take this request back: it leaves ${esc(leadName)}'s queue and Activity">Withdraw</button>` : "")) },
      { id: "watch", label: "Watch list", list: watch, empty: "Your watch list is empty. Add players with the bar above.", html: (l) => rows(l, watchActions) },
      { id: "history", label: "History", list: history, empty: "Nothing settled in the last 30 days.", html: (l) => rows(l, () => "") },
    ];
  }
  // Stay on the chosen tab; otherwise open on whatever is waiting on you, else the first tab with anything in it.
  const tab = tabs.find((t) => t.id === S.review.tab) || tabs.find((t) => t.urgent && t.list.length) || tabs.find((t) => t.list.length) || tabs[0];
  S.review.tab = tab.id;
  main.innerHTML = `<div class="page rv-page">
    <div class="page-h"><h1>War Room</h1><span class="muted">${role === "lead"
      ? "Decide on what the scouts send up and review for you, assign reviews, and keep your watch list"
      : role === "assigner" ? `Assign players to ${esc(reviewScouts().map((x) => x.name).join(" and ") || "the scouts")}, follow them to ${esc(leadName)}'s decision, and keep your watch list`
      : "What's assigned to you, players to send up, and your watch list"}</span></div>
    <section class="panel rv-bar">${reviewAddForm(role)}</section>
    <div class="rv-tabs" role="tablist">${tabs.map((t) => `<button type="button" role="tab" data-rv-tab="${t.id}" aria-selected="${t === tab}" class="${t === tab ? "on" : ""}">
      ${esc(t.label)}${t.id !== "history" && t.list.length ? `<span class="rv-count ${t.urgent ? "urgent" : ""}">${t.list.length}</span>` : ""}</button>`).join("")}</div>
    <section class="panel rv-list" role="tabpanel">${tab.list.length ? tab.html(tab.list) : `<p class="rv-empty">${esc(tab.empty)}</p>`}</section>
  </div>`;
  const waiting = tabs.find((t) => t.urgent)?.list.length || 0;
  setReviewBadge(waiting);
  const root = main.querySelector(".rv-page");
  root.querySelector(".rv-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rv-tab]");
    if (b && b.dataset.rvTab !== S.review.tab) { S.review.tab = b.dataset.rvTab; renderReview(main); }
  });
  wireReview(root, d);
}

// One small dialog for every review action: an optional extra field (role, scout, verdict) and a note.
function reviewDialog({ title, player, extra = "", noteLabel = "Note", required = false, submit = "Save", note: prefill = "" }) {
  return new Promise((resolve) => {
    const m = modal(`<header class="m-h"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
      <p class="hint">${esc(player)}</p><form id="rv-dialog">${extra}
      <label class="lbl" for="rv-d-note">${esc(noteLabel)} ${required ? "*" : "(optional)"}</label>
      <textarea id="rv-d-note" name="note" rows="4" maxlength="4000" ${required ? "required" : ""}>${esc(prefill)}</textarea>
      <div class="m-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${esc(submit)}</button></div></form>`);
    const done = (v) => { obs.disconnect(); resolve(v); };
    const obs = new MutationObserver(() => { if (!m.isConnected) done(null); });
    obs.observe(document.body, { childList: true });
    $("#rv-dialog", m).addEventListener("submit", (e) => {
      e.preventDefault();
      const note = $("#rv-d-note", m);
      note.setCustomValidity(required && !note.value.trim() ? "Please write a note." : "");
      if (!note.reportValidity()) return;
      const out = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).trim()]));
      obs.disconnect(); closeModal(); resolve(out);
    });
    $("select, textarea", m)?.focus();
  });
}

// Nudge the scouts who haven't answered an assignment (shown once a nudge is more than 12 hours old).
function nudgeButton(i) {
  const left = (i.assignees || []).filter((x) => x.status === "open" && x.user_id !== S.me.id);
  if (!left.length) return "";
  const names = left.map((x) => x.name).join(" and ");
  const recent = left.every((x) => x.nudged_at && Date.now() - toDate(x.nudged_at) < 12 * 3600e3);
  return recent ? `<button type="button" class="btn sm ghost" disabled title="You can nudge again 12 hours after the last one">Nudged ${esc(relTime(left[0].nudged_at))}</button>`
    : `<button type="button" class="btn sm" data-rv-nudge title="Bring it to the top of ${esc(names)}'s list, marked as a nudge">Nudge ${esc(names)}</button>`;
}

// The lead's choices on a player waiting in Decisions: the Big Board (add him, or move him if he's on it), the Short
// Board, or not for now.
const decisionActions = (p) => `${p?.roles.length
  ? `<button type="button" class="btn sm" data-rv-move-bb title="Change where he sits in one of his Big Board roles">Move on Big Board</button>`
  : `<button type="button" class="btn sm" data-rv-add-bb title="Put him on the Big Board without starring him">Add to Big Board</button>`}<button type="button" class="btn sm primary" data-rv-add-sb>Add to Short Board</button><button type="button" class="btn sm" data-rv-resolve="not_sb">Not for now</button>`;
const roleSize = (role) => S.players.filter((x) => x.roles.some((r) => r.role === role)).length;
// Rank fields for the Big Board dialogs. Ranks are 1-based on screen, 0-based on the server.
const rankField = (label, hint, required) => `<label class="lbl" for="rv-d-rank">${label} ${required ? "*" : ""}</label>
  <input id="rv-d-rank" name="rank" type="number" min="1" step="1" ${required ? "required" : ""} placeholder="${esc(hint)}">`;
const bbAddFields = (p) => `<label class="lbl" for="rv-d-role">Big Board role *</label><select id="rv-d-role" name="role" required>
    <option value="">Choose a role…</option>${S.config.positions.map((pos) => `<optgroup label="${esc(pos.code)} · ${esc(pos.label)}">${pos.roles.map(([c]) =>
      `<option value="${esc(c)}">${esc(roleLabel(c))} (${roleSize(c)} on it)</option>`).join("")}</optgroup>`).join("")}</select>
  ${rankField("Rank in the role", "Bottom if blank", false)}`;
const bbMoveFields = (p) => `<label class="lbl" for="rv-d-role">Role *</label><select id="rv-d-role" name="role" required>
    ${[...p.roles].sort((a, b) => a.rank - b.rank).map((r) => `<option value="${esc(r.role)}">${esc(roleLabel(r.role))}: now #${rankIn(p, r.role) + 1} of ${roleSize(r.role)}</option>`).join("")}</select>
  ${rankField("Move him to rank", "1 is the top", true)}`;

const roleOptions = (p) => {
  const mine = p.roles.map((r) => r.role);
  const all = Object.keys(S.config.roles).filter((r) => !mine.includes(r));
  const opt = (r) => `<option value="${esc(r)}">${esc(roleLabel(r))}</option>`;
  return `<label class="lbl" for="rv-d-role">Short Board role *</label><select id="rv-d-role" name="role" required>
    ${mine.length ? `<optgroup label="On his Big Board roles">${mine.map(opt).join("")}</optgroup>` : `<option value="">Choose a role…</option>`}
    <optgroup label="${mine.length ? "Another role" : "Big Board roles"}">${all.map(opt).join("")}</optgroup></select>`;
};

async function reviewCreate(kind, playerId, extra = {}) {
  await api("POST", "/api/review/items", { kind, player_id: playerId, ...extra });
  toast(kind === "watch" ? "Added to your watch list" : kind === "sb_review" ? `Sent to ${reviewLead()?.name || "the lead"}` : "Assigned");
}

// Assignments always go to every scout (the server sees to that); the item and its thread are shared.
const assignLabel = () => `Assign to ${reviewScouts().map((s) => s.name).join(" and ") || "the scouts"}`;

async function reviewSendDialog(p, kind, note = "") {
  const lead = reviewLead()?.name || "the lead";
  const v = await reviewDialog({ player: p.name, note,
    submit: kind === "watch" ? "Add" : kind === "sb_review" ? `Send to ${lead}` : "Assign",
    title: kind === "watch" ? "Add to your watch list" : kind === "sb_review" ? `Send to ${lead} for a Short Board decision` : assignLabel(),
    noteLabel: kind === "assignment" ? "Why are you assigning him?" : kind === "sb_review" ? "Why should he go on the Short Board?" : "What to follow up on" });
  if (!v) return false;
  await reviewCreate(kind, p.id, { note: v.note || undefined });
  return true;
}

function wireReview(root, d) {
  // The add form: pick a PINE player from the search, or paste a Transfermarkt link (added to PINE first if new).
  const form = $("#rv-add", root);
  if (form) {
    const inp = $("#rv-q", form), box = $("#rv-res", form);
    let picked = null, results = [], hl = 0;
    const draw = () => {
      box.hidden = !results.length;
      box.innerHTML = results.map((p, i) => `<a href="#" data-pick="${p.id}" class="${i === hl ? "hl" : ""}">${photo(p)}<span class="ci">${nameWithMark(p)}<div class="csub">${esc([p.position, p.club, p.age].filter((x) => x != null && x !== "").join(" · "))}</div></span></a>`).join("");
    };
    const pick = (p) => { picked = p; inp.value = p.name; results = []; draw(); $("#rv-note", form).focus(); };
    inp.addEventListener("input", () => {
      picked = null;
      const q = inp.value.trim();
      results = q && !TM_LINK.test(q) ? S.players.filter((p) => matchText(p, q)).slice(0, 8) : [];
      hl = 0;
      draw();
    });
    inp.addEventListener("keydown", (e) => {
      if (box.hidden) return;
      if (e.key === "ArrowDown") { hl = Math.min(hl + 1, results.length - 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { hl = Math.max(hl - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && results[hl]) { e.preventDefault(); pick(results[hl]); } // pick, don't submit
      else if (e.key === "Escape") { results = []; draw(); }
    });
    inp.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
    inp.addEventListener("focus", () => { if (results.length) box.hidden = false; });
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-pick]");
      if (!a) return;
      e.preventDefault();
      pick(S.byId.get(Number(a.dataset.pick)));
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.submitter, kind = btn?.dataset.rvTarget || "watch";
      const q = inp.value.trim();
      try {
        let player = picked;
        if (!player && q && !TM_LINK.test(q)) { // typed a name without picking: fine if only one player matches
          const matches = S.players.filter((p) => matchText(p, q));
          if (matches.length === 1) player = matches[0];
        }
        if (!player && TM_LINK.test(q)) {
          btn.disabled = true;
          try {
            player = (await api("POST", "/api/players", { tm_url: q, roles: [] })).player;
            toast(`${player.name} added to PINE`);
          } catch (err) {
            if (err.status !== 409 || !err.data?.player_id) throw err;
            player = { id: err.data.player_id, name: err.message.replace(/ is already in PINE$/, "") };
          }
          await reloadPlayers();
        }
        if (!player) { toast(q ? "Several players match: pick one from the list" : "Search for a player, or paste a Transfermarkt link"); inp.focus(); return; }
        const barNote = $("#rv-note", form).value.trim();
        if (kind === "assignment") {
          if (!(await reviewSendDialog(S.byId.get(player.id) || player, "assignment", barNote))) return;
        } else await reviewCreate(kind, player.id, { note: barNote || undefined });
        inp.value = ""; $("#rv-note", form).value = "";
        S.review.tab = { watch: "watch", sb_review: "sent", assignment: "assigned" }[kind]; // show where it went
        await afterMutation();
      } catch (err) { oops(err); } finally { if (btn) btn.disabled = false; }
    });
  }

  root.addEventListener("submit", async (e) => {
    const f = e.target.closest(".rv-note-form");
    if (!f) return;
    e.preventDefault();
    const body = f.elements.body.value.trim();
    if (!body) return;
    try { await api("POST", `/api/review/items/${f.closest("[data-item]").dataset.item}/notes`, { body }); await afterMutation(); } catch (err) { oops(err); }
  });

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    const card = t?.closest(".rv-row");
    if (!card) return;
    const p = S.byId.get(Number(card.dataset.player)), itemId = card.dataset.item;
    const resolve = (body) => api("POST", `/api/review/items/${itemId}/resolve`, body);
    try {
      if (t.matches("[data-rv-nudge]")) {
        const { nudged } = await api("POST", `/api/review/items/${itemId}/nudge`, {});
        toast(`Nudged ${nudged.join(" and ")} on ${p.name}`);
        await afterMutation();
        return;
      }
      if (t.matches("[data-rv-send]")) {
        if (await reviewSendDialog(p, "sb_review")) await afterMutation();
      } else if (t.dataset.rvAssign) {
        if (await reviewSendDialog(p, "assignment")) await afterMutation();
      } else if (t.matches("[data-rv-add-bb]")) {
        const v = await reviewDialog({ title: "Add to the Big Board", player: p.name, extra: bbAddFields(p), noteLabel: "Why (saved as the board reason)", required: true, submit: "Add to Big Board" });
        if (!v) return;
        await resolve({ outcome: "added_bb", role: v.role, index: v.rank ? Number(v.rank) - 1 : undefined, note: v.note });
        toast(`${p.name} is on the Big Board`);
        await afterMutation();
      } else if (t.matches("[data-rv-move-bb]")) {
        const v = await reviewDialog({ title: "Move on the Big Board", player: p.name, extra: bbMoveFields(p), noteLabel: "Why", submit: "Move" });
        if (!v) return;
        await resolve({ outcome: "moved_bb", role: v.role, index: Number(v.rank) - 1, note: v.note || undefined });
        toast(`${p.name} moved to #${v.rank} in ${roleShort(v.role)}`);
        await afterMutation();
      } else if (t.matches("[data-rv-add-sb]")) {
        const v = await reviewDialog({ title: "Add to the Short Board", player: p.name, extra: roleOptions(p), noteLabel: "Why (saved as the board reason)", required: true, submit: "Add to Short Board" });
        if (!v) return;
        await resolve({ outcome: "added_sb", role: v.role, note: v.note });
        toast(`${p.name} is on the Short Board`);
        await afterMutation();
      } else if (t.matches("[data-rv-review]")) {
        const extra = `<label class="lbl">Your verdict</label><div class="seg" role="radiogroup">${S.config.decisions.map((v) =>
          `<label class="v-${v}"><input type="radio" name="verdict" value="${v}" ${p.verdicts?.[S.me.name] === v ? "checked" : ""}> ${cap(v)}</label>`).join("")}</div>`;
        const v = await reviewDialog({ title: "Review", player: p.name, extra, noteLabel: "What did you think?", submit: "Mark reviewed" });
        if (!v) return;
        await resolve({ outcome: "reviewed", verdict: v.verdict || undefined, note: v.note || undefined });
        toast("Marked reviewed");
        await afterMutation();
      } else if (t.dataset.rvResolve) {
        const outcome = t.dataset.rvResolve;
        if (t.matches("[data-rv-withdraw]")) {
          // Withdrawing a request leaves no trace for others, so no note: just confirm.
          if (!confirm(`Withdraw your request on ${p.name}? It leaves ${reviewLead()?.name || "the lead"}'s queue and Activity.`)) return;
          await resolve({ outcome });
          toast("Request withdrawn");
          await afterMutation();
          return;
        }
        const titles = { not_sb: "Not for the Short Board for now", declined: "Decline this review", removed: card.querySelector("[data-rv-assign], [data-rv-send]") ? "Remove from your watch list" : "Withdraw this assignment" };
        const v = await reviewDialog({ title: titles[outcome], player: p.name, noteLabel: outcome === "removed" ? "Note" : "Why?", submit: "Confirm" });
        if (!v) return;
        await resolve({ outcome, note: v.note || undefined });
        await afterMutation();
      }
    } catch (err) { oops(err); }
  });
}
