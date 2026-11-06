#!/usr/bin/env python3
"""Incremental long-throw capability sync. No player analysis is sent to PINE.

Run using the Hearts Python environment. --cache-only never accesses providers or
uploads. Match lists use Hearts' indexed cache; this script owns its compact,
transactional throw-only SQLite cache because get_events() does not cache events.
"""
from __future__ import annotations

import argparse
import csv
import fcntl
import gzip
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

RULE = 'long-throw-v1'
ITERATIONS = {1248: 2025, 1236: 2025, 1253: 2025, 1916: 2026, 1918: 2026, 1870: 2026}
TYPES = {'THROW_IN_CROSS', 'THROW_IN_HIGH_BALL', 'THROW_IN_INTO_HIGH_BALL'}
FIELDS = ['action', 'playerId', 'squadId', 'startAdjCoordinatesX', 'startAdjCoordinatesY',
          'endAdjCoordinatesX', 'endAdjCoordinatesY', 'endPitchPosition',
          'setPieceSubPhaseThrowInType', 'duration']


def timestamp(value):
    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc)


def positive_id(row):
    """A single valid delivery proves capability, regardless of outcome/frequency."""
    if row.get('action') != 'THROW_IN' or row.get('endPitchPosition') != 'OPPONENT_BOX' or row.get('setPieceSubPhaseThrowInType') not in TYPES:
        return None
    try:
        sx, sy, ex, ey = [float(row[k]) for k in FIELDS[3:7]]
        duration = float(row['duration'])
        player, squad = float(row['playerId']), float(row['squadId'])
        if not all(math.isfinite(v) for v in [sx, sy, ex, ey, duration, player, squad]):
            return None
        if not player.is_integer() or player <= 0 or not squad.is_integer() or squad <= 0:
            return None
        distance = math.hypot(ex - sx, ey - sy)
        if (-52.5 <= sx <= 52.5 and abs(sy) <= 34.5 and abs(abs(sy) - 34) <= .5
                and ex > sx and 36 <= ex <= 52.5 and abs(ey) <= 20.16
                and 25 <= distance <= 60 and duration > .001):
            return int(player)
    except (KeyError, TypeError, ValueError, OverflowError):
        pass
    return None


def open_cache(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS matches(iteration INTEGER, match_id INTEGER,
        fetched_at TEXT NOT NULL, revision TEXT NOT NULL, throws TEXT NOT NULL,
        PRIMARY KEY(iteration, match_id));
      CREATE TABLE IF NOT EXISTS positives(player_id INTEGER PRIMARY KEY);
    ''')
    return db


def store_match(db, iteration, match_id, rows, at, revision=''):
    # All throw rows are retained locally so classification is auditable/re-runnable.
    throws = [{k: r.get(k) for k in FIELDS} for r in rows if r.get('action') == 'THROW_IN']
    for r in throws:
        # Provider pandas frames use NaN; on disk use JSON null, never nonstandard JSON.
        for k, v in r.items():
            if isinstance(v, float) and not math.isfinite(v):
                r[k] = None
    db.execute('INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?)',
               (iteration, match_id, at.isoformat(), revision, json.dumps(throws, allow_nan=False)))
    for r in throws:
        pid = positive_id(r)
        if pid:
            db.execute('INSERT OR IGNORE INTO positives VALUES (?)', (pid,))


def bootstrap_audit(db, directory):
    """Seed known complete matches, including zero-throw games, from the frozen audit."""
    manifest = json.loads((directory / 'manifest.json').read_text())
    with (directory / 'match-register.csv').open() as source:
        registered = {int(r['id']): r for r in csv.DictReader(source)}
    grouped = {}
    with gzip.open(directory / 'all-throwins-audit.csv.gz', 'rt') as source:
        for r in csv.DictReader(source):
            key = (int(r['iteration']), int(r['matchId']))
            grouped.setdefault(key, []).append(r)
    # This is the audit observation date, never the date this seed was imported.
    observed = datetime(2026, 9, 6, tzinfo=timezone.utc)
    added = 0
    with db:
        for it in manifest:
            missing = set(it.get('provider_unavailable', []))
            for mid in it['requested_matches']:
                if mid in missing or db.execute('SELECT 1 FROM matches WHERE iteration=? AND match_id=?', (it['iteration'], mid)).fetchone():
                    continue
                store_match(db, int(it['iteration']), mid, grouped.get((int(it['iteration']), mid), []),
                            observed, registered.get(mid, {}).get('lastCalculationDate', ''))
                added += 1
    return added


class HeartsProvider:
    def __init__(self, root, cache_only):
        sys.path.insert(0, str(root.resolve()))
        if cache_only:
            os.environ['HOP_CACHE_READ_ONLY'] = '1'
        from adapters import data
        from adapters.hop_data import ensure_cache
        self.data, self.ensure, self.cache_only = data, ensure_cache, cache_only

    def matches(self, iteration, year, now):
        mode = 'cache_only' if self.cache_only else 'refresh'
        # Refresh match availability/revision every nightly run, not an indefinite auto hit.
        r = self.ensure('impect.matches', iteration=iteration, mode=mode,
                        skip_if_fresher_than_hours=20 if not self.cache_only else None)
        if not r.ok:
            raise RuntimeError(f'Match list {iteration} unavailable: {r.reason}')
        return self.data.get_matches(iteration, mode='cache_only').to_dict('records')

    def events(self, ids):
        if self.cache_only:
            raise RuntimeError('Provider access disabled in cache-only mode')
        return self.data.get_events(ids).to_dict('records')


def sync(db, provider, iterations, *, cache_only=False, max_matches=150, now=None, pause=1):
    now = now or datetime.now(timezone.utc)
    pending, errors, fetched, reused, work = set(), [], 0, 0, []
    for iteration, year in iterations.items():
        try:
            matches = provider.matches(iteration, year, now)
        except Exception as e:
            errors.append(f'Match list {iteration}: {type(e).__name__}')
            continue
        for m in matches:
            try:
                date = timestamp(m['scheduledDate'])
                if date > now - timedelta(hours=4):
                    continue  # don't checkpoint a game still in progress
                mid = int(m['id'])
            except (KeyError, ValueError, TypeError):
                errors.append(f'Malformed match in {iteration}')
                continue
            if m.get('available') not in (True, 'True', 1):
                pending.add((iteration, mid))
                continue
            old = db.execute('SELECT fetched_at,revision FROM matches WHERE iteration=? AND match_id=?', (iteration, mid)).fetchone()
            revision = str(m.get('lastCalculationDate') or '')
            # Re-read corrected matches; also recheck recent matches weekly while data settles.
            due = old and (old[1] != revision or (date > now - timedelta(days=14)
                           and timestamp(old[0]) < now - timedelta(days=7)))
            if old and (cache_only or not due):
                reused += 1
            else:
                work.append((iteration, mid, revision, bool(old)))
                pending.add((iteration, mid))
    # Missing games before correction rechecks; bound upstream work per run.
    work.sort(key=lambda m: m[3])
    if not cache_only:
        for start in range(0, min(len(work), max_matches), 10):
            batch = work[start:min(start + 10, max_matches)]
            try:
                rows = provider.events([m[1] for m in batch])
                by_match = {}
                for r in rows:
                    by_match.setdefault(int(r['matchId']), []).append(r)
                with db:
                    for iteration, mid, revision, _ in batch:
                        # Empty/missing API responses are not proof of a processed match.
                        if mid not in by_match:
                            continue
                        store_match(db, iteration, mid, by_match[mid], now, revision)
                        pending.discard((iteration, mid))
                        fetched += 1
            except Exception as e:
                errors.append(f'Event batch: {type(e).__name__}')
            if pause:
                time.sleep(pause)
    # Re-run the classifier over cached throws too (e.g. interrupted bootstrap).
    with db:
        for (payload,) in db.execute('SELECT throws FROM matches'):
            for row in json.loads(payload):
                pid = positive_id(row)
                if pid:
                    db.execute('INSERT OR IGNORE INTO positives VALUES (?)', (pid,))
    snapshot = dict(schema_version=1, rule_version=RULE, generated_at=now.isoformat(),
                    players=[r[0] for r in db.execute('SELECT player_id FROM positives ORDER BY player_id')],
                    matches=db.execute('SELECT count(*) FROM matches').fetchone()[0], pending_matches=len(pending))
    return snapshot, dict(fetched=fetched, reused=reused, pending=len(pending), errors=errors)


def request(base, token, path, payload=None):
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    req = Request(base.rstrip('/') + path, method='GET' if payload is None else 'PUT',
                  data=None if payload is None else json.dumps(payload, allow_nan=False).encode(),
                  headers={'X-PINE': '1', 'X-PINE-Worker-Token': token, 'Content-Type': 'application/json'})
    with build_opener(NoRedirect).open(req, timeout=90) as response:
        return json.load(response)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--hop-root', type=Path, required=True)
    p.add_argument('--cache', type=Path, required=True, help='Private SQLite cache outside the analysis repo')
    p.add_argument('--bootstrap-audit', type=Path)
    p.add_argument('--cache-only', action='store_true')
    p.add_argument('--upload', action='store_true')
    p.add_argument('--output', type=Path)
    p.add_argument('--env-file', type=Path)
    p.add_argument('--max-matches', type=int, default=150)
    args = p.parse_args()
    if args.cache_only and args.upload:
        p.error('--cache-only cannot upload')
    if args.max_matches < 1:
        p.error('--max-matches must be positive')
    if args.env_file:
        sys.path.insert(0, str(args.hop_root.resolve()))
        from dotenv import load_dotenv
        load_dotenv(args.env_file, override=False)
    base, token = os.environ.get('PINE_URL', ''), os.environ.get('PINE_WORKER_TOKEN', '')
    iterations = dict(ITERATIONS)
    if args.upload:
        u = urlparse(base)
        if not token or u.username or u.password or u.query or u.fragment or (u.scheme != 'https' and not (u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1'))):
            p.error('Upload requires PINE_WORKER_TOKEN and an HTTPS PINE_URL (HTTP allowed only for localhost)')
        config = request(base, token, '/api/worker/long-throws/config')
        if config['rule_version'] != RULE:
            raise RuntimeError('Worker and server long-throw rules differ')
        iterations.update({int(i['id']): int(i['season']) for i in config['iterations']})
        if max(iterations.values()) < datetime.now().year:
            raise RuntimeError('Current season missing from the server season catalog')
    args.cache.parent.mkdir(parents=True, exist_ok=True)
    # launchd and a manual run cannot fetch/publish concurrently.
    with args.cache.with_suffix('.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = open_cache(args.cache)
        try:
            if args.bootstrap_audit:
                print(json.dumps({'bootstrapped_matches': bootstrap_audit(db, args.bootstrap_audit)}), flush=True)
            snapshot, result = sync(db, HeartsProvider(args.hop_root, args.cache_only), iterations,
                                    cache_only=args.cache_only, max_matches=args.max_matches)
            print(json.dumps({**result, 'positive_players': len(snapshot['players'])}), flush=True)
            # A failed listing can't masquerade as a fresh successful nightly check.
            if result['errors']:
                raise RuntimeError('Refresh incomplete; checkpoints retained, last server sync unchanged')
            if args.output:
                tmp = args.output.with_suffix(args.output.suffix + '.part')
                tmp.write_text(json.dumps(snapshot, indent=2) + '\n')
                tmp.replace(args.output)
            if args.upload:
                print(json.dumps(request(base, token, '/api/worker/long-throws', snapshot)), flush=True)
        finally:
            db.close()


if __name__ == '__main__':
    main()
