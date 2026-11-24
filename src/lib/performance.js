// Aggregate timings only: never store player IDs, staff IDs, URLs or report content.
import { bodyLimit } from 'hono/body-limit';
import { newRequestTiming, requestTimings } from './request_timing.js';

// Every legacy bound is kept, so older rows re-bin exactly into the finer layout.
export const TIMING_LIMITS = [50, 100, 150, 250, 350, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000, 60000, 300000];
const LEGACY_LIMITS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000];
export const RETENTION_DAYS = 90;
// Events worth listing one by one: server requests over 1 s, page opens over 2 s, and failed requests.
export const SLOW_REQUEST_MS = 1000;
export const SLOW_PAGE_MS = 2000;
const EVENT_ROWS = 1000;
// Few people use PINE, so most sessions start after a break. Requests in the first minute after
// 15 minutes without use are marked, because caches and provider sign-ins have often expired by then.
export const IDLE_MS = 15 * 60000;
const WAKE_MS = 60000;
// Open tabs poll for changes every 15 seconds; that is not someone using PINE.
const BACKGROUND = new Set(['changes']);
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

// Hourly rows merged into calendar days in the reader's time zone, across releases. At low volume
// an hour rarely holds more than one timing, so days are the finest useful trend.
export function dailyTimings(rows, timeZone = 'UTC') {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map(), groups = new Map();
  for (const row of rows) {
    if (!days.has(row.hour)) days.set(row.hour, format.format(row.hour));
    const day = days.get(row.hour), cold = row.cold ? 1 : 0;
    const key = JSON.stringify([day, row.source, row.metric, row.outcome, cold]);
    if (!groups.has(key)) groups.set(key, { day, source: row.source, metric: row.metric, outcome: row.outcome, cold,
      count: 0, total_ms: 0, max_ms: 0, queries: 0, buckets: TIMING_LIMITS.map(() => 0) });
    const group = groups.get(key);
    group.count += row.count; group.total_ms += row.total_ms; group.queries += row.queries || 0;
    group.max_ms = Math.max(group.max_ms, row.max_ms);
    row.buckets.forEach((count, i) => { group.buckets[i] += count; });
  }
  return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source) || a.metric.localeCompare(b.metric));
}

const validZone = zone => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } };

export function registerPerformance(app, { db, version, now = Date.now }) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS performance_timings (
    hour INTEGER NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL,
    outcome TEXT NOT NULL, cold INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL,
    buckets TEXT NOT NULL, queries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(hour, version, source, metric, outcome, cold)
  );
  CREATE TABLE IF NOT EXISTS performance_slow (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, version TEXT NOT NULL, metric TEXT NOT NULL, status INTEGER NOT NULL,
    total_ms REAL NOT NULL, database_ms REAL NOT NULL, queries INTEGER NOT NULL, external_ms REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'server', cold TEXT
  );
  CREATE INDEX IF NOT EXISTS performance_slow_at ON performance_slow(at);`);
  const columns = table => db.raw.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  // Older tables had no first-use flag in the key; rebuild them once with every row marked as not first use.
  const timingColumns = columns('performance_timings');
  if (!timingColumns.includes('cold')) {
    db.tx(() => {
      db.raw.exec(`CREATE TABLE performance_timings_next (
        hour INTEGER NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, metric TEXT NOT NULL,
        outcome TEXT NOT NULL, cold INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL,
        buckets TEXT NOT NULL, queries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(hour, version, source, metric, outcome, cold));
        INSERT INTO performance_timings_next(hour, version, source, metric, outcome, cold, count, total_ms, max_ms, buckets, queries)
          SELECT hour, version, source, metric, outcome, 0, count, total_ms, max_ms, buckets, ${timingColumns.includes('queries') ? 'queries' : '0'} FROM performance_timings;
        DROP TABLE performance_timings;
        ALTER TABLE performance_timings_next RENAME TO performance_timings;`);
    });
  }
  const slowColumns = columns('performance_slow');
  if (!slowColumns.includes('source')) db.raw.exec("ALTER TABLE performance_slow ADD COLUMN source TEXT NOT NULL DEFAULT 'server'");
  if (!slowColumns.includes('cold')) db.raw.exec('ALTER TABLE performance_slow ADD COLUMN cold TEXT');
  db.once('performance_buckets_2026_11', () => {
    for (const row of db.all('SELECT rowid, buckets FROM performance_timings')) {
      const buckets = JSON.parse(row.buckets);
      if (buckets.length !== TIMING_LIMITS.length) db.run('UPDATE performance_timings SET buckets = ? WHERE rowid = ?', JSON.stringify(normalizeBuckets(buckets)), row.rowid);
    }
  });
  const pending = new Map(), rates = new Map(), events = [];
  const retention = RETENTION_DAYS * 86400000;
  const flush = () => {
    if (!pending.size && !events.length) return;
    try {
      db.tx(() => {
        db.run('DELETE FROM performance_timings WHERE hour < ?', now() - retention);
        for (const entry of events) {
          db.run(`INSERT INTO performance_slow(at, version, source, metric, status, total_ms, database_ms, queries, external_ms, cold)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, entry.at, entry.version, entry.source, entry.metric, entry.status, entry.total_ms,
          entry.database_ms, entry.queries, entry.external_ms, entry.cold);
        }
        db.run('DELETE FROM performance_slow WHERE at < ? OR id <= (SELECT max(id) FROM performance_slow) - ?', now() - retention, EVENT_ROWS);
        for (const row of pending.values()) {
          const key = [row.hour, row.version, row.source, row.metric, row.outcome, row.cold];
          const old = db.get('SELECT * FROM performance_timings WHERE hour=? AND version=? AND source=? AND metric=? AND outcome=? AND cold=?', ...key);
          const buckets = old ? normalizeBuckets(JSON.parse(old.buckets)).map((n, i) => n + row.buckets[i]) : row.buckets;
          db.run(`INSERT OR REPLACE INTO performance_timings(hour, version, source, metric, outcome, cold, count, total_ms, max_ms, buckets, queries)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ...key,
          (old?.count || 0) + row.count, (old?.total_ms || 0) + row.total_ms,
          Math.max(old?.max_ms || 0, row.max_ms), JSON.stringify(buckets), (old?.queries || 0) + row.queries);
        }
      });
      pending.clear(); events.length = 0;
    } catch { /* Measurement must never break a staff request; retry the bounded buffer later. */ }
  };
  const record = (source, metric, ms, outcome, { release = version(), queries = 0, cold = false } = {}) => {
    if (!Number.isFinite(ms) || ms < 0 || ms > TIMING_LIMITS.at(-1)) return;
    const hour = Math.floor(now() / 3600000) * 3600000, flag = cold ? 1 : 0;
    const key = JSON.stringify([hour, release, source, metric, outcome, flag]);
    if (!pending.has(key)) {
      if (pending.size >= 512) return;
      pending.set(key, { hour, version: release, source, metric, outcome, cold: flag, count: 0, total_ms: 0, max_ms: 0, queries: 0, buckets: TIMING_LIMITS.map(() => 0) });
    }
    const row = pending.get(key);
    row.count++; row.total_ms += ms; row.max_ms = Math.max(row.max_ms, ms); row.queries += queries;
    row.buckets[TIMING_LIMITS.findIndex(limit => ms <= limit)]++;
  };
  const logEvent = entry => { if (events.length < EVENT_ROWS) events.push(entry); };
  // 'restart' for the first use after the server started, 'idle' after a break, otherwise null.
  let lastUse = -Infinity, wakeUntil = -Infinity, wake = null, started = false;
  const coldness = (metric, at) => {
    if (!BACKGROUND.has(metric)) {
      if (at - lastUse > IDLE_MS) { wakeUntil = at + WAKE_MS; wake = started ? 'idle' : 'restart'; started = true; }
      lastUse = Math.max(lastUse, at);
    }
    return at <= wakeUntil ? wake : null;
  };
  const timer = setInterval(flush, 30000);
  timer.unref();
  // Register before auth to include its SQL time. Only signed-in reads count.
  app.use('/api/*', async (c, next) => {
    const metric = c.req.method === 'GET' && requestMetric(c.req.path);
    if (!metric) return next();
    const start = performance.now(), at = now();
    const timing = newRequestTiming();
    await requestTimings.run(timing, async () => {
      try { await next(); }
      finally {
        if (timing.externalOpen) timing.externalMs += performance.now() - timing.externalSince;
        timing.active = false;
      }
    });
    if (!c.get('user')) return;
    const ms = performance.now() - start, status = c.res.status, outcome = status < 400 ? 'ok' : 'error';
    const cold = coldness(metric, at);
    c.header('Server-Timing', `app;dur=${ms.toFixed(1)}, sql;dur=${timing.databaseMs.toFixed(1)}, ext;dur=${timing.externalMs.toFixed(1)}${cold ? `, cold;desc=${cold}` : ''}`);
    record('server', metric, ms, outcome, { cold });
    record('database', metric, timing.databaseMs, outcome, { queries: timing.queries, cold });
    record('external', metric, timing.externalMs, outcome, { cold });
    if (ms > SLOW_REQUEST_MS || outcome === 'error') {
      logEvent({ at, version: version(), source: 'server', metric, status, total_ms: ms,
        database_ms: timing.databaseMs, queries: timing.queries, external_ms: timing.externalMs, cold });
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
        body.samples.some(s => !s || !METRICS.has(s.metric) || !Number.isFinite(s.ms) || s.ms < 0 || s.ms > 300000 || !['ok', 'error'].includes(s.outcome) ||
          (s.cold !== undefined && !['idle', 'restart'].includes(s.cold)) || (s.age !== undefined && (!Number.isInteger(s.age) || s.age < 0 || s.age > 600000)))) {
        return c.json({ error: 'Invalid timings' }, 400);
      }
      for (const s of body.samples) {
        record('browser', s.metric, s.ms, s.outcome, { release: body.version, cold: s.cold });
        // Page opens are listed one by one when slow; slow browser requests already appear as server events.
        if (s.metric.endsWith('-render') && s.outcome === 'ok' && s.ms > SLOW_PAGE_MS) {
          logEvent({ at: now() - (s.age || 0), version: body.version, source: 'browser', metric: s.metric, status: 200,
            total_ms: s.ms, database_ms: 0, queries: 0, external_ms: 0, cold: s.cold || null });
        }
      }
      return c.body(null, 204);
    });
    const read = c => {
      c.header('Cache-Control', 'no-store');
      const query = c.req.query();
      const hours = query.days !== undefined ? Number(query.days) * 24 : Number(query.hours ?? RETENTION_DAYS * 24);
      const release = query.version === 'current' ? version() : query.version;
      const timeZone = query.tz || 'UTC';
      if (!Number.isInteger(hours) || hours < 1 || hours > RETENTION_DAYS * 24 || (release && !/^[a-f0-9]{8}$/.test(release)) ||
        timeZone.length > 64 || !validZone(timeZone)) {
        return c.json({ error: `Use hours=1…${RETENTION_DAYS * 24} or days=1…${RETENTION_DAYS}, an eight-character version and a valid time zone` }, 400);
      }
      flush();
      const since = Math.floor((now() - hours * 3600000) / 3600000) * 3600000;
      const all = db.all('SELECT * FROM performance_timings WHERE hour >= ? ORDER BY hour, source, metric', since);
      const rows = all.filter(r => !release || r.version === release).map(r => ({ ...r, buckets: normalizeBuckets(JSON.parse(r.buckets)) }));
      const releases = new Map();
      for (const row of all) {
        const seen = releases.get(row.version) || { version: row.version, first_seen: row.hour, last_seen: row.hour };
        seen.first_seen = Math.min(seen.first_seen, row.hour); seen.last_seen = Math.max(seen.last_seen, row.hour);
        releases.set(row.version, seen);
      }
      const recent = db.all('SELECT * FROM performance_slow WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?', since, EVENT_ROWS)
        .filter(r => !release || r.version === release);
      return c.json({ retention_days: RETENTION_DAYS, current_version: version(), since, time_zone: timeZone, bucket_upper_ms: TIMING_LIMITS,
        releases: [...releases.values()].sort((a, b) => a.first_seen - b.first_seen), summary: summarizeTimings(rows),
        daily: dailyTimings(rows, timeZone), slow_request_ms: SLOW_REQUEST_MS, slow_page_ms: SLOW_PAGE_MS, idle_ms: IDLE_MS,
        events: recent });
    };
    app.get('/api/performance', c => c.get('user')?.is_admin ? read(c) : c.json({ error: 'Admin access required' }, 403));
    // Existing worker auth validates its credential before reaching this handler.
    app.get('/api/worker/performance', read);
  };
  return { registerRoutes, flush, close: () => { clearInterval(timer); flush(); } };
}
