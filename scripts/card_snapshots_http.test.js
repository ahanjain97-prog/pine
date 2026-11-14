import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';
import { createSetupLink } from '../src/auth.js';
import { sha256 } from '../src/lib/card_snapshots.js';

const pdf = Buffer.from('%PDF-1.7 synthetic card\n');
function snapshot() {
  return { schema: 1, pdf_sha256: sha256(pdf), hop_commit: 'abcdef1', data_as_of: '2026-10-01', render_input: {
    schema_version: 16, id: 'player-555-1916-am', iteration: 1916,
    subject: { id: 555, profiles: [{}] }, context: {}, events: { position: 'AM' }, provenance: {},
  } };
}

test('HTTP: snapshots bind to a PDF, require auth, backfill without changing artifacts, and reject replacement', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-snapshot-http-')), file = join(dir, 'pine.db');
  const db = openDb(file), user = db.get('SELECT id FROM users ORDER BY id LIMIT 1');
  const { token } = createSetupLink(db, user.id);
  const player = Number(db.run("INSERT INTO players(name,impect_id) VALUES ('Synthetic Player',555)").lastInsertRowid);
  const add = (status, stored = null) => Number(db.run("INSERT INTO cards(player_id,impect_id,iteration_id,position,status,file,hop_commit,data_as_of) VALUES (?,555,1916,'AM',?,?,'abcdef1','2026-10-01')", player, status, stored).lastInsertRowid);
  const old = add('done', `${player}/old.pdf`), running = add('running'), legacy = add('running'), queued = add('queued');
  db.run("UPDATE cards SET position = 'CF' WHERE id = ?", legacy);
  mkdirSync(join(dir, 'cards', String(player)), { recursive: true });
  writeFileSync(join(dir, 'cards', String(player), 'old.pdf'), pdf); db.raw.close();
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
    env: { ...process.env, PINE_DB: file, PINE_AUTH: 'on', PORT: '0', APP_URL: '', PINE_WORKER_TOKEN: 'snapshot-test', PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } rmSync(dir, { recursive: true, force: true }); });
  let port, output = '';
  child.stdout.on('data', d => { output += d; port = Number(output.match(/localhost:(\d+)/)?.[1]); });
  child.stderr.on('data', d => { output += d; });
  for (let i = 0; i < 100 && !port; i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(port, output);
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, options);
  const worker = { 'X-PINE': '1', 'X-PINE-Worker-Token': 'snapshot-test', 'Content-Type': 'application/json' };
  const put = (id, body, headers = worker) => request(`/api/worker/cards/${id}/snapshot`, { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal((await put(old, snapshot(), { 'X-PINE': '1' })).status, 401);
  assert.equal((await put(queued, snapshot())).status, 409);
  assert.equal((await put(old, { ...snapshot(), pdf_sha256: '0'.repeat(64) })).status, 409);
  assert.equal((await put(old, { ...snapshot(), hop_commit: 'abcdef2' })).status, 409);
  assert.equal((await put(old, snapshot())).status, 200);
  assert.equal((await put(old, snapshot())).status, 200);
  const changed = snapshot(); changed.render_input.context.changed = true;
  assert.equal((await put(old, changed)).status, 409);
  assert.deepEqual(readFileSync(join(dir, 'cards', String(player), 'old.pdf')), pdf);
  assert.equal((await request(`/api/cards/${old}/snapshot`)).status, 401);
  assert.equal((await request(`/api/cards/${old}/snapshot`, { headers: worker })).status, 401);
  assert.equal((await request('/api/worker/cards/snapshots')).status, 401);
  const inventory = await (await request('/api/worker/cards/snapshots', { headers: worker })).json();
  assert.equal(inventory.cards[0].pdf_sha256, sha256(pdf));
  assert.equal(inventory.cards[0].has_snapshot, true);
  assert.equal(inventory.cards[0].file, undefined);
  assert.equal((await request('/api/worker/cards/snapshots?after=-1', { headers: worker })).status, 400);
  const login = await request('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PINE': '1' }, body: JSON.stringify({ token, password: 'Synthetic password 123!' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const read = await request(`/api/cards/${old}/snapshot`, { headers: { Cookie: cookie } });
  assert.equal(read.status, 200); assert.deepEqual(await read.json(), snapshot());
  assert.equal((await request(`/api/cards/${legacy}/snapshot`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await put(running, snapshot())).status, 200);
  const pdfHeaders = { ...worker, 'Content-Type': 'application/pdf', 'X-PINE-Card-Commit': 'abcdef1', 'X-PINE-Card-Data-As-Of': '2026-10-01' };
  const upload = (id, body) => request(`/api/worker/cards/${id}/pdf`, { method: 'PUT', headers: pdfHeaders, body });
  assert.equal((await upload(running, '%PDF-other')).status, 409);
  assert.equal((await upload(running, pdf)).status, 200);
  assert.equal((await upload(legacy, pdf)).status, 200, 'old workers remain compatible');
});
