const LABELS = {
  players: 'Player database', player: 'Player details', 'playing-time': 'Playing-time stats',
  'impect-kpis': 'Player performance stats', 'card-options': 'Card season options', cards: 'Scouting card list',
  maps: 'Pitch map list', physical: 'Physical stats', 'impect-candidates': 'Impect player matches',
  'tm-candidates': 'Transfermarkt matches', 'mlsnp-gates': 'MLS NEXT Pro checks', config: 'App settings',
  changes: 'Background update checks', ncaa: 'NCAA board', 'ncaa-prospects': 'NCAA prospects', review: 'War Room',
  activity: 'Activity feed', analysis: 'Analysis library', 'impect-search': 'Impect search',
  'impect-iterations': 'Impect seasons', 'impect-shortlists': 'Impect shortlists', 'impect-cache': 'Impect cache status',
  board: 'Big Board', 'short-board': 'Short Board', roster: 'Roster', 'war-room': 'War Room',
  compare: 'Player comparison', impect: 'Impect', staff: 'Staff settings',
};
export const metricLabel = metric => metric.endsWith('-render')
  ? `${LABELS[metric.slice(0, -7)] || metric.slice(0, -7)} · page opening` : LABELS[metric] || metric;
export const chartDuration = ms => ms == null ? 'No samples' : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min`
  : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

// Merge counts, never average percentiles. Releases may have very different sample sizes.
export function hourlyTimings(rows, limits, source, metric) {
  const hours = new Map();
  for (const row of rows) {
    if (row.source !== source || row.metric !== metric || row.outcome !== 'ok' || row.count <= 0) continue;
    if (!hours.has(row.hour)) hours.set(row.hour, { hour: row.hour, count: 0, buckets: limits.map(() => 0) });
    const point = hours.get(row.hour);
    point.count += row.count;
    row.buckets.forEach((count, i) => { point.buckets[i] += count; });
  }
  return [...hours.values()].sort((a, b) => a.hour - b.hour).map(point => {
    const percentile = fraction => {
      let count = 0;
      return limits.find((_, i) => (count += point.buckets[i]) >= point.count * fraction);
    };
    return { hour: point.hour, count: point.count, typical_ms: percentile(0.5), slower_ms: percentile(0.95) };
  });
}

const percent = (value, max) => Math.max(0, Math.min(100, 100 * value / max));
const sampleLabel = count => `${count} sample${count === 1 ? '' : 's'}${count < 20 ? ' · few samples' : ''}`;

export function responseTimeAxis(values, { fullRange = false } = {}) {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const largest = Math.max(1, sorted.at(-1) || 0);
  const median = sorted[Math.floor((sorted.length - 1) / 2)] || 0;
  const normal = sorted.filter(v => v <= Math.max(1000, median * 8));
  const canZoom = normal.length > 0 && normal.length < sorted.length;
  const target = canZoom && !fullRange ? Math.max(1, ...normal) : largest;
  const magnitude = 10 ** Math.floor(Math.log10(target / 4));
  const step = [1, 2, 2.5, 5, 10].find(n => n * magnitude >= target / 4) * magnitude;
  const max = Math.ceil(target / step) * step, seconds = max >= 1000;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => {
    const value = i * step;
    return { value, label: String(Number((value / (seconds ? 1000 : 1)).toFixed(3))) };
  });
  return { max, ticks, unit: seconds ? 'seconds' : 'milliseconds', canZoom,
    clipped: sorted.filter(v => v > max).length };
}

export function slowestChart(summary, source, selected, esc, { fullRange = false } = {}) {
  const rows = summary.filter(row => row.source === source && row.outcome === 'ok')
    .sort((a, b) => b.p95_upper_ms - a.p95_upper_ms || b.mean_ms - a.mean_ms).slice(0, 8);
  if (!rows.length) return '<p class="hint">No successful timings for this view yet. Errors, if any, are shown separately below.</p>';
  const axis = responseTimeAxis(rows.map(row => row.p95_upper_ms), { fullRange }), max = axis.max;
  const grid = axis.ticks.map(tick => `<span class="perf-bar-grid-line" style="left:${percent(tick.value, max)}%"></span>`).join('');
  return `<div class="perf-scale-controls"><p class="hint">Response time (${axis.unit}) · shorter is faster</p>${axis.canZoom ? `<button type="button" class="btn sm" data-toggle-latency-range>${fullRange ? 'Zoom to normal range' : 'Show full range'}</button>` : ''}</div>
    ${axis.clipped ? `<p class="hint perf-zoom-note">Zoomed in so normal requests stay readable. ${axis.clipped} measurement${axis.clipped === 1 ? ' is' : 's are'} beyond the scale; » marks the clipped bar and its time is labeled.</p>` : ''}
    <div class="perf-legend"><span><i class="perf-key slower"></i>95% finish within</span><span><i class="perf-key typical"></i>Typical</span></div>
    <div class="perf-bars">${rows.map(row => `<button type="button" class="perf-bar-row" data-pick-metric="${esc(row.metric)}" aria-pressed="${row.metric === selected}">
      <span class="perf-bar-label"><b>${esc(metricLabel(row.metric))}</b><small>${sampleLabel(row.count)}</small></span>
      <span class="perf-bar-track" aria-hidden="true"><span class="perf-bar-fill${row.p95_upper_ms > max ? ' clipped' : ''}" style="width:${percent(row.p95_upper_ms, max)}%"></span>${grid}${row.p50_upper_ms <= max ? `<span class="perf-bar-marker" style="left:${percent(row.p50_upper_ms, max)}%"></span>` : ''}${row.p95_upper_ms > max ? '<span class="perf-bar-overflow">»</span>' : ''}</span>
      <span class="perf-bar-value">≤ ${chartDuration(row.p95_upper_ms)}${row.p95_upper_ms > max ? '<small class="perf-off-scale">Beyond scale</small>' : ''}<small>Typical ≤ ${chartDuration(row.p50_upper_ms)}</small></span>
    </button>`).join('')}</div><div class="perf-bar-axis"><span></span><div><div class="perf-axis-ticks">${axis.ticks.map(tick => `<span class="perf-axis-tick" style="left:${percent(tick.value, max)}%">${tick.label}</span>`).join('')}</div><div class="perf-axis-unit">Response time (${axis.unit})</div></div><span></span></div>`;
}

export function trendChart(points, { since, end = Date.now(), label }, esc) {
  if (!points.length) return '<p class="hint">No successful timings for this selection yet.</p>';
  const start = Math.min(since, points[0].hour), finish = Math.max(end, points.at(-1).hour + 3600000);
  const max = Math.max(1, ...points.map(p => p.slower_ms));
  const x = p => 6 + 588 * (p.hour - start) / (finish - start);
  const y = (p, key) => 194 - 188 * p[key] / max;
  const segments = [];
  for (const point of points) {
    const previous = segments.at(-1)?.at(-1);
    if (!previous || point.hour - previous.hour > 3600000) segments.push([]);
    segments.at(-1).push(point);
  }
  const line = (key, cls) => segments.map(group => `<polyline class="${cls}" points="${group.map(p => `${x(p).toFixed(2)},${y(p, key).toFixed(2)}`).join(' ')}"/>`).join('') +
    points.map(p => `<circle class="${cls}" cx="${x(p).toFixed(2)}" cy="${y(p, key).toFixed(2)}" r="3"><title>${esc(new Date(p.hour).toLocaleString())}: ≤ ${chartDuration(p[key])}, ${sampleLabel(p.count)}</title></circle>`).join('');
  const date = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
  return `<div class="perf-legend"><span><i class="perf-key slower"></i>95% finish within</span><span><i class="perf-key typical"></i>Typical</span></div>
    <div class="perf-plot"><div class="perf-y-axis"><span>${chartDuration(max)}</span><span>${chartDuration(max / 2)}</span><span>0</span></div>
      <svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: typical and slower response times by hour. Higher is slower. Missing hours have gaps.">
        <path class="perf-grid-line" d="M6 6H594 M6 100H594 M6 194H594"/>
        ${line('slower_ms', 'perf-line-slower')}${line('typical_ms', 'perf-line-typical')}
      </svg></div><div class="perf-time-axis"><span>${esc(date(start))}</span><span>${esc(date(finish))}</span></div>
    <p class="hint">Higher means slower. ${points.length === 1 ? 'Only one hour of data so far. ' : ''}Gaps mean no recorded successful timings; they are not zero. Values are approximate upper bounds from timing buckets. Equal bounds may hide smaller changes.</p>
    <details class="perf-hourly"><summary>Hourly chart values</summary><div class="table-wrap"><table class="grid"><thead><tr><th>Hour</th><th>Samples</th><th>Typical ≤</th><th>95% finish within</th></tr></thead><tbody>${points.map(p => `<tr><td>${esc(new Date(p.hour).toLocaleString())}</td><td>${p.count}</td><td>${chartDuration(p.typical_ms)}</td><td>${chartDuration(p.slower_ms)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

export function performanceCharts(data, source, selected, esc, options = {}) {
  const good = data.summary.filter(r => r.source === source && r.outcome === 'ok');
  const errors = data.summary.filter(r => r.source === source && r.outcome === 'error').reduce((n, r) => n + r.count, 0);
  const total = good.reduce((n, r) => n + r.count, 0) + errors;
  const descriptions = {
    browser: 'What staff experience: request, transfer and decoding time. Page-opening timings cover the page shell; panels finish separately.',
    server: 'Time PINE spends handling each request, including database work. It excludes transfer to the browser.',
    database: 'Time spent on database work inside a request. It is part of server time, so do not add them together.',
  };
  const summary = good.find(r => r.metric === selected);
  const points = hourlyTimings(data.rows, data.bucket_upper_ms, source, selected);
  return `<p class="hint">${descriptions[source]} Browser and server observations are collected separately.</p>
    <div class="perf-chart"><h3>What’s slowest?</h3><p class="hint">Longest slower-response times first, up to 8 measurements. Click a row to see its trend. ${total} recorded timings; ${errors} failures${total ? ` (${(100 * errors / total).toFixed(1)}%)` : ''}. Charts show successful timings.</p>${slowestChart(data.summary, source, selected, esc, options)}</div>
    <div class="perf-chart"><h3>Is it getting better or worse?</h3><p><b>${selected ? esc(metricLabel(selected)) : 'Choose a view with successful timings'}</b>${summary ? ` · typical ≤ ${chartDuration(summary.p50_upper_ms)} · 95% finish within ${chartDuration(summary.p95_upper_ms)} · ${sampleLabel(summary.count)}` : ''}</p>
      ${trendChart(points, { since: data.since, label: metricLabel(selected) }, esc)}</div>`;
}

export function buildTimingChart(queues) {
  const values = queues.flatMap(q => [q.queue_samples ? q.mean_queue_ms : null, q.build_samples ? q.mean_build_ms : null]).filter(v => v != null);
  const max = Math.max(1, ...values);
  return `<section class="perf-chart"><h2>Why do card and map builds take time?</h2><p class="hint">Average queue wait versus average build time, over the last 24 hours. Separate averages can come from different jobs. Retry waits include time since the original request.</p>
    <div class="perf-build-bars">${queues.map(q => `<div><h3>${q.kind === 'cards' ? 'Scouting cards' : 'Pitch maps'}</h3>${[['Queue wait', q.mean_queue_ms, q.queue_samples, 'queue'], ['Build time', q.mean_build_ms, q.build_samples, 'build']].map(([label, ms, count, cls]) =>
      `<div class="perf-build-row"><span>${label}</span><span class="perf-bar-track" aria-hidden="true"><span class="perf-bar-fill ${cls}" style="width:${count && ms != null ? percent(ms, max) : 0}%"></span></span><span>${count ? chartDuration(ms) : 'No samples'}<small>${count} ${cls === 'queue' ? 'starts' : 'completions'}</small></span></div>`).join('')}</div>`).join('')}</div>
    ${values.length ? `<div class="perf-build-axis"><span></span><div class="perf-scale"><span>0</span><span>${chartDuration(max)}</span></div><span></span></div>` : '<p class="hint">No starts or completions observed yet. Timings appear as jobs are processed.</p>'}</section>`;
}
