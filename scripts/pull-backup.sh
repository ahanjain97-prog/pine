#!/bin/bash
# Pull a fresh PINE database snapshot from the live site to this Mac, keeping the last 30.
# Run by hand, or daily via scripts/com.pine.backup.plist.
set -euo pipefail

ENV_FILE="${PINE_ENV:-$HOME/pine/.env}"
APP_URL="${PINE_URL:-$(grep '^PINE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}"
DEST="${PINE_BACKUP_DIR:-$HOME/pine-backups}"
[ -n "$APP_URL" ] || { echo "set PINE_URL (in $ENV_FILE or the environment)" >&2; exit 1; }
KEEP=30

TOKEN="${PINE_BACKUP_TOKEN:-$(grep '^PINE_BACKUP_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}"
[ -n "$TOKEN" ] || { echo "set PINE_BACKUP_TOKEN (in $ENV_FILE or the environment)" >&2; exit 1; }

mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d)"
TMP="$DEST/.pine-$STAMP.part"
OUT="$DEST/pine-$STAMP.sqlite"

curl -fsS --max-time 300 -H "Authorization: Bearer $TOKEN" "$APP_URL/api/backup" -o "$TMP"

# A valid SQLite file starts with "SQLite format 3"; refuse to keep an error page.
head -c 15 "$TMP" | grep -q "SQLite format" || { echo "downloaded file is not a database" >&2; rm -f "$TMP"; exit 1; }
mv "$TMP" "$OUT"
echo "$(date '+%Y-%m-%d %H:%M') saved $OUT ($(du -h "$OUT" | cut -f1))"

# keep the newest $KEEP
ls -1t "$DEST"/pine-*.sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done
