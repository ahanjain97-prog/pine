const LABELS = {
  players: 'Player database', player: 'Player details', 'playing-time': 'Playing-time stats',
  'impect-kpis': 'Player performance stats', 'card-options': 'Card season options', cards: 'Scouting card list',
  maps: 'Pitch map list', physical: 'Physical stats', 'impect-candidates': 'Impect player matches',
  'tm-candidates': 'Transfermarkt matches', 'mlsnp-gates': 'MLS NEXT Pro checks', config: 'App settings',
  changes: 'Background update checks', ncaa: 'NCAA board', 'ncaa-prospects': 'NCAA prospects', review: 'War Room data',
  activity: 'Activity feed', analysis: 'Analysis library', 'impect-search': 'Impect search',
  'impect-iterations': 'Impect seasons', 'impect-shortlists': 'Impect shortlists', 'impect-cache': 'Impect cache status',
  board: 'Big Board', 'short-board': 'Short Board', roster: 'Roster', 'war-room': 'War Room',
  compare: 'Player comparison', impect: 'Impect', staff: 'Staff settings',
};
export const metricLabel = metric => metric.endsWith('-render')
  ? `${LABELS[metric.slice(0, -7)] || metric.slice(0, -7)} page` : LABELS[metric] || metric;
export const chartDuration = ms => ms == null ? 'No samples' : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min`
  : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

// Targets sit on timing-bucket edges, so "over the limit" never depends on rounding inside a bucket.
export const TARGETS = {
  page: { good: 1000, slow: 2000, spike: 5000 },
  request: { good: 250, slow: 1000, spike: 3000 },
};
export const MIN_SAMPLES = 5;
export const FEW_SAMPLES = 20;

// Requests each page makes. `waits`: the page shell waits for it. `after`: panels that load once the page is open.
export const PAGE_REQUESTS = {
  player: { waits: ['player'], after: ['playing-time', 'impect-kpis', 'card-options', 'cards', 'maps', 'physical', 'mlsnp-gates', 'impect-candidates', 'tm-candidates'] },
  ncaa: { waits: ['ncaa'], after: ['ncaa-prospects'] },
  'war-room': { waits: ['review'], after: [] },
  impect: { waits: [], after: ['impect-iterations', 'impect-search', 'impect-shortlists', 'impect-cache'] },
  activity: { waits: ['activity'], after: [] },
  analysis: { waits: ['analysis'], after: [] },
  compare: { waits: [], after: ['impect-kpis', 'physical', 'cards'] },
};
const SIGN_IN = 'Opens from the player list loaded at sign-in (Player database), so opening it makes no measured requests. Slowness here is drawing the page in the browser.';
const PAGE_NOTES = { board: SIGN_IN, 'short-board': SIGN_IN, roster: SIGN_IN, players: SIGN_IN,
  staff: 'Its staff list request is not measured. Slowness here is drawing the page or that request.' };

const percentile = (buckets, count, limits, fraction) => {
  let seen = 0;
  return limits.find((_, i) => (seen += buckets[i]) >= count * fraction);
};

// Merge counts, never average percentiles. Releases and hours may have very different sample sizes.
export function summarize(rows, limits) {
  const groups = new Map();
  for (const row of rows) {
    if (!(row.count > 0)) continue;
    const key = `${row.source}|${row.metric}|${row.outcome}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { source: row.source, metric: row.metric, outcome: row.outcome,
      count: 0, total_ms: 0, max_ms: 0, queries: 0, buckets: limits.map(() => 0) });
    group.count += row.count; group.total_ms += row.total_ms; group.queries += row.queries || 0;
    group.max_ms = Math.max(group.max_ms, row.max_ms || 0);
    row.buckets.forEach((n, i) => { group.buckets[i] += n; });
  }
  for (const group of groups.values()) {
    Object.assign(group, { mean_ms: group.total_ms / group.count, mean_queries: group.queries / group.count,
      p50_upper_ms: percentile(group.buckets, group.count, limits, 0.5), p95_upper_ms: percentile(group.buckets, group.count, limits, 0.95) });
  }
  return groups;
}

export function hourlyTimings(rows, limits, source, metric) {
  const hours = new Map();
  for (const row of rows) {
    if (row.source !== source || row.metric !== metric || row.outcome !== 'ok' || row.count <= 0) continue;
    if (!hours.has(row.hour)) hours.set(row.hour, { hour: row.hour, count: 0, total_ms: 0, buckets: limits.map(() => 0) });
    const point = hours.get(row.hour);
    point.count += row.count; point.total_ms += row.total_ms;
    row.buckets.forEach((count, i) => { point.buckets[i] += count; });
  }
  return [...hours.values()].sort((a, b) => a.hour - b.hour).map(point => ({ hour: point.hour, count: point.count,
    mean_ms: point.total_ms / point.count, typical_ms: percentile(point.buckets, point.count, limits, 0.5),
    slower_ms: percentile(point.buckets, point.count, limits, 0.95) }));
}

export function rate(kind, summary) {
  const target = TARGETS[kind];
  if (!summary || summary.count < MIN_SAMPLES) return { status: 'unknown', reason: 'Too few timings to judge yet' };
  const mean = chartDuration(summary.mean_ms);
  if (summary.mean_ms > target.slow) return { status: 'slow', reason: `Averages ${mean}, over the ${chartDuration(target.slow)} limit` };
  if (summary.mean_ms > target.good) return { status: 'watch', reason: `Averages ${mean}, above the ${chartDuration(target.good)} target` };
  if (summary.p95_upper_ms > target.spike) return { status: 'watch', reason: `Usually fast, but at least 1 in 20 takes over ${chartDuration(target.spike)}` };
  return { status: 'good', reason: `Averages ${mean}, within the ${chartDuration(target.good)} target` };
}

// Database and provider time are recorded with the server time of the same requests, so their
// shares of the server total are like-for-like. Browser and server timings are separate populations:
// they are compared, never subtracted.
export function whereTime(item) {
  const { server, database, external, browser } = item;
  if (!server) return null;
  const db = database?.total_ms || 0, ext = external?.total_ms || 0;
  const scale = Math.max(server.total_ms, db + ext) || 1;
  const parts = [
    { key: 'database', label: 'Database', ms: server.mean_ms * db / scale },
    { key: 'provider', label: 'Outside provider', ms: server.mean_ms * ext / scale },
    { key: 'app', label: 'App processing', ms: Math.max(0, server.mean_ms * (1 - (db + ext) / scale)) },
  ];
  const queries = database?.count ? database.mean_queries : null;
  const target = TARGETS.request.good;
  let text;
  if (browser && browser.count >= MIN_SAMPLES && browser.mean_ms > target && browser.mean_ms >= 2 * server.mean_ms) text = 'Mostly network or download';
  else if (server.mean_ms <= target) text = 'Fast on the server';
  else if (ext / scale >= 0.5) text = 'Mostly waiting on an outside provider';
  else if (db / scale >= 0.5) text = 'Mostly database';
  else text = 'Mostly app processing';
  return { parts, text, queries, server_ms: server.mean_ms, many_queries: queries != null && queries >= 50 };
}

const STATUS_ORDER = { slow: 0, watch: 1, good: 2, unknown: 3 };
export function sortItems(items, sort = 'status') {
  return [...items].sort((a, b) => (sort === 'status' ? STATUS_ORDER[a.status] - STATUS_ORDER[b.status] : 0)
    || b.impact_ms - a.impact_ms || a.label.localeCompare(b.label));
}

// The release seen before `version`, by first observed hour.
export function previousVersion(rows, version) {
  const first = new Map();
  for (const row of rows) first.set(row.version, Math.min(row.hour, first.get(row.version) ?? Infinity));
  const mine = first.get(version) ?? Infinity;
  return [...first].filter(([v, hour]) => v !== version && hour <= mine).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

export function buildReport(rows, limits, previousRows = null) {
  const all = summarize(rows, limits), before = previousRows && summarize(previousRows, limits);
  const get = (map, source, metric, outcome = 'ok') => map?.get(`${source}|${metric}|${outcome}`);
  const metrics = [...new Set([...all.values()].filter(g => g.source !== 'database' && g.source !== 'external').map(g => g.metric))];
  const items = metrics.map(metric => {
    const kind = metric.endsWith('-render') ? 'page' : 'request';
    const browser = get(all, 'browser', metric), server = get(all, 'server', metric);
    const source = kind === 'page' || (browser && browser.count >= MIN_SAMPLES) || !server ? 'browser' : 'server';
    const main = source === 'browser' ? browser : server;
    const errors = get(all, source, metric, 'error')?.count || 0, total = (main?.count || 0) + errors;
    const old = get(before, source, metric);
    const change = main && old && main.count >= FEW_SAMPLES && old.count >= FEW_SAMPLES ? (main.mean_ms - old.mean_ms) / old.mean_ms : null;
    return { metric, kind, label: metricLabel(metric), source, main, browser, server,
      database: get(all, 'database', metric), external: get(all, 'external', metric),
      errors, error_rate: total ? errors / total : 0, impact_ms: main?.total_ms || 0, change, ...rate(kind, main) };
  });
  const serverRows = [...all.values()].filter(g => g.source === 'server');
  const requestTotal = serverRows.reduce((n, g) => n + g.count, 0);
  const requestErrors = serverRows.filter(g => g.outcome === 'error').reduce((n, g) => n + g.count, 0);
  return { items, pages: items.filter(i => i.kind === 'page'), requests: items.filter(i => i.kind === 'request'),
    request_total: requestTotal, request_errors: requestErrors, groups: all };
}

export function speedVerdict(report) {
  const rated = report.items.filter(i => i.status !== 'unknown');
  const slow = sortItems(report.items.filter(i => i.status === 'slow'), 'impact');
  const watch = sortItems(report.items.filter(i => i.status === 'watch'), 'impact');
  if (!rated.length) return { color: 'none', label: 'No timings yet', slow, watch };
  if (slow.length) return { color: 'fail', label: `${slow.length} slow${watch.length ? ` · ${watch.length} to watch` : ''}`, slow, watch };
  if (watch.length) return { color: 'hold', label: `${watch.length} to watch`, slow, watch };
  return { color: 'pass', label: 'All within target', slow, watch };
}

const STATUS_CHIP = { slow: ['Slow', 'fail'], watch: ['Watch', 'hold'], good: ['Good', 'pass'], unknown: ['Too few', 'none'] };
export const statusChip = (status, esc, title = '') => {
  const [label, color] = STATUS_CHIP[status] || STATUS_CHIP.unknown;
  return `<span class="dchip v-${color}"${title ? ` title="${esc(title)}"` : ''}>${label}</span>`;
};
const samples = count => `${count} sample${count === 1 ? '' : 's'}${count < FEW_SAMPLES ? ' · few' : ''}`;
const changeCell = change => change == null ? '<span class="muted">—</span>'
  : Math.abs(change) < 0.1 ? '<span class="muted">≈ same</span>'
    : change > 0 ? `<span class="perf-worse">▲ ${Math.round(change * 100)}% slower</span>`
      : `<span class="perf-better">▼ ${Math.round(-change * 100)}% faster</span>`;
const errorCell = item => item.errors ? `<span class="${item.error_rate >= 0.05 ? 'perf-worse' : ''}">${item.errors} · ${(100 * item.error_rate).toFixed(1)}%</span>` : '<span class="muted">0</span>';
const timingCells = item => item.main
  ? `<td class="num"><b>${chartDuration(item.main.mean_ms)}</b></td><td class="num">≤ ${chartDuration(item.main.p95_upper_ms)}</td><td class="num">${item.main.count}${item.main.count < FEW_SAMPLES ? ' <small class="muted">few</small>' : ''}</td><td class="num">${chartDuration(item.impact_ms)}</td>`
  : '<td class="num muted">—</td><td class="num muted">—</td><td class="num muted">0</td><td class="num muted">—</td>';
const pickButton = (item, selected, esc) => `<button type="button" class="perf-pick" data-pick-metric="${esc(item.metric)}" aria-pressed="${item.metric === selected}" title="Show its trend">${esc(item.label)}</button>`;

export function breakdownBar(where) {
  if (!where) return '';
  const total = where.parts.reduce((n, p) => n + p.ms, 0) || 1;
  return `<span class="perf-split" role="img" aria-label="${where.parts.map(p => `${p.label} ${chartDuration(p.ms)}`).join(', ')}">${where.parts.map(p => p.ms > 0
    ? `<span class="perf-split-${p.key}" style="width:${(100 * p.ms / total).toFixed(1)}%" title="${p.label}: ${chartDuration(p.ms)} on average"></span>` : '').join('')}</span>`;
}
const whereCell = (item, esc) => {
  const where = whereTime(item);
  if (!where) return '<td class="muted sm">No server timings</td>';
  return `<td class="perf-where">${breakdownBar(where)}<span class="sm">${esc(where.text)}${where.queries != null && where.queries >= 1 ? ` · <span class="${where.many_queries ? 'perf-worse' : 'muted'}">${Math.round(where.queries)} queries</span>` : ''}</span></td>`;
};

export function requestRows(items, selected, esc, tags = {}) {
  return items.map(item => `<tr class="${item.metric === selected ? 'perf-selected' : ''}"><td>${pickButton(item, selected, esc)}${tags[item.metric] ? `<small class="muted">${esc(tags[item.metric])}</small>` : ''}${item.source === 'server' ? '<small class="muted">server time (no browser timings yet)</small>' : ''}</td>
    <td>${statusChip(item.status, esc, item.reason)}</td>${timingCells(item)}${whereCell(item, esc)}<td>${changeCell(item.change)}</td><td class="num">${errorCell(item)}</td></tr>`).join('');
}
const requestHead = first => `<thead><tr><th>${first}</th><th>Status</th><th class="num">Average</th><th class="num">Slow end</th><th class="num">Calls</th><th class="num">Total wait</th><th>Where the time goes</th><th>vs previous</th><th class="num">Errors</th></tr></thead>`;

export function pagesTable(report, { selected, open = new Set(), sort = 'status' }, esc) {
  const pages = sortItems(report.pages, sort);
  if (!pages.length) return '<p class="hint">No page-opening timings yet. They arrive a few seconds after staff open pages in a reloaded tab.</p>';
  const byMetric = new Map(report.requests.map(r => [r.metric, r]));
  return `<div class="table-wrap"><table class="grid perf-table"><thead><tr><th>Page</th><th>Status</th><th class="num">Average</th><th class="num">Slow end</th><th class="num">Opens</th><th class="num">Total wait</th><th>vs previous</th><th class="num">Errors</th></tr></thead><tbody>${pages.map(page => {
    const view = page.metric.slice(0, -7), related = PAGE_REQUESTS[view] || { waits: [], after: [] };
    const metrics = [...related.waits, ...related.after], isOpen = open.has(page.metric);
    const tags = Object.fromEntries([...related.waits.map(m => [m, 'Page waits for this']), ...related.after.map(m => [m, 'Loads after the page opens'])]);
    const requests = metrics.map(m => byMetric.get(m)).filter(Boolean);
    const detail = `<tr class="perf-sub"${isOpen ? '' : ' hidden'}><td colspan="8"><p class="hint">${esc(page.reason)}.${PAGE_NOTES[view] ? ` ${esc(PAGE_NOTES[view])}` : ''}</p>${requests.length
      ? `<div class="table-wrap"><table class="grid perf-table">${requestHead('Request on this page')}<tbody>${requestRows(sortItems(requests, sort), selected, esc, tags)}</tbody></table></div>`
      : metrics.length ? '<p class="hint">No timings yet for its requests.</p>' : ''}</td></tr>`;
    return `<tr class="${page.metric === selected ? 'perf-selected' : ''}"><td><button type="button" class="perf-expand" data-expand="${esc(page.metric)}" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Hide' : 'Show'} requests for ${esc(page.label)}">${isOpen ? '▾' : '▸'}</button>${pickButton(page, selected, esc)}</td>
      <td>${statusChip(page.status, esc, page.reason)}</td>${timingCells(page)}<td>${changeCell(page.change)}</td><td class="num">${errorCell(page)}</td></tr>${detail}`;
  }).join('')}</tbody></table></div>`;
}

export function requestsTable(report, { selected, sort = 'status' }, esc) {
  if (!report.requests.length) return '<p class="hint">No request timings yet.</p>';
  return `<div class="table-wrap"><table class="grid perf-table">${requestHead('Request')}<tbody>${requestRows(sortItems(report.requests, sort), selected, esc)}</tbody></table></div>`;
}

export function slowRequestsTable(rows, threshold, esc) {
  if (!rows.length) return `<p class="hint">No server requests over ${chartDuration(threshold)} in this period.</p>`;
  return `<div class="table-wrap"><table class="grid perf-table"><thead><tr><th>Time</th><th>Request</th><th class="num">Total</th><th>Split</th><th class="num">Database</th><th class="num">Queries</th><th class="num">Provider</th><th class="num">App</th><th>Result</th></tr></thead><tbody>${rows.map(row => {
    const db = Math.min(row.database_ms, row.total_ms), ext = Math.min(row.external_ms, row.total_ms - db);
    const where = { parts: [{ key: 'database', label: 'Database', ms: db }, { key: 'provider', label: 'Outside provider', ms: ext }, { key: 'app', label: 'App processing', ms: Math.max(0, row.total_ms - db - ext) }] };
    return `<tr><td>${esc(new Date(row.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(metricLabel(row.metric))}</td><td class="num"><b>${chartDuration(row.total_ms)}</b></td><td>${breakdownBar(where)}</td><td class="num">${chartDuration(db)}</td><td class="num${row.queries >= 50 ? ' perf-worse' : ''}">${row.queries}</td><td class="num">${row.external_ms ? chartDuration(ext) : '—'}</td><td class="num">${chartDuration(where.parts[2].ms)}</td><td>${row.status < 400 ? 'OK' : `<span class="perf-worse">Error ${Number(row.status)}</span>`}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

const niceMax = value => {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(n => n * magnitude >= value) * magnitude;
};

export function trendChart(points, { since, end = Date.now(), label, kind = 'request' }, esc) {
  if (!points.length) return '<p class="hint">No successful timings for this selection yet.</p>';
  const target = TARGETS[kind];
  const start = Math.min(since, points[0].hour), finish = Math.max(end, points.at(-1).hour + 3600000);
  const highest = Math.max(...points.map(p => p.mean_ms));
  // Keep averages and both targets readable; a far-off slow end is pinned to the top and labelled.
  const cap = Math.max(target.slow, highest) * 4;
  const max = niceMax(Math.max(target.slow * 1.2, highest * 1.15, Math.min(cap, Math.max(...points.map(p => p.slower_ms)))));
  const x = p => 6 + 588 * (p.hour + 1800000 - start) / (finish - start);
  const y = ms => 194 - 188 * Math.min(ms, max) / max;
  const segments = [];
  for (const point of points) {
    const previous = segments.at(-1)?.at(-1);
    if (!previous || point.hour - previous.hour > 3600000) segments.push([]);
    segments.at(-1).push(point);
  }
  const line = (key, cls, name) => segments.map(group => `<polyline class="${cls}" points="${group.map(p => `${x(p).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ')}"/>`).join('') +
    points.map(p => `<circle class="${cls}${p[key] > max ? ' off-scale' : ''}" cx="${x(p).toFixed(2)}" cy="${y(p[key]).toFixed(2)}" r="${p[key] > max ? 5 : 3}"><title>${esc(new Date(p.hour).toLocaleString())}: ${name} ${key === 'slower_ms' ? '≤ ' : ''}${chartDuration(p[key])}${p[key] > max ? ' (above the chart)' : ''}, ${samples(p.count)}</title></circle>`).join('');
  const most = Math.max(...points.map(p => p.count));
  const date = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
  const clipped = points.some(p => p.slower_ms > max);
  const guide = (ms, cls) => `<line class="${cls}" x1="6" x2="594" y1="${y(ms).toFixed(2)}" y2="${y(ms).toFixed(2)}"/>`;
  return `<div class="perf-legend"><span><i class="perf-key average"></i>Average</span><span><i class="perf-key slower"></i>Slow end (95% within)</span><span><i class="perf-key good"></i>Target ${chartDuration(target.good)}</span><span><i class="perf-key limit"></i>Slow over ${chartDuration(target.slow)}</span></div>
    <div class="perf-plot"><div class="perf-y-axis"><span>${chartDuration(max)}</span><span>${chartDuration(max / 2)}</span><span>0</span></div>
      <svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: average and slow-end response time by hour against the targets. Higher is slower. Missing hours have gaps.">
        <path class="perf-grid-line" d="M6 6H594 M6 100H594 M6 194H594"/>${guide(target.good, 'perf-target-good')}${guide(target.slow, 'perf-target-slow')}
        ${line('slower_ms', 'perf-line-slower', 'slow end')}${line('mean_ms', 'perf-line-average', 'average')}
      </svg>
      <div class="perf-y-axis perf-volume-label"><span>${most}</span><span>uses</span></div>
      <svg class="perf-volume" viewBox="0 0 600 40" preserveAspectRatio="none" role="img" aria-label="Number of timings per hour">${points.map(p => `<rect x="${(x(p) - 2).toFixed(2)}" width="4" y="${(40 - 38 * p.count / most).toFixed(2)}" height="${(38 * p.count / most).toFixed(2)}"><title>${esc(new Date(p.hour).toLocaleString())}: ${samples(p.count)}</title></rect>`).join('')}</svg>
    </div><div class="perf-time-axis"><span>${esc(date(start))}</span><span>${esc(date(finish))}</span></div>
    <p class="hint">${points.length === 1 ? 'Only one hour of data so far. ' : ''}${clipped ? 'Large dots at the top are slow-end values above the chart; hover for the time. ' : ''}Gaps are hours with no use, not zero.</p>
    <details class="perf-hourly"><summary>Hourly values</summary><div class="table-wrap"><table class="grid"><thead><tr><th>Hour</th><th class="num">Uses</th><th class="num">Average</th><th class="num">Typical ≤</th><th class="num">Slow end ≤</th></tr></thead><tbody>${points.map(p => `<tr><td>${esc(new Date(p.hour).toLocaleString())}</td><td class="num">${p.count}</td><td class="num">${chartDuration(p.mean_ms)}</td><td class="num">${chartDuration(p.typical_ms)}</td><td class="num">${chartDuration(p.slower_ms)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

export function technicalTable(report, esc) {
  const rows = [...report.groups.values()].sort((a, b) => a.metric.localeCompare(b.metric) || a.source.localeCompare(b.source) || a.outcome.localeCompare(b.outcome));
  const stage = { server: 'Server', database: 'Database', external: 'Provider', browser: 'Browser' };
  return `<div class="table-wrap"><table class="grid"><thead><tr><th>Measurement</th><th>Stage</th><th>Result</th><th class="num">Samples</th><th class="num">Mean</th><th class="num">p50 ≤</th><th class="num">p95 ≤</th><th class="num">Max</th><th class="num">Queries / req</th></tr></thead><tbody>${rows.map(row =>
    `<tr><td>${esc(row.metric)}</td><td>${esc(stage[row.source] || row.source)}</td><td>${row.outcome === 'ok' ? 'OK' : 'Error'}</td><td class="num">${row.count}</td><td class="num">${chartDuration(row.mean_ms)}</td><td class="num">${chartDuration(row.p50_upper_ms)}</td><td class="num">${chartDuration(row.p95_upper_ms)}</td><td class="num">${chartDuration(row.max_ms)}</td><td class="num">${row.source === 'database' ? row.mean_queries.toFixed(1) : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

const percent = (value, max) => Math.max(0, Math.min(100, 100 * value / max));
export function buildTimingChart(queues) {
  const values = queues.flatMap(q => [q.queue_samples ? q.mean_queue_ms : null, q.build_samples ? q.mean_build_ms : null]).filter(v => v != null);
  const max = Math.max(1, ...values);
  return `<section class="perf-chart"><h3>Why do card and map builds take time?</h3><p class="hint">Average wait in the queue versus average build time, over the last 24 hours. The two averages can come from different jobs. Retry waits include time since the original request.</p>
    <div class="perf-build-bars">${queues.map(q => `<div><h4>${q.kind === 'cards' ? 'Scouting cards' : 'Pitch maps'}</h4>${[['Queue wait', q.mean_queue_ms, q.queue_samples, 'queue'], ['Build time', q.mean_build_ms, q.build_samples, 'build']].map(([label, ms, count, cls]) =>
      `<div class="perf-build-row"><span>${label}</span><span class="perf-bar-track" aria-hidden="true"><span class="perf-bar-fill ${cls}" style="width:${count && ms != null ? percent(ms, max) : 0}%"></span></span><span>${count ? chartDuration(ms) : 'No samples'}<small>${count} ${cls === 'queue' ? 'starts' : 'completions'}</small></span></div>`).join('')}</div>`).join('')}</div>
    ${values.length ? `<div class="perf-build-axis"><span></span><div class="perf-scale"><span>0</span><span>${chartDuration(max)}</span></div><span></span></div>` : '<p class="hint">No starts or completions observed yet. Timings appear as jobs are processed.</p>'}</section>`;
}
