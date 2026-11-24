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

// Targets sit on timing-bucket edges, so counts over them are exact rather than estimated.
export const TARGETS = {
  page: { good: 1000, slow: 2000 },
  request: { good: 250, slow: 1000 },
};
// Few people use PINE, so judge from counts ("3 of 12 took over 2 s"), not percentiles.
export const MIN_SAMPLES = 3;
// Week-on-week changes need this many timings in both weeks.
export const COMPARE_MIN = 5;

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

// Calendar day in this browser's time zone, matching the server's daily rows.
export const dayKey = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const dayStart = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
// The last `n` calendar days, oldest first, ending today.
export function lastDays(n, now = Date.now()) {
  const today = new Date(now);
  return Array.from({ length: n }, (_, i) => dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i)).getTime()));
}
const dayLabel = key => new Date(dayStart(key)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const percentile = (buckets, count, limits, fraction) => {
  let seen = 0;
  return limits.find((_, i) => (seen += buckets[i]) >= count * fraction);
};
// Timings over `ms`. Exact when `ms` is a bucket edge, as every target is.
export const overCount = (group, limits, ms) => group.buckets.reduce((n, count, i) => n + (i > 0 && limits[i - 1] >= ms ? count : 0), 0);

// Merge counts, never average percentiles. Days may have very different sample sizes.
export function summarize(rows, limits) {
  const groups = new Map();
  for (const row of rows) {
    if (!(row.count > 0)) continue;
    const key = `${row.source}|${row.metric}|${row.outcome}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { source: row.source, metric: row.metric, outcome: row.outcome,
      count: 0, total_ms: 0, max_ms: 0, queries: 0, cold_count: 0, cold_total_ms: 0, buckets: limits.map(() => 0) });
    group.count += row.count; group.total_ms += row.total_ms; group.queries += row.queries || 0;
    group.max_ms = Math.max(group.max_ms, row.max_ms || 0);
    if (row.cold) { group.cold_count += row.count; group.cold_total_ms += row.total_ms; }
    row.buckets.forEach((n, i) => { group.buckets[i] += n; });
  }
  for (const group of groups.values()) {
    const warm = group.count - group.cold_count;
    Object.assign(group, { mean_ms: group.total_ms / group.count, mean_queries: group.queries / group.count,
      cold_mean_ms: group.cold_count ? group.cold_total_ms / group.cold_count : null,
      warm_mean_ms: warm ? (group.total_ms - group.cold_total_ms) / warm : null,
      p50_upper_ms: percentile(group.buckets, group.count, limits, 0.5), p95_upper_ms: percentile(group.buckets, group.count, limits, 0.95) });
  }
  return groups;
}

// One point per day with use. Days without use are left out, never zero.
export function dailyPoints(rows, limits, source, metric, kind = 'request') {
  const days = new Map();
  for (const row of rows) {
    if (row.source !== source || row.metric !== metric || row.outcome !== 'ok' || !(row.count > 0)) continue;
    if (!days.has(row.day)) days.set(row.day, { day: row.day, count: 0, total_ms: 0, max_ms: 0, cold: 0, buckets: limits.map(() => 0) });
    const point = days.get(row.day);
    point.count += row.count; point.total_ms += row.total_ms; point.max_ms = Math.max(point.max_ms, row.max_ms);
    if (row.cold) point.cold += row.count;
    row.buckets.forEach((count, i) => { point.buckets[i] += count; });
  }
  const target = TARGETS[kind];
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(({ buckets, ...point }) => ({ ...point,
    mean_ms: point.total_ms / point.count, over_slow: overCount({ buckets }, limits, target.slow), over_good: overCount({ buckets }, limits, target.good) }));
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export function rate(kind, group, limits) {
  const target = TARGETS[kind];
  if (!group || group.count < MIN_SAMPLES) {
    return { status: 'unknown', reason: group?.count ? `Only ${plural(group.count, 'timing')} so far; ${MIN_SAMPLES} are needed to judge` : 'No timings yet', over_slow: null, over_good: null };
  }
  const n = group.count, overSlow = overCount(group, limits, target.slow), overGood = overCount(group, limits, target.good);
  const slowest = `slowest ${chartDuration(group.max_ms)}`;
  const counts = { over_slow: overSlow, over_good: overGood };
  if (overSlow >= 2 && overSlow / n >= 0.2) return { status: 'slow', reason: `${overSlow} of ${n} took over ${chartDuration(target.slow)}; ${slowest}`, ...counts };
  if (overSlow && overSlow / n >= 0.05) return { status: 'watch', reason: `${overSlow} of ${n} took over ${chartDuration(target.slow)}; ${slowest}`, ...counts };
  if (overGood / n >= 0.25) return { status: 'watch', reason: `${overGood} of ${n} took over the ${chartDuration(target.good)} target; ${slowest}`, ...counts };
  return { status: 'good', reason: `${n - overGood} of ${n} within the ${chartDuration(target.good)} target; ${slowest}`, ...counts };
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

// `compare` holds daily rows for the last 7 days (`current`) and the 7 before (`previous`).
export function buildReport(rows, limits, compare = null) {
  const all = summarize(rows, limits);
  const now = compare && summarize(compare.current, limits), before = compare && summarize(compare.previous, limits);
  const get = (map, source, metric, outcome = 'ok') => map?.get(`${source}|${metric}|${outcome}`);
  const metrics = [...new Set([...all.values()].filter(g => g.source !== 'database' && g.source !== 'external').map(g => g.metric))];
  const items = metrics.map(metric => {
    const kind = metric.endsWith('-render') ? 'page' : 'request';
    const browser = get(all, 'browser', metric), server = get(all, 'server', metric);
    const source = kind === 'page' || (browser && browser.count >= MIN_SAMPLES) || !server ? 'browser' : 'server';
    const main = source === 'browser' ? browser : server;
    const errors = get(all, source, metric, 'error')?.count || 0;
    const week = get(now, source, metric), lastWeek = get(before, source, metric);
    const compared = week && lastWeek && week.count >= COMPARE_MIN && lastWeek.count >= COMPARE_MIN;
    return { metric, kind, label: metricLabel(metric), source, main, browser, server,
      database: get(all, 'database', metric), external: get(all, 'external', metric), errors, impact_ms: main?.total_ms || 0,
      change: compared ? (week.mean_ms - lastWeek.mean_ms) / lastWeek.mean_ms : null,
      week_counts: [week?.count || 0, lastWeek?.count || 0], ...rate(kind, main, limits) };
  });
  const serverRows = [...all.values()].filter(g => g.source === 'server');
  const requestTotal = serverRows.reduce((n, g) => n + g.count, 0);
  const requestErrors = serverRows.filter(g => g.outcome === 'error').reduce((n, g) => n + g.count, 0);
  const failing = serverRows.filter(g => g.outcome === 'error').map(g => ({ metric: g.metric, label: metricLabel(g.metric), errors: g.count }))
    .sort((a, b) => b.errors - a.errors || a.label.localeCompare(b.label));
  return { items, pages: items.filter(i => i.kind === 'page'), requests: items.filter(i => i.kind === 'request'),
    request_total: requestTotal, request_errors: requestErrors, failing, groups: all };
}

export function speedVerdict(report) {
  const rated = report.items.filter(i => i.status !== 'unknown');
  const slow = sortItems(report.items.filter(i => i.status === 'slow'), 'impact');
  const watch = sortItems(report.items.filter(i => i.status === 'watch'), 'impact');
  if (!rated.length) return { color: 'none', label: report.items.length ? 'Too few timings yet' : 'No timings yet', slow, watch };
  if (slow.length) return { color: 'fail', label: `${slow.length} slow${watch.length ? ` · ${watch.length} to watch` : ''}`, slow, watch };
  if (watch.length) return { color: 'hold', label: `${watch.length} to watch`, slow, watch };
  return { color: 'pass', label: 'All within target', slow, watch };
}

// Individual slow or failed events, counted for the summary.
export function eventStats(events, { slowRequestMs = 1000, slowPageMs = 2000 } = {}) {
  const failed = events.filter(e => e.status >= 400).length;
  const pages = events.filter(e => e.source === 'browser' && e.total_ms > slowPageMs).length;
  const requests = events.filter(e => e.source !== 'browser' && e.status < 400 && e.total_ms > slowRequestMs).length;
  const cold = events.filter(e => e.cold && e.status < 400).length;
  return { total: events.length, failed, pages, requests, slow: pages + requests, cold };
}
export function eventSummary(stats, period) {
  if (!stats.total) return `Nothing slow or failed in ${period}.`;
  const parts = [stats.pages && plural(stats.pages, 'slow page open'), stats.requests && plural(stats.requests, 'slow request'),
    stats.failed && plural(stats.failed, 'failed request')].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${list[0].toUpperCase()}${list.slice(1)} in ${period}.${stats.cold ? ` ${stats.cold} of the ${plural(stats.slow, 'slow one')} ${stats.cold === 1 ? 'was' : 'were'} the first use after a break, when caches have usually expired.` : ''}`;
}

const STATUS_CHIP = { slow: ['Slow', 'fail'], watch: ['Watch', 'hold'], good: ['Good', 'pass'], unknown: ['Too few', 'none'] };
export const statusChip = (status, esc, title = '') => {
  const [label, color] = STATUS_CHIP[status] || STATUS_CHIP.unknown;
  return `<span class="dchip v-${color}"${title ? ` title="${esc(title)}"` : ''}>${label}</span>`;
};
const changeCell = item => {
  const [week, lastWeek] = item.week_counts, title = `${plural(week, 'timing')} in the last 7 days, ${lastWeek} in the 7 before`;
  if (item.change == null) return `<span class="muted" title="${title}; ${COMPARE_MIN} needed in each">—</span>`;
  if (Math.abs(item.change) < 0.2) return `<span class="muted" title="${title}">≈ same</span>`;
  return item.change > 0 ? `<span class="perf-worse" title="${title}">▲ ${Math.round(item.change * 100)}% slower</span>`
    : `<span class="perf-better" title="${title}">▼ ${Math.round(-item.change * 100)}% faster</span>`;
};
const errorCell = item => item.errors ? `<span class="perf-worse">${item.errors}</span>` : '<span class="muted">0</span>';
// The first use after a break is shown separately when it is clearly slower than the rest.
const coldNote = main => main?.cold_count && main.warm_mean_ms != null && main.cold_mean_ms >= 1.5 * main.warm_mean_ms
  ? `<small class="muted" title="Requests in the first minute after 15 minutes without use">After a break ${chartDuration(main.cold_mean_ms)} · ${main.cold_count}</small>` : '';
const timingCells = item => item.main
  ? `<td class="num"><b>${chartDuration(item.main.mean_ms)}</b>${coldNote(item.main)}</td><td class="num">${chartDuration(item.main.max_ms)}</td><td class="num">${item.over_slow == null ? `<span class="muted">${item.main.count} so far</span>` : `${item.over_slow ? `<b>${item.over_slow}</b>` : 0} of ${item.main.count}`}</td><td class="num">${chartDuration(item.impact_ms)}</td>`
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
  return items.map(item => `<tr class="${item.metric === selected ? 'perf-selected' : ''}"><td>${pickButton(item, selected, esc)}${tags[item.metric] ? `<small class="muted">${esc(tags[item.metric])}</small>` : ''}${item.source === 'server' ? '<small class="muted">server time (too few browser timings)</small>' : ''}</td>
    <td>${statusChip(item.status, esc, item.reason)}</td>${timingCells(item)}${whereCell(item, esc)}<td>${changeCell(item)}</td><td class="num">${errorCell(item)}</td></tr>`).join('');
}
const requestHead = first => `<thead><tr><th>${first}</th><th>Status</th><th class="num">Average</th><th class="num">Slowest</th><th class="num">Over ${chartDuration(TARGETS.request.slow)}</th><th class="num">Total wait</th><th>Where the time goes</th><th>vs last week</th><th class="num">Errors</th></tr></thead>`;

export function pagesTable(report, { selected, open = new Set(), sort = 'status' }, esc) {
  const pages = sortItems(report.pages, sort);
  if (!pages.length) return '<p class="hint">No page-opening timings in this period. They arrive a few seconds after staff open pages in a reloaded tab.</p>';
  const byMetric = new Map(report.requests.map(r => [r.metric, r]));
  return `<div class="table-wrap"><table class="grid perf-table"><thead><tr><th>Page</th><th>Status</th><th class="num">Average</th><th class="num">Slowest</th><th class="num">Over ${chartDuration(TARGETS.page.slow)}</th><th class="num">Total wait</th><th>vs last week</th><th class="num">Errors</th></tr></thead><tbody>${pages.map(page => {
    const view = page.metric.slice(0, -7), related = PAGE_REQUESTS[view] || { waits: [], after: [] };
    const metrics = [...related.waits, ...related.after], isOpen = open.has(page.metric);
    const tags = Object.fromEntries([...related.waits.map(m => [m, 'Page waits for this']), ...related.after.map(m => [m, 'Loads after the page opens'])]);
    const requests = metrics.map(m => byMetric.get(m)).filter(Boolean);
    const detail = `<tr class="perf-sub"${isOpen ? '' : ' hidden'}><td colspan="8"><p class="hint">${esc(page.reason)}.${PAGE_NOTES[view] ? ` ${esc(PAGE_NOTES[view])}` : ''}</p>${requests.length
      ? `<div class="table-wrap"><table class="grid perf-table">${requestHead('Request on this page')}<tbody>${requestRows(sortItems(requests, sort), selected, esc, tags)}</tbody></table></div>`
      : metrics.length ? '<p class="hint">No timings yet for its requests.</p>' : ''}</td></tr>`;
    return `<tr class="${page.metric === selected ? 'perf-selected' : ''}"><td><button type="button" class="perf-expand" data-expand="${esc(page.metric)}" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Hide' : 'Show'} requests for ${esc(page.label)}">${isOpen ? '▾' : '▸'}</button>${pickButton(page, selected, esc)}</td>
      <td>${statusChip(page.status, esc, page.reason)}</td>${timingCells(page)}<td>${changeCell(page)}</td><td class="num">${errorCell(page)}</td></tr>${detail}`;
  }).join('')}</tbody></table></div>`;
}

export function requestsTable(report, { selected, sort = 'status' }, esc) {
  if (!report.requests.length) return '<p class="hint">No request timings in this period.</p>';
  return `<div class="table-wrap"><table class="grid perf-table">${requestHead('Request')}<tbody>${requestRows(sortItems(report.requests, sort), selected, esc)}</tbody></table></div>`;
}

const COLD = { idle: 'First use after a break', restart: 'First use after a restart' };
export function eventsTable(rows, esc) {
  if (!rows.length) return '';
  return `<div class="table-wrap"><table class="grid perf-table"><thead><tr><th>When</th><th>What</th><th class="num">Took</th><th>Where the time went</th><th class="num">Database</th><th class="num">Queries</th><th class="num">Provider</th><th>Result</th></tr></thead><tbody>${rows.map(row => {
    const when = `<td title="Release ${esc(row.version)}">${esc(new Date(row.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td>`;
    const notes = [row.source === 'browser' ? 'Page open, as staff saw it' : '', COLD[row.cold] || ''].filter(Boolean);
    const what = `<td>${esc(metricLabel(row.metric))}${notes.length ? `<small class="muted">${esc(notes.join(' · '))}</small>` : ''}</td>`;
    const result = row.status >= 400 ? `<span class="perf-worse">Error ${Number(row.status)}</span>` : 'Slow';
    if (row.source === 'browser') {
      return `<tr>${when}${what}<td class="num"><b>${chartDuration(row.total_ms)}</b></td><td colspan="4" class="muted sm">Measured in the browser. The server requests listed around the same time show where it went.</td><td>${result}</td></tr>`;
    }
    const db = Math.min(row.database_ms, row.total_ms), ext = Math.min(row.external_ms, row.total_ms - db);
    const where = { parts: [{ key: 'database', label: 'Database', ms: db }, { key: 'provider', label: 'Outside provider', ms: ext }, { key: 'app', label: 'App processing', ms: Math.max(0, row.total_ms - db - ext) }] };
    return `<tr>${when}${what}<td class="num"><b>${chartDuration(row.total_ms)}</b></td><td>${breakdownBar(where)}</td><td class="num">${chartDuration(db)}</td><td class="num${row.queries >= 50 ? ' perf-worse' : ''}">${row.queries}</td><td class="num">${row.external_ms ? chartDuration(ext) : '—'}</td><td>${result}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

const niceMax = value => {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(n => n * magnitude >= value) * magnitude;
};

// One column per calendar day: a dot for the average and a line up to the slowest timing.
export function dailyChart(points, { days, label, kind = 'request', releases = [] }, esc) {
  const index = new Map(days.map((day, i) => [day, i]));
  points = points.filter(p => index.has(p.day));
  if (!points.length) return '<p class="hint">No successful timings for this selection in this period.</p>';
  const target = TARGETS[kind];
  const highest = Math.max(...points.map(p => p.mean_ms));
  // Keep averages and both targets readable; a far-off slowest timing is pinned to the top and labelled.
  const cap = Math.max(target.slow, highest) * 4;
  const max = niceMax(Math.max(target.slow * 1.2, highest * 1.15, Math.min(cap, Math.max(...points.map(p => p.max_ms)))));
  const step = 588 / days.length, x = day => 6 + step * (index.get(day) + 0.5);
  const y = ms => 194 - 188 * Math.min(ms, max) / max;
  const clipped = points.some(p => p.max_ms > max);
  const guide = (ms, cls) => `<line class="${cls}" x1="6" x2="594" y1="${y(ms).toFixed(2)}" y2="${y(ms).toFixed(2)}"/>`;
  const shipped = new Map();
  for (const release of releases) {
    const day = dayKey(release.first_seen);
    if (index.has(day) && day !== days[0]) shipped.set(day, [...(shipped.get(day) || []), release.version]);
  }
  const marks = [...shipped].map(([day, versions]) => `<line class="perf-release" x1="${(x(day) - step / 2).toFixed(2)}" x2="${(x(day) - step / 2).toFixed(2)}" y1="0" y2="200"><title>${esc(dayLabel(day))}: ${plural(versions.length, 'release')} went live</title></line>`).join('');
  // Zero-length round-capped strokes stay circular however the stretched chart is scaled.
  const dot = (day, ms, cls) => `<path class="${cls}" d="M${x(day).toFixed(2)} ${y(ms).toFixed(2)}h0"/>`;
  const columns = points.map(p => {
    const tip = `${esc(dayLabel(p.day))}: average ${chartDuration(p.mean_ms)}, slowest ${chartDuration(p.max_ms)}, ${plural(p.count, 'use')}${p.over_slow ? `, ${p.over_slow} over ${chartDuration(target.slow)}` : ''}`;
    return `<g><title>${tip}${p.max_ms > max ? ' (slowest is above the chart)' : ''}</title><line class="perf-range" x1="${x(p.day).toFixed(2)}" x2="${x(p.day).toFixed(2)}" y1="${y(p.mean_ms).toFixed(2)}" y2="${y(p.max_ms).toFixed(2)}"/>
      ${dot(p.day, p.max_ms, `perf-dot-max${p.max_ms > max ? ' off-scale' : ''}`)}${dot(p.day, p.mean_ms, 'perf-dot-average')}</g>`;
  }).join('');
  const most = Math.max(...points.map(p => p.count)), width = Math.max(1.5, step * 0.6);
  const middle = days[Math.floor(days.length / 2)];
  return `<div class="perf-legend"><span><i class="perf-key average"></i>Average</span><span><i class="perf-key slower"></i>Up to the slowest</span><span><i class="perf-key good"></i>Target ${chartDuration(target.good)}</span><span><i class="perf-key limit"></i>Slow over ${chartDuration(target.slow)}</span>${shipped.size ? '<span><i class="perf-key release"></i>New release</span>' : ''}</div>
    <div class="perf-plot"><div class="perf-y-axis"><span>${chartDuration(max)}</span><span>${chartDuration(max / 2)}</span><span>0</span></div>
      <svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: average and slowest time each day against the targets. Higher is slower. Days without use are blank.">
        <path class="perf-grid-line" d="M6 6H594 M6 100H594 M6 194H594"/>${marks}${guide(target.good, 'perf-target-good')}${guide(target.slow, 'perf-target-slow')}${columns}
      </svg>
      <div class="perf-y-axis perf-volume-label"><span>${most}</span><span>uses</span></div>
      <svg class="perf-volume" viewBox="0 0 600 40" preserveAspectRatio="none" role="img" aria-label="Uses per day">${points.map(p => `<rect x="${(x(p.day) - width / 2).toFixed(2)}" width="${width.toFixed(2)}" y="${(40 - 38 * p.count / most).toFixed(2)}" height="${(38 * p.count / most).toFixed(2)}"><title>${esc(dayLabel(p.day))}: ${plural(p.count, 'use')}</title></rect>`).join('')}</svg>
    </div><div class="perf-time-axis"><span>${esc(dayLabel(days[0]))}</span><span>${esc(dayLabel(middle))}</span><span>${esc(dayLabel(days.at(-1)))}</span></div>
    <p class="hint">${points.length === 1 ? 'Only one day with use so far. ' : ''}${clipped ? 'Large dots at the top are slowest timings above the chart; hover for the value. ' : ''}Days without use are blank, not zero.</p>
    <details class="perf-hourly"><summary>Daily values</summary><div class="table-wrap"><table class="grid"><thead><tr><th>Day</th><th class="num">Uses</th><th class="num">Average</th><th class="num">Slowest</th><th class="num">Over ${chartDuration(target.slow)}</th><th class="num">After a break</th><th>Releases</th></tr></thead><tbody>${[...points].reverse().map(p => `<tr><td>${esc(dayLabel(p.day))}</td><td class="num">${p.count}</td><td class="num">${chartDuration(p.mean_ms)}</td><td class="num">${chartDuration(p.max_ms)}</td><td class="num">${p.over_slow}</td><td class="num">${p.cold}</td><td>${shipped.has(p.day) ? plural(shipped.get(p.day).length, 'release') : ''}</td></tr>`).join('')}</tbody></table></div></details>`;
}

export function technicalTable(report, esc) {
  const rows = [...report.groups.values()].sort((a, b) => a.metric.localeCompare(b.metric) || a.source.localeCompare(b.source) || a.outcome.localeCompare(b.outcome));
  const stage = { server: 'Server', database: 'Database', external: 'Provider', browser: 'Browser' };
  return `<div class="table-wrap"><table class="grid"><thead><tr><th>Measurement</th><th>Stage</th><th>Result</th><th class="num">Samples</th><th class="num">After a break</th><th class="num">Mean</th><th class="num">p50 ≤</th><th class="num">p95 ≤</th><th class="num">Max</th><th class="num">Queries / req</th></tr></thead><tbody>${rows.map(row =>
    `<tr><td>${esc(row.metric)}</td><td>${esc(stage[row.source] || row.source)}</td><td>${row.outcome === 'ok' ? 'OK' : 'Error'}</td><td class="num">${row.count}</td><td class="num">${row.cold_count}</td><td class="num">${chartDuration(row.mean_ms)}</td><td class="num">${chartDuration(row.p50_upper_ms)}</td><td class="num">${chartDuration(row.p95_upper_ms)}</td><td class="num">${chartDuration(row.max_ms)}</td><td class="num">${row.source === 'database' ? row.mean_queries.toFixed(1) : ''}</td></tr>`).join('')}</tbody></table></div>`;
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
