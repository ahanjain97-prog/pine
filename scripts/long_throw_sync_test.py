import importlib.util
import csv
import gzip
import json
import sqlite3
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location('sync_long_throws', Path(__file__).with_name('sync-long-throws.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
NOW = datetime(2026, 11, 6, 12, tzinfo=timezone.utc)


def throw(**changes):
    return dict(action='THROW_IN', playerId=101, squadId=10, matchId=1,
                startAdjCoordinatesX=20, startAdjCoordinatesY=34,
                endAdjCoordinatesX=45, endAdjCoordinatesY=0,
                endPitchPosition='OPPONENT_BOX', duration=2,
                setPieceSubPhaseThrowInType='THROW_IN_CROSS', result='FAIL', **changes)


class Provider:
    def __init__(self):
        self.games = [dict(id=1, scheduledDate='2026-11-04T12:00:00Z', available=True, lastCalculationDate='r1')]
        self.rows = [throw() for _ in range(S.MIN_THROWS)]
        self.calls = []
        self.fail = False

    def matches(self, *args):
        return self.games

    def events(self, ids):
        self.calls.append(ids)
        if self.fail:
            raise OSError('offline')
        return [r for r in self.rows if r['matchId'] in ids]


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'cache.sqlite'
        self.db = S.open_cache(self.path)
        self.addCleanup(lambda: self.db.close())
        self.provider = Provider()

    def run_sync(self, **kwargs):
        return S.sync(self.db, self.provider, {1916: 2026}, now=kwargs.pop('now', NOW), pause=0, **kwargs)

    def test_classifier_single_failed_throw_and_both_sides(self):
        self.assertEqual(S.qualifying_id(throw()), 101)
        # The audit relies on geometry and the box tag, not a subtype or distance minimum.
        for kind in ['THROW_IN_CROSS', 'THROW_IN_HIGH_BALL', 'THROW_IN_INTO_HIGH_BALL', None]:
            r = throw(); r.update(setPieceSubPhaseThrowInType=kind, startAdjCoordinatesY=-34)
            self.assertEqual(S.qualifying_id(r), 101)
        r = throw(); r.update(startAdjCoordinatesX=30, endAdjCoordinatesX=45, endAdjCoordinatesY=14)
        self.assertEqual(S.qualifying_id(r), 101)  # 25m is not a minimum
        r.update(startAdjCoordinatesX=44, endAdjCoordinatesY=20)
        self.assertEqual(S.qualifying_id(r), 101)  # shorter forward box delivery
        r.update(startAdjCoordinatesX=0, endAdjCoordinatesX=36, endAdjCoordinatesY=-14)
        self.assertEqual(S.qualifying_id(r), 101)  # exactly 60m (36, 48)
        r.update(endAdjCoordinatesY=-14.01)
        self.assertIsNone(S.qualifying_id(r))

    def test_rejects_sideways_outside_box_unknown_and_bad_data(self):
        bad = [dict(endAdjCoordinatesY=21), dict(endAdjCoordinatesX=20), dict(endAdjCoordinatesX=35),
               dict(endPitchPosition='FINAL_THIRD'),
               dict(duration=.0001), dict(duration=None), dict(duration=float('nan')),
               dict(startAdjCoordinatesY=20), dict(startAdjCoordinatesX=-52),
               dict(playerId=None), dict(playerId=1.5), dict(squadId=None), dict(endAdjCoordinatesY=float('inf'))]
        for changes in bad:
            r = throw(); r.update(changes)
            with self.subTest(changes=changes):
                self.assertIsNone(S.qualifying_id(r))

    def test_old_rule_flags_reclassified_from_disk_without_provider_access(self):
        r = throw(); r.update(startAdjCoordinatesX=44.7, startAdjCoordinatesY=-34,
                             endAdjCoordinatesX=49.7, endAdjCoordinatesY=-3.6, playerId=303)
        with self.db:
            S.store_match(self.db, 1916, 1, [r], NOW, 'r1')
            self.db.execute('INSERT INTO positives VALUES (303)')  # existing v1 flag
        self.db.close(); self.db = S.open_cache(self.path)
        snapshot, result = self.run_sync(cache_only=True)
        self.assertEqual(snapshot['rule_version'], 'long-throw-v2')
        self.assertEqual(snapshot['players'], [])
        self.assertEqual(result['reused'], 1)
        self.assertEqual(self.provider.calls, [])

    def test_corrected_event_removes_flag_but_unavailable_match_keeps_cached_evidence(self):
        self.run_sync()
        self.provider.games[0]['available'] = False
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [101])
        self.provider.games[0].update(available=True, lastCalculationDate='r2')
        self.provider.rows = [dict(action='PASS', matchId=1)]
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [])
        self.assertEqual(snapshot['matches'], 1)

    def test_disk_cache_reopen_reuses_no_events_then_discovers_new_match(self):
        snapshot, result = self.run_sync()
        self.assertEqual(snapshot['players'], [101])
        self.assertEqual(result['fetched'], 1)
        self.db.close(); self.db = S.open_cache(self.path)
        _, result = self.run_sync(now=NOW + timedelta(days=1))
        self.assertEqual(result['reused'], 1)
        self.assertEqual(len(self.provider.calls), 1)
        self.provider.games.append(dict(id=2, scheduledDate='2026-11-05T12:00:00Z', available=True, lastCalculationDate='r1'))
        r = throw(); r.update(playerId=202, matchId=2); self.provider.rows.extend([r] * S.MIN_THROWS)
        snapshot, result = self.run_sync()
        self.assertEqual(self.provider.calls[-1], [2])
        self.assertEqual(snapshot['players'], [101, 202])
        self.assertEqual(snapshot['matches'], 2)

    def test_missing_and_failed_matches_retry_without_erasing_flags(self):
        self.run_sync()
        self.provider.games.append(dict(id=2, scheduledDate='2026-11-05T12:00:00Z', available=True))
        self.provider.fail = True
        snapshot, result = self.run_sync()
        self.assertTrue(result['errors'])
        self.assertEqual(snapshot['players'], [101])
        self.assertEqual(snapshot['pending_matches'], 1)
        self.provider.fail = False
        snapshot, _ = self.run_sync()  # API omits match 2
        self.assertEqual(snapshot['matches'], 1)
        self.assertEqual(snapshot['pending_matches'], 1)
        r = throw(); r.update(matchId=2, playerId=202); self.provider.rows.extend([r] * S.MIN_THROWS)
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [101, 202])
        self.assertEqual(snapshot['pending_matches'], 0)

    def test_cache_only_never_fetches_missing_or_due_events(self):
        _, result = self.run_sync(cache_only=True)
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(result['pending'], 1)
        self.run_sync()
        self.provider.games[0]['lastCalculationDate'] = 'r2'
        self.run_sync(cache_only=True)
        self.assertEqual(len(self.provider.calls), 1)

    def test_revisions_and_recent_games_are_rechecked_but_old_games_reused(self):
        self.run_sync()
        self.provider.games[0]['lastCalculationDate'] = 'r2'
        self.run_sync()
        self.assertEqual(len(self.provider.calls), 2)
        self.run_sync(now=NOW + timedelta(days=8))
        self.assertEqual(len(self.provider.calls), 3)
        self.run_sync(now=NOW + timedelta(days=30))
        self.assertEqual(len(self.provider.calls), 3)

    def test_zero_throw_game_is_cached_and_budget_is_bounded(self):
        self.provider.rows = [dict(action='PASS', matchId=1)]
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [])
        self.assertEqual(snapshot['matches'], 1)
        self.run_sync()
        self.assertEqual(len(self.provider.calls), 1)
        for mid in range(2, 15):
            self.provider.games.append(dict(id=mid, scheduledDate='2026-11-05T12:00:00Z', available=True))
            self.provider.rows.append(dict(action='PASS', matchId=mid))
        snapshot, result = self.run_sync(max_matches=2)
        self.assertEqual(result['fetched'], 2)
        self.assertEqual(snapshot['pending_matches'], 11)

    def test_unavailable_and_live_matches_not_marked_complete(self):
        self.provider.games[0]['available'] = False
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['pending_matches'], 1)
        self.assertEqual(snapshot['matches'], 0)
        self.provider.games[0].update(available=True, scheduledDate=NOW.isoformat())
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['matches'], 0)
        self.assertEqual(self.provider.calls, [])

    def test_failed_reclassification_rolls_back_lookup_and_retains_match_checkpoint(self):
        with self.db:
            self.db.execute('INSERT INTO positives VALUES (202)')
        self.db.execute("CREATE TRIGGER fail BEFORE INSERT ON positives BEGIN SELECT RAISE(ABORT,'failed'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.run_sync()
        self.assertEqual(self.db.execute('SELECT player_id FROM positives').fetchone()[0], 202)
        self.assertEqual(self.db.execute('SELECT count(*) FROM matches').fetchone()[0], 1)

    def test_automatic_threshold_is_20_and_cache_reuse_does_not_double_count(self):
        self.provider.rows = [throw() for _ in range(S.MIN_THROWS - 1)]
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [])
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [])
        self.provider.games.append(dict(id=2, scheduledDate='2026-11-05T12:00:00Z', available=True))
        r = throw(); r.update(matchId=2); self.provider.rows.append(r)
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [101])
        # Corrected provider data reducing the sample below 20 removes Auto Yes.
        self.provider.games[0]['lastCalculationDate'] = 'r2'
        self.provider.rows = [r] + [throw() for _ in range(S.MIN_THROWS - 2)]
        snapshot, _ = self.run_sync()
        self.assertEqual(snapshot['players'], [])

    def test_frozen_audit_seeds_once_including_zero_throw_games_and_excludes_missing(self):
        root = Path(self.tmp.name)
        (root / 'manifest.json').write_text(json.dumps([dict(iteration=1916, requested_matches=[1, 2, 3], provider_unavailable=[3])]))
        (root / 'match-register.csv').write_text('id,lastCalculationDate\n1,r1\n2,r1\n3,r1\n')
        r = throw(); r['iteration'] = 1916
        with gzip.open(root / 'all-throwins-audit.csv.gz', 'wt') as f:
            writer = csv.DictWriter(f, fieldnames=list(r)); writer.writeheader(); writer.writerows([r] * S.MIN_THROWS)
        self.assertEqual(S.bootstrap_audit(self.db, root), 2)
        self.assertEqual(S.bootstrap_audit(self.db, root), 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM positives').fetchone()[0], 1)
        self.assertEqual(json.loads(self.db.execute('SELECT throws FROM matches WHERE match_id=2').fetchone()[0]), [])


if __name__ == '__main__':
    unittest.main()
