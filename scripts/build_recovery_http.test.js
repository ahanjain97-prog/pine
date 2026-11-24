import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';

test('HTTP: cards and maps keep recovery history, deduplicate progress, and reject raw diagnostics', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-recovery-')), file = join(dir, 'pine.db');
  const db = openDb(file);
  const player = Number(db.run("INSERT INTO players(name,impect_id) VALUES ('Fictional Forward',99001)").lastInsertRowid);
  const jobs = ['cards', 'maps'].map(kind => ({ kind, id: Number(db.run(`INSERT INTO ${kind}(player_id,impect_id,iteration_id,position,status,attempts) VALUES (?,99001,7,'CF','running',1)`, player).lastInsertRowid) }));
  db.raw.close();
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
    env: { ...process.env, PINE_DB: file, PINE_AUTH: 'on', PORT: '0', APP_URL: '', PINE_WORKER_TOKEN: 'recovery-test', PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } rmSync(dir, { recursive: true, force: true }); });
  let port, output = '';
  child.stdout.on('data', d => { output += d; port = Number(output.match(/localhost:(\d+)/)?.[1]); });
  child.stderr.on('data', d => { output += d; });
  for (let i = 0; i < 100 && !port; i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(port, output);
  const headers = { 'X-PINE': '1', 'X-PINE-Worker-Token': 'recovery-test', 'Content-Type': 'application/json' };
  const post = (kind, id, route, body) => fetch(`http://127.0.0.1:${port}/api/worker/${kind}/${id}/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  for (const { kind, id } of jobs) {
    assert.equal((await post(kind, id, 'progress', { code: 'reconciling_data' })).status, 200);
    assert.equal((await post(kind, id, 'progress', { code: 'reconciling_data' })).status, 200);
    assert.equal((await post(kind, id, 'progress', { code: 'private provider URL' })).status, 400);
    assert.equal((await post(kind, id, 'fail', { code: 'data_mismatch', detail: 'private provider URL' })).status, 200);
    assert.equal((await post(kind, id, 'progress', { code: 'retrying_provider' })).status, 409);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/worker/monitoring`)).status, 401);
  const report = await (await fetch(`http://127.0.0.1:${port}/api/worker/monitoring`, { headers })).json();
  for (const { kind, id } of jobs) {
    const events = report.events.filter(e => e.kind === kind && e.job_id === id);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => [e.event, e.error]), [['failed', 'data_mismatch'], ['progress', 'reconciling_data']]);
  }
  assert.ok(!JSON.stringify(report).includes('private provider URL'));
});
