import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { registerPerformance, requestMetric, summarizeTimings, TIMING_LIMITS } from '../src/lib/performance.js';
import { requestTimings, timeDatabase } from '../src/lib/request_timing.js';
import { createTimings, timingMetric, renderMetric } from '../public/performance.js';

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
  assert.match(res.headers.get('Server-Timing'), /^app;dur=\d+\.\d, sql;dur=\d+\.\d$/);
  await app.request('/api/players/20', { headers });
  await app.request('/api/players/19/cards', { headers });
  const body = { version: '1234abcd', samples: [
    { metric: 'player-render', ms: 80, outcome: 'ok' },
    { metric: 'player-render', ms: 1800, outcome: 'ok' },
  ] };
  assert.equal((await post(body)).status, 204);
  let data = await read();
  assert.equal(data.rows.find(r => r.source === 'server' && r.metric === 'player').count, 2);
  const database = data.rows.find(r => r.source === 'database' && r.metric === 'player');
  assert.equal(database.count, 2);
  assert.ok(database.total_ms > 0);
  assert.ok(database.total_ms <= data.rows.find(r => r.source === 'server' && r.metric === 'player').total_ms);
  assert.equal(data.rows.find(r => r.metric === 'cards').outcome, 'error');
  const browser = data.rows.find(r => r.source === 'browser');
  assert.equal(browser.count, 2); assert.equal(browser.total_ms, 1880); assert.equal(browser.max_ms, 1800);
  assert.equal(browser.buckets[TIMING_LIMITS.indexOf(100)], 1);
  assert.equal(browser.buckets[TIMING_LIMITS.indexOf(2000)], 1);
  assert.ok(!JSON.stringify(data).includes('/api/players/'));
  perf.close(); ({ app, perf } = setup());
  assert.equal((await read()).rows.find(r => r.source === 'browser').count, 2);
  assert.equal((await post({ ...body, version: 'abcdef12' })).status, 204);
  assert.equal((await read()).rows.filter(r => r.source === 'browser').length, 2);
  const filtered = await (await app.request('/api/performance?hours=24&version=current', { headers })).json();
  assert.equal(filtered.current_version, '1234abcd');
  assert.deepEqual(new Set(filtered.versions), new Set(['1234abcd', 'abcdef12']));
  assert.ok(filtered.rows.every(r => r.version === '1234abcd'));
  assert.equal(filtered.summary.find(r => r.source === 'browser').p95_upper_ms, 2000);
  for (const query of ['hours=0', 'hours=337', 'hours=no', 'hours=1.5', 'version=bad']) {
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
  data = await read();
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].count, 2);
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
  const first = { active: true, databaseMs: 0 }, second = { active: true, databaseMs: 0 };
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
  assert.equal(data.rows.find(row => row.source === 'server' && row.metric === 'players').count, 2);
  assert.equal(data.rows.find(row => row.source === 'server' && row.metric === 'player').outcome, 'error');
});

test('browser batches contain only timing fields and failed delivery is harmless', async t => {
  const handlers = new Map(), sent = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => { sent.push({ url, opts }); throw new Error('offline'); });
  const previous = globalThis.document;
  globalThis.document = { hidden: false, addEventListener: (name, fn) => handlers.set(name, fn) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const record = createTimings('1234abcd');
  record('player', 123.45);
  globalThis.document.hidden = true;
  record('player', 9000); // background tabs do not contaminate timings
  handlers.get('visibilitychange')();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/performance');
  assert.equal(sent[0].opts.headers['X-PINE'], '1');
  assert.deepEqual(JSON.parse(sent[0].opts.body), { version: '1234abcd', samples: [{ metric: 'player', ms: 123, outcome: 'ok' }] });
  handlers.get('visibilitychange')();
  assert.equal(sent.length, 1);
});
