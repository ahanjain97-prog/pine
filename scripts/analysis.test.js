import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { registerAnalysis, validateAnalysis } from '../src/lib/analysis.js';
import { filterReports } from '../public/analysis.js';
import { buildPublication } from './sync-analysis.mjs';
import { demoPublication } from './fixtures/analysis-demo.mjs';

test('curated publication rejects invalid provenance, dates, duplicate IDs and file tampering', () => {
  assert.equal(validateAnalysis(demoPublication()).reports.length, 6);
  for (const edit of [
    x => { x.reports[0].source.sha256 = '0'.repeat(64); },
    x => { x.reports[0].source.ref = 'main'; },
    x => { x.reports[0].source.path = 'reports/../.env.md'; },
    x => { x.reports[0].reviewed = '2026-02-30'; },
    x => { x.reports[0].review_after = '2020-01-01'; },
    x => { x.reports[0].status = 'Superseded'; },
    x => { x.reports[1].slug = x.reports[0].slug; },
    x => { x.reports[0].html = '<script>alert(1)</script>'; },
    x => { x.reports[0].documents = [{ id: 'report', label: 'Report', format: 'pdf', data: 'bm90LXBkZg==', sha256: 'x' }]; },
  ]) {
    const snapshot = demoPublication(); edit(snapshot); assert.throws(() => validateAnalysis(snapshot));
  }
});

test('publication is atomic, survives restart, excludes file bodies in listing and supports withdrawal', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-analysis-test-')), file = join(dir, 'pine.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db, app;
  const open = () => { db = openDb(file); app = new Hono(); registerAnalysis(app, { db }); };
  open(); t.after(() => db.raw.close());
  const upload = value => app.request('/api/worker/analysis', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.deepEqual((await (await app.request('/api/analysis')).json()).reports, []);
  const snapshot = demoPublication();
  const pdf = Buffer.from('%PDF-1.4\nfictional test fixture\n%%EOF');
  snapshot.reports[0].documents = [{ id: 'report', label: 'Full report', format: 'pdf', data: pdf.toString('base64'), sha256: createHash('sha256').update(pdf).digest('hex') }];
  assert.equal((await upload(snapshot)).status, 200);
  const list = await app.request('/api/analysis');
  assert.match(list.headers.get('cache-control'), /private, no-store/);
  const metadata = await list.json();
  assert.equal(metadata.reports.length, 6);
  assert.equal(metadata.reports[0].source.text, undefined);
  assert.equal(metadata.reports[0].documents[0].data, undefined);
  const attachment = await app.request('/api/analysis/cpl-scouting/files/report?download=1');
  assert.equal(attachment.headers.get('content-type'), 'application/pdf');
  assert.match(attachment.headers.get('content-disposition'), /attachment/);
  assert.match(attachment.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), pdf);
  assert.equal((await app.request('/api/analysis/cpl-scouting/files/source')).headers.get('content-type'), 'text/plain; charset=utf-8');
  const invalid = structuredClone(snapshot); invalid.reports[1].topic = 'Drafts';
  assert.equal((await upload(invalid)).status, 400);
  assert.equal((await upload(snapshot)).status, 409);
  db.raw.close(); open();
  assert.equal((await (await app.request('/api/analysis')).json()).reports.length, 6);
  const withdrawn = { schema_version: 1, generated_at: new Date(Date.now() + 100).toISOString(), reports: [] };
  assert.equal((await upload(withdrawn)).status, 200);
  assert.equal((await app.request('/api/analysis/cpl-scouting')).status, 404);
  assert.equal((await app.request('/api/analysis/cpl-scouting/files/report')).status, 404);
});

test('search supports multiple terms, accents, brief text, topic filters and independent sorting', () => {
  const reports = demoPublication().reports;
  assert.equal(filterReports(reports, { q: 'CPL opportunity' }).length, 1);
  assert.equal(filterReports(reports, { q: 'demonstrátion', topic: 'Team performance' }).length, 2);
  assert.equal(filterReports(reports, { q: 'no such finding' }).length, 0);
  assert.equal(filterReports(reports, { sort: 'newest' })[0].slug, 'mlsnp-graduation');
  assert.equal(filterReports(reports, { sort: 'title' })[0].slug, 'age-curves');
  assert.equal(reports[0].slug, 'cpl-scouting', 'sorting does not mutate catalog order');
});

test('publisher reads pinned Git objects, never unreviewed working-tree changes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-publish-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'demo@example.test'); git('config', 'user.name', 'Demo');
  mkdirSync(join(dir, 'reports'));
  writeFileSync(join(dir, 'reports/demo.md'), '# Reviewed text');
  git('add', '.'); git('commit', '-m', 'Reviewed source');
  const ref = git('rev-parse', 'HEAD');
  const report = demoPublication().reports[0];
  report.source = { ref, path: 'reports/demo.md' };
  report.documents = [];
  writeFileSync(join(dir, 'reports/pine-library.json'), JSON.stringify({ schema_version: 1, reports: [report] }));
  git('add', '.'); git('commit', '-m', 'Curate source');
  writeFileSync(join(dir, 'reports/demo.md'), '# Unreviewed changes');
  const publication = buildPublication(dir, 'HEAD');
  assert.equal(publication.reports[0].source.text, '# Reviewed text');
  assert.equal(publication.reports[0].source.ref, ref);
});
