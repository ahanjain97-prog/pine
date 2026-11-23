# Performance measurement

PINE previously collected no page-load or request timing history. These measurements start only
after deployment and after staff reload their tabs; they cannot establish a past regression.

Normal authenticated usage now records:

- `server`: application time for the player detail/list, playing time, KPIs, card options, cards,
  maps, physical data, linking candidates and MLSNP gates, plus configuration, change polling,
  NCAA lists, War Room, Activity, Analysis catalog and Impect search/cache/shortlists/iterations.
  Includes authentication and response construction; excludes network transport.
- `database`: time inside the synchronous SQLite `all`, `get`, `run` helpers and transaction
  boundaries during each measured request, including statement preparation. This is part of
  server time, not additional latency. Direct `db.raw` calls are not counted. Request-local
  counters keep overlapping requests separate and stop when the response is constructed.
  SQL text and parameters are never captured. Both timings appear in `Server-Timing` as `app`
  and `sql`, so browser developer tools can inspect an individual request.
- `browser`: request time through response JSON decoding for those same endpoints. Metrics
  named `*-render` measure browser time from the start of rendering a main app view to its second animation
  frame, including the view's awaited requests. This measures the page shell; asynchronous
  panels, stats and cards finish separately. `player-render` includes staff reports. It excludes
  the initial app bootstrap, whose player-list request is recorded separately as `players`.

Measurements store counts, totals, maxima and latency buckets, grouped by hour, release version,
source, metric and success/error. No player IDs, names, staff IDs, query strings, notes, IPs or
page content are stored. Browser reports are best effort, batched after five seconds or when
the tab is hidden. Requests starting/ending in the background are excluded. Failed delivery
does not retry. Server samples are buffered for up to 30 seconds before saving to SQLite;
an abrupt shutdown may lose that buffer. Data are retained for 14 days. A maximum of 512
pending aggregate groups bounds memory if SQLite is unavailable; further new groups are dropped.

## Read and compare

Admins can open **Operations → Monitoring → Performance** to see the slowest p95 first, with sample counts,
mean, approximate p50/p95, maximum and separate success/error rows. Filters select the current
release (default), another observed release or all releases, and the last 24 hours, 7 or 14 days.
The panel loads independently and Refresh reads the latest buffered server samples. No prior
history is backfilled. The release hash includes all server/browser JavaScript, CSS and HTML,
so fixes inside a backend helper also get a distinct version for comparison.

An admin session can read `GET /api/performance`. Agents can use
`GET /api/worker/performance` with the existing `X-PINE-Worker-Token` credential. The worker
credential does not grant staff access or permission to submit browser samples. Both reports
are private and must not be committed or posted in a public PR.

Both endpoints accept `hours=1…336` (default 336) and optional `version=current` or an
eight-character release hash. Windows include the whole starting hour. The response includes
`current_version`, observed `versions`, `since`, `summary` sorted by descending p95, plus
`bucket_upper_ms` and hourly `rows`. The summary merges histograms across the selected hours
and releases, keeping sources and success/error outcomes separate. To calculate manually,
sum counts/buckets for the metric,
version and time window being compared. Mean latency is `total_ms / count`; approximate p50
and p95 are the first bucket bounds reaching 50% and 95% of samples. These are upper bounds,
not exact percentiles. Compare success and error rows separately and report sample sizes.
Browser and server samples are separate populations, not paired traces: do not subtract their
percentiles. Gather comparable traffic before and after a fix; a release with very few samples
is insufficient evidence of an improvement.

Start with the slowest render, its request metrics and the panel requests. High database time
points toward SQL. High server time with low database time points toward CPU, disk or provider
calls; it does not identify an individual provider or function. Fast server times with slow browser requests
point toward network/transfer costs. Slow shell rendering with fast detail requests needs a
browser rendering profile. Do not change caching or benchmark logic without this evidence.
