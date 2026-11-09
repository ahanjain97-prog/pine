// Publish only the editorially approved, revision-pinned catalog from the private analysis repo.
// No provider calls, arbitrary HTML, repository scan, or automatic promotion of draft work.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { MAX_ANALYSIS_BYTES, validateAnalysis } from '../src/lib/analysis.js';

const digest = data => createHash('sha256').update(data).digest('hex');
const safePath = path => typeof path === 'string' && /^(reports|experiments)\/[a-zA-Z0-9_./-]+$/.test(path) && !path.split('/').includes('..');
export function buildPublication(root, catalogRef = 'origin/main', catalogPath = 'reports/pine-library.json') {
  if (!safePath(catalogPath)) throw new Error('Invalid catalog path');
  const read = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, maxBuffer: MAX_ANALYSIS_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  const catalogCommit = execFileSync('git', ['rev-parse', '--verify', `${catalogRef}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const catalog = JSON.parse(read(catalogCommit, catalogPath));
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.reports)) throw new Error('Invalid catalog');
  const reports = catalog.reports.map(entry => {
    const { source, documents, ...metadata } = entry;
    if (!/^[a-f0-9]{40}$/.test(source?.ref) || !safePath(source.path)) throw new Error('Source must pin an immutable reviewed commit');
    const text = read(source.ref, source.path).toString('utf8');
    return { ...metadata, source: { repository: 'fordb/hearts-of-pine', ref: source.ref, path: source.path, text, sha256: digest(text) },
      documents: documents.map(file => {
        if (!safePath(file.path)) throw new Error('Invalid publication file path');
        const bytes = read(source.ref, file.path);
        return { id: file.id, label: file.label, format: file.format, data: bytes.toString('base64'), sha256: digest(bytes) };
      }),
    };
  });
  const snapshot = validateAnalysis({ schema_version: 1, generated_at: new Date().toISOString(), reports });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_ANALYSIS_BYTES) throw new Error('Publication exceeds 20 MB');
  return snapshot;
}

async function main() {
  const { values } = parseArgs({ options: { 'hop-root': { type: 'string' }, 'catalog-ref': { type: 'string', default: 'origin/main' },
    catalog: { type: 'string', default: 'reports/pine-library.json' }, output: { type: 'string' }, upload: { type: 'boolean' },
    fetch: { type: 'boolean' }, watch: { type: 'string' } } });
  if (!values['hop-root'] || (!values.output && !values.upload)) throw new Error('Use --hop-root PATH and --output PRIVATE_PATH and/or --upload');
  const root = resolve(values['hop-root']);
  const interval = values.watch === undefined ? null : Number(values.watch);
  if (interval !== null && (!Number.isInteger(interval) || interval < 60)) throw new Error('--watch must be at least 60 seconds');
  let url;
  if (values.upload) {
    url = new URL(process.env.PINE_URL);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || !process.env.PINE_WORKER_TOKEN) throw new Error('Set PINE_URL to the HTTPS origin and PINE_WORKER_TOKEN');
  }
  let previous;
  const run = async () => {
    if (values.fetch) execFileSync('git', ['fetch', 'origin'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const snapshot = buildPublication(root, values['catalog-ref'], values.catalog);
    const content = digest(JSON.stringify(snapshot.reports));
    if (content === previous) return;
    const payload = JSON.stringify(snapshot);
    if (values.output) writeFileSync(resolve(values.output), payload, { mode: 0o600 });
    if (url) {
      const response = await fetch(new URL('/api/worker/analysis', url), { method: 'PUT', redirect: 'error',
        signal: AbortSignal.timeout(60_000), headers: { 'Content-Type': 'application/json', 'X-PINE': '1', 'X-PINE-Worker-Token': process.env.PINE_WORKER_TOKEN }, body: payload });
      if (!response.ok) throw new Error(`Publication upload failed (HTTP ${response.status}); previous library retained`);
    }
    previous = content;
    console.log(`${url ? 'Published' : 'Validated'} ${snapshot.reports.length} curated reports (${Buffer.byteLength(payload)} bytes)`);
  };
  do {
    try { await run(); }
    catch (error) { if (interval === null) throw error; console.error(`Analysis sync failed: ${error.message}`); }
    if (interval !== null) await new Promise(resolve => setTimeout(resolve, interval * 1000));
  } while (interval !== null);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
