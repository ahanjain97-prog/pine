import { statfsSync } from 'node:fs';
import { cardErrorCode, cardProgress, sqlTime } from './cards.js';

const DAY = 86400000;
const KINDS = new Set(['cards', 'maps']);
const EVENTS = new Set(['requested', 'started', 'progress', 'done', 'failed']);
const timestamp = value => value ? Date.parse(`${value.replace(' ', 'T')}Z`) : NaN;
const elapsed = (end, start) => Number.isFinite(end - start) && end >= start ? end - start : null;

export function workerStatus(lastSeen, now) {
  const age = lastSeen == null ? null : Math.max(0, now - lastSeen);
  return { last_seen_at: lastSeen == null ? null : new Date(lastSeen).toISOString(), age_ms: age,
    status: age == null ? 'unknown' : age <= 60000 ? 'recent' : age <= 300000 ? 'quiet' : 'missing' };
}

// Only authenticated card/map protocol traffic proves worker contact. Diagnostic reads do not.
export function workerTraffic(method, path) {
  const claim = /^\/api\/worker\/(cards|maps)\/claim$/.exec(path);
  if (method === 'POST' && claim) return claim[1];
  const job = /^\/api\/worker\/(cards|maps)\/\d+\/(progress|fail|png|pdf|snapshot|json)$/.exec(path);
  if (!job) return null;
  if (method === 'POST' && ['progress', 'fail'].includes(job[2])) return job[1];
  return method === 'PUT' && (job[1] === 'cards' ? ['png', 'pdf', 'snapshot'] : ['json']).includes(job[2]) ? job[1] : null;
}

export function registerMonitoring(app, { db, version, root, now = Date.now,
  runtime = () => ({ uptime_seconds: process.uptime(), memory_bytes: process.memoryUsage().rss }),
  disk = () => { const s = statfsSync(root); return { free_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize }; },
}) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS monitoring_workers (
      kind TEXT PRIMARY KEY, seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monitoring_events (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, job_id INTEGER NOT NULL,
      player_id INTEGER, position TEXT, season TEXT, event TEXT NOT NULL, attempts INTEGER NOT NULL,
      error TEXT, queue_ms REAL, build_ms REAL
    );
    CREATE INDEX IF NOT EXISTS monitoring_events_at ON monitoring_events(at);`);
  const seen = new Map(db.all('SELECT * FROM monitoring_workers').map(row => [row.kind, { at: row.seen_at, saved: row.seen_at }]));
  const started = now();
  let pruneAt = 0, dropped = 0;
  const contact = kind => {
    const time = now(), previous = seen.get(kind);
    const entry = { at: time, saved: previous?.saved ?? 0 };
    seen.set(kind, entry);
    if (!previous || time - entry.saved >= 30000) {
      try {
        db.run('INSERT OR REPLACE INTO monitoring_workers(kind, seen_at) VALUES (?, ?)', kind, time);
        entry.saved = time;
      } catch { dropped++; }
    }
  };
  const recordJob = (kind, id, event) => {
    if (!KINDS.has(kind) || !EVENTS.has(event)) return;
    try {
      const job = db.get(`SELECT * FROM ${kind} WHERE id = ?`, id);
      if (!job) return;
      if (job.status !== { requested: 'queued', started: 'running', progress: 'running', done: 'done', failed: 'failed' }[event]) return;
      const time = now(), requested = timestamp(job.requested_at), began = timestamp(job.started_at);
      db.run(`INSERT INTO monitoring_events(at, kind, job_id, player_id, position, season, event, attempts, error, queue_ms, build_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, time, kind, id, job.player_id, job.position, job.season,
      event, job.attempts, event === 'failed' ? cardErrorCode(job.error) : event === 'progress' ? cardProgress(job.progress)?.code ?? null : null,
      event === 'started' ? elapsed(began, requested) : null,
      event === 'done' ? elapsed(timestamp(job.generated_at), began) : null);
      if (time >= pruneAt) {
        db.run('DELETE FROM monitoring_events WHERE at < ?', time - 14 * DAY);
        pruneAt = time + 3600000;
      }
    } catch { dropped++; /* Monitoring must not fail a job or upload. */ }
  };
  // Claiming also finalizes exhausted jobs. Preserve those failures before the next retry/build.
  const claimJob = (kind, claim) => {
    if (!KINDS.has(kind)) return claim();
    let exhausted = [];
    try {
      exhausted = db.all(`SELECT id FROM ${kind} WHERE status = 'running' AND attempts >= 3
        AND started_at < datetime('now', '-15 minutes')`);
    } catch { dropped++; }
    const job = claim();
    for (const row of exhausted) recordJob(kind, row.id, 'failed');
    if (job) recordJob(kind, job.id, 'started');
    return job;
  };
  app.use('/api/worker/*', async (c, next) => {
    const kind = workerTraffic(c.req.method, c.req.path);
    await next();
    if (kind && c.res.status < 400) contact(kind);
  });
  const report = c => {
    c.header('Cache-Control', 'private, no-store');
    const time = now(), cutoff = sqlTime(new Date(time - 15 * 60000));
    const queues = [...KINDS].map(kind => {
      const counts = db.get(`SELECT count(*) FILTER (WHERE status = 'queued') AS queued,
        count(*) FILTER (WHERE status = 'running') AS running,
        count(*) FILTER (WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)) AS stalled,
        min(requested_at) FILTER (WHERE status = 'queued') AS oldest_queued_at FROM ${kind}`, cutoff);
      const totals = db.get(`SELECT count(*) FILTER (WHERE event = 'requested') AS requested,
        count(*) FILTER (WHERE event = 'done') AS completed, count(*) FILTER (WHERE event = 'failed') AS failed,
        avg(queue_ms) AS mean_queue_ms, avg(build_ms) AS mean_build_ms,
        count(queue_ms) AS queue_samples, count(build_ms) AS build_samples
        FROM monitoring_events WHERE kind = ? AND at >= ?`, kind, time - DAY);
      return { kind, ...counts, oldest_queue_ms: elapsed(time, timestamp(counts.oldest_queued_at)), ...totals };
    });
    const active = [...KINDS].flatMap(kind => db.all(`SELECT j.id, j.player_id, p.name AS player_name,
      j.position, j.season, j.status, j.attempts, j.requested_at, j.started_at, j.progress, j.progress_matches
      FROM ${kind} j LEFT JOIN players p ON p.id = j.player_id WHERE j.status IN ('queued','running')
      ORDER BY j.requested_at, j.id LIMIT 50`).map(row => ({ ...row, kind,
      age_ms: elapsed(time, timestamp(row.status === 'running' ? row.started_at : row.requested_at)) })));
    const events = db.all(`SELECT e.*, p.name AS player_name FROM monitoring_events e
      LEFT JOIN players p ON p.id = e.player_id WHERE e.at >= ? ORDER BY e.at DESC, e.id DESC LIMIT 40`, time - 14 * DAY);
    let storage = null;
    try { storage = disk(); } catch { /* An unavailable disk reading is shown as unknown. */ }
    const workers = [...KINDS].map(kind => ({ kind, ...workerStatus(seen.get(kind)?.at, time) }));
    const lastContact = Math.max(...[...seen.values()].map(entry => entry.at));
    return c.json({ at: new Date(time).toISOString(), version: version(), ...runtime(), storage,
      server_started_at: new Date(started).toISOString(), dropped_observations: dropped,
      worker: workerStatus(Number.isFinite(lastContact) ? lastContact : null, time), workers,
      queues, active, active_limit_per_kind: 50, events });
  };
  app.get('/api/monitoring', c => c.get('user')?.is_admin ? report(c) : c.json({ error: 'Admin access required' }, 403));
  app.get('/api/worker/monitoring', report);
  return { recordJob, claimJob };
}
