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
const sideValue = r => `<span class="cmp-value">${r?.rare ? 'Rare' : pct(r?.percentile) == null ? '<span class="cmp-na">Unavailable</span>' : `${num(r.percentile)}<span class="sr-only"> percentile</span>`}${finite(r?.value) ? `<small>Value ${num(r.value)}</small>` : ''}${r?.outlook ? `<small>Likely ${num(r.outlook.expected)}<br>range ${num(r.outlook.low)} to ${num(r.outlook.high)}</small>` : ''}</span>`;
function chart(row) {
  return `<span class="cmp-chart" aria-hidden="true">${[row.a, row.b].map((r, i) => {
    const p = pct(r?.percentile), o = r?.outlook;
    return `<span class="cmp-bar cmp-${i}${p == null ? ' cmp-bar-missing' : ''}"><span class="cmp-bar-label">${i ? 'B' : 'A'}</span><span class="cmp-track">${p == null ? `<span class="cmp-bar-empty">${r?.rare ? 'Not ranked' : 'Unavailable'}</span>` : `<i class="cmp-fill" style="width:${p}%"></i><i class="cmp-dot cmp-${i}" style="left:${p}%"></i>`}${o && finite(o.low) && finite(o.high) ? `<i class="cmp-range" style="left:${Math.max(0, o.low)}%;width:${Math.min(100, o.high) - Math.max(0, o.low)}%"></i>` : ''}</span></span>`;
  }).join('')}</span>`;
}
function rowHTML(row, comparable, showGroup = false) {
  const delta = gap(row, comparable);
  const notes = [...new Set([row.a?.note, row.b?.note].filter(Boolean))];
  const cells = `<span class="cmp-metric"><b>${esc(row.label)}</b>${showGroup ? `<small>${esc(row.group)}</small>` : ''}${notes.length ? `<small>${esc(notes.join(' '))}</small>` : ''}</span>
    ${[row.a, row.b].map((r, i) => `<span class="cmp-number cmp-${i}"><span class="sr-only">Player ${i ? 'B' : 'A'}: </span><span class="cmp-number-label" aria-hidden="true">${mark(i)} Player ${i ? 'B' : 'A'}</span>${sideValue(r)}</span>`).join('')}${chart(row)}
    <span class="cmp-gap ${delta > 0 ? 'cmp-0' : delta < 0 ? 'cmp-1' : ''}" title="${delta == null ? 'Percentile gap unavailable' : 'The gap is in percentile points. Higher values do not always mean better performance.'}">${delta == null ? '—' : delta === 0 ? 'Same' : `<b>${delta > 0 ? 'A' : 'B'} +${num(Math.round(Math.abs(delta) * 10) / 10)}</b><small>pts</small>`}</span>`;
  const children = mergeRows(row.a?.children, row.b?.children);
  return children.length ? `<details class="cmp-item"><summary class="cmp-row">${cells}<span class="cmp-chevron" aria-hidden="true">⌄</span></summary>
    <div class="cmp-detail">${row.description ? `<p>${esc(row.description)}</p>` : ''}<p class="muted sm">Values appear below their percentiles. For metrics marked ↓, lower values are better and the percentiles account for that. Volume measures how often an action happens.</p>${children.map(r => rowHTML(r, comparable)).join('')}</div></details>`
    : `<div class="cmp-item cmp-row">${cells}<span class="cmp-chevron"></span></div>`;
}
function tableHTML(rows, comparable, state, players, explanation) {
  const grouped = [...new Set(rows.map(row => row.group))].flatMap(group => rows.filter(row => row.group === group));
  const ordered = orderRows(grouped, state.sort, comparable);
  let lastGroup;
  return `<div class="cmp-table-toolbar"><div><h2>${state.tab === 'kpi' ? 'KPI profile' : state.tab === 'physical' ? 'Physical profile' : 'Scouting card metrics'}</h2><p>${esc(explanation)}</p></div><span class="cmp-count">${rows.length} metrics</span></div>
    <div class="cmp-table-controls"><div class="seg cmp-sort" id="cmp-sort" role="group" aria-label="Sort metrics">${[['phase', 'By section'], ['gap', 'Largest differences'], ['close', 'Closest values']].map(([key, label]) => `<button type="button" data-cmp-sort="${key}" class="${state.sort === key ? 'on' : ''}" aria-pressed="${state.sort === key}" ${key !== 'phase' && !comparable ? 'disabled' : ''}>${label}</button>`).join('')}</div><span class="cmp-help">Bars show percentile rank from 0 to 100.</span></div>
    <div class="cmp-columns cmp-row"><span>Metric</span>${players.map((p, i) => `<span class="cmp-column-player cmp-${i}">${mark(i)}<b>${esc(p.name)}</b><small>Player ${i ? 'B' : 'A'} percentile</small></span>`).join('')}<span class="cmp-axis"><span>Percentile rank</span><span class="cmp-ticks"><span>0</span><span>50</span><span>100</span></span></span><span class="cmp-column-gap">Difference<small>Percentile points</small></span><span></span></div>
    <div class="cmp-rows">${ordered.map(row => {
      const heading = state.sort === 'phase' && lastGroup !== row.group ? `<h3 class="cmp-section">${esc(row.group)}</h3>` : '';
      lastGroup = row.group;
      return heading + rowHTML(row, comparable, state.sort !== 'phase');
    }).join('')}</div>`;
}

export async function renderCompare(main, arg, { api, setTitle, players, physicalGroups = [] }) {
  const state = parseComparison(arg), selected = state.ids.map(id => players.find(p => p.id === id) || null);
  main.removeAttribute('data-pid');
  main.innerHTML = `<div class="page cmp-page"><header class="page-h cmp-heading"><div><h1>Compare players</h1><p>Compare KPI profiles, physical data and scouting cards.</p></div><div class="row"><button class="btn" id="cmp-swap" type="button" ${selected.every(Boolean) ? '' : 'disabled'}>⇄ Swap</button><button class="btn" id="cmp-copy" type="button">Copy link</button></div></header>
    <div class="cmp-players">${selected.map((p, i) => `<section class="panel cmp-player cmp-${i}"><div class="cmp-player-top"><span class="cmp-letter">${mark(i)} Player ${i ? 'B' : 'A'}</span>${p ? `<a href="#/player/${p.id}">Open profile ↗</a>` : ''}</div>
      <h2>${esc(p?.name || 'Choose a player')}</h2><p>${esc(p ? [p.position, p.club, p.age != null ? `Age ${p.age}` : ''].filter(Boolean).join(', ') : 'Search by name, club or position.')}</p>
      ${state.ids[i] && !p ? '<p class="warn">The player is unavailable. Choose another player.</p>' : ''}
      <details class="cmp-search" ${p ? '' : 'open'}><summary>${p ? 'Change player' : 'Find a player'}</summary><input type="search" id="cmp-search-${i}" aria-label="Search player ${i ? 'B' : 'A'}" placeholder="Name, club or position…" autocomplete="off"><div id="cmp-results-${i}" class="cmp-results"></div></details>
      <div id="cmp-context-${i}" class="cmp-context"></div></section>`).join('')}</div>
    <div class="cmp-nav"><div class="an-tabs" role="tablist" aria-label="Comparison view">${[['kpi', 'KPI profile'], ['physical', 'Physical'], ['card', 'Scouting cards']].map(([key, label]) => `<button type="button" role="tab" id="cmp-tab-${key}" aria-controls="cmp-body" data-cmp-tab="${key}">${label}</button>`).join('')}</div><span id="cmp-message" class="muted sm" role="status" aria-live="polite"></span></div>
    <section id="cmp-body" class="cmp-body panel" role="tabpanel" aria-live="polite"></section></div>`;
  const root = main.firstElementChild, $ = s => root.querySelector(s);
  // Keep the player headings below Pine's header when its navigation wraps.
  if (window.ResizeObserver) {
    const header = document.querySelector('.top');
    const fit = () => root.isConnected ? root.style.setProperty('--cmp-top', `${header?.getBoundingClientRect().height || 0}px`) : observer.disconnect();
    const observer = new ResizeObserver(fit);
    observer.observe(root); if (header) observer.observe(header);
    fit();
  }
  const cache = new Map();
  let ticket = 0;
  const get = path => {
    if (!cache.has(path)) { const promise = api('GET', path); cache.set(path, promise); promise.catch(() => cache.delete(path)); }
    return cache.get(path);
  };
  const updateURL = () => { if (root.isConnected) history.replaceState(null, '', `/${comparisonPath(state)}`); };
  const change = (key, value) => { state[key] = value; state.sort = key === 'sort' ? value : 'phase'; updateURL(); return draw(); };
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
      results.innerHTML = matches.length ? matches.map(p => `<button type="button" data-pick="${p.id}"><b>${esc(p.name)}</b><small>${esc([p.position, p.club].filter(Boolean).join(', '))}</small></button>`).join('') : '<p>No matching players.</p>';
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
    catch { $('#cmp-message').textContent = 'Copy the page address to share the comparison.'; }
  });
  const tabs = [...root.querySelectorAll('[data-cmp-tab]')];
  const showTab = key => { state.tab = key; state.sort = 'phase'; updateURL(); return draw(); };
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
    const load = (i) => !selected[i].impect_id ? Promise.resolve({ empty: true, reason: 'The player is not linked to Impect. Physical data may still be available.' }) : get(`/api/players/${selected[i].id}/impect-kpis?${new URLSearchParams({ ...(selection[`k${i}`] ? { iteration: selection[`k${i}`] } : {}), ...(selection[`p${i}`] ? { position: selection[`p${i}`] } : {}) })}`);
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
    if (!selected.every(Boolean)) { $('#cmp-body').innerHTML = '<div class="cmp-empty"><span aria-hidden="true">● ─── ◆</span><h2>Choose two players</h2><p>Use the search fields above to select each player.</p></div>'; return; }
    $('#cmp-body').innerHTML = '<p class="loading" role="status">Loading both profiles…</p>';
    for (const i of [0, 1]) context(i, '', 'Loading selection…');
    let data, rows, comparable, explanation, extra = '', notices = [], snapshotError = false;
    try {
      if (state.tab === 'kpi') {
        const loaded = await loadKpi(); if (!active()) return; data = loaded.data;
        for (const key of ['k0', 'k1', 'p0', 'p1']) if (loaded.selection[key]) state[key] = loaded.selection[key];
        const visible = data.map((x, i) => {
          const d = x.data, invalid = d && !d.empty && ((state[`k${i}`] && String(state[`k${i}`]) !== String(d.iteration.id)) || (state[`p${i}`] && state[`p${i}`] !== d.position));
          const seasons = (d?.available_iterations || []).filter(s => s.type !== 'Cup').map(s => ({ key: s.id, label: `${s.season}, ${s.competition}` }));
          if (d && !d.empty) { state[`k${i}`] ||= d.iteration.id; state[`p${i}`] ||= d.position; }
          const controls = `${seasons.length ? select(`cmp-season-${i}`, 'Season and league', seasons, state[`k${i}`]) : ''}${d?.positions?.length ? select(`cmp-position-${i}`, 'Position group', d.positions.map(p => ({ key: p.group, label: `${p.label}, ${num(p.match_share)} matches` })), state[`p${i}`]) : ''}`;
          const warning = x.error || d?.reason || (invalid ? 'The selected season or position is unavailable. Choose another option from the lists above.' : d?.eligible === false ? `The player has ${num(d.match_share)} match shares at this position, below the ${num(d.min_share_used)} required for the comparison group. Percentiles may be less reliable.` : '');
          context(i, controls, d && !d.empty ? `${d.squad ? d.squad + ', ' : ''}${d.position_label}, ${num(d.minutes)} min, ${d.peer_count} players in group` : 'KPI profile unavailable', warning);
          bind(`#cmp-season-${i}`, value => { delete state[`p${i}`]; change(`k${i}`, value); });
          bind(`#cmp-position-${i}`, value => change(`p${i}`, value));
          return invalid ? null : d;
        });
        comparable = kpiComparable(...visible); rows = mergeRows(...visible.map(kpiRows));
        explanation = 'Percentiles rank players in the same position across leagues. Open a category to compare its metrics.';
        if (comparable) notices.push('Both profiles use the same season and comparison group. Gaps show the difference in percentile points.');
        else notices.push('The profiles use different seasons or comparison groups, or the group details are missing. Percentile gaps and sorting by difference are unavailable.');
      } else if (state.tab === 'physical') {
        data = (await Promise.allSettled(selected.map(p => get(`/api/players/${p.id}/physical`)))).map(settled); if (!active()) return;
        const options = data.map(x => (x.data?.linked || []).map(r => ({ ...r, season: String(r.season), key: r.key })).sort((a, b) => b.season.localeCompare(a.season, undefined, { numeric: true })));
        const pair = choosePair(...options, [state.f0, state.f1], (a, b) => a.season === b.season && a.grp === b.grp);
        pair.forEach((r, i) => {
          if (r) state[`f${i}`] = r.key;
          context(i, options[i].length ? select(`cmp-physical-${i}`, 'Season and team', options[i].map(r => ({ key: r.key, label: `${r.season}, ${r.team}, ${r.league}` })), state[`f${i}`]) : '',
            r ? `${r.pos}, ${num(r.mins)} min, ${r.pool} ${r.grp} players in group` : 'Physical data unavailable',
            data[i].error || (!r ? 'No physical data is linked for the selection. You can link physical data on the player profile.' : r.pool < 20 ? `Only ${r.pool} players are in the comparison group, so percentiles may be less reliable.` : ''));
          bind(`#cmp-physical-${i}`, value => change(`f${i}`, value));
        });
        comparable = physicalComparable(...pair); rows = mergeRows(...pair.map((r, i) => physicalRows(data[i].data, r, physicalGroups)));
        explanation = 'Values appear below their percentiles. Higher physical output can depend on the player\'s role and does not always mean better performance.';
        notices.push(comparable ? 'Both players are ranked against the same league, season and position group.' : 'Each player is ranked within their own league, season and position group. The groups differ or have too few players, so percentile gaps and sorting by difference are unavailable.');
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
          context(i, options[i].length ? select(`cmp-card-${i}`, 'Saved card version', options[i].map(c => ({ key: c.id, label: `${c.season}, ${c.position}, ${c.competition}, ${date(c.generated_at)}, #${c.id}` })), state[`c${i}`]) : '',
            c ? `${valid[i]?.render_input.subject.club ? valid[i].render_input.subject.club + ', ' : ''}${c.position}, ${c.season}, data through ${c.data_as_of || 'unknown'}, generated ${date(c.generated_at)}` : 'No completed scouting card',
            data[i].error || snapshots[i].error || (c && !c.has_snapshot ? 'The card values are unavailable for the table. You can compare the original card below.' : c && !valid[i] ? 'The saved card values cannot be shown in the table. Open the PDF below to compare them.' : !c ? 'Create a card from the player profile to compare it here.' : valid[i].render_input.subject.profiles[0].ms < 5 ? `The card uses ${num(valid[i].render_input.subject.profiles[0].ms)} match shares, so percentiles may be less reliable.` : ''));
          bind(`#cmp-card-${i}`, value => change(`c${i}`, value));
        });
        comparable = scoutingComparable(...valid); rows = mergeRows(...valid.map(scoutingRows));
        explanation = 'Values and percentiles come from each saved card. Rare metrics have no percentile. Open the PDF for film notes and role details.';
        if (rows.length) notices.push(comparable ? 'Both cards use the same comparison group, metric definitions and data date. Card percentiles use each card\'s league and position group, while KPI percentiles rank players across leagues.' : 'The cards use different comparison groups, metric definitions or data dates, or some details are missing. You can compare the values, but percentile gaps and sorting by difference are unavailable.');
        extra = cardViewer(pair, selected);
      }
      if (!active()) return;
      if (!comparable) state.sort = 'phase';
      updateURL();
      $('#cmp-body').innerHTML = `${notices.map(note => `<p class="banner ${comparable ? 'info' : 'warn'} cmp-benchmark">${esc(note)}</p>`).join('')}${rows.length ? tableHTML(rows, comparable, state, selected, explanation) : state.tab !== 'card' ? '<div class="cmp-empty"><h2>No data available</h2><p>Choose another season, position or player.</p></div>' : ''}${extra}${snapshotError || data.some(x => x.error) || (state.tab === 'card' && !rows.length) ? '<button class="btn sm" type="button" id="cmp-retry">Try again</button>' : ''}`;
      root.querySelectorAll('[data-cmp-sort]').forEach(button => button.addEventListener('click', async () => {
        const value = button.dataset.cmpSort; await change('sort', value);
        $(`[data-cmp-sort="${value}"]`)?.focus({ preventScroll: true });
      }));
      $('#cmp-retry')?.addEventListener('click', () => { cache.clear(); draw(); });
      wireCardViewer(root);
    } catch (e) {
      if (!active()) return;
      $('#cmp-body').innerHTML = `<div class="cmp-empty"><h2>Could not load the comparison</h2><p>${esc(e.message)}</p><button class="btn" id="cmp-retry" type="button">Try again</button></div>`;
      $('#cmp-retry').addEventListener('click', () => { cache.clear(); draw(); });
    }
  }
  await draw();
}

function cardViewer(cards, players) {
  return `<section class="cmp-card-viewer"><div class="cmp-table-toolbar"><div><h2>Original scouting cards</h2><p>Zoom and scroll both cards together. Use A/B view to switch between cards at the same size.</p></div><div class="row"><label>Zoom <select id="cmp-zoom">${[100, 150, 200, 300, 400].map(n => `<option value="${n}">${n}%</option>`).join('')}</select></label><button class="btn sm" type="button" id="cmp-card-mode" aria-pressed="false">A/B view</button></div></div>
    <div class="cmp-card-flip" hidden>${players.map((p, i) => `<button class="btn sm cmp-${i}" type="button" data-flip="${i}" aria-pressed="${!i}">${mark(i)} ${esc(p.name)}</button>`).join('')}</div>
    <div class="cmp-card-pair">${cards.map((c, i) => `<article class="cmp-card-preview cmp-${i}" data-card-side="${i}"><div class="cmp-card-caption">${mark(i)} <b>${esc(players[i].name)}</b>${c ? `<a href="/api/cards/${c.id}/pdf" target="_blank" rel="noopener">Open PDF ↗</a>` : ''}</div><div class="cmp-card-scroll" tabindex="0" aria-label="${esc(players[i].name)} scouting card preview">${c?.has_image ? `<img src="/api/cards/${c.id}/png" alt="${esc(`${players[i].name}, ${c.season} ${c.position} scouting card`)}">` : `<p class="cmp-card-unavailable">${c ? 'The card preview is unavailable. Open the PDF above.' : 'No completed card is available.'}</p>`}</div></article>`).join('')}</div></section>`;
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
  viewer.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { const p = document.createElement('p'); p.className = 'cmp-card-unavailable'; p.textContent = 'The card preview is unavailable. Open the PDF above.'; img.replaceWith(p); }));
  draw();
}
