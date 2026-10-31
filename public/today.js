// Fixtures only: current board membership is joined on the server; appearances aren't inferred.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ZONE = "America/New_York", HOUR = 60 * 60 * 1000;
export const easternDate = (time = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time));
const clock = (date) => new Date(date).toLocaleTimeString("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" });
const FINISHED = new Set(["FT", "AET", "PEN", "AWD", "WO"]);
const STARTED = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]);
let selectedDate = easternDate();
let followingToday = true;
export function fixtureGroup(status) {
  return STARTED.has(status) ? "In progress" : FINISHED.has(status) ? "Finished" : ["NS", "TBD"].includes(status) ? "Upcoming" : "Other fixtures";
}
function gameHtml(game) {
  const finished = FINISHED.has(game.status), scored = finished && game.goals.home != null && game.goals.away != null;
  const status = STARTED.has(game.status) ? "In progress" : finished ? game.status_label : game.status === "NS" ? "Kickoff" : game.status_label;
  return `<article class="sched-game" aria-label="${esc(game.home.name)} versus ${esc(game.away.name)}">
    <div class="sched-time"><b>${game.status === "TBD" ? "Time TBC" : esc(clock(game.date))}</b><span>${esc(status)}</span></div>
    <div class="sched-match"><div class="sched-league">${esc(game.league.name)}</div>
      <div class="sched-team"><span>${esc(game.home.name)}</span>${scored ? `<b>${game.goals.home}</b>` : ""}</div>
      <div class="sched-team"><span>${esc(game.away.name)}</span>${scored ? `<b>${game.goals.away}</b>` : ""}</div>
    </div>
    <div class="sched-roster"><div class="sched-roster-h">Board players · ${game.players.length}</div>
      <ul>${game.players.map((p) => `<li><a href="#/player/${p.id}"><b>${esc(p.name)}</b><span>${esc([p.position, p.club].filter(Boolean).join(" · "))}</span></a>
        <span class="sched-badge ${p.short_board ? "sched-short" : "sched-big"}">${p.short_board ? "★ Short Board" : "Big Board"}</span></li>`).join("")}</ul>
    </div>
  </article>`;
}
function resultsHtml(data) {
  if (!data.configured) return `<p class="empty">The schedule isn't connected yet. Connect an API-Football account to see games.</p>`;
  if (!data.total_players) return `<p class="empty">Add players to the <a href="#/board">Big Board</a> to see their teams' games here.</p>`;
  const warnings = data.warnings.map((message) => `<div class="banner warn">${esc(message)}</div>`).join("");
  const groups = ["In progress", "Upcoming", "Finished", "Other fixtures"];
  const games = groups.map((group) => {
    const rows = data.games.filter((game) => fixtureGroup(game.status) === group);
    return rows.length ? `<section class="sched-section"><h2>${group} <span>${rows.length} ${rows.length === 1 ? "game" : "games"}</span></h2>${rows.map(gameHtml).join("")}</section>` : "";
  }).join("");
  const empty = data.warnings.length ? "The schedule is unavailable or incomplete. Try again later."
    : data.unmatched.length ? "No games found for the matched clubs. Some players still need matching below."
      : "No games scheduled for your board players' teams on this day.";
  const unmatched = data.unmatched.length ? `<details class="sched-unmatched"><summary>${data.unmatched.length} ${data.unmatched.length === 1 ? "player needs" : "players need"} club or competition matching</summary>
    <ul>${data.unmatched.map((p) => `<li><a href="#/player/${p.id}">${esc(p.name)}</a><span>${esc(p.club || "No club")} · ${esc(p.reason)}</span></li>`).join("")}</ul></details>` : "";
  return `${warnings}${data.stale ? '<div class="banner info">Showing a saved schedule while the provider is unavailable. Results may be out of date.</div>' : ""}
    ${games || `<p class="empty">${empty}</p>`}${unmatched}
    <div class="sched-footer"><span>Players are listed by current club; appearances aren't verified.</span><span>★ Short Board players are also on the Big Board.</span></div>`;
}

export async function loadToday(main, api) {
  if (followingToday) selectedDate = easternDate();
  main.className = "page schedule";
  const boundary = (days) => new Date(Date.parse(easternDate() + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  main.innerHTML = `<div id="schedule-view">
    <div class="page-h"><div><h1>Today</h1><div class="sub">Games featuring players on your Big Board and Short Board.</div></div></div>
    <div class="sched-toolbar"><div class="sched-dates">
      <button type="button" class="btn sched-arrow" data-sched-shift="-1" aria-label="Previous day">‹</button>
      <input type="date" aria-label="Match date" data-sched-date value="${selectedDate}" min="${boundary(-366)}" max="${boundary(366)}">
      <button type="button" class="btn sched-arrow" data-sched-shift="1" aria-label="Next day">›</button>
      <button type="button" class="btn" data-sched-today>Today</button></div><span class="muted sm">All times Eastern (ET)</span></div>
    <div class="sched-summary"><div data-sched-count aria-live="polite"></div><div class="sched-legend"><span class="sched-badge sched-short">★ Short Board</span><span class="sched-badge sched-big">Big Board</span></div></div>
    <div class="sched-freshness muted sm" data-sched-updated></div>
    <div data-sched-results><div class="loading">Loading schedule…</div></div>
  </div>`;
  const root = main.querySelector("#schedule-view"), input = root.querySelector("[data-sched-date]");
  const results = root.querySelector("[data-sched-results]"), count = root.querySelector("[data-sched-count]"), updated = root.querySelector("[data-sched-updated]");
  let request = 0;
  async function load() {
    if (!root.isConnected) return;
    const serial = ++request;
    input.value = selectedDate;
    root.querySelectorAll("[data-sched-shift]").forEach((button) => {
      button.disabled = Number(button.dataset.schedShift) < 0 ? selectedDate <= input.min : selectedDate >= input.max;
    });
    results.innerHTML = '<div class="loading">Loading schedule…</div>'; count.textContent = ""; updated.textContent = "";
    try {
      const data = await api("GET", `/api/schedule?date=${encodeURIComponent(selectedDate)}`);
      if (!root.isConnected || serial !== request) return;
      const players = [...new Map(data.games.flatMap((game) => game.players).map((p) => [p.id, p])).values()];
      const day = new Date(data.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: ZONE });
      count.innerHTML = `<b>${esc(day)}</b> · <b>${data.games.length}</b> ${data.games.length === 1 ? "game" : "games"} · <b>${players.length}</b> board players · <b>${players.filter((p) => p.short_board).length}</b> Short Board`;
      updated.textContent = data.updated_at ? `${data.stale ? "Saved" : "Fixtures updated"} ${new Date(data.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: ZONE })} at ${clock(data.updated_at)} ET · Updates at most hourly` : "Updates at most hourly";
      results.innerHTML = resultsHtml(data);
    } catch (error) {
      if (!root.isConnected || serial !== request) return;
      results.innerHTML = `<div class="banner err">Couldn't load the schedule: ${esc(error.message)}</div>`;
    }
  }
  root.querySelectorAll("[data-sched-shift]").forEach((button) => button.addEventListener("click", () => {
    const date = new Date(selectedDate + "T12:00:00Z"); date.setUTCDate(date.getUTCDate() + Number(button.dataset.schedShift));
    selectedDate = date.toISOString().slice(0, 10); followingToday = selectedDate === easternDate(); load();
  }));
  root.querySelector("[data-sched-today]").addEventListener("click", () => { selectedDate = easternDate(); followingToday = true; load(); });
  input.addEventListener("change", () => { if (input.value && input.validity.valid) { selectedDate = input.value; followingToday = selectedDate === easternDate(); load(); } else input.value = selectedDate; });
  // No score/lineup polling. A visible schedule checks the shared server cache once an hour.
  const tick = () => setTimeout(async () => {
    if (!root.isConnected) return;
    if (!document.hidden) { if (followingToday) selectedDate = easternDate(); await load(); }
    tick();
  }, HOUR);
  tick();
  await load();
}
