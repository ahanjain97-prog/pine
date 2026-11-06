#!/usr/bin/env python3
"""Generate (or install) a nightly macOS launchd job. No secrets go in the plist."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess

LABEL = 'com.pine.long-throw-sync'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--hop-root', type=Path, required=True)
    p.add_argument('--env-file', type=Path, required=True, help='Private file containing PINE_URL and PINE_WORKER_TOKEN')
    p.add_argument('--cache', type=Path, required=True)
    p.add_argument('--output', type=Path, help='Preview only; writes a reviewable plist without loading it')
    p.add_argument('--install', action='store_true')
    p.add_argument('--hour', type=int, default=3)
    args = p.parse_args()
    if not (0 <= args.hour <= 23) or bool(args.output) == args.install:
        p.error('Choose --output FILE or --install, and hour 0–23')
    root, cache = args.hop_root.resolve(), args.cache.resolve()
    python = root / 'venv/bin/python3'
    if not python.is_file() or not args.env_file.is_file():
        p.error('Hearts virtualenv and private env file must exist')
    cache.parent.mkdir(parents=True, exist_ok=True)
    log = cache.parent / 'long-throw-sync.log'
    job = dict(Label=LABEL, ProgramArguments=[str(python), str(Path(__file__).with_name('sync-long-throws.py').resolve()),
               '--hop-root', str(root), '--env-file', str(args.env_file.resolve()), '--cache', str(cache), '--upload'],
               WorkingDirectory=str(root), StartCalendarInterval=dict(Hour=args.hour, Minute=0),
               RunAtLoad=True, StandardOutPath=str(log), StandardErrorPath=str(log),
               ProcessType='Background')
    target = args.output or Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(plistlib.dumps(job))
    if args.install:
        domain = f'gui/{os.getuid()}'
        subprocess.run(['launchctl', 'bootout', f'{domain}/{LABEL}'], check=False, capture_output=True)
        subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)
    print(target)


if __name__ == '__main__':
    main()
