# Staff analysis library

`#/analysis` is a curated staff library with topic browsing, search across briefs,
recent-update and title sorting, and stable links to individual reports. Each
native brief contains takeaways, sections, optional comparison tables, coverage,
limitations, editorial review dates, source provenance and downloads. PDFs open
from authenticated endpoints; staff do not need access to the source repository.

The initial selection and real content are reviewed in a companion PR in the
private Hearts of PINE repository. It includes the five requested topics and
one additional recent study, MLS NEXT Pro graduation. The three topic groups are
Scouting & recruitment, Team performance, and Player development. Older or
superseded reports and unfinished research do not automatically enter the library.

## Content and access

PINE's source is public. Never add real report bodies, conclusions, PDFs, private
snapshots, or real-content screenshots under public/, docs/, scripts/fixtures/,
or anywhere else tracked here. The private source repository owns the editorial
catalog at `reports/pine-library.json`, including exact reviewed source revisions.

`PUT /api/worker/analysis` uses the existing worker token and `X-PINE: 1`. It
validates a complete snapshot, its dates, source paths, exact commit IDs, hashes,
and file signatures before atomically replacing the library. Maximum request:
20 MB. A rejected or older upload leaves the prior publication intact. An empty
approved catalog explicitly withdraws all reports. Report metadata and original
attachments are stored together in SQLite and included in normal backups.

`GET /api/analysis`, `GET /api/analysis/:slug`, and
`GET /api/analysis/:slug/files/:id` inherit PINE's staff sign-in gate. Worker tokens
do not open the read endpoints, and staff sessions cannot publish. Reads use
`Cache-Control: private, no-store`. Markdown downloads are plain-text attachments;
brief content is escaped text, never raw HTML. There are no static report URLs.

A missing initial publication produces a clear empty state. Withdrawn or unknown
report links produce a not-found state. Failures offer a retry and do not insert
late responses into a different page. Publication dates distinguish the report's
update, editorial review, and data coverage. Past review deadlines show **Review
due** rather than silently pretending a study was refreshed.

## Rollout

1. Merge the private catalog PR and deploy this PINE PR.
2. On the analysis host, fetch the private repository including its source
   branches. The initial CPL report is pinned from its separate review branch;
   the private guide records the exact prerequisite.
3. Validate a publication locally, writing only to a private location:

   ```bash
   node scripts/sync-analysis.mjs --hop-root /path/to/hearts-of-pine \
     --catalog-ref origin/main --output /private/path/pine-analysis.json
   ```

4. With `PINE_URL` set to the HTTPS origin and `PINE_WORKER_TOKEN` set in the
   worker environment, publish once or supervise the continuing sync:

   ```bash
   node scripts/sync-analysis.mjs --hop-root /path/to/hearts-of-pine \
     --catalog-ref origin/main --fetch --upload --watch 21600
   ```

The publisher uses Git objects, never dirty working-tree files or analytics APIs.
It fetches Git updates when explicitly given `--fetch`, checks every six hours,
publishes changed catalogs, skips identical content, and retries failed runs
without replacing the last good snapshot. Pinning source commits is deliberate:
upstream edits cannot change a reviewed publication until a curator approves a
new revision. New polished work enters through the private catalog review, whose
admission policy is part of the analysis repo's report-delivery instructions.

The app and worker are separate rollout steps. This PR does not deploy production
or install a daemon on the host. Before merging the private PR, substitute its
branch in `--catalog-ref` to preview the exact collection.

## Review and validation

```bash
npm run check
npm test
python3 -m unittest discover -s scripts -p '*_test.py' -v
node scripts/preview-analysis.mjs
```

The preview uses an empty disposable player database, fictional report findings
and a sample PDF; provider requests are disabled. Use the printed localhost URL
for desktop/phone and light/dark QA. Public screenshots are in
`docs/screenshots/analysis/`. The private catalog PR contains the real content.
