// Local fictional comparison fixture. No real database, provider requests or writes.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { demoPlayers, demoKpi, demoPhysical, demoCards, demoSnapshot, demoCardImage } from './fixtures/comparison-demo.mjs';
export async function startPreview() {
  const dir = mkdtempSync(join(tmpdir(), 'pine-compare-preview-')), file = join(dir, 'pine.db'), db = openDb(file);
  for (const p of demoPlayers) db.run(`INSERT INTO players(id,name,club,position,impect_id,birthdate,citizenship) VALUES (?,?,?,?,?,'2002-04-12','["United States"]')`, p.id, p.name, p.club, p.position, p.impect_id);
  db.raw.close();
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
    env: { ...process.env, PINE_DB: file, PINE_AUTH: 'off', PORT: '0', PINE_WORKER_TOKEN: 'fictional-preview-only', PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', appPort;
  child.stdout.on('data', d => { output += d; appPort = Number(output.match(/localhost:(\d+)/)?.[1]); });
  child.stderr.on('data', d => { output += d; });
  for (let i = 0; i < 100 && !appPort; i++) { if (child.exitCode !== null) throw new Error(output); await new Promise(r => setTimeout(r, 50)); }
  if (!appPort) { child.kill(); throw new Error('Comparison preview failed to start'); }
  const proxy = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'), match = url.pathname.match(/^\/api\/players\/(\d+)\/(impect-kpis|physical|cards|card-options)$/), card = url.pathname.match(/^\/api\/cards\/(\d+)\/(snapshot|png|pdf)$/);
    const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (match) {
      const id = Number(match[1]);
      return json(match[2] === 'impect-kpis' ? demoKpi(id, url.searchParams) : match[2] === 'physical' ? demoPhysical(id) : match[2] === 'cards' ? demoCards(id) : { seasons: [], default: null });
    }
    if (card) {
      if (card[2] === 'snapshot') return json(demoSnapshot(Number(card[1])));
      res.writeHead(200, { 'Content-Type': card[2] === 'png' ? 'image/svg+xml' : 'application/pdf' });
      return res.end(card[2] === 'png' ? demoCardImage(Number(card[1])) : '%PDF-1.4\n% Fictional demo only\n%%EOF');
    }
    const upstream = request({ hostname: '127.0.0.1', port: appPort, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    upstream.on('error', () => { res.writeHead(503); res.end('Preview unavailable'); }); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const stopChild = () => child.kill();
  process.once('exit', stopChild);
  const close = async () => { process.removeListener('exit', stopChild); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); rmSync(dir, { recursive: true, force: true }); };
  return { url: `http://127.0.0.1:${proxy.address().port}`, close };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const preview = await startPreview();
  console.log(`${preview.url}/#/compare/10001,10002`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await preview.close(); process.exit(); });
}
