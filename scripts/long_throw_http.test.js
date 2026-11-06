import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { LONG_THROW_RULE } from '../src/lib/long_throw.js';

// Exercise the real auth middleware, PATCH validation, hydration and board response.
test('HTTP: sync → newly linked player → manual No → refresh → Auto → restart', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pine-long-throw-http-')), file = join(dir, 'pine.db');
  const db = openDb(file); // create it first so server never imports a private seed
  db.run("INSERT INTO players(id,name) VALUES (10001,'Example Defender')");
  db.run("INSERT INTO board_entries(player_id,role,rank,shortlist) VALUES (10001,'RB1',0,1)");
  db.raw.close();
  let child, port;
  const start = async () => {
    child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
      cwd: process.cwd(), env: { ...process.env, PINE_DB: file, PINE_AUTH: 'off', PORT: '0',
        PINE_WORKER_TOKEN: 'local-test-token', PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; const m = output.match(/localhost:(\d+)/); if (m) port = Number(m[1]); });
    child.stderr.on('data', (d) => { output += d; });
    for (let i = 0; i < 100 && !port; i++) {
      if (child.exitCode !== null) throw new Error(`Preview server failed to start: ${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(port, 'Server is listening');
  };
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } port = null; };
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  await start();
  const request = (path, body, worker = false) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : worker ? 'PUT' : 'PATCH', headers: { 'Content-Type': 'application/json', 'X-PINE': '1',
      ...(worker ? { 'X-PINE-Worker-Token': 'local-test-token' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = async () => (await (await request('/api/players/10001')).json()).player;
  const update = async (v) => { const r = await request('/api/players/10001', { long_throw_override: v }); assert.equal(r.status, 200); return (await r.json()).player; };
  const sync = async (players) => {
    const r = await request('/api/worker/long-throws', { schema_version: 1, rule_version: LONG_THROW_RULE,
      generated_at: new Date().toISOString(), players, matches: 2, pending_matches: 0 }, true);
    assert.equal(r.status, 200);
  };
  assert.equal((await read()).has_long_throw, false);
  // No matching PINE profile yet. Adding/linking later must need no provider request.
  await sync([101]);
  const linked = openDb(file); linked.run('UPDATE players SET impect_id=101 WHERE id=10001'); linked.raw.close();
  assert.equal((await read()).has_long_throw, true);
  const board = (await (await request('/api/players')).json()).players.find((p) => p.id === 10001);
  assert.equal(board.has_long_throw, true);
  assert.equal(board.roles[0].shortlist, 1);
  assert.equal((await update(false)).has_long_throw, false);
  await sync([101, 202]);
  assert.equal((await read()).has_long_throw, false);
  assert.equal((await update(null)).has_long_throw, true);
  await sync([202]); // a stricter snapshot must remove an old detected badge
  assert.equal((await read()).has_long_throw, false);
  assert.equal((await update(true)).has_long_throw, true);
  await sync([]);
  assert.equal((await read()).has_long_throw, true); // manual Yes survives removal
  await update(null);
  await sync([101]);
  for (const v of ['yes', 'false', 0, 1, {}]) assert.equal((await request('/api/players/10001', { long_throw_override: v })).status, 400);
  const auditDb = openDb(file);
  assert.deepEqual(JSON.parse(auditDb.get("SELECT detail FROM activity WHERE action='edited_player' ORDER BY id DESC LIMIT 1").detail).long_throw,
    { previous: 1, value: null });
  auditDb.raw.close();
  await update(false);
  await stop(); await start();
  assert.equal((await read()).has_long_throw, false);
  assert.equal((await update(null)).has_long_throw, true);
});
