#!/usr/bin/env python3
"""Read a USL League Two Top Prospects report (PDF) and upload its players to PINE.

The report belongs to the league, so its contents stay out of this public repository: this script reads the
PDF on your machine and sends the list straight to PINE's database.

    python3 scripts/l2-prospects.py "2026 USL L2 Top Prospects Report.pdf" --output l2-2026.json   # check it
    PINE_URL=https://... PINE_WORKER_TOKEN=... python3 scripts/l2-prospects.py report.pdf --upload

Needs PyMuPDF (pip install pymupdf). Reads both layouts seen so far: the 2026 header "NAME| CLUB| 2005"
with a School line, and the 2025 header "NAME| CLUB| RB #2, 2003".
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen

HEADER_2026 = re.compile(r"^(.+?)\s*\|\s*(.+?)\s*\|\s*(\d{4})\s*$", re.M)
HEADER_2025 = re.compile(r"^(.+?)\s*\|\s*(.+?)\s*\|\s*([A-Z/]+)\s*#\s*\d+\s*,\s*(\d{4})\s*$", re.M)
TIER = re.compile(r"^(FIRST|SECOND|THIRD|FOURTH|FIFTH)\s+XI\s*$", re.M)
SCHOOL_IN_PROSE = re.compile(r"^(?:•\s*)?((?:Univ\.|University|College)[^:\n]*|[A-Z][\w .&']+ (?:University|College)):", re.M)


def field(text: str, key: str) -> str | None:
    m = re.search(rf"{key}:\s*(.+?)\s*$", text, re.M)
    return m.group(1).strip() if m else None


ABBREVIATIONS = {"FC", "SC", "CF", "AFC", "RR", "STA", "SA", "US", "USA"}


def title(name: str) -> str:
    """ANDREW SAMUELS -> Andrew Samuels, VERMONT GREEN FC -> Vermont Green FC, keeping McDaid / D'Agostino readable."""
    def word(w: str) -> str:
        return w if w in ABBREVIATIONS or any(ch.isdigit() for ch in w) else w.capitalize()
    out = " ".join(word(w) for w in name.replace("’", "'").split())
    out = re.sub(r"\bMc(\w)", lambda m: "Mc" + m.group(1).upper(), out)
    return re.sub(r"\b([DO])'(\w)", lambda m: m.group(1) + "'" + m.group(2).upper(), out)


def parse(path: str) -> tuple[int | None, list[dict]]:
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    first = doc[0].get_text()
    year = re.search(r"\b(20\d\d)\b", first)
    players = []
    for page in doc:
        t = page.get_text()
        if "Player Profile" not in t or "General" not in t:
            continue
        tier = TIER.search(t)
        h25, h26 = HEADER_2025.search(t), HEADER_2026.search(t)
        if h25:
            name, club, pos, born = h25.group(1), h25.group(2), h25.group(3), int(h25.group(4))
            school = field(t, "School") or (SCHOOL_IN_PROSE.search(t).group(1).strip() if SCHOOL_IN_PROSE.search(t) else None)
        elif h26:
            name, club, born = h26.group(1), h26.group(2), int(h26.group(3))
            after = t[tier.end():].strip().splitlines() if tier else []
            pos, school = (after[0].strip() if after else None), field(t, "School")
        else:
            continue
        players.append({
            "name": title(name.strip()), "club": title(club.strip()), "born": born, "position": pos,
            "tier": tier.group(1).title() if tier else None, "status": field(t, "Player Status"),
            "school": school, "grad": field(t, "Grad Year"), "hometown": field(t, "Hometown"),
        })
    return (int(year.group(1)) if year else None), players


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--year", type=int, help="defaults to the year on the report's cover")
    ap.add_argument("--output", help="write the parsed list here (JSON) to check it")
    ap.add_argument("--upload", action="store_true", help="send it to PINE (PINE_URL, PINE_WORKER_TOKEN)")
    a = ap.parse_args()
    if not a.output and not a.upload:
        ap.error("Choose --output, --upload, or both")
    year, players = parse(a.pdf)
    year = a.year or year
    if not year or not players:
        sys.exit(f"Couldn't read a year and players from {a.pdf}")
    print(f"{year}: {len(players)} players; {sum(1 for p in players if not p['tier'])} without an XI", file=sys.stderr)
    payload = {"year": year, "players": players}
    if a.output:
        with open(a.output, "w") as f:
            json.dump(payload, f, indent=1)
    if a.upload:
        base, token = os.environ.get("PINE_URL", "").rstrip("/"), os.environ.get("PINE_WORKER_TOKEN", "")
        if urlparse(base).scheme != "https" or not token:
            sys.exit("Uploads need an https PINE_URL and PINE_WORKER_TOKEN")
        req = Request(f"{base}/api/worker/l2-prospects", data=json.dumps(payload).encode(), method="PUT",
                      headers={"Content-Type": "application/json", "X-PINE": "1", "X-PINE-Worker-Token": token})
        with urlopen(req, timeout=60) as res:
            print(res.read().decode(), file=sys.stderr)


if __name__ == "__main__":
    main()
