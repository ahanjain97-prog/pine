import { loadPerformancePanel } from './performance.js';
import { buildTimingChart, speedVerdict } from './performance-charts.js';

const CONTACT = { recent: ['Recent contact', 'pass'], quiet: ['Quiet', 'hold'], missing: ['No recent contact', 'fail'], unknown: ['Not observed', 'none'] };
const duration = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`;
const bytes = n => n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
const kindName = kind => kind === 'cards' ? 'Scouting cards' : 'Pitch maps';
const badge = (label, color, esc) => `<span class="dchip v-${color}">${esc(label)}</span>`;
const jobLink = (job, esc) => job.player_name
  ? `<a href="/p/${Number(job.player_id)}">${esc(job.player_name)}</a>` : 'Removed player';

const tile = (label, value, detail, extra = '') => `<section class="panel monitor-stat"${extra}><div class="lbl">${label}</div><div class="monitor-value">${value}</div><div class="hint">${detail}</div></section>`;

// The four answers an admin wants first. `report` comes from the performance panel and may still be loading.
export function monitoringSummary(data, report, esc) {
  let speed, errors;
  if (!report) {
    speed = tile('Speed', '<span class="muted">Loading…</span>', 'Checking page and request timings.');
    errors = tile('Errors', '<span class="muted">Loading…</span>', '');
  } else {
    const verdict = speedVerdict(report);
    const names = [...verdict.slow, ...verdict.watch].slice(0, 4);
    const stats = report.event_stats;
    const cold = stats?.slow && stats.cold ? `<div class="monitor-note">${stats.cold} of ${stats.slow} slow events were the first use after a break.</div>` : '';
    speed = tile('Speed', badge(verdict.label, verdict.color, esc), (names.length
      ? `<ul class="monitor-list">${names.map(item => `<li><button type="button" class="linkish" data-reveal="${esc(item.metric)}">${esc(item.label)}</button> <span class="muted">${esc(item.reason)}</span></li>`).join('')}</ul>`
      : verdict.color === 'pass' ? 'Pages and requests are within their targets.' : verdict.color === 'none' && report.items.length ? 'Each page needs 3 timings in the period before it is judged.' : 'Timings appear once staff use PINE after a tab reload.') + cold);
    // Counts, not rates: with little use, one failure would read as a large percentage.
    const failing = report.failing;
    const failed = report.request_errors;
    errors = tile('Errors', badge(failed ? `${failed} failed` : 'None', !failed ? 'pass' : failed >= 5 ? 'fail' : 'hold', esc), failed
      ? `${failing.slice(0, 3).map(item => `${esc(item.label)} (${item.errors})`).join(', ')}${failing.length > 3 ? ` and ${failing.length - 3} more` : ''}. Out of ${report.request_total} measured requests in the selected period.`
      : `None of ${report.request_total} measured requests failed in the selected period.`);
  }
  if (!data) return speed + errors + tile('Card & map worker', '<span class="muted">Loading…</span>', '') + tile('App health', '<span class="muted">Loading…</span>', '');
  const [contact, color] = CONTACT[data.worker.status] || CONTACT.unknown;
  const all = key => data.queues.reduce((sum, queue) => sum + queue[key], 0);
  const oldest = Math.max(0, ...data.queues.map(q => q.oldest_queue_ms || 0));
  const lowDisk = data.storage && data.storage.free_bytes / data.storage.total_bytes < 0.1;
  return speed + errors +
    tile('Card & map worker', badge(contact, color, esc), `${all('queued')} queued${all('queued') ? `, oldest waiting ${duration(oldest)}` : ''} · ${all('running')} building${all('stalled') ? `<br><span class="warn">${all('stalled')} building for over 15 minutes; check the worker.</span>` : ''}<br>${all('completed')} built, ${all('failed')} failed in 24h`) +
    tile('App health', `<span data-app-state>${lowDisk ? badge('Low disk space', 'fail', esc) : 'Responding'}</span>`, `Up ${duration(data.uptime_seconds * 1000)} · ${bytes(data.memory_bytes)} memory · ${bytes(data.storage?.free_bytes)} disk free`);
}

export function monitoringOverview(data, esc) {
  return `<p class="hint">${data.workers.map(w => `${kindName(w.kind)}: ${esc((CONTACT[w.status] || CONTACT.unknown)[0])}${w.age_ms == null ? '' : ` (${duration(w.age_ms)} ago)`}`).join(' · ')}.
      This measures worker traffic to PINE, not the Mac's power or network directly. Long builds can pause polling.</p>
    ${data.dropped_observations ? '<div class="banner warn">Some monitoring observations could not be saved. Activity and totals may be incomplete.</div>' : ''}
    <div class="monitor-grid monitor-queues">${data.queues.map(q => tile(kindName(q.kind), `${q.queued} queued · ${q.running} building`,
      `Oldest wait ${duration(q.oldest_queue_ms)} · ${q.completed} completed · ${q.failed} failed in 24h`)).join('')}</div>
    ${buildTimingChart(data.queues)}`;
}

export function monitoringJobs(data, esc) {
  const rows = data.active;
  const total = data.queues.reduce((sum, q) => sum + q.queued + q.running, 0);
  const status = job => job.status === 'running' ? 'Building' : 'Queued';
  return `${rows.length ? `<p class="hint">Showing ${rows.length} of ${total} active jobs; up to ${data.active_limit_per_kind} per type, oldest first.</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Player</th><th>Job</th><th>Status</th><th>Waiting / building</th><th>Progress</th><th>Attempt</th></tr></thead><tbody>${rows.map(job =>
      `<tr><td>${jobLink(job, esc)}</td><td>${kindName(job.kind)} #${job.id}<br><span class="muted sm">${esc(job.season || '—')} · ${esc(job.position)}</span></td><td>${badge(status(job), 'hold', esc)}</td><td>${duration(job.age_ms)}</td><td>${job.progress === 'fetching_events' ? `Downloading match events${job.progress_matches ? ` (${job.progress_matches} matches)` : ''}` : '—'}</td><td>${job.attempts}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No jobs waiting or building.</p>'}`;
}

export function monitoringActivity(data, esc) {
  const labels = { requested: 'Requested', started: 'Started', done: 'Completed', failed: 'Failed' };
  return `<p class="hint">Latest 40 events, kept for 14 days. History starts when monitoring is deployed; old jobs are not backfilled. Map rebuilds keep their event history here.</p>
    ${data.events.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Time</th><th>Player</th><th>Job</th><th>Activity</th><th>Detail</th></tr></thead><tbody>${data.events.map(event =>
      `<tr><td>${esc(new Date(event.at).toLocaleString())}</td><td>${jobLink(event, esc)}</td><td>${kindName(event.kind)} #${event.job_id}<br><span class="muted sm">${esc(event.season || '—')} · ${esc(event.position)}</span></td><td>${badge(labels[event.event] || event.event, event.event === 'done' ? 'pass' : event.event === 'failed' ? 'fail' : 'hold', esc)}</td><td>${event.event === 'done' ? `Built in ${duration(event.build_ms)}` : event.event === 'started' ? `Queue ${duration(event.queue_ms)} · attempt ${event.attempts}` : event.event === 'failed' ? esc(event.error || 'failed') : 'Waiting for worker'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No build events observed yet.</p>'}`;
}

export function renderMonitoring(main, { api, esc }) {
  main.innerHTML = `<div class="page monitoring-page"><div class="page-h"><div><h1>Monitoring</h1><p class="sub">What is slow, what is failing, and whether card and map builds are moving.</p></div><div class="spacer"></div><button class="btn" type="button" data-refresh-status>Refresh status</button></div>
    <p class="hint" data-monitor-status role="status">Loading status…</p><div class="monitor-grid" data-summary></div>
    <section class="panel" data-performance></section>
    <section class="panel"><header class="panel-h"><h2>Card and map builds</h2></header><div data-overview></div>
      <details class="monitor-more" data-active-wrap><summary><h3 data-active-title>Active jobs</h3></summary><div data-active></div></details>
      <details class="monitor-more"><summary><h3>Recent build activity</h3></summary><div data-activity></div></details></section></div>`;
  const root = main.firstElementChild, status = root.querySelector('[data-monitor-status]');
  const refresh = root.querySelector('[data-refresh-status]'), summary = root.querySelector('[data-summary]');
  const activeWrap = root.querySelector('[data-active-wrap]');
  let pending = false, disposed = false, lastGood, data = null, report = null, activeTouched = false;
  const drawSummary = () => { summary.innerHTML = monitoringSummary(data, report, esc); };
  drawSummary();
  const load = async () => {
    if (disposed || pending || document.hidden) return;
    if (!root.isConnected) { dispose(); return; }
    pending = true; refresh.disabled = true;
    try {
      const next = await api('GET', '/api/monitoring');
      if (disposed || !root.isConnected) return;
      data = next;
      drawSummary();
      const active = data.queues.reduce((sum, q) => sum + q.queued + q.running, 0);
      root.querySelector('[data-overview]').innerHTML = monitoringOverview(data, esc);
      root.querySelector('[data-active-title]').textContent = `Active jobs (${active})`;
      if (!activeTouched) activeWrap.open = active > 0;
      root.querySelector('[data-active]').innerHTML = monitoringJobs(data, esc);
      root.querySelector('[data-activity]').innerHTML = monitoringActivity(data, esc);
      lastGood = new Date(data.at).toLocaleTimeString();
      status.className = 'hint';
      status.textContent = `Updated ${lastGood} · status refreshes every 15 seconds while visible · release ${data.version}`;
    } catch (error) {
      if (disposed || !root.isConnected) return;
      status.className = 'banner err';
      status.textContent = `Status unavailable: ${error.message}${lastGood ? `. Showing old data from ${lastGood}.` : ''}`;
      const app = root.querySelector('[data-app-state]');
      if (app) app.textContent = 'Status unavailable';
    } finally { pending = false; refresh.disabled = false; }
  };
  activeWrap.querySelector('summary').addEventListener('click', () => { activeTouched = true; });
  const visible = () => { if (!document.hidden) load(); };
  const timer = setInterval(load, 15000);
  const dispose = () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  refresh.addEventListener('click', load);
  document.addEventListener('visibilitychange', visible);
  load();
  const performance = loadPerformancePanel(root.querySelector('[data-performance]'), api, esc, {
    onReport: next => { report = next; drawSummary(); },
  });
  summary.addEventListener('click', event => {
    const button = event.target.closest('[data-reveal]');
    if (button) performance.reveal(button.dataset.reveal);
  });
  return dispose;
}
