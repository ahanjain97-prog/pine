import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { dailyTimings, IDLE_MS, normalizeBuckets, registerPerformance, requestMetric, SLOW_PAGE_MS, SLOW_REQUEST_MS, summarizeTimings, TIMING_LIMITS } from '../src/lib/performance.js';
import { newRequestTiming, requestTimings, timeDatabase, timeExternal, timedFetch } from '../src/lib/request_timing.js';
import { coldness, createTimings, timingMetric, renderMetric } from '../public/performance.js';

test('timing labels strip identities and query strings and ignore unrelated routes', () => {
  for (const [path, metric] of [
    ['/api/players', 'players'], ['/api/players/123', 'player'],
    ['/api/players/123/playing-time', 'playing-time'], ['/api/players/123/notes', null],
    ['/api/players/123/player-render', null], ['/api/auth/login', null],
    ['/api/review', 'review'], ['/api/ncaa/prospects', 'ncaa-prospects'],
    ['/api/impect/search', 'impect-search'], ['/api/changes', 'changes'],
    ['/api/performance', null], ['/api/players/123/review', null],
  ]) {
    assert.equal(requestMetric(path), metric);
    assert.equal(timingMetric(path + '?q=private-text'), metric);
  }
  assert.equal(renderMetric('board'), 'board-render');
  assert.equal(renderMetric('player'), 'player-render');
  assert.equal(renderMetric('private text'), null);
});

test('HTTP timings retain aggregates across collectors, enforce auth/limits and expire old data', async t => {
  const db = openDb(':memory:');
  let clock = Date.UTC(2026, 10, 23);
  const setup = () => {
    const app = new Hono();
    const perf = registerPerformance(app, { db, version: () => '1234abcd', now: () => clock });
    app.use('/api/*', async (c, next) => {
      if (c.req.path.startsWith('/api/worker/')) {
        if (c.req.header('X-Worker') !== 'test') return c.body(null, 401);
      } else {
        if (!c.req.header('X-User')) return c.body(null, 401);
        if (c.req.method !== 'GET' && c.req.header('X-PINE') !== '1') return c.body(null, 400);
        c.set('user', { id: 1, is_admin: c.req.header('X-User') === 'admin' });
      }
      await next();
    });
    perf.registerRoutes();
    app.get('/api/players/:id', c => c.json(db.get('SELECT 1 AS ok')));
    app.get('/api/players/:id/cards', c => c.json({ error: 'test' }, 503));
    return { app, perf };
  };
  let { app, perf } = setup();
  t.after(() => { perf.close(); db.raw.close(); });
  const headers = { 'X-User': 'admin', 'X-PINE': '1', 'Content-Type': 'application/json' };
  const post = body => app.request('/api/performance', { method: 'POST', headers, body: JSON.stringify(body) });
  const read = async () => (await app.request('/api/worker/performance', { headers: { 'X-Worker': 'test' } })).json();
  assert.equal((await app.request('/api/worker/performance')).status, 401);
  assert.equal((await app.request('/api/performance')).status, 401);
  assert.equal((await app.request('/api/performance', { headers: { 'X-User': 'staff' } })).status, 403);
  const denied = await app.request('/api/players/19');
  assert.equal(denied.status, 401); assert.equal(denied.headers.get('Server-Timing'), null);
  const res = await app.request('/api/players/19', { headers });
  assert.deepEqual(await res.json(), { ok: 1 });
  assert.match(res.headers.get('Server-Timing'), /^app;dur=\d+\.\d, sql;dur=\d+\.\d, ext;dur=\d+\.\d, cold;desc=restart$/);
  await app.request('/api/players/20', { headers });
  await app.request('/api/players/19/cards', { headers });
  const body = { version: '1234abcd', samples: [
    { metric: 'player-render', ms: 80, outcome: 'ok' },
    { metric: 'player-render', ms: 1800, outcome: 'ok' },
  ] };
  assert.equal((await post(body)).status, 204);
  let data = await read();
  const serverPlayer = data.daily.filter(r => r.source === 'server' && r.metric === 'player');
  assert.equal(serverPlayer.reduce((n, r) => n + r.count, 0), 2);
  assert.deepEqual(serverPlayer.map(r => r.cold), [1], 'the first use after a restart is marked');
  const database = data.daily.find(r => r.source === 'database' && r.metric === 'player');
  assert.equal(database.count, 2);
  assert.ok(database.total_ms > 0);
  assert.ok(database.total_ms <= serverPlayer[0].total_ms);
  assert.equal(data.daily.find(r => r.metric === 'cards').outcome, 'error');
  assert.equal(data.daily[0].day, '2026-11-23');
  const browser = data.daily.find(r => r.source === 'browser');
  assert.equal(browser.count, 2); assert.equal(browser.total_ms, 1880); assert.equal(browser.max_ms, 1800);
  assert.equal(browser.buckets[TIMING_LIMITS.indexOf(100)], 1);
  assert.equal(browser.buckets[TIMING_LIMITS.indexOf(2000)], 1);
  assert.ok(!JSON.stringify(data).includes('/api/players/'));
  perf.close(); ({ app, perf } = setup());
  assert.equal((await read()).daily.find(r => r.source === 'browser').count, 2);
  assert.equal((await post({ ...body, version: 'abcdef12' })).status, 204);
  data = await read();
  assert.equal(data.daily.filter(r => r.source === 'browser').length, 1, 'days merge releases');
  assert.equal(data.daily.find(r => r.source === 'browser').count, 4);
  assert.deepEqual(data.releases.map(r => r.version).sort(), ['1234abcd', 'abcdef12']);
  const filtered = await (await app.request('/api/performance?days=1&version=current', { headers })).json();
  assert.equal(filtered.current_version, '1234abcd');
  assert.equal(filtered.daily.find(r => r.source === 'browser').count, 2);
  assert.equal(filtered.summary.find(r => r.source === 'browser').p95_upper_ms, 2000);
  // Days follow the reader's time zone: 00:00 UTC is still the previous evening in New York.
  const local = await (await app.request('/api/performance?tz=America%2FNew_York', { headers })).json();
  assert.equal(local.daily[0].day, '2026-11-22'); assert.equal(local.time_zone, 'America/New_York');
  for (const query of ['hours=0', 'hours=2161', 'days=91', 'hours=no', 'hours=1.5', 'version=bad', 'tz=Not%2FAZone']) {
    assert.equal((await app.request(`/api/performance?${query}`, { headers })).status, 400);
  }
  for (const bad of [null, {}, { ...body, samples: [{ metric: 'private text', ms: 4, outcome: 'ok' }] },
    { ...body, samples: [{ metric: 'player', ms: -1, outcome: 'ok' }] },
    { ...body, samples: [{ metric: 'player', ms: 300001, outcome: 'ok' }] },
    { ...body, samples: Array(31).fill(body.samples[0]) }]) assert.equal((await post(bad)).status, 400);
  assert.equal((await app.request('/api/performance', { method: 'POST', headers, body: 'x'.repeat(8193) })).status, 413);
  for (let n = 0; n < 25; n++) await post(body);
  assert.equal((await post(body)).status, 429);
  clock += 15 * 86400000;
  assert.equal((await post(body)).status, 204);
  assert.ok((await read()).daily.some(r => r.day === '2026-11-23'), 'kept for 90 days');
  clock += 91 * 86400000;
  assert.equal((await post(body)).status, 204);
  data = await read();
  assert.equal(data.daily.length, 1); assert.equal(data.daily[0].count, 2);
});

test('summary combines hourly histograms and keeps errors and stages separate', () => {
  const row = (source, outcome, values) => ({ source, outcome, metric: 'player', count: values.length,
    total_ms: values.reduce((sum, n) => sum + n, 0), max_ms: Math.max(...values),
    buckets: TIMING_LIMITS.map((limit, i) => values.filter(n => n <= limit && (!i || n > TIMING_LIMITS[i - 1])).length) });
  const summary = summarizeTimings([row('server', 'ok', [20, 80]), row('server', 'ok', [1800]),
    row('server', 'error', [9000]), row('database', 'ok', [2])]);
  assert.equal(summary.length, 3);
  const success = summary.find(r => r.source === 'server' && r.outcome === 'ok');
  assert.equal(success.count, 3); assert.equal(success.mean_ms, 1900 / 3);
  assert.equal(success.p50_upper_ms, 100); assert.equal(success.p95_upper_ms, 2000);
  assert.equal(summary[0].outcome, 'error');
});

test('database counters stay isolated across overlapping requests and stop after response', async () => {
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const first = newRequestTiming(), second = newRequestTiming();
  const run = requestTimings.run(first, async () => { await paused; timeDatabase(() => 1); });
  requestTimings.run(second, () => timeDatabase(() => 2));
  assert.equal(first.databaseMs, 0);
  assert.ok(second.databaseMs > 0);
  const before = second.databaseMs;
  resume(); await run;
  assert.ok(first.databaseMs > 0); assert.equal(second.databaseMs, before);
  first.active = false;
  const ended = first.databaseMs;
  requestTimings.run(first, () => timeDatabase(() => 3));
  assert.equal(first.databaseMs, ended);
});

test('failed persistence leaves requests working and retries the buffered aggregates', async t => {
  const db = openDb(':memory:'), app = new Hono();
  const perf = registerPerformance(app, { db, version: () => '1234abcd' });
  t.after(() => { perf.close(); db.raw.close(); });
  app.use('/api/*', async (c, next) => { c.set('user', { id: 1, is_admin: true }); await next(); });
  app.onError((error, c) => c.json({ error: 'Fictional failure' }, 500));
  perf.registerRoutes();
  app.get('/api/players', c => c.json(db.all('SELECT 1 AS ok')));
  app.get('/api/players/:id', () => { throw new Error('Fictional failure'); });
  assert.equal((await app.request('/api/players')).status, 200);
  assert.equal((await app.request('/api/players/1')).status, 500);
  const original = db.run;
  const failing = t.mock.method(db, 'run', () => { throw new Error('Disk full'); });
  assert.doesNotThrow(() => perf.flush());
  assert.equal((await app.request('/api/players')).status, 200);
  assert.equal(db.all('SELECT * FROM performance_timings').length, 0);
  failing.mock.restore();
  assert.equal(db.run, original);
  const data = await (await app.request('/api/performance')).json();
  assert.equal(data.summary.find(row => row.source === 'server' && row.metric === 'players').count, 2);
  assert.equal(data.summary.find(row => row.source === 'server' && row.metric === 'player').outcome, 'error');
});

test('browser batches contain only timing fields and failed delivery is harmless', async t => {
  const handlers = new Map(), sent = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => { sent.push({ url, opts }); throw new Error('offline'); });
  const previous = globalThis.document;
  globalThis.document = { hidden: false, addEventListener: (name, fn) => handlers.set(name, fn) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  t.mock.method(Date, 'now', () => 1000);
  const record = createTimings('1234abcd');
  record('player', 123.45);
  record('player-render', 50, 'ok', 'idle');
  globalThis.document.hidden = true;
  record('player', 9000); // background tabs do not contaminate timings
  handlers.get('visibilitychange')();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/performance');
  assert.equal(sent[0].opts.headers['X-PINE'], '1');
  assert.deepEqual(JSON.parse(sent[0].opts.body), { version: '1234abcd', samples: [{ metric: 'player', ms: 123, outcome: 'ok', age: 0 },
    { metric: 'player-render', ms: 50, outcome: 'ok', cold: 'idle', age: 0 }] });
  handlers.get('visibilitychange')();
  assert.equal(sent.length, 1);
});

test('requests record query counts, provider time and a slow log without identities', async t => {
  const db = openDb(':memory:'), app = new Hono();
  let clock = Date.UTC(2026, 10, 23, 10);
  const perf = registerPerformance(app, { db, version: () => '1234abcd', now: () => clock });
  t.after(() => { perf.close(); db.raw.close(); });
  app.use('/api/*', async (c, next) => { c.set('user', { id: 1, is_admin: true }); await next(); });
  perf.registerRoutes();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.get('/api/players/:id', c => { for (let i = 0; i < 3; i++) db.get('SELECT 1'); db.tx(() => db.run('SELECT 1')); return c.json({}); });
  app.get('/api/players/:id/impect-kpis', async c => {
    db.get('SELECT 1');
    // Two overlapping provider calls count their shared wall-clock time once.
    await Promise.all([timeExternal(() => wait(SLOW_REQUEST_MS + 40)), timeExternal(() => wait(SLOW_REQUEST_MS + 20))]);
    return c.json({}, 502);
  });
  const res = await app.request('/api/players/7');
  assert.match(res.headers.get('Server-Timing'), /ext;dur=0\.0, cold;desc=restart$/);
  await app.request('/api/players/7/impect-kpis');
  const data = await (await app.request('/api/performance')).json();
  const database = data.summary.find(r => r.source === 'database' && r.metric === 'player');
  assert.equal(database.mean_queries, 4, 'transaction boundaries are not counted as queries');
  const external = data.summary.find(r => r.source === 'external' && r.metric === 'impect-kpis');
  const server = data.summary.find(r => r.source === 'server' && r.metric === 'impect-kpis');
  assert.ok(external.mean_ms >= SLOW_REQUEST_MS + 30 && external.mean_ms <= server.mean_ms);
  assert.equal(data.slow_request_ms, SLOW_REQUEST_MS);
  assert.equal(data.events.length, 1);
  const slow = data.events[0];
  assert.deepEqual(Object.keys(slow).sort(), ['at', 'cold', 'database_ms', 'external_ms', 'id', 'metric', 'queries', 'source', 'status', 'total_ms', 'version']);
  assert.equal(slow.metric, 'impect-kpis'); assert.equal(slow.status, 502); assert.equal(slow.queries, 1);
  assert.equal(slow.source, 'server'); assert.equal(slow.cold, 'restart');
  assert.ok(slow.external_ms >= SLOW_REQUEST_MS && slow.external_ms <= slow.total_ms);
  assert.equal((await (await app.request('/api/performance?version=abcdef12')).json()).events.length, 0);
  clock += 91 * 86400000;
  await app.request('/api/players/7');
  perf.flush();
  assert.equal(db.all('SELECT * FROM performance_slow').length, 0, 'the event log follows the 90-day retention');
});

test('provider timing ignores calls outside requests and buffers bodies inside them', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual(await (await timedFetch('https://provider.invalid')).json(), { ok: true });
  const timing = newRequestTiming();
  const res = await requestTimings.run(timing, () => timedFetch('https://provider.invalid'));
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(timing.externalMs >= 0); assert.equal(timing.externalOpen, 0);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal((await requestTimings.run(newRequestTiming(), () => timedFetch('https://provider.invalid'))).status, 204);
});

test('legacy timing rows re-bin exactly into the finer buckets', () => {
  const legacy = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const next = normalizeBuckets(legacy);
  assert.equal(next.length, TIMING_LIMITS.length);
  assert.equal(next.reduce((a, b) => a + b, 0), legacy.reduce((a, b) => a + b, 0));
  assert.equal(next[TIMING_LIMITS.indexOf(250)], 3); assert.equal(next[TIMING_LIMITS.indexOf(150)], 0);
  assert.equal(next[TIMING_LIMITS.indexOf(300000)], 11);
  const db = openDb(':memory:');
  db.raw.exec(`CREATE TABLE performance_timings (hour INTEGER NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL,
    outcome TEXT NOT NULL, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL, buckets TEXT NOT NULL, PRIMARY KEY(hour, version, source, metric, outcome))`);
  db.run('INSERT INTO performance_timings VALUES (?,?,?,?,?,?,?,?,?)', Date.now(), '1234abcd', 'server', 'player', 'ok', 66, 1, 1, JSON.stringify(legacy));
  const perf = registerPerformance(new Hono(), { db, version: () => '1234abcd' });
  const row = db.get('SELECT * FROM performance_timings');
  assert.deepEqual(JSON.parse(row.buckets), next); assert.equal(row.queries, 0);
  perf.close(); db.raw.close();
});

test('the first minute after a break is marked, background polling is not use, and slow page opens are listed', async t => {
  const db = openDb(':memory:'), app = new Hono();
  let clock = Date.UTC(2026, 10, 23, 15);
  const perf = registerPerformance(app, { db, version: () => '1234abcd', now: () => clock });
  t.after(() => { perf.close(); db.raw.close(); });
  app.use('/api/*', async (c, next) => { c.set('user', { id: 1, is_admin: true }); await next(); });
  perf.registerRoutes();
  app.get('/api/players/:id', c => c.json({}));
  app.get('/api/changes', c => c.json({}));
  app.get('/api/players/:id/cards', c => c.json({ error: 'missing' }, 404));
  const cold = async path => coldness((await app.request(path)).headers);
  assert.equal(await cold('/api/players/1'), 'restart');
  clock += 30000;
  assert.equal(await cold('/api/players/1'), 'restart', 'the whole first minute is marked');
  clock += 40000;
  assert.equal(await cold('/api/players/1'), null);
  // An open tab polling for changes keeps going during the break without counting as use.
  for (let i = 0; i < 70; i++) { clock += 15000; await app.request('/api/changes'); }
  assert.equal(await cold('/api/players/1'), 'idle');
  clock += 10000;
  assert.equal(await cold('/api/changes'), 'idle', 'polls inside a wake-up minute are marked too');
  assert.equal((await app.request('/api/players/1/cards')).status, 404);
  const headers = { 'X-PINE': '1', 'Content-Type': 'application/json' };
  const post = samples => app.request('/api/performance', { method: 'POST', headers, body: JSON.stringify({ version: '1234abcd', samples }) });
  assert.equal((await post([{ metric: 'player-render', ms: SLOW_PAGE_MS + 500, outcome: 'ok', cold: 'idle', age: 4000 },
    { metric: 'board-render', ms: 300, outcome: 'ok' }, { metric: 'player', ms: 9000, outcome: 'ok' }])).status, 204);
  for (const bad of [{ cold: 'yes' }, { age: -1 }, { age: 600001 }, { age: 1.5 }]) {
    assert.equal((await post([{ metric: 'player-render', ms: 10, outcome: 'ok', ...bad }])).status, 400);
  }
  const data = await (await app.request('/api/performance')).json();
  assert.equal(data.idle_ms, IDLE_MS);
  const page = data.events.find(e => e.source === 'browser');
  assert.equal(page.metric, 'player-render'); assert.equal(page.cold, 'idle'); assert.equal(page.at, clock - 4000);
  assert.equal(data.events.filter(e => e.source === 'browser').length, 1, 'only slow page opens are listed from the browser');
  assert.ok(data.events.some(e => e.metric === 'cards' && e.status === 404), 'failed requests are listed even when fast');
  const browserCold = data.daily.find(r => r.source === 'browser' && r.metric === 'player-render');
  assert.equal(browserCold.cold, 1);
});

test('older tables gain the first-use flag and event columns without losing rows', () => {
  const db = openDb(':memory:');
  db.raw.exec(`CREATE TABLE performance_timings (hour INTEGER NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL,
    outcome TEXT NOT NULL, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL, buckets TEXT NOT NULL, queries INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(hour, version, source, metric, outcome));
    CREATE TABLE performance_slow (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, version TEXT NOT NULL, metric TEXT NOT NULL, status INTEGER NOT NULL,
    total_ms REAL NOT NULL, database_ms REAL NOT NULL, queries INTEGER NOT NULL, external_ms REAL NOT NULL);`);
  const buckets = JSON.stringify(TIMING_LIMITS.map((_, i) => i === 3 ? 2 : 0));
  db.run('INSERT INTO performance_timings VALUES (?,?,?,?,?,?,?,?,?,?)', Date.now(), '1234abcd', 'database', 'player', 'ok', 2, 40, 30, buckets, 9);
  db.run('INSERT INTO performance_slow(at, version, metric, status, total_ms, database_ms, queries, external_ms) VALUES (?,?,?,?,?,?,?,?)', Date.now(), '1234abcd', 'cards', 200, 1500, 10, 2, 0);
  const perf = registerPerformance(new Hono(), { db, version: () => '1234abcd' });
  const row = db.get('SELECT * FROM performance_timings');
  assert.equal(row.cold, 0); assert.equal(row.queries, 9); assert.equal(row.buckets, buckets);
  const event = db.get('SELECT * FROM performance_slow');
  assert.equal(event.source, 'server'); assert.equal(event.cold, null);
  perf.close(); db.raw.close();
});

test('daily rows merge hours and releases within a local day and keep first-use rows apart', () => {
  const hour = Date.UTC(2026, 10, 23, 14);
  const row = (offset, extra = {}) => ({ hour: hour + offset * 3600000, version: 'aaaa1111', source: 'server', metric: 'player', outcome: 'ok', cold: 0,
    count: 1, total_ms: 100, max_ms: 100, queries: 0, buckets: TIMING_LIMITS.map((_, i) => i === 1 ? 1 : 0), ...extra });
  const days = dailyTimings([row(0), row(1, { version: 'bbbb2222', max_ms: 400 }), row(2, { cold: 1 }), row(16)], 'America/New_York');
  assert.deepEqual(days.map(d => [d.day, d.cold, d.count, d.max_ms]), [['2026-11-23', 0, 2, 400], ['2026-11-23', 1, 1, 100], ['2026-11-24', 0, 1, 100]]);
});
