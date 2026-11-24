// The Options tab: every end-of-season roster decision the clubs have announced, club by club, with the
// releases they came in and which clubs haven't posted yet. Players PINE follows open their profile; the rest show
// the release and an Add button. The list itself never lives in the repository (see src/lib/roster_decisions.js).

export const LEAGUE_NAMES = { USLC: "USL Championship", USL1: "USL League One", MLSNP: "MLS Next Pro", MLS: "MLS" };
const LEAGUE_SHORT = { USLC: "USLC", USL1: "USL1", MLSNP: "Next Pro", MLS: "MLS" };
// How each decision reads, and its colour family: fa (makes a free agent), talk, stay, out (left the roster another way).
export const DECISION = {
  option_declined: ["Option declined", "fa"], out_of_contract: ["Out of contract", "fa"], negotiating: ["In talks", "talk"],
  option_pending: ["Option pending", "talk"], option_exercised: ["Option picked up", "stay"], guaranteed_contract: ["Under contract", "stay"],
  signed: ["Signed", "stay"], transfer: ["Transferred", "out"], loan_out: ["Loaned out", "out"], loan_in: ["Loaned in", "stay"], other: ["Other", "out"],
};
const ORDER = Object.keys(DECISION);
// Impect's position groups (the KPI profile's), in pitch order; a release's GK/D/M/F stands in when Impect has none.
export const POS_GROUPS = [["GK", "GK"], ["CB", "CB"], ["FB", "FB"], ["MID", "DM/CM"], ["AM", "AM"], ["W", "W"], ["ST", "ST"]];
const FROM_RELEASE = { GK: ["GK"], D: ["CB", "FB"], M: ["MID", "AM"], F: ["W", "ST"] };
export const groupsOf = (d) => (d.position_group ? [d.position_group] : FROM_RELEASE[String(d.position || "").toUpperCase()] || []);
export const DEFAULT_TAGS = { good_minutes: 1000, good_data: 60 };
export const goodMinutes = (d, t = DEFAULT_TAGS) => (d.minutes ?? 0) >= t.good_minutes;
export const goodData = (d, t = DEFAULT_TAGS) => d.data_pct != null && d.data_pct >= t.good_data;
const POSITION_TEXT = { GK: "Goalkeeper", D: "Defender", M: "Midfielder", F: "Forward" };
const PINE_LEAGUE = { USLC: "USLC", USL1: "USL1", MLSNP: "MLS Next Pro", MLS: "MLS" };
const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const webLink = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);
const day = (iso) => {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

// The decisions the filters keep, grouped by club, newest club news first.
export function groupDecisions(decisions, releases, f, inPine, tags = DEFAULT_TAGS) {
  const q = fold(f.q).trim();
  const keep = decisions.filter((d) => (!f.league || (d.league || "other") === f.league)
    && (f.show !== "fa" || d.free_agent)
    && (!f.pine || (f.pine === "in") === inPine(d))
    && (!f.pos || groupsOf(d).includes(f.pos))
    && (!f.goodMin || goodMinutes(d, tags))
    && (!f.goodData || goodData(d, tags))
    && (!q || fold(d.name).includes(q) || fold(d.club).includes(q)));
  const byClub = new Map();
  for (const d of keep) {
    if (!byClub.has(d.club)) byClub.set(d.club, { club: d.club, league: d.league, rows: [], latest: "" });
    const g = byClub.get(d.club);
    g.rows.push(d);
    if ((d.announced || "") > g.latest) g.latest = d.announced || "";
  }
  for (const r of releases) { const g = byClub.get(r.club); if (g && (r.published || "") > g.latest) g.latest = r.published || ""; }
  const groups = [...byClub.values()];
  for (const g of groups) g.rows.sort((a, b) => ORDER.indexOf(a.decision) - ORDER.indexOf(b.decision) || a.name.localeCompare(b.name));
  return groups.sort((a, b) => b.latest.localeCompare(a.latest) || a.club.localeCompare(b.club));
}

export function renderOptions(main, ctx) {
  const { api, esc, photo, nameWithMark, openAddPlayer, toast, oops, setOptionsBadge, players, byId, isAdmin, modal, closeModal, afterAdd } = ctx;
  const f = (ctx.state.optFilter ||= { league: "", show: "", pine: "", pos: "", goodMin: false, goodData: false, q: "" });
  main.innerHTML = `<div class="page"><div class="page-h"><div><h1>Options</h1><div class="sub">Loading the clubs' roster decisions…</div></div></div></div>`;
  let data;
  const load = async () => {
    try { data = await api("GET", "/api/options"); } catch (e) { oops(e); return; }
    draw();
    // Opening the tab clears the badge: everything up to the newest release counts as seen.
    const top = Math.max(0, ...data.releases.filter((r) => r.alert).map((r) => r.id));
    if (top > data.last_read) api("POST", "/api/options/read", { release_id: top }).then((r) => setOptionsBadge(r.options?.n || 0, r.options?.recent)).catch(() => {});
  };

  const pineName = new Map(players().map((p) => [fold(p.name), p]));
  const inPine = (d) => d.player_id != null && byId().has(d.player_id);

  function watchLine(w) {
    if (!w?.enabled) return `<span class="muted">The club-site watcher is off on this copy of PINE.</span>`;
    if (!w.last_run) return `<span class="muted">${w.running ? "Checking the club sites now…" : "The first check of the club sites runs shortly."}</span>`;
    const failed = w.failed?.length ? ` · <details class="opt-failed"><summary>${w.failed.length} didn't load</summary><ul>${w.failed.map((x) =>
      `<li>${esc(x.club)} <span class="muted">${esc(x.error)}</span></li>`).join("")}</ul></details>` : "";
    return `<span>Checked ${w.feeds} club news pages ${esc(ctx.relTime(w.last_run))}</span>${failed}${w.note ? `<div class="opt-note">${esc(w.note)}</div>` : ""}`;
  }
  function impectLine(i) {
    if (!i?.configured) return "";
    if (i.running) return `<div class="opt-note-i">Linking players to Impect…</div>`;
    if (i.error) return `<div class="opt-note-i warn">Impect linking failed: ${esc(i.error)}</div>`;
    const linked = data.decisions.filter((d) => d.impect_id).length;
    return `<div class="opt-note-i">${linked} of ${data.decisions.length} players linked to Impect${i.last_run ? ` · ${esc(ctx.relTime(i.last_run))}` : ""}${
      isAdmin() ? ` <button type="button" class="linkish" id="opt-relink">Relink now</button>` : ""}</div>`;
  }
  const releaseLink = (r, label) => webLink(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(label ?? r.title)} <span aria-hidden="true">↗</span></a>` : esc(label ?? r.title);
  const leagueTag = (lg) => `<span class="opt-lg lg-${esc(lg || "other")}">${esc(LEAGUE_SHORT[lg] || "Other")}</span>`;

  function cover() {
    return `<div class="opt-cover">${["USLC", "USL1", "MLSNP"].map((lg) => {
      const clubs = data.clubs.filter((c) => c.league === lg);
      const posted = clubs.filter((c) => c.status === "posted").length;
      return `<section class="panel opt-cov"><div class="lbl">${esc(LEAGUE_NAMES[lg])}</div>
        <div class="opt-cov-n"><b>${posted}</b> of ${clubs.length} clubs have posted decisions</div>
        <div class="opt-cov-clubs">${clubs.map((c) => `<button type="button" class="opt-chip s-${c.status}" data-club="${esc(c.club)}" title="${esc(c.club)}: ${
          c.status === "posted" ? "decisions posted" : c.status === "moves" ? "single moves only so far" : "nothing yet"}">${esc(c.club)}</button>`).join("")}</div></section>`;
    }).join("")}</div>`;
  }

  const tagsHtml = (d) => `${goodMinutes(d, data.tags) ? `<span class="opt-tag t-min" title="${(d.minutes || 0).toLocaleString()} league minutes this season">${Math.floor(d.minutes / 100) * 100 >= 1000 ? `${(Math.floor(d.minutes / 100) * 100).toLocaleString()}+ min` : "Minutes"}</span>` : ""}${
    goodData(d, data.tags) ? `<span class="opt-tag t-data" title="Impect KPI profile: ${d.data_pct}th percentile on average across his position's categories">Data ${d.data_pct}</span>` : ""}`;
  // Everyone links somewhere: his PINE profile, else his Impect profile (a pop-up), else the release.
  function playerCell(d) {
    const p = inPine(d) ? byId().get(d.player_id) : null;
    if (p) return `<a class="opt-p" href="#/player/${p.id}">${photo(p)}<span class="ci"><span class="name-line">${nameWithMark(p)}${tagsHtml(d)}</span><div class="csub">${esc(p.club || "")}</div></span></a>`;
    const twin = pineName.get(fold(d.name));
    const sub = twin ? `Not linked · PINE has <a href="#/player/${twin.id}">${esc(twin.name)}</a>${twin.club ? ` (${esc(twin.club)})` : ""}`
      : d.impect_id ? `Not in PINE · Impect${d.impect_squad ? `: ${esc(d.impect_squad)}` : ""}` : "Not in PINE · no Impect match yet";
    const name = d.impect_id ? `<button type="button" class="linkish nm" data-imp="${d.id}">${esc(d.name)}</button>`
      : webLink(d.source_url) ? `<a class="nm" href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">${esc(d.name)}</a>` : `<span class="nm">${esc(d.name)}</span>`;
    return `<span class="opt-p">${photo({ name: d.name })}<span class="ci"><span class="name-line">${name}${tagsHtml(d)}</span><div class="csub">${sub}</div></span></span>`;
  }
  const posLabel = (d) => d.position_group ? (POS_GROUPS.find(([k]) => k === d.position_group)?.[1] || d.position_group) : (d.position || "");
  function row(d) {
    const [label, kind] = DECISION[d.decision] || [d.decision, "out"];
    const p = inPine(d), add = !p && !pineName.has(fold(d.name));
    return `<tr class="${p ? "in-pine" : "not-pine"}"><td>${playerCell(d)}</td><td class="opt-pos">${esc(posLabel(d))}</td>
      <td><span class="opt-dec k-${kind}" title="${esc(d.decision_raw || label)}">${esc(label)}</span>${d.free_agent && !p ? ` <span class="fa-mark" title="Free agent">FA</span>` : ""}${d.in_talks ? ` <span class="opt-talks">in talks</span>` : ""}${
        d.notes ? ` <span class="opt-info" title="${esc(d.notes)}" aria-label="Note: ${esc(d.notes)}">i</span>` : ""}</td>
      <td class="opt-num ${goodMinutes(d, data.tags) ? "good" : ""}">${d.minutes != null ? d.minutes.toLocaleString() : ""}</td>
      <td class="opt-num ${goodData(d, data.tags) ? "good" : ""}">${d.data_pct != null ? d.data_pct : ""}</td>
      <td class="opt-date">${esc(day(d.announced))}</td>
      <td class="opt-act">${webLink(d.source_url) ? `<a class="opt-src" href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Release <span aria-hidden="true">↗</span></a>` : ""}${
        add ? `<button type="button" class="btn sm" data-add="${d.id}" ${d.impect_id ? 'title="Adds him from Impect, with his full profile"' : ""}>+ Add</button>` : ""}</td></tr>`;
  }
  function clubBlock(g) {
    const n = (k) => g.rows.filter((d) => DECISION[d.decision]?.[1] === k).length;
    const counts = [["fa", "free agent", "free agents"], ["talk", "in talks", "in talks"], ["stay", "staying", "staying"], ["out", "other move", "other moves"]]
      .map(([k, one, many]) => n(k) ? `${n(k)} ${n(k) === 1 ? one : many}` : "").filter(Boolean).join(" · ");
    const rel = data.releases.filter((r) => r.club === g.club && webLink(r.url));
    return `<section class="panel opt-club"><header class="opt-club-h"><h3>${esc(g.club)}</h3>${leagueTag(g.league)}<span class="muted opt-counts">${counts}</span>
        <span class="opt-links">${rel.slice(0, 3).map((r) => releaseLink(r, r.published ? `Release · ${day(r.published)}` : "Release")).join("")}</span></header>
      <div class="table-wrap"><table class="grid opt-table"><thead><tr><th>Player</th><th>Pos</th><th>Decision</th><th title="League minutes this season (Impect)">Min</th><th title="Impect KPI profile: average percentile across his position's categories">Data</th><th>Date</th><th></th></tr></thead>
      <tbody>${g.rows.map(row).join("")}</tbody></table></div></section>`;
  }
  function list() {
    const groups = groupDecisions(data.decisions, data.releases, f, inPine, data.tags);
    const n = groups.reduce((s, g) => s + g.rows.length, 0);
    return `<div class="opt-count muted">${n} decision${n === 1 ? "" : "s"} from ${groups.length} club${groups.length === 1 ? "" : "s"}</div>${
      groups.length ? groups.map(clubBlock).join("") : `<div class="panel empty">No decisions match. ${data.decisions.length ? "Try clearing the filters." : "Decisions appear here once the research upload has run."}</div>`}`;
  }
  function releasesTable() {
    if (!data.releases.length) return "";
    return `<section class="panel opt-releases"><h2>Releases</h2><div class="table-wrap"><table class="grid"><thead><tr><th>Date</th><th>League</th><th>Club</th><th>Release</th><th>Found by</th></tr></thead><tbody>${
      data.releases.map((r) => `<tr class="${r.alert && r.id > data.last_read ? "is-new" : ""}"><td class="opt-date">${esc(day(r.published || r.found_at))}</td><td>${leagueTag(r.league)}</td>
        <td>${esc(r.club)}${r.alert && r.id > data.last_read ? ` <span class="opt-new-pill">New</span>` : ""}</td><td>${releaseLink(r)}</td>
        <td class="muted">${r.source === "upload" ? "Research upload" : "Club site"}</td></tr>`).join("")}</tbody></table></div></section>`;
  }
  const seg = (id, opts, cur) => `<div class="seg" id="${id}">${opts.map(([k, l]) => `<button type="button" data-k="${k}" class="${cur === k ? "on" : ""}">${l}</button>`).join("")}</div>`;

  function draw() {
    const fresh = data.releases.filter((r) => r.alert && r.id > data.last_read);
    main.innerHTML = `<div class="page opt-page">
      <div class="page-h"><div><h1>Options</h1><div class="sub">End-of-${data.season}-season roster decisions from the clubs' own releases: USL Championship, USL League One and MLS Next Pro (with the MLS first-team releases that carry Next Pro players).</div></div>
        <div class="spacer"></div><div class="opt-watch">${watchLine(data.watch)}${isAdmin() ? ` <button type="button" class="btn sm" id="opt-check">Check club sites now</button>` : ""}${impectLine(data.impect)}</div></div>
      ${fresh.length ? `<section class="panel opt-fresh"><h2>New since you last looked</h2><ul>${fresh.map((r) => `<li>${leagueTag(r.league)} <b>${esc(r.club)}</b> ${releaseLink(r)}${r.published ? ` <span class="muted">${esc(day(r.published))}</span>` : ""}</li>`).join("")}</ul></section>` : ""}
      ${cover()}
      <div class="opt-filters">
        ${seg("of-league", [["", "All"], ["USLC", "Championship"], ["USL1", "League One"], ["MLSNP", "Next Pro"], ["MLS", "MLS"]], f.league)}
        ${seg("of-show", [["", "All decisions"], ["fa", "Free agents"]], f.show)}
        ${seg("of-pine", [["", "Everyone"], ["in", "In PINE"], ["out", "Not in PINE"]], f.pine)}
        ${seg("of-pos", [["", "All positions"], ...POS_GROUPS], f.pos)}
        <div class="seg" id="of-tags" role="group" aria-label="Tags"><button type="button" data-t="goodMin" class="${f.goodMin ? "on" : ""}" title="${data.tags.good_minutes.toLocaleString()}+ league minutes this season">Good minutes</button><button type="button" data-t="goodData" class="${f.goodData ? "on" : ""}" title="Impect KPI profile at or above the ${data.tags.good_data}th percentile on average">Good data</button></div>
        <input id="of-q" type="search" placeholder="Find a player or club…" value="${esc(f.q)}" aria-label="Find a player or club">
      </div>
      <div id="opt-list">${list()}</div>
      ${releasesTable()}
    </div>`;
    const root = main.firstElementChild;
    const redraw = () => { root.querySelector("#opt-list").innerHTML = list(); };
    root.querySelector("#of-tags").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-t]");
      if (!b) return;
      f[b.dataset.t] = !f[b.dataset.t];
      b.classList.toggle("on", f[b.dataset.t]);
      redraw();
    });
    for (const [id, key] of [["of-league", "league"], ["of-show", "show"], ["of-pine", "pine"], ["of-pos", "pos"]]) {
      root.querySelector(`#${id}`).addEventListener("click", (e) => {
        const b = e.target.closest("button[data-k]");
        if (!b) return;
        f[key] = b.dataset.k;
        root.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b));
        redraw();
      });
    }
    const q = root.querySelector("#of-q");
    q.addEventListener("input", () => { f.q = q.value; redraw(); });
    root.querySelector(".opt-cover").addEventListener("click", (e) => {
      const b = e.target.closest("[data-club]");
      if (!b) return;
      f.q = f.q === b.dataset.club ? "" : b.dataset.club; q.value = f.q; f.league = ""; f.show = ""; f.pine = ""; f.pos = ""; f.goodMin = false; f.goodData = false;
      root.querySelectorAll(".opt-filters .seg button").forEach((x) => x.classList.toggle("on", x.dataset.k === ""));
      redraw();
      root.querySelector("#opt-list").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    root.querySelector("#opt-list").addEventListener("click", (e) => {
      const imp = e.target.closest("[data-imp]");
      if (imp) { const d = data.decisions.find((x) => x.id === Number(imp.dataset.imp)); if (d) impectCard(d); return; }
      const b = e.target.closest("[data-add]");
      if (!b) return;
      const d = data.decisions.find((x) => x.id === Number(b.dataset.add));
      if (d) addPlayer(d, b);
    });
    root.querySelector("#opt-relink")?.addEventListener("click", async () => {
      try { await api("POST", "/api/options/impect", {}); toast("Linking players to Impect in the background; this takes a few minutes"); await load(); } catch (err) { oops(err); }
    });
    root.querySelector("#opt-check")?.addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Checking…";
      try { const r = await api("POST", "/api/options/check", {}); toast(r.found ? `Found ${r.found} new release${r.found === 1 ? "" : "s"}` : "No new releases"); await load(); }
      catch (err) { oops(err); e.target.disabled = false; e.target.textContent = "Check club sites now"; }
    });
  }
  // From Impect when he's matched (the full profile, like the Impect tab), else the prefilled manual form.
  async function addPlayer(d, btn) {
    if (!d.impect_id) {
      openAddPlayer({ prefill: { name: d.name, club: d.club, league: PINE_LEAGUE[d.league] || "", position: POSITION_TEXT[d.position] || d.position || "" } });
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    try {
      const r = await api("POST", "/api/players", { impect_id: d.impect_id });
      closeModal();
      toast(`${r.player?.name || d.name} added to PINE`);
      await afterAdd();
      await load();
    } catch (err) {
      if (err.status === 409) { toast("Already in PINE"); await afterAdd(); await load(); }
      else { oops(err); if (btn) { btn.disabled = false; btn.textContent = "+ Add"; } }
    }
  }

  // His Impect profile in a pop-up: this season's position, minutes and category percentiles.
  async function impectCard(d) {
    const m = modal(`<header class="m-h"><h2>${esc(d.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
      <div class="opt-imp"><div class="loading sm">Loading his Impect profile…</div></div>`, { wide: true });
    const body = m.querySelector(".opt-imp");
    let k;
    try { k = await api("GET", `/api/impect/players/${d.impect_id}/kpis${d.iteration_id ? `?iteration=${d.iteration_id}` : ""}`); }
    catch (err) { body.innerHTML = `<div class="banner err sm">${esc(err.message)}</div>`; return; }
    if (!body.isConnected) return;
    const [label] = DECISION[d.decision] || [d.decision];
    const head = `<div class="opt-imp-h"><span class="opt-dec k-${(DECISION[d.decision] || [])[1] || "out"}">${esc(label)}</span> <b>${esc(d.club)}</b>
      ${webLink(d.source_url) ? `<a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Release ↗</a>` : ""}<span class="opt-imp-tags">${tagsHtml(d)}</span></div>`;
    const cats = (k.categories || []).filter((c) => Number.isFinite(c.percentile));
    body.innerHTML = k.empty ? `${head}<p class="empty">${esc(k.reason || "No Impect season data.")}</p>` : `${head}
      <div class="kpi-ctx"><b>${esc([k.position_label, k.squad, `${(k.minutes || 0).toLocaleString()} min`].filter(Boolean).join(" · "))}</b>
        <span class="muted">${esc(k.iteration?.competition || "")} ${esc(k.iteration?.season || "")} · vs ${k.peer_count} ${esc(String(k.position_label || "").toLowerCase())}s in ${esc((k.benchmark_competitions || []).join(", "))}</span></div>
      ${cats.length ? `<div class="opt-imp-cats">${cats.map((c) => `<div class="opt-imp-cat${c.composite ? " comp" : ""}"><span class="opt-imp-l" title="${esc(c.description || "")}">${esc(c.label || c.name)}</span>
        <span class="opt-imp-bar"><span style="width:${Math.max(2, Math.min(100, c.percentile))}%" class="${c.percentile >= 60 ? "hi" : c.percentile < 40 ? "lo" : ""}"></span></span><span class="opt-imp-n">${Math.round(c.percentile)}</span></div>`).join("")}</div>`
        : `<p class="empty">Not enough minutes at one position this season to rank him.</p>`}
      <p class="hint">Percentiles against the pooled USL Championship, League One and Next Pro benchmark at his position, scored like the KPI profile on a player page.</p>`;
    body.insertAdjacentHTML("beforeend", inPine(d) ? "" : `<div class="m-actions"><button type="button" class="btn primary" data-imp-add>+ Add to PINE from Impect</button></div>`);
    body.querySelector("[data-imp-add]")?.addEventListener("click", (e) => addPlayer(d, e.target));
  }

  return load();
}
