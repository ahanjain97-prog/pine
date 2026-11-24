# Monitoring

Admins can open **Operations → Monitoring** (`/#/monitoring`). Staff settings link to it too.
The dashboard uses existing card/map protocols; no worker update or new dependency is needed.

The page reads top to bottom as: four summary tiles (**Speed**, **Errors**, **Card & map worker**,
**App health**), then **What is slow?** (see [performance.md](performance.md)), then **Card and map
builds**. Speed names up to four slow or watch items, largest total wait first; clicking one opens
it in the performance tables and charts its trend. Errors is the share of measured server requests
that failed in the selected performance period. Active jobs open automatically when there are any;
recent build activity is collapsed until opened.

- **Mac Mini worker:** successful authenticated claims, progress updates and artifact uploads
  count as contact, including an empty claim poll. Diagnostic/backup reads do not count. Cards
  and maps show separate contact ages. Recent means within 60 seconds; quiet is 1–5 minutes;
  no recent contact means over 5 minutes. Not observed means no saved contact yet. These are
  PINE's observations, not direct checks of the Mac's power, internet, CPU or worker process.
  A long build can pause polling without the Mac going offline.
- **Jobs:** current queued/running counts, oldest queue age, and jobs running longer than the
  existing 15-minute retry threshold. Up to 50 active jobs per type are listed, with player
  links, match-download progress and attempt counts. Totals cover the full queue.
- **Build activity:** requests, starts/retries, completions and failures, with the latest 40
  events listed. New observations persist for 14 days, including when map rebuilds replace old
  job rows. Retention cleanup runs at most hourly when another event is saved. Events are
  private operational data and must never be committed or copied into public PRs.
- **24-hour metrics and build chart:** observed requests/completions/failures, average queue time on starts
  (with sample count), and average build time on completions (with sample count). Queue time
  on a retry includes elapsed time since the original request; build time covers the last
  attempt only. Historical jobs are not backfilled; counts start after deployment. Failures
  finalized automatically after exhausted attempts count when the next claim finalizes them.
  Queue wait and build time have separate horizontal bars and sample sizes. They are not
  stacked or summed, because they can come from different jobs. Missing timings say "No
  samples"; an observed zero wait remains zero.
- **App health:** response status, process uptime, resident memory and volume free space.
  Disk readings below 10% free are labeled low; an unavailable disk reading is shown as `—`.
  These are current readings rather than time-series host metrics.
- **Performance:** page and request status against targets, where server time goes, hourly trends and a log of
  slow requests, described in [performance.md](performance.md). Its refresh and filters are independent of status polling.

Status refreshes every 15 seconds while the page is visible and immediately on returning to
the tab. Navigating away stops polling. Failed refreshes keep prior data with a stale-data
message rather than pretending the app or worker is healthy.

`GET /api/monitoring` requires an admin session. `GET /api/worker/monitoring` uses the existing
worker credential through the normal worker auth gate. Both return `private, no-store`
responses. Neither read updates worker contact. No notes, reports, staff identities, secrets,
provider URLs, or filesystem paths are returned. Player names and links are returned only
behind these existing access controls.

Monitoring stores two small SQLite tables: `monitoring_workers` and `monitoring_events`.
Worker contact is kept in memory and persisted at most once per 30 seconds per job type;
restart may therefore make its last-contact timestamp up to 30 seconds older. Event write
failures do not fail builds/uploads; the dashboard warns if observations were dropped during
this server run. There are no automated retries, worker restarts, alerts or external probes.
