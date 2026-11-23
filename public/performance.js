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
    <div class="row"><label>Period <select data-hours><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="336">Last 14 days</option></select></label>
      <label>Version <select data-version><option value="current">Current release</option><option value="">All releases</option></select></label></div>
    <p class="hint">Server includes database work. Browser includes transfer and JSON decoding; render measures the page shell, with panels loading separately. p50/p95 are approximate upper bounds. Browser and server samples are collected independently.</p>
    <div data-results aria-live="polite" class="loading sm">Loading timings…</div>`;
  const hours = panel.querySelector('[data-hours]'), release = panel.querySelector('[data-version]');
  const results = panel.querySelector('[data-results]'), refresh = panel.querySelector('[data-refresh]');
  let generation = 0;
  const duration = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  const load = async () => {
    const request = ++generation;
    refresh.disabled = true;
    try {
      const data = await api('GET', `/api/performance?hours=${hours.value}${release.value ? `&version=${release.value}` : ''}`);
      if (request !== generation || !panel.isConnected) return;
      const selected = release.value;
      release.innerHTML = `<option value="current">Current release (${esc(data.current_version)})</option><option value="">All releases</option>` +
        data.versions.filter(v => v !== data.current_version).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      release.value = selected;
      results.className = '';
      if (!data.summary.length) { results.innerHTML = '<p class="hint">No timings yet for this period and version. Use PINE, then refresh after a few seconds. Tracking starts after deployment and a tab reload.</p>'; return; }
      results.innerHTML = `<p class="hint">Slowest p95 first. A high database time points to SQL; high server time with low database time needs a closer look at provider calls or application work.</p>
        <div class="table-wrap"><table class="grid"><thead><tr><th>Measurement</th><th>Stage</th><th>Result</th><th>Samples</th><th>Mean</th><th>p50 ≤</th><th>p95 ≤</th><th>Max</th></tr></thead><tbody>${data.summary.map(row =>
          `<tr><td>${esc(row.metric)}</td><td>${esc({ server: 'Server', database: 'Database', browser: 'Browser' }[row.source] || row.source)}</td><td>${row.outcome === 'ok' ? 'OK' : 'Error'}</td><td>${row.count}</td><td>${duration(row.mean_ms)}</td><td>${duration(row.p50_upper_ms)}</td><td>${duration(row.p95_upper_ms)}</td><td>${duration(row.max_ms)}</td></tr>`).join('')}</tbody></table></div>`;
    } catch (error) {
      if (request === generation && panel.isConnected) results.textContent = `Couldn't load timings: ${error.message}`;
    } finally { if (request === generation) refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  hours.addEventListener('change', load);
  release.addEventListener('change', load);
  await load();
}
