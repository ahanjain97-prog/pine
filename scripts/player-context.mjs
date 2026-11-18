#!/usr/bin/env node
// Read live agent context, a fresh live backup, or an explicitly selected local snapshot.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextFilters, playerContext } from '../src/lib/player_context.js';

const help = `Usage: npm run --silent player-context -- [filters] [source]

Filters: --board all|big|short|ncaa  --role FWD2  --player-id 123  --q "Name"
         --limit 10 (1-50)  --offset 0
Source:  --url https://pine.example.com  (defaults to PINE_URL or APP_URL)
         --db /absolute/path/snapshot.sqlite  (explicit local snapshot, opened read-only)

Live access uses PINE_AGENT_TOKEN with GET /api/agent/player-context.
If no agent key is configured, PINE_BACKUP_TOKEN downloads a fresh backup instead;
the temporary file is deleted after reading. Optional PINE_SITE_PASSWORD is supported.
Credentials are loaded from the repo .env or PINE_ENV; never pass keys as arguments.
JSON includes next_offset; fetch every page before summarizing all matching players.
Example: npm run --silent player-context -- --board big --role FWD2
`;

function options(args) {
  const opts = {}, names = new Set(['board', 'role', 'player-id', 'q', 'limit', 'offset', 'url', 'db']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !names.has(name)) throw new Error(`Unknown option ${args[i]}; use --help`);
    if (Object.hasOwn(opts, name)) throw new Error(`Option --${name} must appear once`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    opts[name] = value;
  }
  if (opts.db && opts.url) throw new Error('Choose either --db or --url');
  return opts;
}

function readSnapshot(path, filters, source) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    raw.exec('PRAGMA query_only = ON; BEGIN');
    const db = { all: (sql, ...p) => raw.prepare(sql).all(...p), get: (sql, ...p) => raw.prepare(sql).get(...p) };
    const result = playerContext(db, filters);
    raw.exec('COMMIT');
    return { ...result, source };
  } finally { raw.close(); }
}

async function main() {
  if (process.argv.includes('--help')) { process.stdout.write(help); return; }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = process.env.PINE_ENV || join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const opts = options(process.argv.slice(2));
  const filters = Object.fromEntries(Object.entries(opts).filter(([k]) => !['url', 'db'].includes(k)).map(([k, v]) => [k.replaceAll('-', '_'), v]));
  contextFilters(filters); // Reject typos before making a request or downloading a database.
  let result;
  if (opts.db) {
    const path = resolve(opts.db), modified = statSync(path).mtime.toISOString();
    result = readSnapshot(path, filters, { kind: 'local_snapshot', path, file_modified_at: modified,
      freshness: 'Local file; modification time does not establish when live data was last backed up.' });
  } else {
    const base = opts.url || process.env.PINE_URL || process.env.APP_URL;
    if (!base) throw new Error('Set PINE_URL or use --url for live data, or explicitly choose --db for a local snapshot');
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the site origin as --url (no credentials, path, query or fragment)');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Live access requires HTTPS (HTTP allowed only on localhost)');
    const agentToken = process.env.PINE_AGENT_TOKEN, backupToken = process.env.PINE_BACKUP_TOKEN;
    if (!agentToken && !backupToken) throw new Error('Set PINE_AGENT_TOKEN or PINE_BACKUP_TOKEN for live access');
    const headers = agentToken ? { 'X-PINE-Agent-Token': agentToken } : { 'X-PINE-Backup-Token': backupToken };
    if (process.env.PINE_SITE_PASSWORD) headers.Authorization = `Basic ${Buffer.from(`pine:${process.env.PINE_SITE_PASSWORD}`).toString('base64')}`;
    url.pathname = agentToken ? '/api/agent/player-context' : '/api/backup';
    if (agentToken) url.search = new URLSearchParams(filters).toString();
    const started = new Date().toISOString();
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(agentToken ? 60000 : 300000), redirect: 'error' });
    if (!response.ok) throw new Error(`PINE returned HTTP ${response.status}; check the URL, credentials and deployed version`);
    if (agentToken) {
      result = await response.json();
      if (result.schema_version !== 1 || !Array.isArray(result.players) || !result.pagination) throw new Error('Unexpected player context response');
      result.source = { kind: 'live_api', origin: url.origin, requested_at: started };
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') throw new Error('Backup response is not a SQLite database');
      const dir = mkdtempSync(join(tmpdir(), 'pine-player-context-'));
      try {
        const path = join(dir, 'snapshot.sqlite');
        writeFileSync(path, bytes, { mode: 0o600 });
        result = readSnapshot(path, filters, { kind: 'live_backup', origin: url.origin, requested_at: started,
          retrieved_at: new Date().toISOString() });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((e) => { process.stderr.write(`player-context: ${e.message}\n`); process.exitCode = 1; });
