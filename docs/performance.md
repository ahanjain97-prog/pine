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
  SQL text and parameters are never captured. Statements (`all`, `get`, `run`) are also counted
  per request; transaction boundaries add time but are not counted as queries.
- `external`: wall-clock time with at least one outside provider call in flight (Impect,
  Transfermarkt, NCAA and physical-data fetches), including downloading the response body.
  Overlapping calls count once. Retry back-off sleeps are not included. Part of server time.
  All three timings appear in `Server-Timing` as `app`, `sql` and `ext`, so browser developer
  tools can inspect an individual request.
- `browser`: request time through response JSON decoding for those same endpoints. Metrics
  named `*-render` measure browser time from the start of rendering a main app view to its second animation
  frame, including the view's awaited requests. This measures the page shell; asynchronous
  panels, stats and cards finish separately. `player-render` includes staff reports. It excludes
  the initial app bootstrap, whose player-list request is recorded separately as `players`.

Measurements store counts, totals, maxima, query totals and latency buckets, grouped by hour, release version,
source, metric and success/error. Bucket upper bounds are 50, 100, 150, 250, 350, 500 and 750 ms,
1, 1.5, 2, 3, 5, 10, 30 and 60 s, and 5 min. Rows saved with the earlier, coarser buckets are
re-binned once at startup; every earlier bound still exists, so no timing moves to a lower bound.

Server requests over 1 s are also logged one by one in `performance_slow`: time, release, metric,
HTTP status, total, database time, query count and provider time. Nothing else is stored. The log
keeps the newest 500 entries for at most 14 days and is buffered and saved with the aggregates. No player IDs, names, staff IDs, query strings, notes, IPs or
page content are stored. Browser reports are best effort, batched after five seconds or when
the tab is hidden. Requests starting/ending in the background are excluded. Failed delivery
does not retry. Server samples are buffered for up to 30 seconds before saving to SQLite;
an abrupt shutdown may lose that buffer. Data are retained for 14 days. A maximum of 512
pending aggregate groups bounds memory if SQLite is unavailable; further new groups are dropped.

## Read and compare

Admins can open **Operations → Monitoring → What is slow?**:

- **Pages:** each page's opening time, slowest status first. Columns are status, average
  (exact), slow end (the bucket bound 95% finish within), uses, total wait (uses × average, the
  staff time spent waiting in the period), change against the previous release, and errors.
  Expanding a page lists the requests it waits for and the panels that load after it opens.
  Board, Short Board, Roster and Database pages draw from the player list loaded at sign-in.
- **Status** compares the average with targets on bucket edges. Pages: good up to 1 s, watch up
  to 2 s, slow above. Requests: good up to 250 ms, watch up to 1 s, slow above. Something fast on
  average whose slow end is above 5 s (pages) or 3 s (requests) is Watch. Fewer than 5 timings
  is "Too few"; fewer than 20 is labelled "few".
- **Where the time goes** stacks average server time as database, outside provider and app
  processing. Those come from the same requests, so their shares are like-for-like. The hint
  says "Mostly network or download" when staff wait at least twice the server time; browser and
  server timings are separate populations and are never subtracted. 50 or more queries per
  request is highlighted.
- **Trend:** average and slow end by hour for the selected page or request, with the good and
  slow targets drawn as dashed lines and uses per hour underneath. Missing hours have gaps, not
  zeros. Slow-end values far above the averages are pinned to the top and marked. Hourly values
  also have an accessible data table.
- **All requests** lists every measured request, including ones not tied to a page. Requests use
  staff (browser) timings when there are at least 5, otherwise server time, and say so.
- **Recent slow requests** lists up to 100 logged server requests over 1 s with each one's split.
- **Technical details** keeps the raw table of every stage and outcome.

Filters select the period (24 hours, 7 or 14 days), the release (current by default, another
observed release or all) and the order (worst first or most total wait). Hourly histograms from
multiple releases are merged by sample counts before computing percentiles; percentiles are never
averaged. "vs previous" compares averages with the release first observed before the selected one, over that release's whole 14-day history,
only when both have at least 20 timings, and shows ≈ same within 10%. No statistical
significance is inferred.

The panel loads independently and Refresh reads the latest buffered server samples. No prior
history is backfilled. The release hash includes all server/browser JavaScript, CSS and HTML,
so fixes inside a backend helper also get a distinct version for comparison.

An admin session can read `GET /api/performance`. Agents can use
`GET /api/worker/performance` with the existing `X-PINE-Worker-Token` credential. The worker
credential does not grant staff access or permission to submit browser samples. Both reports
are private and must not be committed or posted in a public PR.

Both endpoints accept `hours=1…336` (default 336) and optional `version=current` or an
eight-character release hash. Windows include the whole starting hour. The response includes
`current_version`, observed `versions`, `since`, `summary` sorted by descending p95 (database rows
also carry `mean_queries`), `bucket_upper_ms`, hourly `rows` (database rows carry a `queries` total),
`slow_request_ms` and up to 500 `slow_requests` (newest first). The summary merges histograms across the selected hours
and releases, keeping sources and success/error outcomes separate. To calculate manually,
sum counts/buckets for the metric,
version and time window being compared. Mean latency is `total_ms / count`; approximate p50
and p95 are the first bucket bounds reaching 50% and 95% of samples. These are upper bounds,
not exact percentiles. Compare success and error rows separately and report sample sizes.
Browser and server samples are separate populations, not paired traces: do not subtract their
percentiles. Gather comparable traffic before and after a fix; a release with very few samples
is insufficient evidence of an improvement.

Start with the slowest page, its request metrics and the panel requests. High database time
points toward SQL; a high query count points toward per-row queries. High provider time points
toward an outside service. High server time with low database and provider time points toward CPU
or disk work; it does not identify an individual function. Fast server times with slow browser requests
point toward network/transfer costs. Slow shell rendering with fast detail requests needs a
browser rendering profile. Do not change caching or benchmark logic without this evidence.
