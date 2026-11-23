import { loadPerformancePanel } from './performance.js';
import { buildTimingChart } from './performance-charts.js';

const CONTACT = { recent: ['Recent contact', 'pass'], quiet: ['Quiet', 'hold'], missing: ['No recent contact', 'fail'], unknown: ['Not observed', 'none'] };
const duration = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`;
const bytes = n => n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
const kindName = kind => kind === 'cards' ? 'Scouting cards' : 'Pitch maps';
const badge = (label, color, esc) => `<span class="dchip v-${color}">${esc(label)}</span>`;
const jobLink = (job, esc) => job.player_name
  ? `<a href="/p/${Number(job.player_id)}">${esc(job.player_name)}</a>` : 'Removed player';

export function monitoringOverview(data, esc) {
  const [contact, color] = CONTACT[data.worker.status] || CONTACT.unknown;
  const all = key => data.queues.reduce((sum, queue) => sum + queue[key], 0);
  const stat = (label, value, detail) => `<section class="panel monitor-stat"><div class="lbl">${label}</div><div class="monitor-value">${value}</div><p class="hint">${detail}</p></section>`;
  const lowDisk = data.storage && data.storage.free_bytes / data.storage.total_bytes < 0.1;
  return `<div class="monitor-grid">
      ${stat('Mac Mini worker', badge(contact, color, esc), data.worker.age_ms == null ? 'Waiting for the first card/map check-in.' : `Last successful worker contact ${duration(data.worker.age_ms)} ago.`)}
      ${stat('Job queue', `${all('queued')} queued · ${all('running')} running`, all('stalled') ? `${all('stalled')} running for over 15 minutes; check the worker.` : 'Cards and pitch maps combined.')}
      ${stat('Completed · last 24h', String(all('completed')), `${all('failed')} observed failures · ${all('requested')} new requests`)}
      ${stat('App health', '<span data-app-state>Responding</span>', `Up ${duration(data.uptime_seconds * 1000)} · ${bytes(data.memory_bytes)} memory · ${bytes(data.storage?.free_bytes)} disk free${lowDisk ? '<br><span class="warn">Low disk space</span>' : ''}`)}
    </div>
    <p class="hint">${data.workers.map(w => `${kindName(w.kind)}: ${esc((CONTACT[w.status] || CONTACT.unknown)[0])}${w.age_ms == null ? '' : ` (${duration(w.age_ms)} ago)`}`).join(' · ')}.
      This measures worker traffic to PINE, not the Mac's power or network directly. Long builds can pause polling.</p>
    ${data.dropped_observations ? '<div class="banner warn">Some monitoring observations could not be saved. Activity and totals may be incomplete.</div>' : ''}
    <div class="monitor-grid monitor-queues">${data.queues.map(q => stat(kindName(q.kind), `${q.queued} queued · ${q.running} running`,
      `Oldest wait ${duration(q.oldest_queue_ms)} · ${q.completed} completed · ${q.failed} failed in 24h`)).join('')}</div>
    ${buildTimingChart(data.queues)}`;
}

export function monitoringJobs(data, esc) {
  const rows = data.active;
  const total = data.queues.reduce((sum, q) => sum + q.queued + q.running, 0);
  const status = job => job.status === 'running' ? 'Building' : 'Queued';
  return `<header class="panel-h"><h2>Active jobs</h2></header>${rows.length ? `<p class="hint">Showing ${rows.length} of ${total} active jobs; up to ${data.active_limit_per_kind} per type, oldest first.</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Player</th><th>Job</th><th>Status</th><th>Waiting / building</th><th>Progress</th><th>Attempt</th></tr></thead><tbody>${rows.map(job =>
      `<tr><td>${jobLink(job, esc)}</td><td>${kindName(job.kind)} #${job.id}<br><span class="muted sm">${esc(job.season || '—')} · ${esc(job.position)}</span></td><td>${badge(status(job), 'hold', esc)}</td><td>${duration(job.age_ms)}</td><td>${job.progress === 'fetching_events' ? `Downloading match events${job.progress_matches ? ` (${job.progress_matches} matches)` : ''}` : '—'}</td><td>${job.attempts}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No jobs waiting or building.</p>'}`;
}

export function monitoringActivity(data, esc) {
  const labels = { requested: 'Requested', started: 'Started', done: 'Completed', failed: 'Failed' };
  return `<header class="panel-h"><h2>Build activity</h2></header><p class="hint">Latest 40 events, kept for 14 days. History starts when monitoring is deployed; old jobs are not backfilled. Map rebuilds keep their event history here.</p>
    ${data.events.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Time</th><th>Player</th><th>Job</th><th>Activity</th><th>Detail</th></tr></thead><tbody>${data.events.map(event =>
      `<tr><td>${esc(new Date(event.at).toLocaleString())}</td><td>${jobLink(event, esc)}</td><td>${kindName(event.kind)} #${event.job_id}<br><span class="muted sm">${esc(event.season || '—')} · ${esc(event.position)}</span></td><td>${badge(labels[event.event] || event.event, event.event === 'done' ? 'pass' : event.event === 'failed' ? 'fail' : 'hold', esc)}</td><td>${event.event === 'done' ? `Built in ${duration(event.build_ms)}` : event.event === 'started' ? `Queue ${duration(event.queue_ms)} · attempt ${event.attempts}` : event.event === 'failed' ? esc(event.error || 'failed') : 'Waiting for worker'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No build events observed yet.</p>'}`;
}

export function renderMonitoring(main, { api, esc }) {
  main.innerHTML = `<div class="page monitoring-page"><div class="page-h"><div><h1>Monitoring</h1><p class="sub">Worker contact, card and map builds, and app performance.</p></div><div class="spacer"></div><button class="btn" type="button" data-refresh-status>Refresh status</button></div>
    <p class="hint" data-monitor-status role="status">Loading status…</p><div data-overview></div>
    <section class="panel" data-active></section><section class="panel" data-activity></section>
    <section class="panel" data-performance></section></div>`;
  const root = main.firstElementChild, status = root.querySelector('[data-monitor-status]');
  const refresh = root.querySelector('[data-refresh-status]');
  let pending = false, disposed = false, lastGood;
  const load = async () => {
    if (disposed || pending || document.hidden) return;
    if (!root.isConnected) { dispose(); return; }
    pending = true; refresh.disabled = true;
    try {
      const data = await api('GET', '/api/monitoring');
      if (disposed || !root.isConnected) return;
      root.querySelector('[data-overview]').innerHTML = monitoringOverview(data, esc);
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
  const visible = () => { if (!document.hidden) load(); };
  const timer = setInterval(load, 15000);
  const dispose = () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  refresh.addEventListener('click', load);
  document.addEventListener('visibilitychange', visible);
  load();
  loadPerformancePanel(root.querySelector('[data-performance]'), api, esc);
  return dispose;
}
