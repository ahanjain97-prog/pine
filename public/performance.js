import { PAGE_REQUESTS, buildReport, chartDuration, dailyChart, dailyPoints, dayStart, eventStats, eventSummary, eventsTable, lastDays,
  pagesTable, requestsTable, sortItems, technicalTable, TARGETS } from './performance-charts.js';

// Batches of anonymous timings: no URLs, player IDs, staff IDs or content.
export function timingMetric(path) {
  const clean = path.split('?')[0];
  const routes = {
    '/api/players': 'players', '/api/config': 'config', '/api/changes': 'changes',
    '/api/ncaa': 'ncaa', '/api/ncaa/prospects': 'ncaa-prospects', '/api/review': 'review',
    '/api/activity': 'activity', '/api/analysis': 'analysis', '/api/impect/search': 'impect-search',
    '/api/impect/iterations': 'impect-iterations', '/api/impect/shortlists': 'impect-shortlists',
    '/api/impect/cache': 'impect-cache',
  };
  if (Object.hasOwn(routes, clean)) return routes[clean];
  const match = /^\/api\/players\/\d+(?:\/(playing-time|impect-kpis|card-options|cards|maps|physical|impect-candidates|tm-candidates|mlsnp-gates))?$/.exec(clean);
  return match ? match[1] || 'player' : null;
}

export function renderMetric(view) {
  return ['board', 'short-board', 'roster', 'players', 'player', 'ncaa', 'war-room', 'compare', 'analysis', 'impect', 'activity', 'staff'].includes(view) ? `${view}-render` : null;
}

// The server marks responses in the first minute after a break ('idle') or a restart ('restart').
export function coldness(headers) {
  const match = /(?:^|,)\s*cold;desc="?(idle|restart)"?/.exec(headers?.get?.('Server-Timing') || '');
  return match ? match[1] : null;
}

export function createTimings(version) {
  const samples = [];
  let timer;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!samples.length || !/^[a-f0-9]{8}$/.test(version || '')) return;
    // `age` lets the server place a slow page open at the time it happened, not when the batch arrived.
    const now = Date.now(), batch = samples.splice(0, 30).map(({ at, ...sample }) => ({ ...sample, age: Math.min(600000, Math.max(0, now - at)) }));
    fetch('/api/performance', { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-PINE': '1' },
      body: JSON.stringify({ version, samples: batch }),
    }).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  return (metric, ms, outcome = 'ok', cold = null) => {
    if (!metric || document.hidden || !Number.isFinite(ms) || ms < 0 || ms > 300000) return;
    if (samples.length < 30) samples.push({ metric, ms: Math.round(ms), outcome, ...(cold ? { cold } : {}), at: Date.now() });
    if (!timer) timer = setTimeout(flush, 5000);
  };
}

const HOW_TO_READ = `<details class="perf-help"><summary>How to read this</summary><ul class="hint">
  <li><b>Status</b> counts how many timings went over the limit. Pages should open within ${chartDuration(TARGETS.page.good)} and are slow over ${chartDuration(TARGETS.page.slow)}; requests should finish within ${chartDuration(TARGETS.request.good)} and are slow over ${chartDuration(TARGETS.request.slow)}. <b>Slow</b>: at least 2, and at least 1 in 5, over the limit. <b>Watch</b>: an occasional one over the limit, or at least 1 in 4 over the target. Fewer than 3 timings is "Too few".</li>
  <li><b>Average</b> and <b>Slowest</b> are exact. "After a break" shows the average for the first minute of use after 15 minutes without anyone using PINE, when it is clearly slower than the rest. Caches and provider sign-ins have usually expired by then.</li>
  <li><b>Total wait</b> is the staff time spent waiting on it in this period (uses × average). It shows what is worth fixing first.</li>
  <li><b>Where the time goes</b> splits average server time into database, outside providers (Impect, Transfermarkt, NCAA, physical data) and app processing. "Mostly network or download" means staff wait at least twice as long as the server works. Browser and server timings are collected separately, so they are compared, never subtracted.</li>
  <li><b>vs last week</b> compares the average over the last 7 days with the 7 days before, when both weeks have at least 5 timings. Changes under 20% show as "≈ same".</li>
  <li><b>Page</b> timings cover opening the page shell. Panels that load afterwards are listed as separate requests when you expand the page.</li>
  <li>Timings are kept for 90 days, and the newest 1,000 slow or failed events. No player, staff, URL or content details are stored.</li>
</ul></details>`;

const PERIOD_NAMES = { 7: 'the last 7 days', 14: 'the last 14 days', 30: 'the last 30 days', 90: 'the last 90 days' };
const EVENTS_SHOWN = 25;

export function loadPerformancePanel(panel, api, esc, { onReport } = {}) {
  panel.innerHTML = `<header class="panel-h"><h2>What is slow?</h2><button type="button" class="btn sm" data-refresh>Refresh</button></header>
    <div class="row perf-filters"><label>Period <select data-days>${Object.entries(PERIOD_NAMES).map(([days, name]) => `<option value="${days}"${days === '14' ? ' selected' : ''}>${name[0].toUpperCase()}${name.slice(1)}</option>`).join('')}</select></label>
      <label>Order <select data-sort><option value="status">Worst first</option><option value="impact">Most total wait</option></select></label></div>
    ${HOW_TO_READ}<div data-results aria-live="polite" class="loading sm">Loading timings…</div>`;
  const period = panel.querySelector('[data-days]'), sort = panel.querySelector('[data-sort]');
  const results = panel.querySelector('[data-results]'), refresh = panel.querySelector('[data-refresh]');
  let generation = 0, data, report, selected = '', chosen = false, allEvents = false;
  const open = new Set(), sections = {};
  const draw = () => {
    if (!data) return;
    const days = lastDays(Number(period.value)), week = lastDays(7), fortnight = lastDays(14);
    const rows = data.daily.filter(r => r.day >= days[0]);
    report = buildReport(rows, data.bucket_upper_ms, {
      current: data.daily.filter(r => r.day >= week[0]),
      previous: data.daily.filter(r => r.day >= fortnight[0] && r.day < week[0]),
    });
    const events = data.events.filter(e => e.at >= dayStart(days[0]));
    report.events = events;
    report.event_stats = eventStats(events, { slowRequestMs: data.slow_request_ms, slowPageMs: data.slow_page_ms });
    onReport?.(report);
    const items = new Map(report.items.map(item => [item.metric, item]));
    if (!items.has(selected) || !chosen) {
      const worst = sortItems(report.items.filter(i => i.main))[0];
      if (!items.has(selected)) chosen = false;
      if (!chosen) selected = worst?.metric || '';
    }
    const item = items.get(selected);
    results.className = '';
    if (!report.items.length && !events.length) {
      results.innerHTML = `<p class="hint">No timings in ${PERIOD_NAMES[period.value]}. Use PINE, then refresh after a few seconds. Tracking starts after deployment and a tab reload.</p>`;
      return;
    }
    const keep = (key, fallback) => sections[key] ?? fallback;
    const shown = allEvents ? events : events.slice(0, EVENTS_SHOWN);
    results.innerHTML = `<div class="perf-section"><h3>Slow and failed (${events.length})</h3><p class="hint">${esc(eventSummary(report.event_stats, PERIOD_NAMES[period.value]))} Each one is listed below, newest first: page opens over ${chartDuration(data.slow_page_ms)}, server requests over ${chartDuration(data.slow_request_ms)} and failed requests.</p>
        ${eventsTable(shown, esc)}${events.length > shown.length ? `<button type="button" class="btn sm" data-all-events>Show all ${events.length}</button>` : ''}</div>
      <div class="perf-section"><h3>Pages</h3><p class="hint">How long staff wait for each page to open. Expand a page to see the requests behind it.</p><div class="perf-legend"><span>Where the time goes:</span><span><i class="perf-key database"></i>Database</span><span><i class="perf-key provider"></i>Outside provider</span><span><i class="perf-key app"></i>App processing</span></div>${pagesTable(report, { selected, open, sort: sort.value }, esc)}</div>
      <div class="perf-chart" data-trend><h3>Is ${item ? esc(item.label) : 'it'} getting better or worse?</h3>${item ? `<p class="hint">${item.kind === 'page' ? 'Staff wait to open the page' : item.source === 'browser' ? 'Staff wait for this request' : 'Server time for this request'}, by day. ${esc(item.reason)}. Click any name in the tables to chart it.</p>
        ${dailyChart(dailyPoints(rows, data.bucket_upper_ms, item.source, item.metric, item.kind), { days, label: item.label, kind: item.kind, releases: data.releases }, esc)}` : '<p class="hint">Click a name in the tables to chart it.</p>'}</div>
      <details class="perf-section" data-keep="requests" ${keep('requests', !report.pages.length) ? 'open' : ''}><summary><h3>All requests</h3></summary><p class="hint">Every measured request, including ones not tied to a page such as background update checks.</p>${requestsTable(report, { selected, sort: sort.value }, esc)}</details>
      <details class="perf-details" data-keep="technical" ${keep('technical', false) ? 'open' : ''}><summary>Technical details</summary><p class="hint">All stages and outcomes for the selected period. Server includes database and provider time. p50/p95 are bucket upper bounds.</p>${technicalTable(report, esc)}</details>`;
  };
  const load = async () => {
    const request = ++generation;
    refresh.disabled = true;
    if (!data) { results.className = 'loading sm'; results.textContent = 'Loading timings…'; }
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const next = await api('GET', `/api/performance?days=90&tz=${encodeURIComponent(zone)}`);
      if (request !== generation || !panel.isConnected) return;
      data = next;
      draw();
    } catch (error) {
      if (request === generation && panel.isConnected) { results.className = 'banner err'; results.textContent = `Couldn't load timings: ${error.message}`; }
    } finally { if (request === generation) refresh.disabled = false; }
  };
  const select = metric => {
    selected = metric; chosen = true;
    draw();
    panel.querySelector('[data-trend]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  refresh.addEventListener('click', load);
  period.addEventListener('change', draw);
  sort.addEventListener('change', draw);
  // <details> toggles do not bubble; capture them so redraws keep each section as the admin left it.
  results.addEventListener('toggle', event => {
    if (event.target.dataset?.keep) sections[event.target.dataset.keep] = event.target.open;
  }, true);
  results.addEventListener('click', event => {
    if (event.target.closest('[data-all-events]')) { allEvents = true; draw(); return; }
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      const metric = expand.dataset.expand;
      if (open.has(metric)) open.delete(metric); else open.add(metric);
      draw();
      results.querySelector(`[data-expand="${CSS.escape(metric)}"]`)?.focus();
      return;
    }
    const pick = event.target.closest('[data-pick-metric]');
    if (!pick) return;
    select(pick.dataset.pickMetric);
    [...results.querySelectorAll('[data-pick-metric]')].find(el => el.dataset.pickMetric === selected)?.focus({ preventScroll: true });
  });
  const ready = load();
  // Jump from the summary: open its page or the request list, then chart it.
  const reveal = metric => {
    if (!report) return;
    if (!metric.endsWith('-render')) {
      const page = report.pages.find(p => (PAGE_KEYS[p.metric] || []).includes(metric));
      if (page) open.add(page.metric); else sections.requests = true;
    }
    select(metric);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return { ready, reveal };
}

const PAGE_KEYS = Object.fromEntries(Object.entries(PAGE_REQUESTS).map(([view, r]) => [`${view}-render`, [...r.waits, ...r.after]]));
