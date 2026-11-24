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
  tools can inspect an individual request. A request in the first minute after a break also
  carries `cold;desc=idle` (or `restart`, see below).
- `browser`: request time through response JSON decoding for those same endpoints. Metrics
  named `*-render` measure browser time from the start of rendering a main app view to its second animation
  frame, including the view's awaited requests. This measures the page shell; asynchronous
  panels, stats and cards finish separately. `player-render` includes staff reports. It excludes
  the initial app bootstrap, whose player-list request is recorded separately as `players`.

PINE has about three regular users, a few short sessions a day. Hours rarely hold more than one
timing, releases ship several times a day, and most sessions begin after a break. The report is
built for that: it judges from counts over a limit, trends by day, compares weeks rather than
releases, and lists slow and failed events one by one.

Measurements store counts, totals, maxima, query totals and latency buckets, grouped by hour, release version,
source, metric, success/error and first use after a break. Bucket upper bounds are 50, 100, 150, 250, 350, 500 and 750 ms,
1, 1.5, 2, 3, 5, 10, 30 and 60 s, and 5 min. Rows saved with the earlier, coarser buckets are
re-binned once at startup; every earlier bound still exists, so no timing moves to a lower bound.
Tables from before the first-use flag are rebuilt once at startup with every existing row marked
as not first use.

**First use after a break.** Requests that start in the first minute after 15 minutes with no
measured use are marked `idle`; the first minute after the server starts is marked `restart`.
Background change polling (every 15 seconds from any open tab) does not count as use. Caches,
provider sign-ins and SQLite pages have often gone cold by then, so these requests are kept
apart in the aggregates. The browser reads the mark from `Server-Timing` and marks its own timing
of that request, and of a page open that waited on it.

**Slow and failed events** are logged one by one in `performance_slow`: server requests over 1 s,
server requests that failed (status 400 or above, however fast), and page opens over 2 s
reported by the browser. Each holds time, release, source (`server` or `browser`), metric, HTTP
status, total, database time, query count, provider time and the first-use mark. Browser events
have no server split. Browser samples carry `age` (milliseconds since the timing ended, up to
10 minutes) so a page open is placed when it happened rather than when the batch arrived. The
log keeps the newest 1,000 events for at most 90 days and is buffered and saved with the
aggregates. No player IDs, names, staff IDs, query strings, notes, IPs or
page content are stored. Browser reports are best effort, batched after five seconds or when
the tab is hidden. Requests starting/ending in the background are excluded. Failed delivery
does not retry. Server samples are buffered for up to 30 seconds before saving to SQLite;
an abrupt shutdown may lose that buffer. Data are retained for 90 days. A maximum of 512
pending aggregate groups bounds memory if SQLite is unavailable; further new groups are dropped.

## Read and compare

Admins can open **Operations → Monitoring → What is slow?**:

- **Slow and failed** comes first: a one-line count for the period (for example "3 slow page
  opens, 2 slow requests and 1 failed request in the last 14 days. 4 of the 5 slow ones were the
  first use after a break") and each event, newest first, with its split and first-use mark.
  The newest 25 are shown; the rest open on request. Browser page opens have no server split;
  the server requests listed around the same time show where the time went.
- **Pages:** each page's opening time, slowest status first. Columns are status, average
  (exact), slowest (exact), how many went over the 2 s limit ("3 of 12"), total wait (uses ×
  average, the staff time spent waiting in the period), change on last week, and error count.
  When the first use after a break averages at least 1.5 times the rest, it shows under the
  average with its count. Expanding a page lists the requests it waits for and the panels that
  load after it opens. Board, Short Board, Roster and Database pages draw from the player list
  loaded at sign-in.
- **Status** counts timings over limits that sit on bucket edges, so the counts are exact.
  Pages: target 1 s, limit 2 s. Requests: target 250 ms, limit 1 s. **Slow**: at least 2, and at
  least 1 in 5, over the limit. **Watch**: one over the limit at a rate of at least 1 in 20, or at
  least 1 in 4 over the target. Fewer than 3 timings is "Too few". Percentiles are not used to
  judge: at this volume the 95th percentile is just the slowest timing.
- **Where the time goes** stacks average server time as database, outside provider and app
  processing. Those come from the same requests, so their shares are like-for-like. The hint
  says "Mostly network or download" when staff wait at least twice the server time; browser and
  server timings are separate populations and are never subtracted. 50 or more queries per
  request is highlighted.
- **Trend:** one column per calendar day for the selected page or request: a dot for the average
  and a line up to the slowest timing, with the target and limit as dashed lines, uses per day
  underneath, and a dotted line on days a new release went live. Days without use are blank.
  A slowest timing far above the averages is pinned to the top and marked. Daily values,
  including first-use counts and releases, also have an accessible data table.
- **All requests** lists every measured request, including ones not tied to a page. Requests use
  staff (browser) timings when there are at least 3, otherwise server time, and say so.
- **Technical details** keeps the raw table of every stage and outcome, with percentiles.

Filters select the period (7, 14, 30 or 90 days, 14 by default) and the order (worst first or
most total wait). The whole period is read across releases. "vs last week" compares the average
over the last 7 calendar days with the 7 before, only when both weeks have at least 5 timings,
and shows ≈ same within 20%. Hover it for both counts. No statistical significance is inferred.
Days follow the admin's browser time zone.

The panel loads independently and Refresh reads the latest buffered server samples. No prior
history is backfilled. The release hash includes all server/browser JavaScript, CSS and HTML,
so fixes inside a backend helper also get a distinct version.

An admin session can read `GET /api/performance`. Agents can use
`GET /api/worker/performance` with the existing `X-PINE-Worker-Token` credential. The worker
credential does not grant staff access or permission to submit browser samples. Both reports
are private and must not be committed or posted in a public PR.

Both endpoints accept `days=1…90` or `hours=1…2160` (default 90 days), an optional `tz` IANA time
zone for day boundaries (default UTC), and optional `version=current` or an eight-character
release hash. Windows include the whole starting hour. The response includes `current_version`,
`releases` (each with `first_seen` and `last_seen` hours), `since`, `time_zone`, `summary` sorted
by descending p95 (database rows also carry `mean_queries`), `bucket_upper_ms`, `daily` rows
(day, source, metric, outcome and `cold` 0/1, merged across hours and releases; database rows carry a
`queries` total), `slow_request_ms`, `slow_page_ms`, `idle_ms` and up to 1,000 `events` (newest
first). The summary merges histograms across the selected window and releases, keeping sources and
success/error outcomes separate. Mean latency is `total_ms / count`; approximate p50 and p95 are
the first bucket bounds reaching 50% and 95% of samples. These are upper bounds, not exact
percentiles. Compare success and error rows separately and report sample sizes.
Browser and server samples are separate populations, not paired traces: do not subtract their
percentiles. With this little use, compare weeks of comparable traffic before and after a fix,
and check whether slow events cluster on first use after a break before blaming steady-state code.

Start with the slow and failed events, then the slowest page, its request metrics and the panel
requests. High database time points toward SQL; a high query count points toward per-row
queries. High provider time points toward an outside service. Slowness mostly on first use after
a break points toward expiring caches or provider sign-ins. High server time with low database
and provider time points toward CPU or disk work; it does not identify an individual function.
Fast server times with slow browser requests point toward network/transfer costs. Slow shell
rendering with fast detail requests needs a browser rendering profile. Do not change caching or
benchmark logic without this evidence.
