// Isolated, fictional UI examples. No production database or provider access.
// node scripts/preview-long-throws.mjs → prints an available localhost URL
// ?theme=light / ?theme=dark force the existing theme tokens for visual QA.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { saveLongThrows, LONG_THROW_RULE } from '../src/lib/long_throw.js';
const dir = mkdtempSync(join(tmpdir(), 'pine-long-throw-preview-')), file = join(dir, 'pine.db');
const db = openDb(file);
const players = [
  ['Alex Mercer', 'Right-Back', 'Harbor FC', 'RB1', 101],
  ['Leo Santos', 'Right-Back', 'Riverside FC', 'RB1', 102],
  ['Noah Turner', 'Centre-Back', 'Summit FC', 'RCB1', 103],
  ['Finn Ellis', 'Left-Back', 'Valley FC', 'LB1', 104],
  ['Evan Brooks', 'Centre-Back', 'Coast FC', 'LCB1', 105],
  ['Sam Rowan', 'Forward', 'North FC', 'FWD1', 106],
];
players.forEach(([name, position, club, role, impect], i) => {
  db.run(`INSERT INTO players(id,name,position,club,league,birthdate,citizenship,impect_id,summary)
    VALUES (?,?,?,?,?,'2002-04-12','["United States"]',?,?)`, 10001 + i, name, position, club, 'Example League', impect,
    i ? null : 'Fictional player for interface review. Demonstration data only.');
  db.run('INSERT INTO board_entries(player_id,role,rank,shortlist) VALUES (?,?,?,1)', 10001 + i, role, i === 1 ? 1 : 0);
});
saveLongThrows(db, { schema_version: 1, rule_version: LONG_THROW_RULE, generated_at: new Date().toISOString(), players: [101, 103, 104], matches: 25, pending_matches: 0 });
db.raw.close();
const css = readFileSync('public/styles.css', 'utf8');
const light = css.match(/^:root\s*\{([\s\S]*?)\n\}/)[1];
const dark = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}/)[1];
const child = spawn(process.execPath, ['--import', './scripts/fixtures/offline-fetch.mjs', 'src/server.js'], {
  env: { ...process.env, PINE_DB: file, PINE_AUTH: 'off', PORT: '0', PINE_WORKER_TOKEN: 'local-preview-only',
    PINE_SITE_PASSWORD: '', IMPECT_USERNAME: '', IMPECT_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(d));
let appPort;
child.stdout.on('data', (d) => { process.stdout.write(d); const m = String(d).match(/localhost:(\d+)/); if (m) appPort = Number(m[1]); });
const proxy = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:8799');
  const selected = url.searchParams.get('theme');
  const theme = selected || (req.headers.cookie || '').match(/preview-theme=(light|dark)/)?.[1];
  const upstream = request({ hostname: '127.0.0.1', port: appPort || 1, path: req.url, method: req.method, headers: req.headers }, (r) => {
    const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
      let body = Buffer.concat(chunks);
      const headers = { ...r.headers };
      if (selected) headers['set-cookie'] = `preview-theme=${selected === 'dark' ? 'dark' : 'light'}; Path=/; SameSite=Lax`;
      if (theme && headers['content-type']?.includes('text/html')) {
        body = Buffer.from(body.toString().replace('</head>', `<style>:root{${theme === 'dark' ? dark : light}}</style></head>`));
        delete headers['content-length'];
      }
      res.writeHead(r.statusCode, headers); res.end(body);
    });
  });
  upstream.on('error', () => { res.writeHead(503); res.end('Preview starting; reload shortly.'); });
  req.pipe(upstream);
});
proxy.listen(0, '127.0.0.1', () => console.log(`Fictional preview: http://localhost:${proxy.address().port}?theme=light`));
proxy.on('error', () => child.kill());
const cleanup = () => { proxy.close(); child.kill(); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
child.on('exit', () => { rmSync(dir, { recursive: true, force: true }); process.exit(); });
