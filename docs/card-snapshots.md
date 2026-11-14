# Structured scouting card snapshots

Each newly built scouting card can retain its complete renderer input alongside
its PDF and PNG. This is the existing card data, including metric IDs, values,
percentiles, peer/sample context, history, role mixtures, event coordinates,
missing values and provenance. It does not change scoring or introduce new metrics.
The Hearts of Pine CLI already renders from this saved input.

## Storage and API

SQLite `cards` gains nullable `snapshot_file`, `snapshot_schema` (the renderer's
schema version) and `snapshot_sha256` (the stored JSON envelope's digest).
The compressed JSON lives under the existing durable cards directory:
`<player_id>/card-<card_id>-<digest>.snapshot.json.gz`. It is not disposable cache.
Database-only backups do not include these files; back up the cards directory too.
Every card version keeps its own snapshot, PDF and PNG.

The envelope is:

```json
{
  "schema": 1,
  "pdf_sha256": "<64 lowercase hexadecimal characters>",
  "hop_commit": "<generator Git commit, or null if unavailable>",
  "data_as_of": "2026-10-01",
  "render_input": {
    "schema_version": 16,
    "id": "player-555-1916-am",
    "iteration": 1916,
    "subject": {"id": 555, "profiles": [{}]},
    "context": {},
    "events": {"position": "AM"},
    "provenance": {}
  }
}
```

The example omits renderer fields for brevity. Upload the full original input;
never replace unavailable values with zero or reinterpret an earlier schema.
The envelope schema and renderer schema are independent. Historical positive
renderer versions are retained as-is; consumers must select an appropriate reader.

- `PUT /api/worker/cards/:id/snapshot`: worker token and `X-PINE: 1` required;
  at most 10 MiB uncompressed JSON. Validates structure, finite numbers, render
  version, player, iteration and exact position. Upload before the PDF for new
  cards. Identical retries succeed; a different snapshot returns 409.
- The PDF upload checks its bytes, generator commit and data date against any
  attached snapshot before completing the card. Older workers without snapshots
  remain compatible during rollout. A reclaimed job clears the earlier attempt's
  snapshot pointer, just as it clears its PNG pointer.
- `GET /api/cards/:id/snapshot`: staff authentication required; returns the
  gzip-encoded JSON for completed cards only, with private/no-store headers.
  Existing card listings include `has_snapshot` and `snapshot_schema`.
- `GET /api/worker/cards/snapshots?after=0`: worker-only inventory of completed
  versions, 100 at a time. Follow the returned `next` cursor until null. Includes
  identities, provenance, availability and the actual stored PDF digest; no paths.

## Rollout and historical recovery

Deploy the Pine server first, then update the Hearts of Pine worker. The new
worker archives `.player-card.json` and `.snapshot.json` beside each PDF before
uploading the snapshot, PNG and PDF in that order. A failed snapshot delivery
prevents publishing a new PDF without its data; archived originals remain
available for retries and backfill.

The Hearts of Pine `workflows.player_cards.snapshot_backfill` command inventories
all completed server versions, skips attached snapshots, and pairs retained
renderer inputs by exact PDF SHA-256. It can search multiple original output
folders. A completed card accepts a backfill only when its stored PDF digest,
commit and data date match; neither its PDF nor its generation date is modified.

Run a dry audit first, then the same command with `--upload`. See
`hearts-of-pine/docs/player-cards.md` for commands. Reports are private operational
data and must not be committed to this public repository.

The previous worker discarded its temporary JSON and retained only PDFs/PNGs.
Some historical cards therefore have no recoverable original input. The audit
reports missing/invalid/ambiguous originals individually and exits nonzero on
incomplete recovery. It never recalculates present-day values and attaches them
to an old PDF. Regenerating such a card creates a separate version with a new
matching PDF and snapshot.
