import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';
import { createSetupLink } from '../src/auth.js';
import { demoPublication } from './fixtures/analysis-demo.mjs';

test('HTTP: staff sign-in protects catalog, briefs and attachments; only worker token publishes', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-analysis-http-')), file = join(dir, 'pine.db');
  const db = openDb(file);
  const user = db.get('SELECT id FROM users ORDER BY id LIMIT 1');
  const { token } = createSetupLink(db, user.id);
  db.raw.close();
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
    env: { ...process.env, PINE_DB: file, PINE_AUTH: 'on', PORT: '0', APP_URL: '',
      PINE_WORKER_TOKEN: 'test-analysis-worker', PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } rmSync(dir, { recursive: true, force: true }); });
  let port, output = '';
  child.stdout.on('data', d => { output += d; port = Number(output.match(/localhost:(\d+)/)?.[1]); });
  child.stderr.on('data', d => { output += d; });
  for (let i = 0; i < 100 && !port; i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(port, output);
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, options);
  const privatePaths = ['/api/analysis', '/api/analysis/cpl-scouting', '/api/analysis/cpl-scouting/files/source', '/api/analysis/cpl-scouting/files/sample'];
  for (const path of privatePaths) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/analysis/cpl-scouting.pdf')).status, 404, 'no static publication path');
  const payload = JSON.stringify(demoPublication());
  const headers = { 'Content-Type': 'application/json', 'X-PINE': '1' };
  assert.equal((await request('/api/worker/analysis', { method: 'PUT', headers, body: payload })).status, 401);
  assert.equal((await request('/api/worker/analysis', { method: 'PUT', headers: { ...headers, 'X-PINE-Worker-Token': 'test-analysis-worker' }, body: payload })).status, 200);
  assert.equal((await request('/api/worker/analysis', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PINE-Worker-Token': 'test-analysis-worker' }, body: payload })).status, 400, 'CSRF header required');
  const signedIn = await request('/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ token, password: 'Fictional password 123!' }) });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  for (const path of privatePaths) {
    const response = await request(path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private, no-store/);
  }
  assert.equal((await request('/api/analysis', { headers: { 'X-PINE-Worker-Token': 'test-analysis-worker' } })).status, 401, 'worker tokens cannot read staff content');
  assert.equal((await request('/api/worker/analysis', { method: 'PUT', headers: { ...headers, Cookie: cookie }, body: payload })).status, 401, 'staff cannot publish with a session');
});
