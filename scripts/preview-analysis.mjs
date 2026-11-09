// Isolated fictional publication and empty player database. Never reads a production database.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';
import { demoPublication } from './fixtures/analysis-demo.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pine-analysis-preview-'));
const file = join(dir, 'pine.db');
const db = openDb(file); db.raw.close();
const child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
  env: { ...process.env, PINE_DB: file, PINE_AUTH: 'off', PORT: '0', PINE_WORKER_TOKEN: 'fictional-preview-only',
    PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', d => process.stderr.write(d));
let ready = false;
child.stdout.on('data', async data => {
  const port = String(data).match(/localhost:(\d+)/)?.[1];
  if (!port || ready) return;
  ready = true;
  const response = await fetch(`http://127.0.0.1:${port}/api/worker/analysis`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-PINE': '1', 'X-PINE-Worker-Token': 'fictional-preview-only' },
    body: JSON.stringify(demoPublication()) });
  if (!response.ok) { console.error('Preview publication failed'); child.kill(); return; }
  console.log(`Fictional analysis preview: http://localhost:${port}/#/analysis`);
});
process.on('SIGINT', () => child.kill()); process.on('SIGTERM', () => child.kill());
child.on('exit', code => { rmSync(dir, { recursive: true, force: true }); process.exit(code || 0); });
