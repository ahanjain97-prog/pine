// Aggregate timings only: never store player IDs, staff IDs, URLs or report content.
import { bodyLimit } from 'hono/body-limit';
import { requestTimings } from './request_timing.js';

export const TIMING_LIMITS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000];
const PLAYER_METRICS = new Set(['playing-time', 'impect-kpis', 'card-options', 'cards', 'maps', 'physical', 'impect-candidates', 'tm-candidates', 'mlsnp-gates']);
const ROUTES = new Map([
  ['/api/players', 'players'], ['/api/config', 'config'], ['/api/changes', 'changes'],
  ['/api/ncaa', 'ncaa'], ['/api/ncaa/prospects', 'ncaa-prospects'],
  ['/api/review', 'review'], ['/api/activity', 'activity'], ['/api/analysis', 'analysis'],
  ['/api/impect/search', 'impect-search'], ['/api/impect/iterations', 'impect-iterations'],
  ['/api/impect/shortlists', 'impect-shortlists'], ['/api/impect/cache', 'impect-cache'],
]);
const RENDERS = ['board', 'short-board', 'roster', 'players', 'player', 'ncaa', 'war-room', 'compare', 'analysis', 'impect', 'activity', 'staff'];
const METRICS = new Set(['player', ...PLAYER_METRICS, ...ROUTES.values(), ...RENDERS.map(view => `${view}-render`)]);
export function requestMetric(path) {
  if (ROUTES.has(path)) return ROUTES.get(path);
  const match = /^\/api\/players\/\d+(?:\/([^/]+))?$/.exec(path);
  return match ? !match[1] ? 'player' : PLAYER_METRICS.has(match[1]) ? match[1] : null : null;
}

export function summarizeTimings(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.source, row.metric, row.outcome]);
    if (!groups.has(key)) groups.set(key, { source: row.source, metric: row.metric, outcome: row.outcome,
      count: 0, total_ms: 0, max_ms: 0, buckets: TIMING_LIMITS.map(() => 0) });
    const group = groups.get(key);
    group.count += row.count; group.total_ms += row.total_ms;
    group.max_ms = Math.max(group.max_ms, row.max_ms);
    row.buckets.forEach((count, i) => { group.buckets[i] += count; });
  }
  return [...groups.values()].map(group => {
    const percentile = fraction => {
      let count = 0;
      return TIMING_LIMITS.find((_, i) => (count += group.buckets[i]) >= group.count * fraction);
    };
    const { buckets, total_ms, ...rest } = group;
    return { ...rest, mean_ms: total_ms / group.count, p50_upper_ms: percentile(0.5), p95_upper_ms: percentile(0.95) };
  }).sort((a, b) => b.p95_upper_ms - a.p95_upper_ms || b.mean_ms - a.mean_ms);
}

export function registerPerformance(app, { db, version, now = Date.now }) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS performance_timings (
    hour INTEGER NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL,
    outcome TEXT NOT NULL, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL,
    buckets TEXT NOT NULL, PRIMARY KEY(hour, version, source, metric, outcome)
  )`);
  const pending = new Map(), rates = new Map();
  const retention = 14 * 86400000;
  const flush = () => {
    if (!pending.size) return;
    try {
      db.tx(() => {
        db.run('DELETE FROM performance_timings WHERE hour < ?', now() - retention);
        for (const row of pending.values()) {
          const key = [row.hour, row.version, row.source, row.metric, row.outcome];
          const old = db.get('SELECT * FROM performance_timings WHERE hour=? AND version=? AND source=? AND metric=? AND outcome=?', ...key);
          const buckets = old ? JSON.parse(old.buckets).map((n, i) => n + row.buckets[i]) : row.buckets;
          db.run('INSERT OR REPLACE INTO performance_timings VALUES (?,?,?,?,?,?,?,?,?)', ...key,
            (old?.count || 0) + row.count, (old?.total_ms || 0) + row.total_ms,
            Math.max(old?.max_ms || 0, row.max_ms), JSON.stringify(buckets));
        }
      });
      pending.clear();
    } catch { /* Measurement must never break a staff request; retry the bounded buffer later. */ }
  };
  const record = (source, metric, ms, outcome, release = version()) => {
    if (!Number.isFinite(ms) || ms < 0 || ms > TIMING_LIMITS.at(-1)) return;
    const hour = Math.floor(now() / 3600000) * 3600000;
    const key = JSON.stringify([hour, release, source, metric, outcome]);
    if (!pending.has(key)) {
      if (pending.size >= 512) return;
      pending.set(key, { hour, version: release, source, metric, outcome, count: 0, total_ms: 0, max_ms: 0, buckets: TIMING_LIMITS.map(() => 0) });
    }
    const row = pending.get(key);
    row.count++; row.total_ms += ms; row.max_ms = Math.max(row.max_ms, ms);
    row.buckets[TIMING_LIMITS.findIndex(limit => ms <= limit)]++;
  };
  const timer = setInterval(flush, 30000);
  timer.unref();
  // Register before auth to include its SQL time. Only signed-in reads count.
  app.use('/api/*', async (c, next) => {
    const metric = c.req.method === 'GET' && requestMetric(c.req.path);
    if (!metric) return next();
    const start = performance.now();
    const timing = { databaseMs: 0, active: true };
    await requestTimings.run(timing, async () => {
      try { await next(); }
      finally { timing.active = false; }
    });
    if (!c.get('user')) return;
    const ms = performance.now() - start, outcome = c.res.status < 400 ? 'ok' : 'error';
    c.header('Server-Timing', `app;dur=${ms.toFixed(1)}, sql;dur=${timing.databaseMs.toFixed(1)}`);
    record('server', metric, ms, outcome);
    record('database', metric, timing.databaseMs, outcome);
  });
  const registerRoutes = () => {
    app.post('/api/performance', bodyLimit({ maxSize: 8192 }), async c => {
      const user = c.get('user');
      if (!user) return c.json({ error: 'Not signed in' }, 401);
      const minute = Math.floor(now() / 60000);
      for (const [id, rate] of rates) if (rate.minute !== minute) rates.delete(id);
      const rate = rates.get(user.id) || { minute, count: 0 };
      if (++rate.count > 20) return c.json({ error: 'Too many timing reports' }, 429);
      rates.set(user.id, rate);
      let body;
      try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid timings' }, 400); }
      if (!/^[a-f0-9]{8}$/.test(body?.version) || !Array.isArray(body.samples) || body.samples.length > 30 ||
        body.samples.some(s => !s || !METRICS.has(s.metric) || !Number.isFinite(s.ms) || s.ms < 0 || s.ms > 300000 || !['ok', 'error'].includes(s.outcome))) {
        return c.json({ error: 'Invalid timings' }, 400);
      }
      for (const s of body.samples) record('browser', s.metric, s.ms, s.outcome, body.version);
      return c.body(null, 204);
    });
    const read = c => {
      c.header('Cache-Control', 'no-store');
      const hours = Number(c.req.query('hours') ?? 336);
      const release = c.req.query('version') === 'current' ? version() : c.req.query('version');
      if (!Number.isInteger(hours) || hours < 1 || hours > 336 || (release && !/^[a-f0-9]{8}$/.test(release))) {
        return c.json({ error: 'Use hours=1…336 and an eight-character version' }, 400);
      }
      flush();
      const since = Math.floor((now() - hours * 3600000) / 3600000) * 3600000;
      const all = db.all('SELECT * FROM performance_timings WHERE hour >= ? ORDER BY hour, source, metric', since);
      const rows = all.filter(r => !release || r.version === release).map(r => ({ ...r, buckets: JSON.parse(r.buckets) }));
      return c.json({ retention_days: 14, current_version: version(), since, bucket_upper_ms: TIMING_LIMITS,
        versions: [...new Set(all.map(r => r.version))], summary: summarizeTimings(rows), rows });
    };
    app.get('/api/performance', c => c.get('user')?.is_admin ? read(c) : c.json({ error: 'Admin access required' }, 403));
    // Existing worker auth validates its credential before reaching this handler.
    app.get('/api/worker/performance', read);
  };
  return { registerRoutes, flush, close: () => { clearInterval(timer); flush(); } };
}
