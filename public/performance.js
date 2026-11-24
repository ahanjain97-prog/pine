import { PAGE_REQUESTS, buildReport, chartDuration, hourlyTimings, pagesTable, previousVersion, requestsTable, slowRequestsTable, sortItems, technicalTable, TARGETS, trendChart } from './performance-charts.js';

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

export function createTimings(version) {
  const samples = [];
  let timer;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!samples.length || !/^[a-f0-9]{8}$/.test(version || '')) return;
    const batch = samples.splice(0, 30);
    fetch('/api/performance', { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-PINE': '1' },
      body: JSON.stringify({ version, samples: batch }),
    }).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  return (metric, ms, outcome = 'ok') => {
    if (!metric || document.hidden || !Number.isFinite(ms) || ms < 0 || ms > 300000) return;
    if (samples.length < 30) samples.push({ metric, ms: Math.round(ms), outcome });
    if (!timer) timer = setTimeout(flush, 5000);
  };
}

const HOW_TO_READ = `<details class="perf-help"><summary>How to read this</summary><ul class="hint">
  <li><b>Status</b> compares the average with targets: pages should open within ${chartDuration(TARGETS.page.good)} (slow over ${chartDuration(TARGETS.page.slow)}); requests within ${chartDuration(TARGETS.request.good)} (slow over ${chartDuration(TARGETS.request.slow)}). Something that is usually fast but has a slow end over ${chartDuration(TARGETS.page.spike)} (pages) or ${chartDuration(TARGETS.request.spike)} (requests) is marked Watch.</li>
  <li><b>Average</b> is exact. <b>Slow end</b> is the time 95% finish within, rounded up to a timing bucket, so it is an upper bound.</li>
  <li><b>Total wait</b> is the staff time spent waiting on it in this period (uses × average). It shows what is worth fixing first.</li>
  <li><b>Where the time goes</b> splits average server time into database, outside providers (Impect, Transfermarkt, NCAA, physical data) and app processing. "Mostly network or download" means staff wait at least twice as long as the server works. Browser and server timings are collected separately, so they are compared, never subtracted.</li>
  <li><b>Page</b> timings cover opening the page shell. Panels that load afterwards are listed as separate requests when you expand the page.</li>
  <li><b>vs previous</b> compares averages with the release before the selected one, when both have at least 20 timings. Under 20 timings is marked "few".</li>
  <li>Timings started when this page was deployed and are kept for 14 days. No player, staff, URL or content details are stored.</li>
</ul></details>`;

export function loadPerformancePanel(panel, api, esc, { onReport } = {}) {
  panel.innerHTML = `<header class="panel-h"><h2>What is slow?</h2><button type="button" class="btn sm" data-refresh>Refresh</button></header>
    <div class="row perf-filters"><label>Period <select data-hours><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="336">Last 14 days</option></select></label>
      <label>Release <select data-version><option value="current">Current release</option><option value="">All releases</option></select></label>
      <label>Order <select data-sort><option value="status">Worst first</option><option value="impact">Most total wait</option></select></label></div>
    ${HOW_TO_READ}<div data-results aria-live="polite" class="loading sm">Loading timings…</div>`;
  const hours = panel.querySelector('[data-hours]'), release = panel.querySelector('[data-version]');
  const sort = panel.querySelector('[data-sort]'), results = panel.querySelector('[data-results]'), refresh = panel.querySelector('[data-refresh]');
  let generation = 0, data, report, selected = '', chosen = false;
  const open = new Set(), sections = {};
  const versionOf = () => release.value === 'current' ? data.current_version : release.value;
  const draw = () => {
    if (!data) return;
    const since = Math.floor((Date.now() - Number(hours.value) * 3600000) / 3600000) * 3600000;
    const version = versionOf(), inPeriod = data.rows.filter(r => r.hour >= since);
    const rows = version ? inPeriod.filter(r => r.version === version) : inPeriod;
    // The previous release is found across all 14 days: it may have been replaced before this period began.
    const previous = version && previousVersion(data.rows, version);
    report = buildReport(rows, data.bucket_upper_ms, previous ? data.rows.filter(r => r.version === previous) : null);
    onReport?.(report);
    const items = new Map(report.items.map(item => [item.metric, item]));
    if (!items.has(selected) || !chosen) {
      const worst = sortItems(report.items.filter(i => i.main))[0];
      if (!items.has(selected)) chosen = false;
      if (!chosen) selected = worst?.metric || '';
    }
    const item = items.get(selected);
    results.className = '';
    if (!report.items.length) {
      results.innerHTML = '<p class="hint">No timings yet for this period and release. Use PINE, then refresh after a few seconds. Tracking starts after deployment and a tab reload.</p>';
      return;
    }
    const slow = data.slow_requests.filter(r => r.at >= since && (!version || r.version === version)).slice(0, 100);
    const keep = (key, fallback) => sections[key] ?? fallback;
    results.innerHTML = `${previous ? `<p class="hint">"vs previous" compares with release ${esc(previous)}, across its whole 14-day history.</p>` : ''}
      <div class="perf-section"><h3>Pages</h3><p class="hint">How long staff wait for each page to open. Expand a page to see the requests behind it.</p><div class="perf-legend"><span>Where the time goes:</span><span><i class="perf-key database"></i>Database</span><span><i class="perf-key provider"></i>Outside provider</span><span><i class="perf-key app"></i>App processing</span></div>${pagesTable(report, { selected, open, sort: sort.value }, esc)}</div>
      <div class="perf-chart" data-trend><h3>Is ${item ? esc(item.label) : 'it'} getting better or worse?</h3>${item ? `<p class="hint">${item.kind === 'page' ? 'Staff wait to open the page' : item.source === 'browser' ? 'Staff wait for this request' : 'Server time for this request'}, by hour. ${esc(item.reason)}. Click any name in the tables to chart it.</p>
        ${trendChart(hourlyTimings(rows, data.bucket_upper_ms, item.source, item.metric), { since, label: item.label, kind: item.kind }, esc)}` : '<p class="hint">Click a name in the tables to chart it.</p>'}</div>
      <details class="perf-section" data-keep="requests" ${keep('requests', !report.pages.length) ? 'open' : ''}><summary><h3>All requests</h3></summary><p class="hint">Every measured request, including ones not tied to a page such as background update checks.</p>${requestsTable(report, { selected, sort: sort.value }, esc)}</details>
      <details class="perf-section" data-keep="slow" ${keep('slow', slow.length > 0) ? 'open' : ''}><summary><h3>Recent slow requests (${slow.length})</h3></summary><p class="hint">Individual server requests over ${chartDuration(data.slow_request_ms)}, newest first (up to 100). Each shows where its own time went. Browser-side time is not included.</p>${slowRequestsTable(slow, data.slow_request_ms, esc)}</details>
      <details class="perf-details" data-keep="technical" ${keep('technical', false) ? 'open' : ''}><summary>Technical details</summary><p class="hint">All stages and outcomes for the selected period and release. Server includes database and provider time. p50/p95 are bucket upper bounds.</p>${technicalTable(report, esc)}</details>`;
  };
  const load = async () => {
    const request = ++generation;
    refresh.disabled = true;
    if (!data) { results.className = 'loading sm'; results.textContent = 'Loading timings…'; }
    try {
      const next = await api('GET', '/api/performance?hours=336');
      if (request !== generation || !panel.isConnected) return;
      data = next;
      const current = release.value, first = new Map();
      for (const row of data.rows) first.set(row.version, Math.min(row.hour, first.get(row.version) ?? Infinity));
      const versions = [...first].filter(([v]) => v !== data.current_version).sort((a, b) => b[1] - a[1]);
      const since = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric' });
      release.innerHTML = `<option value="current">Current release (${esc(data.current_version)})</option><option value="">All releases</option>` +
        versions.map(([v, hour]) => `<option value="${esc(v)}">${esc(v)} · from ${esc(since(hour))}</option>`).join('');
      release.value = [...release.options].some(o => o.value === current) ? current : 'current';
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
  hours.addEventListener('change', draw);
  release.addEventListener('change', draw);
  sort.addEventListener('change', draw);
  // <details> toggles do not bubble; capture them so redraws keep each section as the admin left it.
  results.addEventListener('toggle', event => {
    if (event.target.dataset?.keep) sections[event.target.dataset.keep] = event.target.open;
  }, true);
  results.addEventListener('click', event => {
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
