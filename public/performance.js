import { chartDuration, metricLabel, performanceCharts } from './performance-charts.js';

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

export async function loadPerformancePanel(panel, api, esc) {
  panel.innerHTML = `<header class="panel-h"><h2>Performance</h2><button type="button" class="btn sm" data-refresh>Refresh</button></header>
    <div class="row perf-filters"><label>Period <select data-hours><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="336">Last 14 days</option></select></label>
      <label>Version <select data-version><option value="current">Current release</option><option value="">All releases</option></select></label>
      <label>View <select data-source><option value="browser">Staff experience</option><option value="server">Server processing</option><option value="database">Database work</option></select></label>
      <label>Trend for <select data-metric aria-label="Measurement to chart"><option value="">Waiting for timings…</option></select></label></div>
    <p class="hint">Typical means the middle recorded timing. “95% finish within” shows the slower end of successful timings. Both are approximate upper bounds, not exact times.</p>
    <div data-results aria-live="polite" class="loading sm">Loading timings…</div>`;
  const hours = panel.querySelector('[data-hours]'), release = panel.querySelector('[data-version]');
  const source = panel.querySelector('[data-source]'), metric = panel.querySelector('[data-metric]');
  const results = panel.querySelector('[data-results]'), refresh = panel.querySelector('[data-refresh]');
  let generation = 0, data, sourceChosen = false;
  const draw = () => {
    if (!data) return;
    const metrics = data.summary.filter(row => row.source === source.value && row.outcome === 'ok');
    const previous = metric.value;
    metric.innerHTML = metrics.length ? metrics.map(row => `<option value="${esc(row.metric)}">${esc(metricLabel(row.metric))}</option>`).join('') : '<option value="">No successful timings</option>';
    if (metrics.some(row => row.metric === previous)) metric.value = previous;
    const technicalOpen = results.querySelector('.perf-details')?.open;
    results.className = '';
    if (!data.summary.length) { results.innerHTML = '<p class="hint">No timings yet for this period and version. Use PINE, then refresh after a few seconds. Tracking starts after deployment and a tab reload.</p>'; return; }
    results.innerHTML = performanceCharts(data, source.value, metric.value, esc) +
      `<details class="perf-details" ${technicalOpen ? 'open' : ''}><summary>Technical details</summary><p class="hint">All stages and outcomes for the selected period and release. Server includes database time. p50/p95 are bucket upper bounds.</p>
        <div class="table-wrap"><table class="grid"><thead><tr><th>Measurement</th><th>Stage</th><th>Result</th><th>Samples</th><th>Mean</th><th>p50 ≤</th><th>p95 ≤</th><th>Max</th></tr></thead><tbody>${data.summary.map(row =>
          `<tr><td>${esc(row.metric)}</td><td>${esc({ server: 'Server', database: 'Database', browser: 'Browser' }[row.source] || row.source)}</td><td>${row.outcome === 'ok' ? 'OK' : 'Error'}</td><td>${row.count}</td><td>${chartDuration(row.mean_ms)}</td><td>${chartDuration(row.p50_upper_ms)}</td><td>${chartDuration(row.p95_upper_ms)}</td><td>${chartDuration(row.max_ms)}</td></tr>`).join('')}</tbody></table></div></details>`;
  };
  const load = async () => {
    const request = ++generation;
    refresh.disabled = true;
    data = null;
    results.className = 'loading sm'; results.textContent = 'Loading timings…';
    try {
      const next = await api('GET', `/api/performance?hours=${hours.value}${release.value ? `&version=${release.value}` : ''}`);
      if (request !== generation || !panel.isConnected) return;
      data = next;
      const selected = release.value;
      const versions = [...new Set([...data.versions, ...(/^[a-f0-9]{8}$/.test(selected) ? [selected] : [])])];
      release.innerHTML = `<option value="current">Current release (${esc(data.current_version)})</option><option value="">All releases</option>` +
        versions.filter(v => v !== data.current_version).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      release.value = selected;
      if (!sourceChosen && !data.summary.some(row => row.source === 'browser') && data.summary.some(row => row.source === 'server')) source.value = 'server';
      draw();
    } catch (error) {
      if (request === generation && panel.isConnected) results.textContent = `Couldn't load timings: ${error.message}`;
    } finally { if (request === generation) refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  hours.addEventListener('change', load);
  release.addEventListener('change', load);
  source.addEventListener('change', () => { sourceChosen = true; draw(); });
  metric.addEventListener('change', draw);
  results.addEventListener('click', event => {
    const button = event.target.closest('[data-pick-metric]');
    if (!button) return;
    metric.value = button.dataset.pickMetric;
    draw();
    [...results.querySelectorAll('[data-pick-metric]')].find(el => el.dataset.pickMetric === metric.value)?.focus();
  });
  await load();
}
