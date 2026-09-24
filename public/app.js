// PINE front end: single page, no build step.
// Routes: #/board  #/players  #/player/:id  #/impect  #/activity  #/staff
// Shared links come in as /p/:id, which the server rewrites to #/player/:id before this boots.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3l7 9h-3.5l6.2 8h-4.9l6.4 7.5H4.8l6.4-7.5H6.3l6.2-8H9z" fill="currentColor"/><rect x="14.5" y="27" width="3" height="3.5" fill="currentColor"/></svg>`;
const GROUPS = ["Volume", "Repeated Efforts", "Top Speed", "Accel / Decel"];
const GRP_NAME = { CB: "centre backs", FB: "full backs", MID: "midfielders", FWD: "forwards", GK: "goalkeepers" };

const S = {
  me: null, config: null, players: [], byId: new Map(), version: 0, pollTimer: null, dragging: null,
  board: { decision: "all", q: "", league: "" },
  table: { q: "", decision: "all", position: "", league: "", coaches: new Set(), sort: "updated_at", dir: -1 },
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
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const photo = (p, size = "") => p.photo_url
  ? `<img class="ph ${size}" src="${esc(p.photo_url)}" alt="" loading="lazy" data-ini="${esc(initials(p.name))}">`
  : `<span class="ph ini ${size}">${esc(initials(p.name))}</span>`;
const decisionChip = (d, lg = false) => `<span class="dchip ${d ? "v-" + d : ""} ${lg ? "lg" : ""}">${d ? cap(d) : "Undecided"}</span>`;
const verdictChip = (v) => `<span class="dchip ${v ? "v-" + v : ""}">${v ? cap(v) : "No verdict"}</span>`;
const fact = (label, value, html = false) => (value == null || value === "" ? "" : `<div><dt>${esc(label)}</dt><dd>${html ? value : esc(value)}</dd></div>`);
function verdictDots(verdicts, wide = false) {
  return `<span class="vdots ${wide ? "wide" : ""}">${S.config.staff.map((s) => {
    const v = verdicts?.[s.name];
    return `<i class="vdot ${v ? "v-" + v : ""}" title="${esc(s.name)}: ${v ? cap(v) : "no verdict"}"></i>`;
  }).join("")}</span>`;
}
function seg(current, attr) {
  return `<div class="seg" role="group">${S.config.decisions.map((d) =>
    `<button type="button" class="v-${d} ${current === d ? "on" : ""}" data-${attr}="${d}" aria-pressed="${current === d}">${cap(d)}</button>`).join("")}${
    current ? `<button type="button" data-${attr}="" title="Clear">Clear</button>` : ""}</div>`;
}
const matchText = (p, q) => {
  if (!q) return true;
  const n = q.toLowerCase();
  return [p.name, p.club, p.league, p.position, (p.citizenship || []).join(" ")].some((x) => String(x || "").toLowerCase().includes(n));
};
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
const closeModal = () => $("#modal")?.remove();

/* ---------- data sync ---------- */
async function reloadPlayers() {
  const { players } = await api("GET", "/api/players");
  S.players = players;
  S.byId = new Map(players.map((p) => [p.id, p]));
}
async function syncVersion() { try { S.version = (await api("GET", "/api/changes")).version; } catch {} }
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
  try { v = (await api("GET", "/api/changes")).version; } catch { return; }
  if (v === S.version) return;
  S.version = v;
  if (S.dragging || busyEditing() || $("#modal")) { $("#upd").hidden = false; return; }
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
      <a href="#/players" data-v="players">Database</a>
      <a href="#/impect" data-v="impect">Impect</a>
      <a href="#/activity" data-v="activity">Activity</a>
      ${S.me.is_admin ? `<a href="#/staff" data-v="staff">Staff</a>` : ""}
    </nav>
    <div class="top-r">
      <div class="gsearch"><input id="gs" type="search" placeholder="Find a player  ( / )" autocomplete="off" aria-label="Find a player"><div class="gs-res" id="gs-res" hidden></div></div>
      <button class="btn primary" id="add-btn" type="button">+ Add player</button>
      ${S.config.auth === "off"
        ? `<label class="me" title="Notes, verdicts and changes are recorded under this name"><span class="avatar">${esc(S.me.name[0])}</span>
            <select id="act-as" aria-label="Acting as">${S.config.staff.map((s) => `<option value="${s.id}" ${s.id === S.me.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>`
        : `<div class="me"><span class="avatar">${esc(S.me.name[0])}</span><span class="me-name">${esc(S.me.name)}</span><button class="btn ghost sm" id="logout" type="button">Sign out</button></div>`}
    </div>
  </header>
  <div class="update-pill" id="upd" hidden><button class="btn sm" type="button">New changes from staff · refresh</button></div>
  <main id="main"></main>`;
  $("#add-btn").addEventListener("click", () => openAddPlayer());
  $("#logout")?.addEventListener("click", async () => { try { await api("POST", "/api/auth/logout", {}); } catch {} showLogin(); });
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
  wireGlobalSearch();
}

function wireGlobalSearch() {
  const inp = $("#gs"), box = $("#gs-res");
  let results = [], hl = 0;
  const draw = () => {
    box.hidden = !results.length;
    box.innerHTML = results.map((p, i) => `<a href="#/player/${p.id}" class="${i === hl ? "hl" : ""}">${photo(p)}<span class="ci"><div class="nm">${esc(p.name)}</div><div class="csub">${esc([p.age, p.club].filter((x) => x != null && x !== "").join(" · "))}</div></span>${decisionChip(p.decision)}</a>`).join("");
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
    return { view, arg };
  }
  const shared = location.pathname.match(/^\/p\/(\d+)/);
  return shared ? { view: "player", arg: shared[1] } : { view: "board", arg: undefined };
}

const canonicalUrl = ({ view, arg }) => (view === "player" ? `/p/${arg}` : `/#/${view}`);

async function render() {
  if (!S.me) return;
  const { view, arg } = route();
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === view || (view === "player" && a.dataset.v === "players")));
  $("#upd").hidden = true;
  const views = { board: renderBoard, players: renderTable, player: renderPlayer, impect: renderImpect, activity: renderActivity, staff: renderStaff };
  if (!views[view]) { location.hash = "#/board"; return; }
  // replaceState fires nothing, so this can't loop back into render().
  const want = canonicalUrl({ view, arg });
  if (location.pathname + location.hash !== want) history.replaceState(null, "", want);
  // The player view retitles itself once the profile loads.
  setTitle({ board: "Big Board", players: "Database", impect: "Impect", activity: "Activity", staff: "Staff" }[view]);
  await views[view]($("#main"), arg);
}

/* ---------- big board ---------- */
function renderBoard(main) {
  const f = S.board;
  const onBoard = S.players.filter((p) => p.roles.length);
  const count = (d) => onBoard.filter((p) => p.decision === d).length;
  const unassigned = S.players.filter((p) => !p.roles.length);
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
      </div>
    </div>
    <div class="pitch-wrap"><div class="pitch">${S.config.positions.map(posBox).join("")}</div></div>
    <section class="panel tray">
      <header class="panel-h"><h2>Not on the board</h2><span class="muted sm">${unassigned.length} player${unassigned.length === 1 ? "" : "s"} · drag onto a role, or drag a card here to take it off</span></header>
      <div class="tray-body" data-tray="1">${unassigned.map((p) => boardCard(p, null)).join("") || `<p class="empty">Everyone in PINE has a role on the board.</p>`}</div>
    </section>
  </div>`;
  wireBoard(main.firstElementChild);
}

function posBox(pos) {
  const total = new Set(pos.roles.flatMap(([c]) => playersInRole(c).map((p) => p.id))).size;
  return `<section class="pos" style="grid-area:${pos.area}">
    <header class="pos-h"><span class="pos-code">${pos.code}</span><span class="pos-label">${esc(pos.label)}</span><span class="pos-n">${total}</span></header>
    <div class="lanes">${pos.roles.map(([code, label]) => {
      const list = playersInRole(code);
      const num = roleInfo(code).num;
      return `<div class="lane">
        <div class="lane-h"><span class="lane-t" title="${esc(pos.code)} #${num}: ${esc(label)}"><b>#${num}</b>${esc(label)}</span><span class="lane-n">${list.length}</span>
          <button type="button" class="icon-btn" data-add-role="${code}" title="Add a player to ${esc(label)}" aria-label="Add a player to ${esc(pos.code)} ${esc(label)}">+</button></div>
        <div class="lane-body" data-role="${code}">${list.map((p) => boardCard(p, code)).join("") || `<div class="lane-empty">Drop players here</div>`}</div>
      </div>`;
    }).join("")}</div>
  </section>`;
}

// Domestic = US citizen, from Transfermarkt citizenship (players not linked to Transfermarkt carry
// Impect's German country names). People from Puerto Rico and the other territories listed are US
// citizens. Green cards aren't on Transfermarkt, so a permanent resident still shows as international.
const US_CITIZENSHIPS = new Set(["United States", "Vereinigte Staaten", "Puerto Rico", "US Virgin Islands",
  "Amerikanische Jungferninseln", "Guam", "Northern Mariana Islands", "Nördliche Marianen"]);
function rosterBadge(p) {
  const cit = p.citizenship || [];
  if (!cit.length) return "";
  const dom = cit.some((c) => US_CITIZENSHIPS.has(c));
  return `<span class="roster ${dom ? "dom" : "intl"}" title="${dom ? "Domestic" : "International"}: ${esc(cit.join(", "))}">${dom ? "DOM" : "INTL"}</span>`;
}

function boardCard(p, role) {
  const sub = [p.age, p.club].filter((x) => x != null && x !== "").join(" · ") || p.position || "";
  return `<a class="pcard ${p.decision ? "v-" + p.decision : ""}" href="#/player/${p.id}" draggable="true" data-pid="${p.id}" ${role ? `data-role="${role}"` : ""}>
    ${role ? `<span class="rank">${rankIn(p, role) + 1}</span>` : ""}${photo(p)}
    <span class="ci"><div class="nm-row"><span class="nm">${esc(p.name)}</span>${rosterBadge(p)}</div><div class="csub">${esc(sub)}</div></span>${verdictDots(p.verdicts)}</a>`;
}

function applyBoardFilter(root) {
  const f = S.board;
  $$(".pcard", root).forEach((c) => {
    const p = S.byId.get(Number(c.dataset.pid));
    c.hidden = !(p && matchDecision(p, f.decision) && (!f.league || p.league === f.league) && matchText(p, f.q));
  });
}

function cardAfter(zone, y) {
  return $$(".pcard:not(.dragging)", zone).filter((c) => !c.hidden)
    .find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
}

function wireBoard(root) {
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
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-add-role]");
    if (b) { e.preventDefault(); openRolePicker(b.dataset.addRole); }
  });

  let marker = null;
  const clear = () => { marker?.remove(); marker = null; $$(".over", root).forEach((x) => x.classList.remove("over")); };
  root.addEventListener("dragstart", (e) => {
    const card = e.target.closest?.(".pcard[draggable]");
    if (!card) return;
    S.dragging = { pid: Number(card.dataset.pid), from: card.dataset.role || null, el: card };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.pid);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  root.addEventListener("dragend", () => { S.dragging?.el?.classList.remove("dragging"); S.dragging = null; clear(); });
  root.addEventListener("dragover", (e) => {
    if (!S.dragging) return;
    const zone = e.target.closest(".lane-body, [data-tray]");
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!zone.classList.contains("over")) { $$(".over", root).forEach((x) => x.classList.remove("over")); zone.classList.add("over"); }
    if (zone.matches(".lane-body")) {
      marker ??= Object.assign(document.createElement("div"), { className: "drop-marker" });
      const before = cardAfter(zone, e.clientY);
      if (before) zone.insertBefore(marker, before); else zone.appendChild(marker);
    } else marker?.remove();
  });
  root.addEventListener("dragleave", (e) => {
    const zone = e.target.closest?.(".lane-body, [data-tray]");
    if (zone && !zone.contains(e.relatedTarget)) { zone.classList.remove("over"); if (marker && zone.contains(marker)) marker.remove(); }
  });
  root.addEventListener("drop", async (e) => {
    if (!S.dragging) return;
    const zone = e.target.closest(".lane-body, [data-tray]");
    if (!zone) return;
    e.preventDefault();
    const { pid, from } = S.dragging;
    let req = null;
    if (zone.matches(".lane-body")) {
      const before = cardAfter(zone, e.clientY);
      const others = $$(".pcard", zone).filter((c) => Number(c.dataset.pid) !== pid);
      const index = before ? others.indexOf(before) : others.length;
      req = api("POST", "/api/board/move", { player_id: pid, from_role: from, to_role: zone.dataset.role, index });
    } else if (from) {
      req = api("DELETE", `/api/players/${pid}/roles/${from}`);
    }
    clear();
    S.dragging = null;
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
    $("#rp-list", m).innerHTML = list.map((p) => `<button type="button" class="pcard ${p.decision ? "v-" + p.decision : ""}" data-pick="${p.id}">${photo(p)}
      <span class="ci"><div class="nm">${esc(p.name)}</div><div class="csub">${esc([p.position, p.club].filter(Boolean).join(" · "))}</div></span>
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
    try { await api("POST", `/api/players/${b.dataset.pick}/roles`, { role }); closeModal(); toast("Added to the board"); await afterMutation(); } catch (err) { oops(err); }
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
    ${d.duplicate ? "" : `<div class="assign"><div class="rp-host"></div><div class="dec-host"></div>
      <div class="m-actions" style="margin-top:0"><button type="button" class="btn primary" id="tm-save">Add to PINE</button></div></div>`}`;
}

function openAddPlayer({ role = null, url = "" } = {}) {
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
          <div><label class="lbl" for="mf-league">League</label><input id="mf-league" name="league"></div>
          <div><label class="lbl" for="mf-dob">Date of birth</label><input id="mf-dob" name="birthdate" type="date"></div>
          <div><label class="lbl" for="mf-foot">Foot</label><select id="mf-foot" name="foot"><option value="">Unknown</option><option>right</option><option>left</option><option>both</option></select></div>
        </div>
        <div class="assign"><div class="rp-host"></div><div class="dec-host"></div></div>
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
  $("#man-form", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api("POST", "/api/players", { ...body, roles: [...manRoles.selected], decision: manDec.value });
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
      $("#tm-save", out).addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Adding…";
        try {
          const r = await api("POST", "/api/players", { tm_url: u, roles: [...rp.selected], decision: dp.value });
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
  const m = modal(`<header class="m-h"><h2>Edit ${esc(p.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <form id="ep"><div class="form-grid">${F.map(([k, l, t]) => `<div><label class="lbl" for="ep-${k}">${l}</label><input id="ep-${k}" name="${k}" type="${t}" value="${esc(p[k] ?? "")}"></div>`).join("")}</div>
    ${p.tm_id ? `<p class="hint" style="margin-top:10px">Manual changes are preserved when you sync from Transfermarkt later.</p>` : ""}
    <div class="m-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`, { wide: true });
  $("#ep", m).addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("PATCH", `/api/players/${p.id}`, Object.fromEntries(new FormData(e.target))); closeModal(); toast("Saved"); await afterMutation(); } catch (err) { oops(err); }
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
const COLS = [
  { k: "name", l: "Player", sort: (p) => p.name.toLowerCase() },
  { k: "age", l: "Age", sort: (p) => p.age ?? 999 },
  { k: "board", l: "Board", sort: (p) => p.roles.map((r) => r.role).join(",") || "~" },
  { k: "club", l: "Club", sort: (p) => (p.club || "~").toLowerCase() },
  { k: "league", l: "League", sort: (p) => (p.league || "~").toLowerCase() },
  { k: "contract_expires", l: "Contract", sort: (p) => p.contract_expires || "9999" },
  { k: "market_value_eur", l: "Value", sort: (p) => p.market_value_eur ?? -1 },
  { k: "decision", l: "Decision", sort: (p) => ({ pass: 0, hold: 1, fail: 2 })[p.decision] ?? 3 },
  { k: "verdicts", l: "Staff", sort: (p) => -Object.values(p.verdicts || {}).filter((v) => v === "pass").length },
  { k: "note_count", l: "Notes", sort: (p) => p.note_count },
  { k: "updated_at", l: "Updated", sort: (p) => p.updated_at },
];

function tableFiltered() {
  const f = S.table;
  const col = COLS.find((c) => c.k === f.sort) || COLS[0];
  return S.players
    .filter((p) => matchText(p, f.q) && matchDecision(p, f.decision) && (!f.league || p.league === f.league)
      && (!f.coaches.size || [p.created_by, ...(p.changed_by || [])].some((id) => f.coaches.has(Number(id))))
      && (!f.position || (f.position === "none" ? !p.roles.length : p.roles.some((r) => roleInfo(r.role)?.position === f.position))))
    .sort((a, b) => { const x = col.sort(a), y = col.sort(b); return (x < y ? -1 : x > y ? 1 : 0) * f.dir; });
}

function renderTable(main) {
  const f = S.table;
  const decs = [["all", "Any decision"], ["pass", "Pass"], ["hold", "Hold"], ["fail", "Fail"], ["none", "Undecided"]];
  const coachLabel = () => {
    const names = S.config.staff.filter((s) => f.coaches.has(s.id)).map((s) => s.name);
    return names.length ? `Changed by ${names.length <= 2 ? names.join(" + ") : `${names.length} coaches`}` : "Changed by any coach";
  };
  main.innerHTML = `<div class="page">
    <div class="page-h">
      <div><h1>Database</h1><div class="sub" id="t-count"></div></div>
      <div class="spacer"></div>
      <div class="filters">
        <input id="tf-q" type="search" placeholder="Search name, club, nationality…" value="${esc(f.q)}" aria-label="Search">
        <select id="tf-dec" aria-label="Decision">${decs.map(([k, l]) => `<option value="${k}" ${f.decision === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select id="tf-pos" aria-label="Board position"><option value="">Any board position</option><option value="none" ${f.position === "none" ? "selected" : ""}>Not on board</option>${S.config.positions.map((p) => `<option value="${p.code}" ${f.position === p.code ? "selected" : ""}>${p.code} · ${esc(p.label)}</option>`).join("")}</select>
        <select id="tf-league" aria-label="League"><option value="">All leagues</option>${leaguesOf().map((l) => `<option value="${esc(l)}" ${f.league === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <details class="coach-filter" id="tf-coach">
          <summary title="${esc(coachLabel())}"><span id="tf-coach-label">${esc(coachLabel())}</span></summary>
          <div class="coach-filter-menu">
            <div class="coach-filter-h"><b>Added or changed by</b><button type="button" class="btn link sm" id="tf-coach-clear" ${f.coaches.size ? "" : "disabled"}>Clear</button></div>
            ${S.config.staff.map((s) => `<label><input type="checkbox" value="${s.id}" aria-label="${esc(s.name)}" ${f.coaches.has(s.id) ? "checked" : ""}> <span>${esc(s.name)}</span></label>`).join("")}
          </div>
        </details>
        <button type="button" class="btn" id="t-csv">Export CSV</button>
      </div>
    </div>
    <div class="table-wrap"><table class="grid">
      <thead><tr>${COLS.map((c) => `<th data-sort="${c.k}" class="${f.sort === c.k ? "sorted" + (f.dir > 0 ? " asc" : "") : ""}">${c.l}</th>`).join("")}</tr></thead>
      <tbody id="t-body"></tbody>
    </table></div>
  </div>`;
  const root = main.firstElementChild;
  const draw = () => {
    const list = tableFiltered();
    $("#t-count", root).textContent = `${list.length} of ${S.players.length} players`;
    $("#t-body", root).innerHTML = list.map((p) => `<tr data-href="#/player/${p.id}">
      <td class="name">${photo(p)}<div><div class="nm">${esc(p.name)}</div><div class="csub">${esc(p.position || "")}</div></div></td>
      <td>${p.age ?? ""}</td>
      <td>${p.roles.map((r) => `<span class="chip" title="${esc(roleLabel(r.role))}, rank ${r.rank + 1}">${esc(roleShort(r.role))} <b>${r.rank + 1}</b></span>`).join("")}</td>
      <td>${esc(p.club || "")}</td>
      <td>${esc(p.league || "")}</td>
      <td class="${contractSoon(p.contract_expires) ? "warn" : ""}">${fmtDate(p.contract_expires)}</td>
      <td>${esc(p.market_value_display || "")}</td>
      <td>${decisionChip(p.decision)}</td>
      <td>${verdictDots(p.verdicts, true)}</td>
      <td>${p.note_count || ""}</td>
      <td class="muted">${relTime(p.updated_at)}</td>
    </tr>`).join("") || `<tr><td colspan="${COLS.length}" class="empty-state">${S.players.length ? "No players match these filters." : "No players yet. Click “+ Add player” and paste a Transfermarkt link."}</td></tr>`;
  };
  draw();
  $("#tf-q", root).addEventListener("input", (e) => { f.q = e.target.value; draw(); });
  $("#tf-dec", root).addEventListener("change", (e) => { f.decision = e.target.value; draw(); });
  $("#tf-pos", root).addEventListener("change", (e) => { f.position = e.target.value; draw(); });
  $("#tf-league", root).addEventListener("change", (e) => { f.league = e.target.value; draw(); });
  $("#tf-coach", root).addEventListener("change", (e) => {
    const input = e.target.closest("input[type=checkbox]");
    if (!input) return;
    const id = Number(input.value);
    if (input.checked) f.coaches.add(id); else f.coaches.delete(id);
    $("#tf-coach-label", root).textContent = coachLabel();
    $("#tf-coach summary", root).title = coachLabel();
    $("#tf-coach-clear", root).disabled = !f.coaches.size;
    draw();
  });
  $("#tf-coach-clear", root).addEventListener("click", () => {
    f.coaches.clear();
    $$("#tf-coach input[type=checkbox]", root).forEach((input) => (input.checked = false));
    $("#tf-coach-label", root).textContent = coachLabel();
    $("#tf-coach summary", root).title = coachLabel();
    $("#tf-coach-clear", root).disabled = true;
    draw();
  });
  $("thead", root).addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    if (f.sort === th.dataset.sort) f.dir *= -1; else { f.sort = th.dataset.sort; f.dir = ["updated_at", "note_count", "market_value_eur"].includes(f.sort) ? -1 : 1; }
    $$("th", root).forEach((x) => { x.className = x.dataset.sort === f.sort ? "sorted" + (f.dir > 0 ? " asc" : "") : ""; });
    draw();
  });
  $("#t-body", root).addEventListener("click", (e) => { const tr = e.target.closest("tr[data-href]"); if (tr) location.hash = tr.dataset.href; });
  $("#t-csv", root).addEventListener("click", () => exportCsv(tableFiltered()));
}

function exportCsv(list) {
  const cols = ["name", "age", "birthdate", "position", "club", "league", "contract_expires", "market_value_display", "decision", "roles", "verdicts", "note_count", "tm_url"];
  const val = (p, k) => k === "roles" ? p.roles.map((r) => `${roleShort(r.role)} rank ${r.rank + 1}`).join("; ")
    : k === "verdicts" ? Object.entries(p.verdicts || {}).map(([n, v]) => `${n}: ${v}`).join("; ") : p[k] ?? "";
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
  setTitle(p.name);
  const counts = { pass: 0, hold: 0, fail: 0 };
  d.staff.forEach((s) => s.verdict && counts[s.verdict]++);
  const pending = d.staff.filter((s) => !s.verdict).length;
  const verdictMap = Object.fromEntries(d.staff.filter((s) => s.verdict).map((s) => [s.name, s.verdict]));

  main.innerHTML = `<div class="page">
    <button type="button" class="back" id="back">← Back</button>
    <section class="panel p-head">
      ${photo(p, "xl")}
      <div style="min-width:0">
        <div class="p-name-row"><h1>${esc(p.name)}</h1>${p.shirt_number ? `<span class="shirt">#${p.shirt_number}</span>` : ""}${decisionChip(p.decision, true)}</div>
        <div class="p-sub">${p.club_logo_url ? `<img class="club-logo" src="${esc(p.club_logo_url)}" alt="">` : ""}${esc([p.position, p.club, p.league].filter(Boolean).join(" · "))}</div>
        <dl class="facts">
          ${fact("Age", p.age != null ? `${p.age} <span class="muted">(${esc(fmtDate(p.birthdate))})</span>` : null, true)}
          ${fact("Height", p.height_cm ? `${p.height_cm} cm` : null)}
          ${fact("Foot", cap(p.foot))}
          ${fact("Citizenship", p.citizenship.join(", "))}
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
          ${S.me.is_admin ? `<button type="button" class="btn sm ghost danger" id="del-p">Delete</button>` : ""}
        </div>
      </div>
      <aside class="p-decision">
        <div class="lbl">Club decision</div>
        ${seg(p.decision, "decision")}
        <div class="muted sm">${p.decision ? `Set by ${esc(p.decision_by_name || "unknown")} · ${esc(relTime(p.decision_at))}` : "No decision yet"}</div>
        <div class="lbl" style="margin:6px 0 0">Staff verdicts</div>
        <div class="consensus">${["pass", "hold", "fail"].map((k) => `<span class="cons c-${k}"><b>${counts[k]}</b> ${cap(k)}</span>`).join("")}<span class="cons"><b>${pending}</b> Pending</span></div>
        ${verdictDots(verdictMap, true)}
      </aside>
    </section>

    <div class="p-grid">
      <div>
        <section class="panel"><header class="panel-h"><h2>Big board</h2></header>${rolesPanel(p)}</section>
        <section class="panel">
          <header class="panel-h"><h2>Summary</h2><span class="muted sm">Shared club summary</span></header>
          <textarea id="summary" rows="3" data-draft data-orig="${esc(p.summary || "")}" placeholder="Overall summary, fit, next steps…">${esc(p.summary || "")}</textarea>
          <div class="row end" style="margin-top:6px"><button type="button" class="btn sm" id="save-summary">Save summary</button></div>
        </section>
        ${p.impect_id ? `<section class="panel" id="kpi-panel"><header class="panel-h"><h2>Impect KPI profile</h2></header><div class="loading sm">Loading…</div></section>` : ""}
        <section class="panel"><header class="panel-h"><h2>Staff evaluations</h2></header><div class="evals">${d.staff.map(evalHTML).join("")}</div></section>
      </div>
      <div>
        ${p.tm_url ? "" : `<section class="panel" id="tm-panel"><header class="panel-h"><h2>Transfermarkt</h2></header><div class="loading sm">Searching Transfermarkt…</div></section>`}
        <section class="panel" id="phys-panel"><header class="panel-h"><h2>Physical data</h2></header><div class="loading sm">Loading…</div></section>
        <section class="panel" id="impect-panel"><header class="panel-h"><h2>Impect</h2></header><div class="loading sm">Loading…</div></section>
        ${d.lists.length ? `<section class="panel"><header class="panel-h"><h2>Lists</h2></header><div class="row">${d.lists.map((l) => `<span class="chip">${esc(l.name)}</span>`).join("")}</div></section>` : ""}
        <section class="panel"><header class="panel-h"><h2>History</h2></header><ul class="feed">${d.activity.map((a) => `<li><span><b>${esc(actor(a))}</b> ${describe(a, true)}</span><span class="when" title="${esc(fmtDateTime(a.created_at))}">${esc(relTime(a.created_at))}</span></li>`).join("") || `<li class="empty">No history yet.</li>`}</ul></section>
      </div>
    </div>
  </div>`;
  const root = main.firstElementChild;
  wirePlayer(root, d);
  if (p.impect_id) loadKpiPanel(root, p);
  if (!p.tm_url) loadTmPanel(root, p);
  loadPhysicalPanel(root, p);
  loadImpectPanel(root, p);
}

/* ---------- impect KPI profile ---------- */
function kpiComponent(m) {
  if (m.percentile == null) {
    return `<div class="bar"><span class="bl" title="${esc(m.definition || m.label)}">${esc(m.label)} <span class="raw">${m.value == null ? "no data" : esc(String(m.value)) + " · percentile unavailable"}</span></span><span class="track"></span><span class="bv">–</span></div>`;
  }
  const label = `${m.label}${m.inverted ? " ↓" : ""}`;
  return bar(label, Math.round(m.percentile), m.value, {
    format: fmtKpiNum,
    title: [label, m.meaning].filter(Boolean).join(" — "),
  });
}

function kpiCategory(c) {
  const pct = c.percentile == null ? null : Math.round(c.percentile);
  const parts = [...c.components].sort((x, y) => (y.percentile ?? -1) - (x.percentile ?? -1));
  return `<li><details>
    <summary><span class="kpi-name">${esc(c.name)}</span>
      <span class="kpi-bar"><span style="width:${pct ?? 0}%;background:${pct == null ? "var(--none)" : band(pct)}"></span></span>
      <b title="${esc(`Pooled: ${c.peer_count} valid peers`)}">${pct == null ? "\u2013" : pct}</b></summary>
    <p class="sm muted">Pooled benchmark: ${c.peer_count} valid peers.</p>
    <div class="bars">${parts.map(kpiComponent).join("")}</div>
  </details></li>`;
}

function loadKpiPanel(root, p) {
  const el = $("#kpi-panel", root);
  const head = (extra = "") => `<header class="panel-h"><h2>Impect KPI profile</h2>${extra}</header>`;
  const draw = async (iterationId, position) => {
    el.innerHTML = `${head()}<div class="loading sm">Scoring against the pooled positional benchmark…</div>`;
    let d;
    const qs = new URLSearchParams();
    if (iterationId) qs.set("iteration", iterationId);
    if (position) qs.set("position", position);
    const q = qs.toString();
    try { d = await api("GET", `/api/players/${p.id}/impect-kpis${q ? `?${q}` : ""}`); } catch (e) {
      el.innerHTML = `${head()}<div class="banner err sm">${esc(e.message)}</div>`;
      return;
    }
    const picker = (d.available_iterations || []).length > 1
      ? `<select id="kpi-it" aria-label="Season">${d.available_iterations.map((i) => `<option value="${i.id}" ${d.iteration?.id === i.id ? "selected" : ""}>${esc(i.competition)} ${esc(i.season)}</option>`).join("")}</select>`
      : "";
    if (d.empty) {
      el.innerHTML = `${head(picker)}<p class="empty">${esc(d.reason)}</p>`;
    } else {
      el.innerHTML = `${head(picker)}
        <p class="hint" style="margin:-4px 0 10px">${esc(d.position_label)} · ${esc(d.squad || "")} · ${d.minutes.toLocaleString()} min (${d.match_share} match shares).
          Pooled benchmark: <b>${d.peer_count}</b> ${esc(d.position_label.toLowerCase())}s across ${esc(d.benchmark_competitions.join(" + "))}, ${esc(d.iteration.season)}, with ${d.min_share_used}+ match shares at this position. Each KPI is standardised within its own league before pooling.</p>
        ${(d.positions || []).length > 1 ? `<div class="kpi-positions" role="group" aria-label="Position benchmarked">${d.positions.map((o) =>
          `<button type="button" class="${o.group === d.position ? "on" : ""}${o.eligible ? "" : " thin"}" data-kpi-pos="${esc(o.group)}" aria-pressed="${o.group === d.position}"
            title="${esc(o.impect_positions.map((x) => `${x.name.replace(/_/g, " ").toLowerCase()} ${x.match_share}`).join(", "))}${o.eligible ? "" : " (below the minimum)"}">${esc(o.label)} <span>${o.match_share}</span></button>`).join("")}</div>` : ""}
        ${!d.eligible ? `<p class="banner warn">Small sample: ${d.match_share} match shares (${d.minutes.toLocaleString()} min) at this position, below the ${d.min_share_used} required for the reference group. Percentiles are shown but are less reliable.</p>` : ""}
        ${d.missing_benchmark_competitions?.length ? `<p class="sm muted">Unavailable for this season: ${esc(d.missing_benchmark_competitions.join(", "))}.</p>` : ""}
        <ol class="kpi-list">${[...d.categories].sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1)).map(kpiCategory).join("")}</ol>
        <p class="sm muted" style="margin:8px 0 0">Bars show pooled percentiles, highest to lowest; expand a category for its metrics and valid peer count. Raw volume and threat values are Impect rates per match share; ratios and scores are shown as supplied. Equal-weight, direction-adjusted KPI z-scores fitted only on qualified peers; each KPI belongs to one category.
          A high percentile on a volume KPI means “more”, not necessarily “better”; ↓ marks KPIs where lower is favourable.
          Transfers count once in the reference, using their largest qualified league sample.
          Oldest reference fetch: ${esc(new Date(d.cohort_built_at).toLocaleString())}. Cached for up to 12 hours.</p>`;
    }
    $("#kpi-it", el)?.addEventListener("change", (e) => draw(e.target.value, null));
    el.querySelectorAll("[data-kpi-pos]").forEach((b) => b.addEventListener("click", () => draw(d.iteration?.id, b.dataset.kpiPos)));
  };
  draw();
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

function evalHTML(s) {
  const mine = s.user_id === S.me.id;
  return `<article class="eval ${mine ? "mine" : ""}">
    <header class="eval-h"><span class="avatar">${esc(s.name[0])}</span><b>${esc(s.name)}</b>${mine ? `<span class="you">You</span>` : ""}${mine ? seg(s.verdict, "verdict") : verdictChip(s.verdict)}</header>
    ${mine ? `<form class="note-form" id="note-form">
      <input name="context" id="nf-ctx" data-keep placeholder="Context, e.g. Live vs Richmond 9/12, video, trial" aria-label="Note context">
      <textarea name="body" id="nf-body" data-keep data-draft data-orig="" rows="3" placeholder="Add your notes on this player…" aria-label="Note"></textarea>
      <div class="row end"><button class="btn sm primary" type="submit">Add note</button></div></form>` : ""}
    <div class="notes">${s.notes.length ? s.notes.map((n) => noteHTML(n, mine)).join("") : `<p class="empty">${mine ? "No notes from you yet." : `No notes from ${esc(s.name)} yet.`}</p>`}</div>
  </article>`;
}

function noteHTML(n, mine) {
  return `<div class="note" data-note="${n.id}">
    ${n.context ? `<div class="note-ctx">${esc(n.context)}</div>` : ""}
    <div class="note-body">${esc(n.body)}</div>
    <div class="note-meta"><span title="${esc(fmtDateTime(n.created_at))}">${esc(relTime(n.created_at))}${n.updated_at !== n.created_at ? " · edited" : ""}</span>
      ${mine ? `<button type="button" data-note-edit="${n.id}">Edit</button><button type="button" data-note-del="${n.id}">Delete</button>` : ""}</div>
  </div>`;
}

function wirePlayer(root, d) {
  const p = d.player;
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t || t.closest("#phys-panel, #impect-panel")) return;
    try {
      if (t.id === "back") { if (history.length > 1) history.back(); else location.hash = "#/board"; return; }
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
      if (t.id === "save-summary") { await api("PATCH", `/api/players/${p.id}`, { summary: $("#summary", root).value }); toast("Summary saved"); return await afterMutation(); }
      if (t.id === "add-role-btn") {
        const role = $("#add-role-sel", root).value;
        if (!role) return;
        await api("POST", `/api/players/${p.id}/roles`, { role });
        return await afterMutation();
      }
      if (t.dataset.roleRm) { await api("DELETE", `/api/players/${p.id}/roles/${t.dataset.roleRm}`); return await afterMutation(); }
      if (t.dataset.roleMove) {
        const [role, dir] = t.dataset.roleMove.split(":");
        await api("POST", "/api/board/move", { player_id: p.id, from_role: role, to_role: role, index: rankIn(p, role) + Number(dir) });
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

function physCard(r, meta, open) {
  const pool = `${r.pool} ${GRP_NAME[r.grp] || r.grp}`;
  return `<details class="phys" ${open ? "open" : ""}>
    <summary><div style="min-width:0"><b>${esc(r.season)} · ${esc(r.team)}</b><div class="muted sm">${esc(r.league)} · ${esc(r.pos)} · ${r.mins} min${r.mp ? ` · ${r.mp} apps` : ""}</div></div>
      <span class="pct-pill" style="--c:${band(r.overall)}" title="Average percentile across all 14 metrics">${r.overall}</span></summary>
    <div class="inner">
      ${r.pool < 10 ? `<div class="banner warn sm">Only ${pool} in this pool, too few for percentiles to mean much.</div>`
        : r.pool < 20 ? `<div class="banner warn sm">Small pool (${pool}). Read the percentiles loosely.</div>`
        : `<div class="muted sm">Percentile vs ${pool} in ${esc(r.league)} ${esc(r.season)}</div>`}
      <div class="bars group">${GROUPS.map((g) => bar(g, r.groupsPct[g])).join("")}</div>
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
  const el = $("#phys-panel", root);
  let d;
  try { d = await api("GET", `/api/players/${p.id}/physical`); } catch (e) {
    el.innerHTML = `<header class="panel-h"><h2>Physical data</h2></header><p class="empty">Couldn't load physical data: ${esc(e.message)}</p>`;
    return;
  }
  const draw = (editing) => {
    const shown = new Set([...d.linked, ...d.candidates].map((r) => r.key));
    el.innerHTML = `<header class="panel-h"><h2>Physical data</h2>${d.linked.length && !d.confirmed ? `<span class="muted sm">Auto-matched</span>` : ""}
      <button type="button" class="btn sm ghost" data-phys-toggle>${editing ? "Cancel" : d.linked.length ? "Change" : "Link"}</button></header>
      ${editing ? `<p class="hint">Tick every season row that belongs to this player.</p>
          <div>${d.linked.map((r) => physCand(r, true)).join("")}${d.candidates.map((r) => physCand(r, false)).join("")}${!shown.size ? `<p class="empty">No name matches. Search below.</p>` : ""}</div>
          <input type="search" id="phys-q" placeholder="Search by name or team…" style="width:100%;margin-top:8px" aria-label="Search physical database">
          <div id="phys-res"></div>
          <div class="row end" style="margin-top:10px"><button type="button" class="btn sm primary" data-phys-save>Save links</button></div>`
        : d.linked.length ? d.linked.map((r, i) => physCard(r, d.meta, i === 0)).join("")
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
    ${x.pine_id ? `<a class="sm" href="#/player/${x.pine_id}">In PINE</a>` : `<button type="button" class="btn sm" data-imp-link="${x.impect_id}">Link</button>`}</div>`;
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
  </div>`;
  const root = main.firstElementChild;
  loadShortLists(root);
  loadTmMatch(root);

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
    try { return await api("POST", `/api/impect/shortlists/${encodeURIComponent(tr.dataset.sl)}/import`, { role: $("[data-sl-role]", tr).value || null }); }
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

/* ---------- activity + staff ---------- */
// Who did it. The backup script downloads with its own key, not as a staff member.
const actor = (a) => a.user || (a.action === "downloaded_backup" && /backup script/.test(a.detail || "") ? "Backup script" : "Someone");

function describe(a, onPlayerPage = false) {
  let d = {};
  try { d = a.detail ? JSON.parse(a.detail) : {}; } catch {}
  const who = onPlayerPage ? "this player" : a.player_id ? `<a href="#/player/${a.player_id}">${esc(a.player || "a player")}</a>` : esc(d.name || "a player");
  const chip = (v) => `<span class="dchip v-${esc(v)}">${esc(cap(v))}</span>`;
  switch (a.action) {
    case "added_player": return `added ${who}${d.list ? ` from the Impect list “${esc(d.list)}”` : d.source === "transfermarkt" ? " from Transfermarkt" : d.source === "impect" ? " from Impect" : ""}`;
    case "set_decision": return d.decision ? `set the club decision on ${who} to ${chip(d.decision)}` : `cleared the club decision on ${who}`;
    case "set_verdict": return d.verdict ? `marked ${who} ${chip(d.verdict)}` : `cleared their verdict on ${who}`;
    case "added_note": return `added a note on ${who}`;
    case "edited_note": return `edited a note on ${who}`;
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
    case "added_role": return `added ${who} to ${esc(roleLabel(d.role))}`;
    case "removed_role": return `removed ${who} from ${esc(roleLabel(d.role))}`;
    case "synced_tm": return `synced ${who} from Transfermarkt`;
    case "linked_tm": return `linked ${who} to Transfermarkt`;
    case "linked_physical": return `updated physical data links for ${who}`;
    case "linked_impect": return d.impect_id ? `linked ${who} to Impect` : `unlinked ${who} from Impect`;
    case "edited_player": return `edited details for ${who}`;
    case "deleted_player": return `deleted ${esc(d.name || "a player")}`;
    case "imported_list": return `imported the Impect list “${esc(d.name)}” (${d.created ?? 0} new)`;
    case "downloaded_backup": return d.via ? "saved its daily copy of the database" : "downloaded a copy of the database";
    case "edited_staff": return `updated staff member ${esc(d.name)}`;
    case "added_staff": return `added staff member ${esc(d.name)}`;
    case "created_signin_link": return `created a sign-in link for ${esc(d.name)}`;
    case "set_password": return "set their PINE password";
    default: return esc(String(a.action).replace(/_/g, " "));
  }
}

async function renderActivity(main) {
  main.innerHTML = `<div class="page" style="max-width:900px"><div class="page-h"><h1>Activity</h1></div><section class="panel"><ul class="feed" id="feed"><li class="loading">Loading…</li></ul></section></div>`;
  try {
    const { activity } = await api("GET", "/api/activity?limit=250");
    $("#feed").innerHTML = activity.map((a) => `<li><span class="avatar">${esc(actor(a)[0])}</span><span><b>${esc(actor(a))}</b> ${describe(a)}</span><span class="when" title="${esc(fmtDateTime(a.created_at))}">${esc(relTime(a.created_at))}</span></li>`).join("") || `<li class="empty">Nothing yet.</li>`;
  } catch (e) { $("#feed").innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
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
    <div class="page-h"><div><h1>Staff</h1><div class="sub">Everyone on this list gets their own evaluation section on every player. To let someone sign in, or to reset a forgotten password,
      click <b>Email sign-in link</b>: a Gmail draft opens, addressed to them with their link, and you press Send. They open the link, choose a password, and from then on sign in with their email and that password.
      A link works once and expires after 7 days.</div></div></div>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Name</th><th>Sign-in email</th><th>Sign-in</th><th>Admin</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr data-uid="${u.id}" data-has-password="${u.has_password ? 1 : 0}" style="cursor:default"><td><b>${esc(u.name)}</b></td>
        <td><input type="email" value="${esc(u.email || "")}" placeholder="Add an email to let ${esc(u.name)} sign in" style="width:260px" aria-label="${esc(u.name)} email"></td>
        <td>${signInStatus(u)}</td>
        <td><input type="checkbox" ${u.is_admin ? "checked" : ""} ${u.id === S.me.id ? "disabled" : ""} aria-label="${esc(u.name)} is admin"></td>
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
        await api("PATCH", `/api/users/${tr.dataset.uid}`, { email: $("input[type=email]", tr).value, is_admin: $("input[type=checkbox]", tr).checked });
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
}

// hashchange alone isn't enough: stepping back or forward between /p/7 and a #/view changes the
// path as well as the fragment, which is a popstate, not a hashchange. replaceState fires neither,
// so canonicalising the URL in render() can't loop back in here.
const onNavigate = () => {
  if (welcomeToken()) return showWelcome(welcomeToken());
  closeModal();
  render().then(() => scrollTo(0, 0));
};
window.addEventListener("hashchange", onNavigate);
window.addEventListener("popstate", onNavigate);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#modal")) closeModal();
  if (e.key === "/" && S.me && !e.target.matches("input, textarea, select") && !$("#modal")) { e.preventDefault(); $("#gs")?.focus(); }
});
// Pasting a Transfermarkt link anywhere on the page opens "Add player".
document.addEventListener("paste", (e) => {
  if (!S.me || e.target.matches?.("input, textarea") || $("#modal")) return;
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
    s.textContent = img.dataset.ini || "?";
    img.replaceWith(s);
  }
}, true);

boot();
