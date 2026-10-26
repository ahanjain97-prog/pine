#!/usr/bin/env python3
"""Build gate inputs with the original study; optionally publish to PINE.

Run with the analysis repository's Python environment. No staff/board data is read.
Use --cache-only --output FILE for reproducible validation without network writes.
Use --upload --watch 21600 for the production worker (under a service supervisor).
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlparse
from urllib.request import Request

RULE_VERSION = "mlsnp-graduation-2026-10-20"
DEFAULT_MOVE = "2027-02-28"


def request(base, token, path, payload=None):
    # Refuse redirects so the worker credential cannot be forwarded to another host.
    from urllib.request import HTTPRedirectHandler, build_opener
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    req = Request(base + path, data=None if payload is None else json.dumps(payload, allow_nan=False).encode(),
                  method="GET" if payload is None else "PUT", headers={
                      "X-PINE": "1", "X-PINE-Worker-Token": token, "Content-Type": "application/json"})
    with build_opener(NoRedirect).open(req, timeout=90) as response:
        return json.load(response)


def iso_time(path):
    return datetime.fromtimestamp(Path(path).stat().st_mtime, timezone.utc).isoformat()


def build(args, move):
    import pandas as pd
    root = args.hop_root.resolve()
    study = root / "experiments/mlsnp_graduation_20261019"
    if not (study / "arrivals.py").is_file():
        raise RuntimeError("The analysis checkout must contain the October 2026 graduation study (PR #697)")
    sys.path[:0] = [str(study), str(root)]
    if args.cache_only:
        os.environ["HOP_CACHE_READ_ONLY"] = "1"
    import arrivals as A
    from common import MLSNP_ITERATIONS, ASA_FIRST_SEASON, ASA_LEAGUE_LABEL
    from adapters import data as D
    from adapters.hop_data import ensure_cache

    cutoff = pd.Timestamp(move)
    now = pd.Timestamp.now(tz="UTC").tz_localize(None)
    if cutoff <= now.normalize():
        raise RuntimeError("Projected move date must be in the future; update PINE's recruitment window")
    if cutoff.year > max(MLSNP_ITERATIONS) + 1:
        raise RuntimeError("The study's iteration catalog needs the new season before gates can refresh")
    lower = cutoff - pd.Timedelta(days=365)
    needed = {s: it for s, it in MLSNP_ITERATIONS.items() if s >= lower.year and s <= now.year}
    if not needed:
        raise RuntimeError("No covered MLSNP season in the projected move window")
    sources = []
    for league, season, iteration in A.iterations():
        datasets = ["impect.player_matchsums"]
        if league == "MLSNP" and season in needed:
            datasets += ["impect.player_iteration_averages", "impect.player_iteration_scores", "impect.matches"]
        for dataset in datasets:
            result = ensure_cache(dataset, iteration=iteration, mode="cache_only" if args.cache_only else "refresh",
                                  skip_if_fresher_than_hours=6 if season == now.year else float("inf"))
            if not result.ok or not result.path:
                raise RuntimeError(f"Missing {league} {season} {dataset}; previous PINE snapshot retained")
            fetched = iso_time(result.path)
            sources.append({"name": f"{league} {season} {dataset.split('.')[-1]}", "fetched_at": fetched,
                            "stale": season == now.year and now.timestamp() - Path(result.path).stat().st_mtime > 48 * 3600})

    # pro_experience uses ASA only outside Impect's covered league-seasons.
    covered = {(league, season) for league, season, _ in A.iterations()}
    asa_paths = []
    from adapters.asa import fetch_player_xgoals
    for league, first in ASA_FIRST_SEASON.items():
        for season in range(first, max(MLSNP_ITERATIONS) + 1):
            path = A.D_ASA / f"players_{league}_{season}_xgoals.json"
            if (ASA_LEAGUE_LABEL[league], season) in covered:
                # pro_experience opens every season's file before skipping the ones Impect covers, so a
                # fresh checkout needs these too; they never count toward the result, so a cached copy will do.
                if not args.cache_only and not path.exists():
                    fetch_player_xgoals(league, season)
                continue
            if not args.cache_only and (not path.exists() or (season == now.year and time.time() - path.stat().st_mtime > 21600)):
                fetch_player_xgoals(league, season, refresh=True)
            if not path.exists():
                raise RuntimeError(f"Missing ASA {league} {season}; previous PINE snapshot retained")
            asa_paths.append((season, path))
    for title, paths in [("ASA historical minutes", [p for s, p in asa_paths if s < now.year]),
                         ("ASA current-season minutes", [p for s, p in asa_paths if s == now.year])]:
        if paths:
            oldest = min(paths, key=lambda p: p.stat().st_mtime)
            sources.append({"name": title, "fetched_at": iso_time(oldest),
                            "stale": "current-season" in title and time.time() - oldest.stat().st_mtime > 48 * 3600})
    identity_path = A.OUT / "identity.parquet"
    sources.append({"name": "Study identity mapping", "fetched_at": iso_time(identity_path), "stale": False})

    apps, teams, people = A.appearances()
    apps = apps[apps.date <= now]
    teams = teams[teams.date <= now]
    candidates = people[people.playerId.isin(apps[(apps.league == "MLSNP") & (apps.date >= lower)].playerId)]
    arr = candidates.assign(window_start=cutoff, usl_season=cutoff.year, first_usl_date=pd.NaT)
    arr, weights = A.mlsnp_window(arr, apps, teams)
    arr = A.pro_experience(arr, apps)
    pcts = A.season_percentiles(needed, ["BALL_WIN_NUMBER"], ["IMPECT_SCORE_PACKING"])
    # An absent peer group must remain unavailable rather than becoming a zero/pass.
    for key in ["pct_BALL_WIN_NUMBER", "pct_IMPECT_SCORE_PACKING"]:
        if key not in pcts:
            pcts[key] = float("nan")
    arr = arr.merge(A.window_metrics(weights, pcts), on="playerId", how="left")

    # Coverage is checked against scheduled, already-played games for each player's teams.
    unavailable = set()
    for season, iteration in needed.items():
        matches = D.get_matches(iteration, mode="cache_only")
        date_col = "scheduledDate" if "scheduledDate" in matches else "dateTime"
        dates = pd.to_datetime(matches[date_col], utc=True).dt.tz_localize(None)
        missing = matches[(dates >= lower) & (dates <= now) & (matches.available != True)]
        unavailable.update(int(s) for col in ["homeSquadId", "awaySquadId"] for s in missing[col].dropna())
    latest_groups = pcts.sort_values("season").drop_duplicates("playerId", keep="last").set_index("playerId").group6
    number = lambda v: None if pd.isna(v) else float(v)
    # Weighted means can produce 100.00000000000001. Clamp endpoints only;
    # do not round values near the P50 decision boundary.
    percentile = lambda v: None if pd.isna(v) else max(0.0, min(100.0, float(v)))
    rows = []
    for r in arr.itertuples():
        mine = apps[(apps.playerId == r.playerId) & (apps.league == "MLSNP") & (apps.date >= lower)]
        group = latest_groups.get(r.playerId)
        if pd.isna(group):
            raise RuntimeError("Player is missing a study peer group; previous PINE snapshot retained")
        rows.append({"impect_id": int(r.playerId), "group": group,
                     "birthdate": None if pd.isna(r.birthdate) else str(r.birthdate)[:10],
                     "packing": percentile(r.pct_IMPECT_SCORE_PACKING), "ball_wins": percentile(r.pct_BALL_WIN_NUMBER),
                     "pro_minutes": number(r.pro_minutes), "sample_minutes": number(r.mlsnp_minutes),
                     "match_shares": number(r.mlsnp_match_share), "seasons": sorted(int(s) for s in mine.season.unique()),
                     "data_as_of": str(r.mlsnp_last_date.date()), "coverage_gap": bool(set(mine.squadId) & unavailable),
                     "sources": sources})
    commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    return {"schema_version": 1, "rule_version": RULE_VERSION, "move_date": move,
            "generated_at": datetime.now(timezone.utc).isoformat(), "source_commit": commit, "players": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hop-root", type=Path, required=True)
    parser.add_argument("--move-date", help="Export only; uploads use PINE's configured move date")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cache-only", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--watch", type=int, metavar="SECONDS", help="Repeat under a service supervisor (minimum 3600)")
    args = parser.parse_args()
    if not args.output and not args.upload:
        parser.error("Choose --output, --upload, or both")
    if args.watch and args.watch < 3600:
        parser.error("--watch must be at least 3600 seconds")
    if args.upload and args.move_date:
        parser.error("Uploads use PINE_MLSNP_MOVE_DATE from the server")
    base = os.environ.get("PINE_URL", "").rstrip("/")
    token = os.environ.get("PINE_WORKER_TOKEN", "")
    if args.upload and (urlparse(base).scheme != "https" or not token):
        parser.error("Uploads require HTTPS PINE_URL and PINE_WORKER_TOKEN environment variables")
    while True:
        try:
            move = args.move_date or DEFAULT_MOVE
            if args.upload:
                config = request(base, token, "/api/worker/mlsnp-gates/config")
                if config.get("rule_version") != RULE_VERSION:
                    raise RuntimeError("PINE and the worker use different gate rule versions")
                move = config["move_date"]
            snapshot = build(args, move)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                temp = args.output.with_suffix(args.output.suffix + ".tmp")
                temp.write_text(json.dumps(snapshot, allow_nan=False), encoding="utf-8")
                temp.replace(args.output)
            if args.upload:
                request(base, token, "/api/worker/mlsnp-gates", snapshot)
            print(f"Gates built: {len(snapshot['players'])} players; move {move}; {'published' if args.upload else 'export only'}", flush=True)
        except Exception as exc:
            # HTTPError bodies/URLs can contain deployment details; log only type and safe context.
            from urllib.error import URLError
            print(f"Gates update failed: {type(exc).__name__}" if isinstance(exc, URLError) else f"Gates update failed: {exc}", file=sys.stderr, flush=True)
            if not args.watch:
                return 1
        if not args.watch:
            return 0
        time.sleep(args.watch)


if __name__ == "__main__":
    raise SystemExit(main())
