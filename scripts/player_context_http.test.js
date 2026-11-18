import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { contextSample } from './fixtures/player-context.mjs';
import { openDb } from '../src/db.js';
import { createSetupLink } from '../src/auth.js';

const exec = promisify(execFile);

test('HTTP and CLI: isolated agent auth, complete live reads, backup fallback, and read-only snapshots', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-context-http-')), file = join(dir, 'pine.sqlite');
  const db = contextSample(openDb(file));
  const { token } = createSetupLink(db, 101);
  db.raw.close();
  const envFile = join(dir, '.env'); writeFileSync(envFile, '');
  const env = { ...process.env, PINE_ENV: envFile, PINE_DB: file, PINE_AUTH: 'on', PORT: '0', APP_URL: '', PINE_URL: '',
    PINE_WORKER_TOKEN: 'fictional-worker', PINE_BACKUP_TOKEN: 'fictional-backup', PINE_AGENT_TOKEN: 'fictional-agent',
    PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' };
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } rmSync(dir, { recursive: true, force: true }); });
  let port, output = '';
  child.stdout.on('data', d => { output += d; port = Number(output.match(/localhost:(\d+)/)?.[1]); });
  child.stderr.on('data', d => { output += d; });
  for (let i = 0; i < 100 && !port; i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(port, output);
  const origin = `http://127.0.0.1:${port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, options);
  const path = '/api/agent/player-context?board=big&role=FWD2';
  for (const headers of [{}, { 'X-PINE-Worker-Token': env.PINE_WORKER_TOKEN }, { 'X-PINE-Backup-Token': env.PINE_BACKUP_TOKEN }]) {
    assert.equal((await request(path, { headers })).status, 401);
  }
  const signIn = await request('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PINE': '1' },
    body: JSON.stringify({ token, password: 'Fictional password 123!' }) });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(path, { headers: { Cookie: cookie } })).status, 401, 'staff session cannot read club-wide private threads');
  const headers = { 'X-PINE-Agent-Token': env.PINE_AGENT_TOKEN };
  const response = await request(path, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const result = await response.json();
  assert.equal(result.pagination.total, 2);
  assert.equal(result.players[0].reviews[1].notes[0].body, 'Watch again next month');
  assert.equal(result.players[0].activity.length, 49);
  assert.equal((await request('/api/players', { headers })).status, 401, 'agent key does not grant general app access');
  assert.equal((await request('/api/worker/scouting-context', { headers })).status, 401);
  assert.equal((await request('/api/backup', { headers })).status, 401);
  assert.equal((await request('/api/players/501/decision', { method: 'PUT', headers: { ...headers, 'X-PINE': '1', 'Content-Type': 'application/json' }, body: '{"decision":"fail"}' })).status, 401);
  assert.equal((await request('/api/agent/player-context', { method: 'POST', headers: { ...headers, 'X-PINE': '1' } })).status, 405);
  const worker = await (await request('/api/worker/scouting-context', { headers: { 'X-PINE-Worker-Token': env.PINE_WORKER_TOKEN } })).json();
  assert.equal(JSON.stringify(worker).includes('Strong in the air'), false, 'limited worker context unchanged');

  const args = ['scripts/player-context.mjs', '--url', origin, '--board', 'big', '--role', 'FWD2'];
  const live = JSON.parse((await exec(process.execPath, args, { env })).stdout);
  assert.equal(live.source.kind, 'live_api');
  assert.deepEqual(live.players, result.players);
  const backup = JSON.parse((await exec(process.execPath, args, { env: { ...env, PINE_AGENT_TOKEN: '' } })).stdout);
  assert.equal(backup.source.kind, 'live_backup');
  assert.deepEqual(backup.players, result.players);

  // Read a static backup so neither the test server nor the reader can change the fixture under the hash check.
  const snapshotFile = join(dir, 'snapshot.sqlite');
  const bytes = Buffer.from(await (await request('/api/backup', { headers: { 'X-PINE-Backup-Token': env.PINE_BACKUP_TOKEN } })).arrayBuffer());
  writeFileSync(snapshotFile, bytes);
  const digest = () => createHash('sha256').update(readFileSync(snapshotFile)).digest('hex');
  const before = digest();
  const local = JSON.parse((await exec(process.execPath, ['scripts/player-context.mjs', '--db', snapshotFile, '--player-id', '500'], { env })).stdout);
  assert.equal(local.source.kind, 'local_snapshot');
  assert.equal(local.players[0].player.id, 501);
  assert.equal(digest(), before, 'CLI does not migrate or write the snapshot');
  await assert.rejects(exec(process.execPath, ['scripts/player-context.mjs', '--board', 'big'], { env: { ...env, PINE_AGENT_TOKEN: '', PINE_BACKUP_TOKEN: '' } }), /Set PINE_URL/);
  await assert.rejects(exec(process.execPath, ['scripts/player-context.mjs', '--url', origin, '--roles', 'FWD2'], { env }), /Unknown option/);
  await assert.rejects(exec(process.execPath, ['scripts/player-context.mjs', '--url', 'http://example.com'], { env }), /requires HTTPS/);
});
