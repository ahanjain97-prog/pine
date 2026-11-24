import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { claimCard, sqlTime } from '../src/lib/cards.js';
import { claimMap } from '../src/lib/maps.js';
import { registerMonitoring, workerStatus, workerTraffic } from '../src/lib/monitoring.js';
import { monitoringOverview, monitoringJobs, monitoringActivity, monitoringSummary } from '../public/monitoring.js';
import { buildReport } from '../public/performance-charts.js';

function setup(t, db = openDb(':memory:'), initial = Date.now()) {
  let clock = initial;
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/worker/')) {
      if (c.req.header('X-Worker') !== 'fixture') return c.body(null, 401);
    } else {
      if (!c.req.header('X-User')) return c.body(null, 401);
      c.set('user', { is_admin: c.req.header('X-User') === 'admin' });
    }
    await next();
  });
  const monitor = registerMonitoring(app, { db, version: () => '1234abcd', now: () => clock,
    runtime: () => ({ uptime_seconds: 120, memory_bytes: 123456 }),
    disk: () => ({ free_bytes: 500, total_bytes: 1000 }) });
  app.post('/api/worker/cards/claim', () => new Response(null, { status: 204 }));
  app.post('/api/worker/maps/claim', c => c.json({ error: 'fictional' }, 500));
  app.get('/api/worker/cards/snapshots', c => c.json({ cards: [] }));
  app.post('/api/worker/cards/:id/progress', c => c.json({ ok: true }));
  const read = async () => {
    const res = await app.request('/api/monitoring', { headers: { 'X-User': 'admin' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Cache-Control'), /private, no-store/);
    return res.json();
  };
  return { app, db, monitor, read, clock: value => { clock = value; }, now: () => clock };
}

test('monitoring requires admin/worker auth and diagnostic reads cannot impersonate worker contact', async t => {
  const { app, db, read, clock, now } = setup(t);
  t.after(() => db.raw.close());
  const time = now();
  for (const [path, headers, expected] of [
    ['/api/monitoring', {}, 401], ['/api/monitoring', { 'X-User': 'staff' }, 403],
    ['/api/worker/monitoring', {}, 401], ['/api/worker/monitoring', { 'X-User': 'admin' }, 401],
    ['/api/worker/monitoring', { 'X-Worker': 'fixture' }, 200],
  ]) assert.equal((await app.request(path, { headers })).status, expected);
  assert.equal((await read()).worker.status, 'unknown');
  assert.equal((await app.request('/api/worker/cards/claim', { method: 'POST' })).status, 401);
  await app.request('/api/worker/cards/snapshots', { headers: { 'X-Worker': 'fixture' } });
  await app.request('/api/worker/maps/claim', { method: 'POST', headers: { 'X-Worker': 'fixture' } });
  assert.equal((await read()).worker.status, 'unknown');
  await app.request('/api/worker/cards/claim', { method: 'POST', headers: { 'X-Worker': 'fixture' } });
  assert.equal((await read()).worker.status, 'recent');
  assert.equal(db.get('SELECT seen_at FROM monitoring_workers WHERE kind = ?', 'cards').seen_at, time);
  clock(time + 61000);
  assert.equal((await read()).worker.status, 'quiet');
  clock(time + 301000);
  assert.equal((await read()).worker.status, 'missing');
  assert.equal((await read()).workers.find(w => w.kind === 'maps').status, 'unknown');
  const restarted = setup(t, db, time + 302000);
  assert.equal((await restarted.read()).worker.last_seen_at, new Date(time).toISOString());
  await app.request('/api/worker/cards/1/progress', { method: 'POST', headers: { 'X-Worker': 'fixture' } });
  assert.equal((await read()).worker.status, 'recent', 'build progress also proves contact');
});

test('worker contact route allowlist excludes arbitrary reads and incorrect methods', () => {
  assert.equal(workerTraffic('GET', '/api/worker/cards/claim'), null);
  assert.equal(workerTraffic('GET', '/api/worker/cards/snapshots'), null);
  assert.equal(workerTraffic('GET', '/api/worker/monitoring'), null);
  assert.equal(workerTraffic('PUT', '/api/worker/cards/1/pdf'), 'cards');
  assert.equal(workerTraffic('PUT', '/api/worker/maps/1/json'), 'maps');
  assert.equal(workerTraffic('PUT', '/api/worker/maps/1/pdf'), null);
  assert.equal(workerStatus(null, 1000).status, 'unknown');
});

test('job activity survives map replacement and separates queue wait, build time and failed retries', async t => {
  const { db, monitor, read, now } = setup(t);
  t.after(() => db.raw.close());
  const time = now();
  const player = Number(db.run("INSERT INTO players(name, impect_id) VALUES ('Fictional Forward', 99001)").lastInsertRowid);
  const add = (kind, requested, status = 'queued', attempts = 0, started = null) => Number(db.run(
    `INSERT INTO ${kind}(player_id, impect_id, iteration_id, position, requested_at, status, attempts, started_at)
      VALUES (?,99001,7,'CF',?,?,?,?)`, player, sqlTime(new Date(requested)), status, attempts, started).lastInsertRowid);
  const card = add('cards', time - 60000);
  monitor.recordJob('cards', card, 'requested');
  monitor.claimJob('cards', () => claimCard(db));
  const start = Date.parse(db.get('SELECT started_at FROM cards WHERE id = ?', card).started_at.replace(' ', 'T') + 'Z');
  db.run("UPDATE cards SET status = 'done', generated_at = ? WHERE id = ?", sqlTime(new Date(start + 30000)), card);
  monitor.recordJob('cards', card, 'done');
  const map = add('maps', time - 120000, 'running', 2, sqlTime(new Date(time - 30000)));
  db.run("UPDATE maps SET status = 'failed', error = 'render_failed' WHERE id = ?", map);
  monitor.recordJob('maps', map, 'failed');
  db.run('DELETE FROM maps WHERE id = ?', map);
  add('maps', time - 180000);
  add('cards', time - 2000000, 'running', 1, sqlTime(new Date(time - 1000000)));
  let data = await read();
  const cards = data.queues.find(q => q.kind === 'cards'), maps = data.queues.find(q => q.kind === 'maps');
  assert.equal(cards.completed, 1); assert.equal(cards.build_samples, 1); assert.equal(cards.mean_build_ms, 30000);
  assert.ok(cards.mean_queue_ms >= 59000 && cards.mean_queue_ms <= 61000);
  assert.equal(cards.stalled, 1); assert.equal(maps.queued, 1); assert.equal(maps.failed, 1);
  assert.equal(data.events.find(e => e.event === 'failed').error, 'render_failed');
  assert.ok(!JSON.stringify(data).includes('requested_by'), 'no staff details or note content in monitoring');
  const exhausted = add('cards', time - 2000000, 'running', 3, sqlTime(new Date(time - 1000000)));
  monitor.claimJob('cards', () => claimCard(db));
  assert.equal((await read()).events.find(e => e.job_id === exhausted && e.kind === 'cards').event, 'failed');
  const restarted = setup(t, db, time);
  assert.equal((await restarted.read()).queues.find(q => q.kind === 'maps').failed, 1);
  db.run('UPDATE monitoring_events SET at = ?', time - 15 * 86400000);
  data = await read();
  assert.equal(data.events.length, 0);
  assert.equal(data.queues.find(q => q.kind === 'cards').completed, 0);
});

test('failed monitoring writes never fail claims and reports show incomplete observations', async t => {
  const { db, monitor, read } = setup(t);
  t.after(() => db.raw.close());
  const player = Number(db.run("INSERT INTO players(name) VALUES ('Fictional Defender')").lastInsertRowid);
  const job = Number(db.run("INSERT INTO maps(player_id, impect_id, iteration_id, position) VALUES (?, 99, 7, 'CB')", player).lastInsertRowid);
  const run = db.run;
  t.mock.method(db, 'run', (sql, ...params) => {
    if (sql.includes('monitoring_')) throw new Error('Fictional disk full');
    return run(sql, ...params);
  });
  assert.doesNotThrow(() => monitor.recordJob('maps', job, 'requested'));
  assert.equal(monitor.claimJob('maps', () => claimMap(db)).id, job);
  assert.equal(db.get('SELECT status FROM maps WHERE id = ?', job).status, 'running');
  assert.ok((await read()).dropped_observations >= 2);
});

test('dashboard escapes player text and accurately labels empty and missing worker states', () => {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const data = { worker: { status: 'unknown', age_ms: null }, workers: [], queues: [],
    uptime_seconds: 0, memory_bytes: 0, storage: null, active: [], events: [], active_limit_per_kind: 50 };
  assert.match(monitoringSummary(data, null, esc), /Not observed/);
  assert.match(monitoringSummary(null, null, esc), /Loading/);
  assert.match(monitoringOverview(data, esc), /No starts or completions/);
  assert.match(monitoringJobs(data, esc), /No jobs waiting/);
  assert.match(monitoringActivity(data, esc), /No build events/);
  data.events = [{ at: Date.now(), player_id: 1, player_name: '<img src=x onerror=alert(1)>',
    kind: 'cards', job_id: 1, event: 'failed', error: '<script>unsafe</script>' }];
  const html = monitoringActivity(data, esc);
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img/);
});

test('summary names slow items first and reports request errors', () => {
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const limits = [250, 1000, 5000];
  const row = (source, metric, count, total_ms, buckets, outcome = 'ok') => ({ hour: 0, version: 'a', source, metric, outcome, count, total_ms, max_ms: 0, buckets });
  const report = buildReport([
    row('browser', 'player-render', 10, 40000, [0, 0, 10]),
    row('server', 'impect-kpis', 10, 15000, [0, 0, 10]),
    row('server', 'impect-kpis', 1, 100, [1, 0, 0], 'error'),
    row('server', 'config', 30, 300, [30, 0, 0]),
  ], limits);
  const html = monitoringSummary(null, report, esc);
  assert.match(html, /2 slow/);
  assert.ok(html.indexOf('Player details page') < html.indexOf('Player performance stats'), 'largest total wait first');
  assert.match(html, /data-reveal="player-render"/);
  assert.match(html, /2\.4% failed/);
  assert.match(monitoringSummary(null, buildReport([row('server', 'config', 30, 300, [30, 0, 0])], limits), esc), /All within target/);
  assert.match(monitoringSummary(null, buildReport([], limits), esc), /No timings yet/);
});
