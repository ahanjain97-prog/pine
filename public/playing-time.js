// Small career timeline: all years stay visible; only real team fixtures create marks.
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const number = (n) => Math.round(n).toLocaleString();
const share = (n) => n == null ? "—" : `${Math.round(n)}%`;
const cache = new Map();
async function read(api, path) {
  const old = cache.get(path);
  if (old && Date.now() - old.at < 5 * 60 * 1000) return old.promise;
  const promise = api("GET", path).catch((e) => { cache.delete(path); throw e; });
  cache.set(path, { at: Date.now(), promise });
  while (cache.size > 150) cache.delete(cache.keys().next().value);
  return promise;
}

// Keep equal-width game marks apart in congested weeks, nudging dates only when needed.
export function fixturePositions(fractions, width) {
  const left = 3, right = Math.max(left, width - 3);
  const gap = Math.min(5, (right - left) / Math.max(1, fractions.length - 1));
  const xs = fractions.map((f) => Math.max(left, Math.min(right, f * width)));
  for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + gap);
  if (xs.length) xs[xs.length - 1] = Math.min(xs.at(-1), right);
  for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - gap);
  return xs;
}
function spaceFixtureMarks(chart) {
  const marks = [...chart.querySelectorAll("[data-time]")];
  const xs = fixturePositions(marks.map((m) => Number(m.dataset.time)), chart.getBoundingClientRect().width);
  marks.forEach((m, i) => m.setAttribute(m.tagName === "circle" ? "cx" : "x", m.tagName === "circle" ? xs[i] : xs[i] - 1.5));
}
if (typeof window !== "undefined") window.addEventListener("resize", () => document.querySelectorAll(".pt-chart").forEach(spaceFixtureMarks));

function timeline(team, season, color) {
  const games = team.fixtures;
  const startYear = Number(String(season).slice(0, 4));
  let start = Date.UTC(startYear, 0, 1), end = Date.UTC(startYear + 1, 0, 1);
  // Also contain cross-year seasons if these are added to the Impect subscription later.
  if (games.length && games.some((g) => Date.parse(g.date) < start || Date.parse(g.date) >= end)) {
    start = Date.UTC(new Date(games[0].date).getUTCFullYear(), new Date(games[0].date).getUTCMonth(), 1);
    const last = new Date(games.at(-1).date);
    end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1);
  }
  const height = 34, max = Math.max(110, ...games.map((g) => g.minutes || 0));
  const title = `${team.name}, ${season}: ${number(team.minutes)} minutes, ${share(team.share)} minute share`;
  const marks = games.map((g) => {
    const x = 2 + 96 * (Date.parse(g.date) - start) / (end - start);
    const date = new Date(g.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const label = `${date} · ${team.name} v ${g.opponent} · ${g.minutes == null ? "data unavailable" : `${number(g.minutes)} min`}`;
    const data = `data-time="${x / 100}" data-game="${escape(label)}"`;
    if (g.minutes == null) return `<circle cx="${x}%" cy="30" r="1.5" class="pt-unknown" ${data}><title>${escape(label)}</title></circle>`;
    const h = g.minutes > 0 ? Math.max(2, 26 * g.minutes / max) : 4;
    return `<rect x="${x}%" y="${30 - h}" width="3" height="${h}" class="${g.minutes > 0 ? "pt-played" : "pt-zero"}" ${data}><title>${escape(label)}</title></rect>`;
  }).join("");
  return `<svg class="pt-chart" role="img" aria-label="${escape(title)}" style="--pt-color:var(--pt-team-${color})" height="${height}">
    <title>${escape(title)}</title><desc>${escape(games.map((g) => `${new Date(g.date).toISOString().slice(0, 10)}: ${g.minutes == null ? "data unavailable" : `${number(g.minutes)} minutes`}`).join("; "))}</desc>
    <line x1="2%" x2="98%" y1="30" y2="30" class="pt-baseline"/>${marks}</svg>`;
}

export async function loadPlayingTimePanel(el, p, api) {
  const head = `<header class="panel-h"><h2>Playing time</h2><span class="sm muted">League · playoffs included</span></header>`;
  if (!p.impect_id) {
    el.innerHTML = `${head}<p class="empty">Link this player to Impect to see playing time.</p>`;
    return;
  }
  const base = `/api/players/${p.id}/playing-time`;
  let manifest;
  try { manifest = await read(api, base); } catch {
    el.innerHTML = `${head}<p class="empty">Playing time is unavailable. <button type="button" class="btn sm" data-pt-retry>Retry</button></p>`;
    el.querySelector("[data-pt-retry]").onclick = () => loadPlayingTimePanel(el, p, api);
    return;
  }
  if (!el.isConnected) return;
  if (!manifest.seasons.length) { el.innerHTML = `${head}<p class="empty">No covered league minutes.</p>`; return; }
  const seasons = new Map(), failed = new Set();
  const draw = () => {
    if (!el.isConnected) return;
    const teamIds = [...new Set([...seasons.values()].flatMap((s) => s.teams.map((t) => t.id)))];
    el.innerHTML = `${head}<div class="pt-months" aria-hidden="true"><span>Jan</span><span>Apr</span><span>Jul</span><span>Oct</span><span>Dec</span></div>
      <div class="pt-seasons">${manifest.seasons.map(({ season, covered }) => {
        const s = seasons.get(season);
        const missing = !covered || (s && !s.teams.length);
        return `<div class="pt-season"><div class="pt-year"><b>${escape(season)}</b>
          ${failed.has(season) ? `<span class="pt-message">Unavailable <button type="button" class="btn sm" data-pt-season="${escape(season)}">Retry</button></span>`
            : missing ? `<span class="pt-message">No covered match data</span>`
              : !s ? `<span class="pt-message">Loading…</span>` : ""}
          ${s?.teams.length ? `<span class="pt-total">${number(s.minutes)} min <span class="pt-share">· ${share(s.share)} share</span></span>` : ""}</div>
          ${(s?.teams || []).map((t) => `<div class="pt-lane"><span class="pt-team" title="${escape(`${t.name} · ${t.competition}`)}">${escape(t.name)}</span>
            <div class="pt-plot">${timeline(t, season, teamIds.indexOf(t.id) % 4)}</div>
            <span class="pt-team-total">${s.teams.length > 1 ? `${number(t.minutes)}′<span class="pt-share">${share(t.share)} share</span>` : ""}</span></div>`).join("")}</div>`;
      }).join("")}</div>
      <div class="pt-legend"><span><i class="pt-key played"></i>Minutes played</span><span><i class="pt-key zero"></i>Team played, 0 min</span><span>Blank = no game</span>
        ${[...seasons.values()].some((s) => s.teams.some((t) => t.fixtures.some((g) => g.minutes === null))) ? `<span>○ Data unavailable</span>` : ""}</div>
      <p class="pt-game-detail" aria-live="polite" hidden></p>`;
    el.querySelectorAll(".pt-chart").forEach(spaceFixtureMarks);
    el.querySelectorAll("[data-pt-season]").forEach((b) => b.onclick = () => load(b.dataset.ptSeason));
    el.querySelectorAll(".pt-chart").forEach((chart) => chart.addEventListener("click", (e) => {
      const mark = e.target.closest("[data-game]");
      if (!mark) return;
      const detail = el.querySelector(".pt-game-detail");
      detail.textContent = mark.dataset.game;
      detail.hidden = false;
    }));
  };
  const load = async (season) => {
    failed.delete(season);
    draw();
    try { seasons.set(season, await read(api, `${base}?season=${encodeURIComponent(season)}`)); }
    catch { failed.add(season); }
    draw();
  };
  draw();
  // Recent years appear first; navigation away stops queuing older downloads.
  for (const { season, covered } of manifest.seasons) {
    if (!el.isConnected) break;
    if (covered) await load(season);
  }
}
