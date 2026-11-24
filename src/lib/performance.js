// Aggregate timings only: never store player IDs, staff IDs, URLs or report content.
import { bodyLimit } from 'hono/body-limit';
import { newRequestTiming, requestTimings } from './request_timing.js';

// Every legacy bound is kept, so older rows re-bin exactly into the finer layout.
export const TIMING_LIMITS = [50, 100, 150, 250, 350, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000, 60000, 300000];
const LEGACY_LIMITS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000];
export const SLOW_REQUEST_MS = 1000;
const SLOW_LOG_ROWS = 500;
export function normalizeBuckets(buckets) {
  if (buckets.length === TIMING_LIMITS.length) return buckets;
  const next = TIMING_LIMITS.map(() => 0);
  buckets.forEach((count, i) => { next[TIMING_LIMITS.indexOf(LEGACY_LIMITS[i])] += count; });
  return next;
}
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
      count: 0, total_ms: 0, max_ms: 0, queries: 0, buckets: TIMING_LIMITS.map(() => 0) });
    const group = groups.get(key);
    group.count += row.count; group.total_ms += row.total_ms; group.queries += row.queries || 0;
    group.max_ms = Math.max(group.max_ms, row.max_ms);
    row.buckets.forEach((count, i) => { group.buckets[i] += count; });
  }
  return [...groups.values()].map(group => {
    const percentile = fraction => {
      let count = 0;
      return TIMING_LIMITS.find((_, i) => (count += group.buckets[i]) >= group.count * fraction);
    };
    const { buckets, total_ms, queries, ...rest } = group;
    return { ...rest, total_ms, mean_ms: total_ms / group.count, p50_upper_ms: percentile(0.5), p95_upper_ms: percentile(0.95),
      ...(group.source === 'database' ? { mean_queries: queries / group.count } : {}) };
  }).sort((a, b) => b.p95_upper_ms - a.p95_upper_ms || b.mean_ms - a.mean_ms);
}

export function registerPerformance(app, { db, version, now = Date.now }) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS performance_timings (
    hour INTEGER NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL,
    outcome TEXT NOT NULL, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL,
    buckets TEXT NOT NULL, PRIMARY KEY(hour, version, source, metric, outcome)
  );
  CREATE TABLE IF NOT EXISTS performance_slow (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, version TEXT NOT NULL, metric TEXT NOT NULL, status INTEGER NOT NULL,
    total_ms REAL NOT NULL, database_ms REAL NOT NULL, queries INTEGER NOT NULL, external_ms REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS performance_slow_at ON performance_slow(at);`);
  // Database rows also sum statements, so a read can report queries per request.
  if (!db.raw.prepare('PRAGMA table_info(performance_timings)').all().some(c => c.name === 'queries')) {
    db.raw.exec('ALTER TABLE performance_timings ADD COLUMN queries INTEGER NOT NULL DEFAULT 0');
  }
  db.once('performance_buckets_2026_11', () => {
    for (const row of db.all('SELECT rowid, buckets FROM performance_timings')) {
      const buckets = JSON.parse(row.buckets);
      if (buckets.length !== TIMING_LIMITS.length) db.run('UPDATE performance_timings SET buckets = ? WHERE rowid = ?', JSON.stringify(normalizeBuckets(buckets)), row.rowid);
    }
  });
  const pending = new Map(), rates = new Map(), slow = [];
  const retention = 14 * 86400000;
  const flush = () => {
    if (!pending.size && !slow.length) return;
    try {
      db.tx(() => {
        db.run('DELETE FROM performance_timings WHERE hour < ?', now() - retention);
        for (const entry of slow) {
          db.run(`INSERT INTO performance_slow(at, version, metric, status, total_ms, database_ms, queries, external_ms)
            VALUES (?,?,?,?,?,?,?,?)`, entry.at, entry.version, entry.metric, entry.status, entry.total_ms,
          entry.database_ms, entry.queries, entry.external_ms);
        }
        db.run('DELETE FROM performance_slow WHERE at < ? OR id <= (SELECT max(id) FROM performance_slow) - ?', now() - retention, SLOW_LOG_ROWS);
        for (const row of pending.values()) {
          const key = [row.hour, row.version, row.source, row.metric, row.outcome];
          const old = db.get('SELECT * FROM performance_timings WHERE hour=? AND version=? AND source=? AND metric=? AND outcome=?', ...key);
          const buckets = old ? normalizeBuckets(JSON.parse(old.buckets)).map((n, i) => n + row.buckets[i]) : row.buckets;
          db.run(`INSERT OR REPLACE INTO performance_timings(hour, version, source, metric, outcome, count, total_ms, max_ms, buckets, queries)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, ...key,
          (old?.count || 0) + row.count, (old?.total_ms || 0) + row.total_ms,
          Math.max(old?.max_ms || 0, row.max_ms), JSON.stringify(buckets), (old?.queries || 0) + row.queries);
        }
      });
      pending.clear(); slow.length = 0;
    } catch { /* Measurement must never break a staff request; retry the bounded buffer later. */ }
  };
  const record = (source, metric, ms, outcome, release = version(), queries = 0) => {
    if (!Number.isFinite(ms) || ms < 0 || ms > TIMING_LIMITS.at(-1)) return;
    const hour = Math.floor(now() / 3600000) * 3600000;
    const key = JSON.stringify([hour, release, source, metric, outcome]);
    if (!pending.has(key)) {
      if (pending.size >= 512) return;
      pending.set(key, { hour, version: release, source, metric, outcome, count: 0, total_ms: 0, max_ms: 0, queries: 0, buckets: TIMING_LIMITS.map(() => 0) });
    }
    const row = pending.get(key);
    row.count++; row.total_ms += ms; row.max_ms = Math.max(row.max_ms, ms); row.queries += queries;
    row.buckets[TIMING_LIMITS.findIndex(limit => ms <= limit)]++;
  };
  const timer = setInterval(flush, 30000);
  timer.unref();
  // Register before auth to include its SQL time. Only signed-in reads count.
  app.use('/api/*', async (c, next) => {
    const metric = c.req.method === 'GET' && requestMetric(c.req.path);
    if (!metric) return next();
    const start = performance.now();
    const timing = newRequestTiming();
    await requestTimings.run(timing, async () => {
      try { await next(); }
      finally {
        if (timing.externalOpen) timing.externalMs += performance.now() - timing.externalSince;
        timing.active = false;
      }
    });
    if (!c.get('user')) return;
    const ms = performance.now() - start, outcome = c.res.status < 400 ? 'ok' : 'error';
    c.header('Server-Timing', `app;dur=${ms.toFixed(1)}, sql;dur=${timing.databaseMs.toFixed(1)}, ext;dur=${timing.externalMs.toFixed(1)}`);
    record('server', metric, ms, outcome);
    record('database', metric, timing.databaseMs, outcome, version(), timing.queries);
    record('external', metric, timing.externalMs, outcome);
    if (ms > SLOW_REQUEST_MS && slow.length < SLOW_LOG_ROWS) {
      slow.push({ at: now(), version: version(), metric, status: c.res.status, total_ms: ms,
        database_ms: timing.databaseMs, queries: timing.queries, external_ms: timing.externalMs });
    }
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
      const rows = all.filter(r => !release || r.version === release).map(r => ({ ...r, buckets: normalizeBuckets(JSON.parse(r.buckets)) }));
      const slowRows = db.all('SELECT * FROM performance_slow WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?', since, SLOW_LOG_ROWS)
        .filter(r => !release || r.version === release);
      return c.json({ retention_days: 14, current_version: version(), since, bucket_upper_ms: TIMING_LIMITS,
        versions: [...new Set(all.map(r => r.version))], summary: summarizeTimings(rows), rows,
        slow_request_ms: SLOW_REQUEST_MS, slow_requests: slowRows });
    };
    app.get('/api/performance', c => c.get('user')?.is_admin ? read(c) : c.json({ error: 'Admin access required' }, 403));
    // Existing worker auth validates its credential before reaching this handler.
    app.get('/api/worker/performance', read);
  };
  return { registerRoutes, flush, close: () => { clearInterval(timer); flush(); } };
}
