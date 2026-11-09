// Curated private publications. The complete snapshot (including files) is backed up with SQLite.
import { createHash } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';

export const ANALYSIS_TOPICS = ['Scouting & recruitment', 'Team performance', 'Player development'];
export const MAX_ANALYSIS_BYTES = 20 * 1024 * 1024;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const date = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => typeof value === 'string' && date.test(value) && new Date(value).toISOString().slice(0, 10) === value;
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value, max = 20) => Array.isArray(value) && value.length <= max && value.every(v => text(v));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
const sha = data => createHash('sha256').update(data).digest('hex');

export function validateAnalysis(input) {
  const bad = message => { throw new Error(message); };
  if (!exact(input, ['schema_version', 'generated_at', 'reports']) || input.schema_version !== 1 ||
      !text(input.generated_at, 40) || !Number.isFinite(Date.parse(input.generated_at)) ||
      new Date(input.generated_at).toISOString() !== input.generated_at || Date.parse(input.generated_at) > Date.now() + 300_000 ||
      !Array.isArray(input.reports) || input.reports.length > 100) bad('Invalid analysis snapshot');
  const ids = new Set();
  for (const r of input.reports) {
    if (!exact(r, ['slug', 'title', 'topic', 'summary', 'updated', 'reviewed', 'review_after', 'coverage', 'status', 'read_minutes', 'tags', 'takeaways', 'limitations', 'sections', 'source', 'documents']) ||
        !text(r.slug, 80) || !slug.test(r.slug) || ids.has(r.slug) || !text(r.title, 160) || !ANALYSIS_TOPICS.includes(r.topic) ||
        !text(r.summary, 600) || !['Analysis', 'Reference', 'Preliminary', 'Exploratory'].includes(r.status) || !text(r.coverage, 600) ||
        ![r.updated, r.reviewed, r.review_after].every(validDate) || r.review_after < r.reviewed || r.updated > r.reviewed ||
        r.reviewed > new Date().toISOString().slice(0, 10) || !Number.isInteger(r.read_minutes) || r.read_minutes < 1 || r.read_minutes > 120 ||
        !strings(r.tags, 12) || !strings(r.takeaways, 8) || !r.takeaways.length || !text(r.limitations) ||
        !Array.isArray(r.sections) || !r.sections.length || r.sections.length > 20 || !Array.isArray(r.documents) || r.documents.length > 8) bad('Invalid report metadata');
    ids.add(r.slug);
    const s = r.source;
    if (!exact(s, ['repository', 'ref', 'path', 'sha256', 'text']) || s.repository !== 'fordb/hearts-of-pine' ||
        !/^[a-f0-9]{40}$/.test(s.ref) || !text(s.path, 240) || !/^(reports|experiments)\/[a-zA-Z0-9_./-]+\.md$/.test(s.path) ||
        s.path.split('/').includes('..') || !text(s.text, 250_000) || s.sha256 !== sha(s.text)) bad('Invalid report provenance');
    for (const section of r.sections) {
      if (!exact(section, ['title', 'paragraphs', 'bullets', 'table']) || !text(section.title, 160) ||
          (section.paragraphs !== undefined && !strings(section.paragraphs)) ||
          (section.bullets !== undefined && !strings(section.bullets))) bad('Invalid report section');
      if (section.table !== undefined) {
        const t = section.table;
        if (!exact(t, ['columns', 'rows']) || !strings(t.columns, 10) || !t.columns.length || !Array.isArray(t.rows) || t.rows.length > 100 ||
            !t.rows.every(row => strings(row, 10) && row.length === t.columns.length)) bad('Invalid report table');
      }
    }
    const files = new Set();
    for (const d of r.documents) {
      if (!exact(d, ['id', 'label', 'format', 'data', 'sha256']) || !text(d.id, 80) || !slug.test(d.id) || d.id === 'source' || files.has(d.id) ||
          !text(d.label, 120) || !['pdf', 'png'].includes(d.format) || !text(d.data, 7_000_000)) bad('Invalid report file');
      files.add(d.id);
      const bytes = Buffer.from(d.data, 'base64');
      if (bytes.toString('base64') !== d.data || d.sha256 !== sha(bytes) ||
          (d.format === 'pdf' ? !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) :
            !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) bad('Invalid report file contents');
    }
  }
  return input;
}

const withoutFiles = ({ documents, source, ...report }) => ({ ...report,
  source: { repository: source.repository, ref: source.ref, path: source.path, sha256: source.sha256 },
  documents: documents.map(({ data, ...file }) => file),
});

export function registerAnalysis(app, { db }) {
  db.run('CREATE TABLE IF NOT EXISTS analysis_library(id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)');
  const read = () => JSON.parse(db.get('SELECT payload FROM analysis_library WHERE id = 1')?.payload || '{"reports":[],"generated_at":null}');
  // These endpoints inherit the server's staff-session gate and worker-token gate.
  app.use('/api/analysis/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
  app.get('/api/analysis', c => {
    c.header('Cache-Control', 'private, no-store');
    const snapshot = read();
    return c.json({ generated_at: snapshot.generated_at, reports: snapshot.reports.map(withoutFiles) });
  });
  app.get('/api/analysis/:slug', c => {
    const report = read().reports.find(r => r.slug === c.req.param('slug'));
    return report ? c.json({ report: withoutFiles(report) }) : c.json({ error: 'Report not found' }, 404);
  });
  app.get('/api/analysis/:slug/files/:id', c => {
    const report = read().reports.find(r => r.slug === c.req.param('slug'));
    const id = c.req.param('id');
    if (id === 'source' && report) {
      c.header('Content-Type', 'text/plain; charset=utf-8');
      c.header('Content-Disposition', `attachment; filename="${report.slug}.md"`);
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(report.source.text);
    }
    const file = report?.documents.find(d => d.id === id);
    if (!file) return c.json({ error: 'File not found' }, 404);
    c.header('Content-Type', file.format === 'pdf' ? 'application/pdf' : 'image/png');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename="${report.slug}-${file.id}.${file.format}"`);
    return c.body(Buffer.from(file.data, 'base64'));
  });
  app.put('/api/worker/analysis', bodyLimit({ maxSize: MAX_ANALYSIS_BYTES }), async c => {
    let snapshot;
    try { snapshot = validateAnalysis(await c.req.json()); }
    catch { return c.json({ error: 'Invalid analysis publication; previous library retained' }, 400); }
    const current = read();
    if (current.generated_at && snapshot.generated_at <= current.generated_at) return c.json({ error: 'Older publication rejected' }, 409);
    db.run('INSERT INTO analysis_library(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', JSON.stringify(snapshot));
    return c.json({ ok: true, reports: snapshot.reports.length, generated_at: snapshot.generated_at });
  });
}
