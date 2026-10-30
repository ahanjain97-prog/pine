# PINE: Player Identification Network Evaluation

Recruitment database and big board for Portland Hearts of Pine. One place for every player we track:
Transfermarkt profile, Impect link, physical data, a comment section for each staff member
(Ray, Ahan, Ford, Bobby, Alex, Yuta), pass / hold / fail verdicts, and a ranked big board by position and role.

## Run it locally

Needs Node 22.13+ (uses the built-in `node:sqlite`).

```bash
git clone https://github.com/ahanjain97-prog/pine.git
cd pine
npm install
cp .env.example .env   # fill in only what you need; never commit it
npm start              # http://localhost:8787
```

Want to help? See [CONTRIBUTING.md](CONTRIBUTING.md).

Sign-in is email + password. Nobody signs up: an admin opens **Staff** and clicks **Email sign-in link** next to a
person, which opens a Gmail draft to them with the link; press Send. The link opens a page where they choose a password; after
that they sign in with their email and that password and stay signed in for 180 days on that device. A link works
once and expires after 7 days; a forgotten password is fixed the same way, with a new link. Any signed-in staff
member can edit the big board, add players and write in their own evaluation section; admins can also delete
players and manage the staff list. With `PINE_AUTH=off` (local development) there is no sign-in: pick who you
are from the name menu in the top bar.

## KPI benchmarks

KPI bars rank players against qualified players at the same position and in the same season across
USL Championship, MLS Next Pro and USL League One. The display shows only pooled percentiles,
sorted highest to lowest with unavailable scores last. League percentiles remain in the API response.
Both metric normalization and ranking use a fixed minimum of five match shares at that position.
Players below that floor are still scored against the qualified reference, with a small-sample warning. The KPI card can switch between every position group the player logged that season.
Requests can raise the floor, but cannot lower it below five.

Categories retain the existing equal-weight, direction-adjusted, 1%-winsorized z-score definitions.
Percentiles use midpoint empirical ranks (including midpoint ties). At least eight valid reference
values are required. Category details show their actual valid peer counts. References count transfers
once per position, using their largest qualified league sample; the selected player's displayed
values remain those of the selected league season. Older seasons list unavailable leagues explicitly.
An available league failing to load produces an error instead of silently changing the benchmark.
Pooling is league-adjusted: each KPI is standardised within its own league before the three leagues are ranked together, which removes league-wide differences in raw output (including any genuine difference in league level). Reference fetch times are shown; API data
are cached for up to 12 hours.

Metric labels come from Impect, except where their label misstates the number: pXT KPIs are a change in
the team's goal threat per match rather than a count of actions, several "percent" figures are 0-1 shares,
and a few ratios don't say what is divided by what. Those are relabelled in `DISPLAY_OVERRIDES`
(`src/lib/impect_kpi.js`), and a test fails if a new percent/ratio/pXT metric arrives without one.

The panel groups categories by phase of play (on-ball, final third, off-ball) and shows one
name for each idea at every position: the study calls the same five passing metrics "Build-up circulation"
at centre-back and "Circulation and tempo" in midfield, and the page calls both "Circulation". Opening a
category splits its metrics into how well, how much, mistakes and Impect's own scores, each with the
median of the player's own league and a percentile against that league alone. The names, phases and
descriptions live in `src/lib/impect_display.js`, and a test fails if a regenerated study adds a category
without one.

Impect data for a league season (every squad's KPIs and scores, about 10 seconds to download) and the Impect
player pool are kept on disk next to the database, under `cache/`, so a deploy or restart doesn't make the next
viewer wait. A copy of any age is served at once and replaced in the background when stale. The server checks
every season of our three leagues at startup and every six hours: the current season is re-downloaded when it
is over six hours old, finished seasons once a week. The season list for player cards and pitch maps is read
from the same data rather than downloaded again. The Impect page shows when each league season was last saved,
and admins can press **Refresh all now** to download everything straight away (two or three minutes, in the
background). Cups are not kept: cup games are left out of the KPI benchmarks.

Run `npm test` for benchmark and mocked-API regression tests, and `npm run check` for syntax checks.

## MLS NEXT Pro gates

Current MLS NEXT Pro player pages have an **MLS NEXT Pro gates** tab immediately after Player card.
The badge counts the gates met: Packing P50+, ball wins P50+, 2,000+ recorded pro minutes, and age
22+ on the projected move date. Goalkeepers use three gates (ball wins is not applicable). The tab
works without a generated card; players without an Impect link can still see the age check.
The current club league takes precedence over an older Impect competition, so players who have
moved to another league do not keep the tab merely because they played MLSNP previously.

These are the October 2026 graduation study's inputs, **not** the pooled KPI profile percentiles.
The study groups midfielders together, uses MLSNP-only season/position references with 5+ match
shares and at least 10 valid peers, and weights season percentiles by match shares in the 365 days
before the move. Pro minutes cover MLS, MLSNP, USLC and USL1, excluding overseas minutes. Exact
birthdays and unrounded values determine gates. Missing inputs are unavailable, never automatic
failures. Under 5 match shares is provisional; under 1,500 minutes is directional. Data and source
timestamps, coverage gaps, stale inputs, DOB disagreements, and the rule version are visible.

**Rollout requires the sync worker as well as the web deployment.** Run the worker on the analysis
host, using its existing Python environment and a checkout containing the graduation study from
`fordb/hearts-of-pine` PR #697 (`experiments/mlsnp_graduation_20261019/arrivals.py`), initialized
Impect/ASA caches, and the study's `data/identity.parquet`. It calls the original study functions;
it does not read staff notes, decisions, or board membership. No new PINE dependency is needed.

Export a private snapshot first, without fetching or publishing:

```bash
/path/to/hearts-of-pine/venv/bin/python3 scripts/sync-mlsnp-gates.py \
  --hop-root /path/to/hearts-of-pine --cache-only --output /private/tmp/mlsnp-gates.json
```

For production, supply `PINE_URL` (HTTPS) and the existing `PINE_WORKER_TOKEN` in the worker's
environment. Supervise this long-running command with launchd/systemd, separately from the card
worker. It refreshes current data at most every six hours and preserves historical caches:

```bash
/path/to/hearts-of-pine/venv/bin/python3 scripts/sync-mlsnp-gates.py \
  --hop-root /path/to/hearts-of-pine --upload --watch 21600
```

Set `PINE_MLSNP_MOVE_DATE` on the web server (default `2027-02-28`); the worker reads that setting
from its authenticated config endpoint each run. A changed move date hides incompatible inputs
until a matching snapshot arrives. Update the study's season catalog before the next recruitment
cycle; the worker refuses unsupported future cycles and past move dates instead of silently
reusing the wrong window. Failed refreshes retain the last good snapshot and log an error. Inputs
older than 48 hours are flagged. Before the first upload, the tab says it is awaiting data.

`PUT /api/worker/mlsnp-gates` requires `X-PINE: 1` and `X-PINE-Worker-Token`. It validates the entire
snapshot (maximum 10 MB) before atomically replacing the stored inputs, rejects older snapshots,
and stores only the supported fields. Inputs and their rule/source versions live in the SQLite
database and are included in normal backups. Staff read `GET /api/players/:id/mlsnp-gates` through
the existing sign-in gate. No real player snapshot belongs in this public repository.

## Player playing time

Each player page has a compact league-fixture timeline, season minutes and minute share, with separate club rows for transfers. Bars show minutes played; short baseline marks are team games with zero recorded minutes. Empty calendar space has no fixture. Played playoffs count, cups and future games do not. Unlinked players have a simple Impect-link prompt, and missing seasons/data are not presented as zero minutes.

Minute share divides recorded player minutes by actual match duration across the relevant team fixtures, including added and extra time. A matching current club/join date bounds the current stint; non-overlapping historical transfers use the next club’s first appearance as an approximate boundary. Injury absences stay in the denominator. Two seasons load concurrently, with the newest requested first. Complete player timelines are saved on disk and served immediately while stale views refresh in the background (current seasons after six hours, historical seasons after a week). Completed match data are retained for 30 days, with recent games refreshed after six hours. Startup and the six-hour Impect refresh also prepare current-season fixtures for all clubs, with foreground player requests taking priority over background downloads.

## Configuration (`.env`, never committed)

| Variable | Purpose |
|---|---|
| `IMPECT_USERNAME`, `IMPECT_PASSWORD` | Impect account used for the Customer API and Scouting short lists |
| `PINE_SITE_PASSWORD` | One shared password in front of the whole site (browser prompt; username can be anything, e.g. `pine`). Redundant once everyone has their own sign-in; delete it then. |
| `PINE_ADMIN_EMAIL` | Email for the seeded admin account, used only when the database is first created. |
| `PINE_AUTH=off` | No sign-in; pick who you are from the name menu in the top bar. For local development. Delete it to require sign-in. |
| `PINE_BACKUP_TOKEN` | Key that `scripts/pull-backup.sh` downloads snapshots with (set the same value on the deployment and in the Mac's `.env`). It opens `/api/backup` only. |
| `PINE_WORKER_TOKEN` | Key the player card worker sends as `X-PINE-Worker-Token` (same value on the deployment and on the worker). It opens `/api/worker/*` only; unset, those routes refuse everything. |
| `PINE_MLSNP_MOVE_DATE` | Projected MLSNP-to-USL move date for gate checks; defaults to `2027-02-28`. The sync worker reads it from PINE. |
| `APP_URL` | Public URL once hosted. Sign-in links use it, and `https://…` makes the sign-in cookie secure-only. |
| `PORT` | Default 8787 |
| `PINE_DB` | SQLite file, default `data/pine.db` |
| `PHYS_DATA_URL` | Physical data JSON, default the player-physical-data site |
| `PINE_COLLEGE_DATA_URL` | College scouting `data.json` for the NCAA section, default the college-soccer-scouting-2026 repository on GitHub |

## What's where

Official signings have a magenta frame and **✓ Signed** badge on the player page, Big Board,
Short Board, NCAA board, player list and search results. Any signed-in staff member can use
**Mark as signed** under **Signing status** on a player page; press the same button to remove
the status if needed. This is separate from Pass / Hold / Fail and does not move the player,
change their club details or alter board ranks. Changes are saved in Activity. Transfermarkt
syncs leave the signing status alone.

- **Big Board** (`#/board`): pitch layout of all 11 positions and 25 roles from the depth chart. Drag cards
  to rank within a role or move between roles; drag to "Not on the board" to take a player off. Card stripe
  = club decision, dots = the six staff verdicts, DOM / INTL = domestic (US citizen, from Transfermarkt citizenship)
  or international. Green cards aren't on Transfermarkt and its citizenship is sometimes wrong, so Edit details
  on the player page can set the roster status to Domestic or International by hand; syncs leave that alone.
  A player with no citizenship anywhere shows a dashed **?** instead, and their page says the roster status is
  unknown, so someone sets it in Edit details. College players are filled in automatically where possible: from
  their college profile's country, and otherwise (on start and after each college import) by looking them up on
  Transfermarkt, linking only when exactly one result has their surname at one of their schools (their PINE club
  or college profile's school; initials count, so LMU = Loyola Marymount).
  College players whose league names NCAA also carry a lavender tag beside DOM / INTL: their college grade
  ("B/B") when the college database grades them, otherwise "NCAA". Cards shorten college clubs to the team name.
  College players on the NCAA board without a Big Board role stay in the NCAA board's tray, not this one. Pasting a college player's
  Transfermarkt link sets the league to NCAA (Transfermarkt has no league for college programs; the club name
  ends with the school in brackets, e.g. "Indiana Hoosiers (Indiana University)"). A league edited by hand wins.
  Each board has a **Key** explaining its marks. Cards show at most three tags (extra ones fold into "+N" with
  a tooltip), and the verdict dots only once someone has a verdict.
- **Short Board** (`#/short-board`): the same pitch, positions and roles as the big board, showing only the
  top targets. A player becomes one by the ☆ on their board card (or the ☆ beside a role on their player
  page), per role, so the same player can be a target at one role and not another. Order follows the big
  board, and dragging a card here reorders it there too. Dropping a card into another role asks whether to
  move the player there or duplicate them (a top target in both roles). Stored as `board_entries.shortlist`, which `src/lib/board.js` carries across reorders; not to be confused with the Impect Scouting short lists on
  the Impect page, which are an import source.
- **NCAA** (`#/ncaa`): the college section, in college purple. **Board** has a tab per year and uses the Big Board's
  pitch formation, with one ranked list per position. The latest year (2026, marked Live) is PINE's board,
  seeded from the college scouting database's latest board in its order, plus every Big Board player whose
  league names NCAA. Drag to re-rank or move between positions, and drag a row to the tray below to take it
  off; someone taken off stays off (neither the Big Board sync nor a re-import puts them back) until dragged
  back in. Earlier years (`#/ncaa/2025`, `#/ncaa/2024`) show those boards as the college database ranked them,
  read-only, including players not in PINE (click one for their reports). Rows show the college grade
  (current/future, coloured by the future grade; the best grade across their reports, as the college database
  shows it), their class that season and school, and DOM / INTL and agent status on the live board, or where the
  player is now on past boards. **College database** lists every prospect with grade, seasons scouted, where they
  are now, reports and board spot, filterable by year; click a row for the reports. Classes follow the college
  scouting site's rule (classForYear): a report from that season gives the class, otherwise the latest class
  moves up a year per season (a 2025 Junior is a 2026 Senior), capped at Grad Student. The live board shows 2026
  classes, past boards that season's, and the college database the chosen year's.
  Being on the Big Board is what marks a college player as a priority. On the live board those rows carry a
  green **BB** tag (hover for their roles) and the ☆ that makes them a top target (Short Board); filter by
  Big Board or not. Hover anyone else for **+ BB**, which adds them to the Big Board at the role their college
  scouting suggests (e.g. True #9 (Target) → FWD #2 Target, Inverted Winger → #2 Inverted Winger; otherwise
  the position's first role). Big Board and Short Board cards show the college grade in the NCAA tag
  ("NCAA B/A"), and the Database table shows each player's NCAA board spot beside their roles.
  Players on the latest college board become PINE players (league NCAA, `source` `college_import`) unless
  they're already in PINE. Names match strictest first: the same name (accents and letters like ø ignored);
  the same first and last name (middle names); the same surname and first three letters of the first name
  (Matt/Matthew) for NCAA players. Two candidates means no link. College-import players found to duplicate an
  existing player are merged into them at startup (notes, verdicts, roles, history and college links move
  across; the college rank wins on the NCAA board), logged in Activity. A profile linked wrongly has a **Not
  this player?** button, and that prospect is never relinked. The data is `data.json` from the
  college-soccer-scouting-2026 repository (`PINE_COLLEGE_DATA_URL`), imported on the first start after the
  section (or its year boards) shipped and again when an admin presses **Re-import**, which refreshes grades,
  reports and past boards and keeps links and the live board's order. Code: `src/lib/ncaa.js`.
- **USL League Two Top Prospects**: players picked for the league's yearly Top Prospects report carry an
  orange **L2 '26** tag (**L2 '25 '26** for both years; hover for the XI, position and L2 club) on the Big Board,
  Short Board, NCAA boards, both database tables and the player page, which lists each pick. The report's
  Player Status (Domestic / International) fills in DOM / INTL when citizenship doesn't, and the player page
  notes when the two disagree. The reports are the league's, so they never go in this public repository:
  `python3 scripts/l2-prospects.py "<report>.pdf" --upload` (PyMuPDF; `PINE_URL` and `PINE_WORKER_TOKEN` set) reads
  the PDF locally and replaces that year's list in PINE (`PUT /api/worker/l2-prospects`; `--output FILE` to check
  it first). Entries match PINE players by name, like the college import, and birth years more than a year apart
  rule a match out; players added later are matched when they're created. Code: `src/lib/l2.js`.
- **College reports written in PINE**: any college player can get a grade and report like the imported ones.
  On a player page, **+ Add report** (grade now and ceiling on the college database's scale D- to A+++, class,
  school, date, how they were seen, match, notes); Add player shows the same fields for college players (a
  Transfermarkt college club, or league NCAA by hand), plus an NCAA board position, and the NCAA page has
  **+ Add college player**. The first report makes a college profile (origin `pine`); a player already in the
  college database gets the report on their imported profile. A profile's grade is its best report's by
  ceiling, exactly as the college database works it out, so PINE and imported reports count the same. Only a
  report's author or an admin can edit or delete it; imported reports are read-only, and a re-import replaces
  only its own (`ncaa_reports.origin`).
- **Agent**: a panel on every player page for who represents them (unknown, no agent, advisor, agent),
  agent and agency names, email, phone, last contact and notes. It is PINE's own record; Transfermarkt's
  agent line is shown beneath it for reference and never overwrites it.
- **Database** (`#/players`): sortable and filterable table of everyone, with CSV export.
- **Player page**: the header holds Transfermarkt facts, the club decision and the staff verdict tally. Staff evaluations
  show everyone's box (yours first, then anyone who has weighed in); "Hide empty" folds the rest into one line,
  remembered per browser. Below it,
  the shared summary, college scouting reports (players in the college database) and one evaluation section per staff member (only you can
  write in yours), with big board roles, the NCAA board spot (college players), agent details, lists, the Impect link and history alongside. Underneath are tabs for
  the KPI profile, physical data, pitch maps and player card; one season and position picker drives the three
  Impect tabs (physical data has its own seasons). A tab loads the first time it is opened.
- **Player card**: a PDF made outside PINE, shown on the player page as a picture that opens the PDF.
  Pick a season (league seasons in our three leagues, never the cup) and a position (any with at least
  one Impect match share that season); an admin presses Generate. That queues a job; the card worker on
  the Mac mini claims it (`POST /api/worker/cards/claim`), renders it, uploads a PNG of it
  (`PUT /api/worker/cards/:id/png`, optional) and then the PDF (`PUT /api/worker/cards/:id/pdf`, which
  finishes the job), or reports a failure code (`POST /api/worker/cards/:id/fail`). While it works it can
  post a progress note (`POST /api/worker/cards/:id/progress`, `fetching_events` and a match count), which the
  panel shows under "Generating" so staff know why a card that downloads Impect match data first is slower.
  Every version is kept and any signed-in staff member can open it. One card per player can be in progress, and at most 30 are
  requested across PINE per 24 hours.
- **Pitch maps**: a panel on the player page (Impect-linked players) under the player card. It shows the card's two
  activity maps (In attack, Defensive actions) for a season and position, with up to three metrics per map chosen
  from every metric the card worker exports (28 today: the card's markers plus passes into the box, receptions,
  ball losses, clearances and more; hover one for its definition). The shading never depends on the metrics
  shown. Anyone signed in can build maps; the card worker claims the job (`POST /api/worker/maps/claim`), may
  post the same `fetching_events` progress note, and uploads the export (`PUT /api/worker/maps/:id/json`, at most
  5 MB, which finishes the job) or a failure code (`POST /api/worker/maps/:id/fail`). The export has every
  metric's points, so choosing metrics is instant. Each view keeps only its latest build, gzipped; a rebuild
  replaces it. The panel says when a build predates newer metrics or is over a week old in the current season,
  and when the worker is offline or not yet taking map jobs. Chosen metrics are remembered per position group in
  the browser; Download PNG saves both maps as a picture. At most 6 builds wait per person and 200 are requested
  across PINE per 24 hours. Old `#/maps/<player id>` links open the player page.
- **Add player**: paste a Transfermarkt link (or paste one anywhere on the page). Physical data and
  Impect are matched automatically by name + date of birth / club.
  An exact name and date-of-birth match also detects a player already imported from Impect.
  For older duplicate Transfermarkt imports, admins can use **Combine profiles** beside the matching
  Impect candidate. This keeps the existing profile's board position, scouting records and connected
  data, adds the Transfermarkt details, and redirects the duplicate's old links. It only accepts an
  untouched duplicate with the same name and birthday; staff edits or scouting records block it.
  Original records are saved privately in the database for recovery and included in backups.
- **Impect** (`#/impect`): import or sync Impect Scouting short lists (each list maps to a board role;
  centre-back lists split LCB/RCB by foot), or browse every player in our Impect competitions.
- **Activity** (`#/activity`): grouped by player under day headings (Today, Yesterday, …), each group collapsed to
  its latest update with a count; open one for its full history. Notes and college reports are marked **Your
  report** (green) or **New report · <Name>** (blue), with the start of what was written and a tinted row; edits are a
  quiet **Report edited**. Any player with a report added in the last 7 days carries a ✎ after their name on the
  boards and tables (green when the latest is yours; hover for who and when). Non-player updates (imports, staff,
  PINE) form a General group per day. Filter by player, Reports only, who, and backups (hidden by default).
- **Staff** (`#/staff`, admins): set each person's sign-in email, add staff, and choose who gets an evaluation
  section and verdict dot on every player (**Evaluations**; someone unticked still shows where they've written).

## Data sources

- **Transfermarkt**: server-side scrape of the public profile page and quick search.
- **Impect Customer API** (`api.impect.com/v5/customerapi`): iterations, squads and players for
  MLS NEXT Pro, USL Championship, USL League One and USL Cup; used for search, import and linking.
- **Impect Scouting short lists** (`api.impect.com/v1/scouting/player-short-lists`): the backend behind
  scouting.impect.com. It isn't part of Impect's documented API, so it could change without notice.
- **Physical data**: `site_data.json` from the player-physical-data site (percentiles within
  league / season / position group). Links open that site's card for the same player.
  Matching (`src/lib/physical.js`): site names are mostly Wyscout short names ("A. Surname"), and a
  row's age is the player's age when the data was exported (the same in every season). A row links
  automatically when the name matches (initial + surname, full name, a longer site surname such as
  "McNeil LeFlore", the first of two Spanish surnames, or a one-letter spelling difference) and the age
  agrees within a year, with the club (Transfermarkt club, loan club or Impect squad, via short-name
  aliases) as a second check. Surname-only matches are shown as suggestions to confirm. The server
  re-links every unconfirmed player at startup and every 6 hours; links saved by hand are never changed.

## Layout

```
src/server.js                  Hono app, all /api routes, serves public/
src/db.js                      SQLite schema, staff seed, activity log
src/auth.js                    Password sign-in, one-time setup links, session cookies
src/roles.js                   Positions/roles, Impect list-name -> role hints
src/lib/board.js               Board entries: add, reorder, and keep top-target stars
src/lib/transfermarkt.js       Profile + search scraping
src/lib/tm_match.js            Bulk Transfermarkt matching (confirms by date of birth)
src/lib/impect.js              Impect login, player pool, matching, Scouting short lists
src/lib/impect_kpi.js          Live KPI category percentiles per player; league-season cohorts (disk-backed)
src/lib/disk_cache.js          Keeps Impect downloads on disk across restarts
src/lib/impect_categories.js   KPI category definitions (generated from the metric-stability study)
src/lib/impect_display.js      How the KPI profile names, groups and explains those categories
src/lib/card_options.js        Which player card seasons and positions can be requested
src/lib/cards.js               Player card jobs for the worker, and where the PDFs and PNGs are saved
src/lib/maps.js                Pitch map jobs for the worker; checks, trims and stores their exports
src/lib/physical.js            Physical data loading + matching
src/lib/backup.js              Daily database snapshots + download
public/                        index.html, app.js (no build step), styles.css
scripts/check.mjs              npm run check: syntax-check every file
scripts/pull-backup.sh         Pull a database snapshot to a Mac (daily via com.pine.backup.plist)
data/pine.db                   The local database (never committed)
```

## Hosting (Railway, live)

Deployed on Railway with sign-in on (email + password, set up through links from the Staff page) and no shared site
password. The live address is kept out of this repo.

- Railway project `pine`, service `pine`, environment `production`. This folder is linked, so the Railway CLI works from `~/pine`.
- The database lives on the `pine-volume` disk mounted at `/app/data` (500 MB). Deploys never touch it.
- Player card PDFs and their PNGs live on the same disk under `/app/data/cards/<player id>/`, one pair per
  version, never overwritten or deleted. They are not in the database snapshots; the Mac mini worker keeps its own copy of
  every card it renders.
- Pitch map exports live under `/app/data/maps/<player id>/` (gzipped JSON, tens of KB each), only the latest
  per player, season and position. They are not in the snapshots either; any view can be rebuilt.
- Settings (Impect login, passwords, `APP_URL`) are Railway variables; the local `.env` is not uploaded.
- Deploys are automatic: Railway is connected to this repo, so a push to `main` builds and releases.
  GitHub Actions runs `npm run check` and `npm test` on every push and pull request. Manual override:
  `npx @railway/cli up --detach`. **Check a push actually landed** (`git ls-remote origin refs/heads/main`):
  committing on a feature branch leaves `main` untouched and nothing deploys.
- Startup logs: `npx @railway/cli service logs --deployment --lines 50`
- Change a setting: `npx @railway/cli variable set KEY=value`
- Custom domain later: `npx @railway/cli domain pine.example.com` prints the DNS record to add.
- `data/pine.db` on this Mac is the pre-move copy; Railway is the source of truth.
- `seed/` let the first deploy copy the local database onto the disk; it only runs when the disk has no database.

## Temporary public link from this Mac (retired)

Before Railway, PINE was shared through a free Cloudflare quick tunnel pointing at this Mac. It only worked while
the Mac was awake and both processes were running, and the address changed every time the tunnel restarted.

```bash
cd ~/pine && npm start        # terminal 1: the app
cd ~/pine && npm run tunnel   # terminal 2: prints the https://….trycloudflare.com link
```

To stop both: `lsof -ti tcp:8787 | xargs kill; pkill -f "bin/cloudflared tunnel"`.

## Automatic match preparation

The match-prep reader calls `GET /api/worker/scouting-context` with the existing
`X-PINE-Worker-Token`. The response contains player identities, Big Board roles,
the Short Board flag for each role, and list membership, with a check time.
Staff notes, verdicts, decisions, board ranks, and account data are excluded.
The endpoint only reads the database and sends `Cache-Control: no-store`.
