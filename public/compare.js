import { matchText } from './search.js';
import { finite, pct, positionGroup, parseComparison, comparisonPath, mergeRows, gap, orderRows, choosePair,
  kpiComparable, kpiRows, physicalComparable, physicalRows, scoutingComparable, scoutingRows } from './comparison-data.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = v => finite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : 'Unavailable';
const date = v => v ? new Date(v.replace(' ', 'T') + (/Z$|\+\d\d:\d\d$/.test(v) ? '' : 'Z')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date';
const mark = i => `<span class="cmp-symbol cmp-${i}" aria-hidden="true">${i ? '◆' : '●'}</span>`;
const option = (value, label, selected) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
const select = (id, label, options, selected) => `<label><span>${esc(label)}</span><select id="${id}">${selected && !options.some(o => String(o.key) === String(selected)) ? option(selected, 'Selection unavailable', selected) : ''}${options.map(o => option(o.key, o.label, selected)).join('')}</select></label>`;
const settled = r => r.status === 'fulfilled' ? { data: r.value } : { error: r.reason.message };
const sideValue = r => `<span class="cmp-value">${r?.rare ? 'Rare' : pct(r?.percentile) == null ? '<span class="cmp-na">Unavailable</span>' : `${num(r.percentile)}<small class="cmp-pct-unit">pct</small>`}${finite(r?.value) ? `<small>raw ${num(r.value)}</small>` : ''}${r?.outlook ? `<small>Likely ${num(r.outlook.expected)}<br>range ${num(r.outlook.low)}–${num(r.outlook.high)}</small>` : ''}</span>`;
function chart(row) {
  const a = pct(row.a?.percentile), b = pct(row.b?.percentile);
  return `<span class="cmp-track" aria-hidden="true"><i class="cmp-mid"></i>${a != null && b != null ? `<i class="cmp-bridge" style="left:${Math.min(a, b)}%;width:${Math.abs(a - b)}%"></i>` : ''}${[a, b].map((p, i) => {
    const o = row[i ? 'b' : 'a']?.outlook;
    return `${o && finite(o.low) && finite(o.high) ? `<i class="cmp-range cmp-${i}" style="left:${Math.max(0, o.low)}%;width:${Math.min(100, o.high) - Math.max(0, o.low)}%"></i>` : ''}${p == null ? '' : `<i class="cmp-dot cmp-${i}" style="left:${p}%"></i>`}`;
  }).join('')}</span>`;
}
function rowHTML(row, comparable, detail = false) {
  const delta = gap(row, comparable);
  const notes = [...new Set([row.a?.note, row.b?.note].filter(Boolean))];
  const cells = `<span class="cmp-metric"><b>${esc(row.label)}</b>${detail ? '' : `<small>${esc(row.group)}</small>`}${notes.length ? `<small>${esc(notes.join(' · '))}</small>` : ''}</span>
    <span class="cmp-number cmp-0"><span class="sr-only">Player A: </span>${sideValue(row.a)}</span>${chart(row)}<span class="cmp-number cmp-1"><span class="sr-only">Player B: </span>${sideValue(row.b)}</span>
    <span class="cmp-gap ${delta > 0 ? 'cmp-0' : delta < 0 ? 'cmp-1' : ''}" title="${delta == null ? 'No comparable percentile gap' : 'Difference in percentile points; higher is not always better'}">${delta == null ? '—' : delta === 0 ? 'Same' : `${delta > 0 ? 'A' : 'B'} +${num(Math.round(Math.abs(delta) * 10) / 10)}`}</span>`;
  const children = mergeRows(row.a?.children, row.b?.children);
  return children.length ? `<details class="cmp-item"><summary class="cmp-row">${cells}<span class="cmp-chevron" aria-hidden="true">⌄</span></summary>
    <div class="cmp-detail">${row.description ? `<p>${esc(row.description)}</p>` : ''}<p class="muted sm">Raw values and existing percentiles. ↓ means lower raw values are better; the percentile already accounts for this. Volume means more, not necessarily better.</p>${children.map(r => rowHTML(r, comparable, true)).join('')}</div></details>`
    : `<div class="cmp-item cmp-row">${cells}<span></span></div>`;
}
function tableHTML(rows, comparable, state, players, explanation) {
  const grouped = [...new Set(rows.map(row => row.group))].flatMap(group => rows.filter(row => row.group === group));
  const ordered = orderRows(grouped, state.sort, comparable);
  let lastGroup;
  return `<div class="cmp-table-toolbar"><div><h2>${state.tab === 'kpi' ? 'KPI profile' : state.tab === 'physical' ? 'Physical profile' : 'Scouting card metrics'}</h2><p>${esc(explanation)}</p></div>
    <label class="cmp-sort"><span>Order</span><select id="cmp-sort"><option value="phase">By section</option><option value="gap" ${!comparable ? 'disabled' : ''}>Largest differences</option><option value="close" ${!comparable ? 'disabled' : ''}>Closest values</option></select></label></div>
    <div class="cmp-columns cmp-row"><span>Metric <small>${rows.length} aligned rows</small></span><span>${mark(0)} A <small class="cmp-column-name">${esc(players[0].name)}</small></span><span class="cmp-axis"><span>0</span><span>50</span><span>100</span></span><span>${mark(1)} B <small class="cmp-column-name">${esc(players[1].name)}</small></span><span>Gap <small>pct points</small></span><span></span></div>
    <div class="cmp-rows">${ordered.map(row => {
      const heading = state.sort === 'phase' && lastGroup !== row.group ? `<h3 class="cmp-section">${esc(row.group)}</h3>` : '';
      lastGroup = row.group;
      return heading + rowHTML(row, comparable);
    }).join('')}</div>`;
}

export async function renderCompare(main, arg, { api, setTitle, players, physicalGroups = [] }) {
  const state = parseComparison(arg), selected = state.ids.map(id => players.find(p => p.id === id) || null);
  main.removeAttribute('data-pid');
  main.innerHTML = `<div class="page cmp-page"><header class="cmp-heading"><div><div class="cmp-eyebrow">PLAYER COMPARISON</div><h1>See the difference.</h1><p>Two players. The same rows. Every detail in context.</p></div><div class="row"><button class="btn" id="cmp-swap" type="button" ${selected.every(Boolean) ? '' : 'disabled'}>⇄ Swap</button><button class="btn" id="cmp-copy" type="button">Copy link</button></div></header>
    <div class="cmp-players">${selected.map((p, i) => `<section class="cmp-player cmp-${i}"><div class="cmp-player-top"><span class="cmp-letter">${mark(i)} ${i ? 'B' : 'A'}</span>${p ? `<a href="#/player/${p.id}">Open profile ↗</a>` : ''}</div>
      <h2>${esc(p?.name || 'Choose a player')}</h2><p>${esc(p ? [p.position, p.club, p.age != null ? `Age ${p.age}` : ''].filter(Boolean).join(' · ') : 'Search the Pine database below.')}</p>
      ${state.ids[i] && !p ? '<p class="warn">This player is unavailable. Choose another.</p>' : ''}
      <details class="cmp-search" ${p ? '' : 'open'}><summary>${p ? 'Change player' : 'Find a player'}</summary><input type="search" id="cmp-search-${i}" aria-label="Search player ${i ? 'B' : 'A'}" placeholder="Name, club or position…" autocomplete="off"><div id="cmp-results-${i}" class="cmp-results"></div></details>
      <div id="cmp-context-${i}" class="cmp-context"></div></section>`).join('')}</div>
    <div class="cmp-nav"><div class="an-tabs" role="tablist" aria-label="Comparison view">${[['kpi', 'KPI profile'], ['physical', 'Physical'], ['card', 'Scouting cards']].map(([key, label]) => `<button type="button" role="tab" id="cmp-tab-${key}" aria-controls="cmp-body" data-cmp-tab="${key}">${label}</button>`).join('')}</div><span id="cmp-message" class="muted sm" role="status" aria-live="polite"></span></div>
    <section id="cmp-body" class="cmp-body panel" role="tabpanel" aria-live="polite"></section></div>`;
  const root = main.firstElementChild, $ = s => root.querySelector(s);
  const cache = new Map();
  let ticket = 0;
  const get = path => {
    if (!cache.has(path)) { const promise = api('GET', path); cache.set(path, promise); promise.catch(() => cache.delete(path)); }
    return cache.get(path);
  };
  const updateURL = () => { if (root.isConnected) history.replaceState(null, '', `/${comparisonPath(state)}`); };
  const change = (key, value) => { state[key] = value; state.sort = key === 'sort' ? value : 'phase'; updateURL(); draw(); };
  const bind = (id, fn) => $(id)?.addEventListener('change', e => fn(e.target.value));
  const context = (i, controls, text, warning = '') => {
    $(`#cmp-context-${i}`).innerHTML = `${controls}<p>${esc(text)}</p>${warning ? `<p class="cmp-warning">${esc(warning)}</p>` : ''}`;
  };
  const choosePlayer = (i, id) => {
    state.ids[i] = id;
    for (const key of ['k', 'p', 'f', 'c']) delete state[`${key}${i}`];
    state.sort = 'phase'; location.hash = comparisonPath(state);
  };
  selected.forEach((p, i) => {
    const search = $(`#cmp-search-${i}`), results = $(`#cmp-results-${i}`);
    const drawResults = () => {
      const q = search.value.trim();
      const matches = players.filter(p => p.id !== state.ids[1 - i] && (!q || matchText(p, q))).slice(0, 8);
      results.innerHTML = matches.length ? matches.map(p => `<button type="button" data-pick="${p.id}"><b>${esc(p.name)}</b><small>${esc([p.position, p.club].filter(Boolean).join(' · '))}</small></button>`).join('') : '<p>No matching players.</p>';
    };
    search.addEventListener('input', drawResults);
    search.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); results.querySelector('button')?.focus(); }
      if (e.key === 'Enter') { const id = Number(results.querySelector('button')?.dataset.pick); if (id) choosePlayer(i, id); }
      if (e.key === 'Escape' && p) { search.closest('details').open = false; search.closest('details').querySelector('summary').focus(); }
    });
    results.addEventListener('click', e => { const button = e.target.closest('[data-pick]'); if (button) choosePlayer(i, Number(button.dataset.pick)); });
    drawResults();
  });
  $('#cmp-swap').addEventListener('click', () => {
    state.ids.reverse();
    for (const k of ['k', 'p', 'f', 'c']) [state[`${k}0`], state[`${k}1`]] = [state[`${k}1`], state[`${k}0`]];
    location.hash = comparisonPath(state);
  });
  $('#cmp-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('#cmp-message').textContent = 'Comparison link copied.'; }
    catch { $('#cmp-message').textContent = 'Copy this page’s address to share the comparison.'; }
  });
  const tabs = [...root.querySelectorAll('[data-cmp-tab]')];
  const showTab = key => { state.tab = key; state.sort = 'phase'; updateURL(); draw(); };
  tabs.forEach((button, i) => {
    button.addEventListener('click', () => showTab(button.dataset.cmpTab));
    button.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus(); showTab(tabs[index].dataset.cmpTab);
    });
  });
  setTitle(selected.every(Boolean) ? `${selected[0].name} vs ${selected[1].name}` : 'Compare players');

  async function loadKpi() {
    const selection = { ...state };
    const load = (i) => !selected[i].impect_id ? Promise.resolve({ empty: true, reason: 'No Impect link. Physical data may still be available.' }) : get(`/api/players/${selected[i].id}/impect-kpis?${new URLSearchParams({ ...(selection[`k${i}`] ? { iteration: selection[`k${i}`] } : {}), ...(selection[`p${i}`] ? { position: selection[`p${i}`] } : {}) })}`);
    let data = (await Promise.allSettled([load(0), load(1)])).map(settled);
    if (data.every(x => x.data && !x.data.empty)) {
      const pair = choosePair(...data.map(x => x.data.available_iterations.filter(s => s.type !== 'Cup').map(s => ({ ...s, key: s.id }))), [selection.k0, selection.k1]);
      let again = false;
      pair.forEach((p, i) => { if (!selection[`k${i}`] && p && p.key !== data[i].data.iteration.id) { selection[`k${i}`] = p.key; again = true; } });
      if (again) data = (await Promise.allSettled([load(0), load(1)])).map(settled);
      if (data.every(x => x.data && !x.data.empty)) {
        const common = data[0].data.positions.find(p => data[1].data.positions.some(q => q.group === p.group))?.group;
        again = false;
        for (const i of [0, 1]) if (!selection[`p${i}`]) {
          const other = selection[`p${1 - i}`];
          const group = data[i].data.positions.some(p => p.group === other) ? other : common || data[i].data.position;
          selection[`p${i}`] = group;
          if (group !== data[i].data.position) again = true;
        }
        if (again) data = (await Promise.allSettled([load(0), load(1)])).map(settled);
      }
    }
    return { data, selection };
  }
  async function draw() {
    const mine = ++ticket, active = () => mine === ticket && root.isConnected;
    tabs.forEach(button => { const on = button.dataset.cmpTab === state.tab; button.classList.toggle('on', on); button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1; });
    $('#cmp-body').setAttribute('aria-labelledby', `cmp-tab-${state.tab}`);
    if (!selected.every(Boolean)) { $('#cmp-body').innerHTML = '<div class="cmp-empty"><span aria-hidden="true">● ─── ◆</span><h2>Who are we comparing?</h2><p>Choose two players to line up their profiles.</p></div>'; return; }
    $('#cmp-body').innerHTML = '<p class="loading" role="status">Loading both profiles…</p>';
    for (const i of [0, 1]) context(i, '', 'Loading selection…');
    let data, rows, comparable, explanation, extra = '', notices = [], snapshotError = false;
    try {
      if (state.tab === 'kpi') {
        const loaded = await loadKpi(); if (!active()) return; data = loaded.data;
        for (const key of ['k0', 'k1', 'p0', 'p1']) if (loaded.selection[key]) state[key] = loaded.selection[key];
        const visible = data.map((x, i) => {
          const d = x.data, invalid = d && !d.empty && ((state[`k${i}`] && String(state[`k${i}`]) !== String(d.iteration.id)) || (state[`p${i}`] && state[`p${i}`] !== d.position));
          const seasons = (d?.available_iterations || []).filter(s => s.type !== 'Cup').map(s => ({ key: s.id, label: `${s.season} · ${s.competition}` }));
          if (d && !d.empty) { state[`k${i}`] ||= d.iteration.id; state[`p${i}`] ||= d.position; }
          const controls = `${seasons.length ? select(`cmp-season-${i}`, 'Season & league', seasons, state[`k${i}`]) : ''}${d?.positions?.length ? select(`cmp-position-${i}`, 'Position benchmark', d.positions.map(p => ({ key: p.group, label: `${p.label} · ${num(p.match_share)} matches` })), state[`p${i}`]) : ''}`;
          const warning = x.error || d?.reason || (invalid ? 'The selected season or position is unavailable. Choose an offered sample.' : d?.eligible === false ? `Small sample: ${num(d.match_share)} match shares, below the ${num(d.min_share_used)}-match benchmark floor.` : '');
          context(i, controls, d && !d.empty ? `${d.squad ? d.squad + ' · ' : ''}${d.position_label} · ${num(d.minutes)} min · ${d.peer_count} peers · ${d.iteration.season}` : 'KPI profile unavailable', warning);
          bind(`#cmp-season-${i}`, value => { delete state[`p${i}`]; change(`k${i}`, value); });
          bind(`#cmp-position-${i}`, value => change(`p${i}`, value));
          return invalid ? null : d;
        });
        comparable = kpiComparable(...visible); rows = mergeRows(...visible.map(kpiRows));
        explanation = 'Existing pooled percentiles. Open a category to compare the underlying metrics.';
        if (comparable) notices.push('Same positional benchmark and season. Each league is standardized before pooling; a gap is a difference in percentile points.');
        else notices.push('Different or unavailable benchmark contexts. Read each profile in its own context; percentile gaps and difference sorting are unavailable.');
      } else if (state.tab === 'physical') {
        data = (await Promise.allSettled(selected.map(p => get(`/api/players/${p.id}/physical`)))).map(settled); if (!active()) return;
        const options = data.map(x => (x.data?.linked || []).map(r => ({ ...r, season: String(r.season), key: r.key })).sort((a, b) => b.season.localeCompare(a.season, undefined, { numeric: true })));
        const pair = choosePair(...options, [state.f0, state.f1], (a, b) => a.season === b.season && a.grp === b.grp);
        pair.forEach((r, i) => {
          if (r) state[`f${i}`] = r.key;
          context(i, options[i].length ? select(`cmp-physical-${i}`, 'Physical season & team', options[i].map(r => ({ key: r.key, label: `${r.season} · ${r.team} · ${r.league}` })), state[`f${i}`]) : '',
            r ? `${r.pos} · ${num(r.mins)} min · ${r.pool} ${r.grp} peers · ${r.league} ${r.season}` : 'Physical data unavailable',
            data[i].error || (!r ? 'No linked data for this selection. Link physical data from the player profile.' : r.pool < 20 ? `Small pool (${r.pool}). Read percentiles loosely.` : ''));
          bind(`#cmp-physical-${i}`, value => change(`f${i}`, value));
        });
        comparable = physicalComparable(...pair); rows = mergeRows(...pair.map((r, i) => physicalRows(data[i].data, r, physicalGroups)));
        explanation = 'Raw values appear below percentiles. Physical output describes the player and their role; more is not automatically better.';
        notices.push(comparable ? 'Same league, season and position pool. Higher means more output, not automatically better.' : 'Physical percentiles use each player’s own league, season and position pool. These pools differ or are too small; percentile gaps and difference sorting are unavailable.');
      } else {
        data = (await Promise.allSettled(selected.map(p => get(`/api/players/${p.id}/cards`)))).map(settled); if (!active()) return;
        const options = data.map(x => (x.data?.cards || []).filter(c => c.status === 'done').map(c => ({ ...c, key: c.id })).sort((a, b) => String(b.season).localeCompare(String(a.season), undefined, { numeric: true }) || String(b.generated_at).localeCompare(String(a.generated_at))));
        const pair = choosePair(...options, [state.c0, state.c1], (a, b) => a.season === b.season && positionGroup(a.position) === positionGroup(b.position));
        const snapshots = (await Promise.allSettled(pair.map(c => c?.has_snapshot ? get(`/api/cards/${c.id}/snapshot`) : Promise.resolve(null)))).map(settled); if (!active()) return;
        snapshotError = snapshots.some(x => x.error);
        const valid = snapshots.map((x, i) => {
          const r = x.data?.render_input, c = pair[i];
          return r?.schema_version === 16 && r.subject?.profiles?.[0] && Array.isArray(r.subject.profiles[0].grid) && r.subject?.id === selected[i].impect_id && r.iteration === c?.iteration_id && r.events?.position === c?.position ? x.data : null;
        });
        pair.forEach((c, i) => {
          if (c) state[`c${i}`] = c.id;
          context(i, options[i].length ? select(`cmp-card-${i}`, 'Saved card version', options[i].map(c => ({ key: c.id, label: `${c.season} · ${c.position} · ${c.competition} · ${date(c.generated_at)} · #${c.id}` })), state[`c${i}`]) : '',
            c ? `${valid[i]?.render_input.subject.club ? valid[i].render_input.subject.club + ' · ' : ''}${c.position} · ${c.season} · data through ${c.data_as_of || 'unknown'} · generated ${date(c.generated_at)}` : 'No completed scouting card',
            data[i].error || snapshots[i].error || (c && !c.has_snapshot ? 'This version has no structured snapshot. Its existing PDF remains available below.' : c && !valid[i] ? 'This snapshot format is not supported here. Use its original PDF below.' : !c ? 'Create a card from the player profile to compare it here.' : valid[i].render_input.subject.profiles[0].ms < 5 ? `Small card sample: ${num(valid[i].render_input.subject.profiles[0].ms)} match shares.` : ''));
          bind(`#cmp-card-${i}`, value => change(`c${i}`, value));
        });
        comparable = scoutingComparable(...valid); rows = mergeRows(...valid.map(scoutingRows));
        explanation = 'Saved card values, with the card’s original ranks. Rare metrics remain ungraded; film notes and role mixtures remain on the original card.';
        if (rows.length) notices.push(comparable ? 'Same saved card benchmark, metric grid and data date. Card ranks use their original league and position pool, which differs from the pooled KPI profile.' : 'Saved cards have different or unavailable benchmark contexts, metric grids or data dates. Raw values remain visible; percentile gaps and difference sorting are unavailable.');
        extra = cardViewer(pair, selected);
      }
      if (!active()) return;
      if (!comparable) state.sort = 'phase';
      updateURL();
      $('#cmp-body').innerHTML = `${notices.map(note => `<p class="banner ${comparable ? 'info' : 'warn'} cmp-benchmark">${esc(note)}</p>`).join('')}${rows.length ? tableHTML(rows, comparable, state, selected, explanation) : state.tab !== 'card' ? '<div class="cmp-empty"><h2>No values to compare for this selection</h2><p>Choose another season, position or player.</p></div>' : ''}${extra}${snapshotError || data.some(x => x.error) || (state.tab === 'card' && !rows.length) ? '<button class="btn sm" type="button" id="cmp-retry">Reload data</button>' : ''}`;
      if ($('#cmp-sort')) { $('#cmp-sort').value = state.sort; bind('#cmp-sort', value => change('sort', value)); }
      $('#cmp-retry')?.addEventListener('click', () => { cache.clear(); draw(); });
      wireCardViewer(root);
    } catch (e) {
      if (!active()) return;
      $('#cmp-body').innerHTML = `<div class="cmp-empty"><h2>Couldn’t load the comparison</h2><p>${esc(e.message)}</p><button class="btn" id="cmp-retry" type="button">Try again</button></div>`;
      $('#cmp-retry').addEventListener('click', () => { cache.clear(); draw(); });
    }
  }
  await draw();
}

function cardViewer(cards, players) {
  return `<section class="cmp-card-viewer"><div class="cmp-table-toolbar"><div><h2>Original scouting cards</h2><p>Zoom both previews together, or switch between players at the same size.</p></div><div class="row"><label>Zoom <select id="cmp-zoom">${[100, 150, 200, 300, 400].map(n => `<option value="${n}">${n}%</option>`).join('')}</select></label><button class="btn sm" type="button" id="cmp-card-mode" aria-pressed="false">A/B view</button></div></div>
    <div class="cmp-card-flip" hidden>${players.map((p, i) => `<button class="btn sm cmp-${i}" type="button" data-flip="${i}" aria-pressed="${!i}">${mark(i)} ${esc(p.name)}</button>`).join('')}</div>
    <div class="cmp-card-pair">${cards.map((c, i) => `<article class="cmp-card-preview cmp-${i}" data-card-side="${i}"><div class="cmp-card-caption">${mark(i)} <b>${esc(players[i].name)}</b>${c ? `<a href="/api/cards/${c.id}/pdf" target="_blank" rel="noopener">Open PDF ↗</a>` : ''}</div><div class="cmp-card-scroll" tabindex="0" aria-label="${esc(players[i].name)} scouting card preview">${c?.has_image ? `<img src="/api/cards/${c.id}/png" alt="${esc(`${players[i].name}, ${c.season} ${c.position} scouting card`)}">` : `<p class="cmp-card-unavailable">${c ? 'No image preview for this card. Open the PDF above.' : 'No completed card for this selection.'}</p>`}</div></article>`).join('')}</div></section>`;
}
function wireCardViewer(root) {
  const viewer = root.querySelector('.cmp-card-viewer'); if (!viewer) return;
  let flip = matchMedia('(max-width: 600px)').matches, side = '0', syncing = false, x = 0, y = 0;
  const panes = [...viewer.querySelectorAll('.cmp-card-scroll')];
  const restore = () => {
    syncing = true;
    requestAnimationFrame(() => {
      panes.filter(p => p.offsetWidth).forEach(p => { p.scrollLeft = x * (p.scrollWidth - p.clientWidth); p.scrollTop = y * (p.scrollHeight - p.clientHeight); });
      requestAnimationFrame(() => { syncing = false; });
    });
  };
  const draw = () => {
    viewer.classList.toggle('cmp-flip-mode', flip); viewer.querySelector('.cmp-card-flip').hidden = !flip;
    viewer.querySelector('#cmp-card-mode').setAttribute('aria-pressed', String(flip));
    viewer.querySelector('#cmp-card-mode').textContent = flip ? 'Side by side' : 'A/B view';
    viewer.querySelectorAll('[data-card-side]').forEach(p => p.hidden = flip && p.dataset.cardSide !== side);
    viewer.querySelectorAll('[data-flip]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.flip === side)));
    restore();
  };
  viewer.querySelector('#cmp-card-mode').addEventListener('click', () => { flip = !flip; draw(); });
  viewer.querySelectorAll('[data-flip]').forEach(b => b.addEventListener('click', () => { side = b.dataset.flip; draw(); }));
  viewer.querySelector('#cmp-zoom').addEventListener('change', e => { viewer.style.setProperty('--cmp-zoom', `${e.target.value}%`); restore(); });
  panes.forEach((pane, i) => pane.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    const other = panes[1 - i];
    x = pane.scrollWidth > pane.clientWidth ? pane.scrollLeft / (pane.scrollWidth - pane.clientWidth) : 0;
    y = pane.scrollHeight > pane.clientHeight ? pane.scrollTop / (pane.scrollHeight - pane.clientHeight) : 0;
    other.scrollLeft = x * (other.scrollWidth - other.clientWidth); other.scrollTop = y * (other.scrollHeight - other.clientHeight);
    requestAnimationFrame(() => { syncing = false; });
  }));
  viewer.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { const p = document.createElement('p'); p.className = 'cmp-card-unavailable'; p.textContent = 'Preview unavailable. Open the PDF above.'; img.replaceWith(p); }));
  draw();
}
