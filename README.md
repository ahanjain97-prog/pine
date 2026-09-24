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

Run `npm test` for benchmark and mocked-API regression tests, and `npm run check` for syntax checks.

## Configuration (`.env`, never committed)

| Variable | Purpose |
|---|---|
| `IMPECT_USERNAME`, `IMPECT_PASSWORD` | Impect account used for the Customer API and Scouting short lists |
| `PINE_SITE_PASSWORD` | One shared password in front of the whole site (browser prompt; username can be anything, e.g. `pine`). Redundant once everyone has their own sign-in; delete it then. |
| `PINE_ADMIN_EMAIL` | Email for the seeded admin account, used only when the database is first created. |
| `PINE_AUTH=off` | No sign-in; pick who you are from the name menu in the top bar. For local development. Delete it to require sign-in. |
| `PINE_BACKUP_TOKEN` | Key that `scripts/pull-backup.sh` downloads snapshots with (set the same value on the deployment and in the Mac's `.env`). It opens `/api/backup` only. |
| `PINE_WORKER_TOKEN` | Key the player card worker sends as `X-PINE-Worker-Token` (same value on the deployment and on the worker). It opens `/api/worker/*` only; unset, those routes refuse everything. |
| `APP_URL` | Public URL once hosted. Sign-in links use it, and `https://…` makes the sign-in cookie secure-only. |
| `PORT` | Default 8787 |
| `PINE_DB` | SQLite file, default `data/pine.db` |
| `PHYS_DATA_URL` | Physical data JSON, default the player-physical-data site |

## What's where

- **Big Board** (`#/board`): pitch layout of all 11 positions and 25 roles from the depth chart. Drag cards
  to rank within a role or move between roles; drag to "Not on the board" to take a player off. Card stripe
  = club decision, dots = the six staff verdicts, DOM / INTL = domestic (US citizen, from Transfermarkt citizenship)
  or international. Green cards aren't on Transfermarkt, so a permanent resident shows as INTL.
- **Database** (`#/players`): sortable and filterable table of everyone, with CSV export.
- **Player page**: Transfermarkt info (sync button), club decision, staff verdict summary, board roles
  (with up/down ranking), shared summary, player card, one evaluation section per staff member (only you
  can write in yours), physical percentiles, Impect link, lists, and history.
- **Player card**: a PDF made outside PINE, shown on the player page as a picture that opens the PDF.
  Pick a season (league seasons in our three leagues, never the cup) and a position (any with at least
  one Impect match share that season). Those choices come from every player's match shares per season,
  stored in SQLite (`card_shares`): closed seasons are fetched from Impect once, the current season is
  refreshed in the background every 12 hours, and at startup the server fetches any season it doesn't
  have yet. An admin presses Generate. That queues a job; the card worker on
  the Mac mini claims it (`POST /api/worker/cards/claim`), renders it, uploads a PNG of it
  (`PUT /api/worker/cards/:id/png`, optional) and then the PDF (`PUT /api/worker/cards/:id/pdf`, which
  finishes the job), or reports a failure code (`POST /api/worker/cards/:id/fail`). While it works it can
  post a progress note (`POST /api/worker/cards/:id/progress`, `fetching_events` and a match count), which the
  panel shows under "Generating" so staff know why a card that downloads Impect match data first is slower.
  Every version is kept and any signed-in staff member can open it. One card per player can be in progress, and at most 30 are
  requested across PINE per 24 hours.
- **Add player**: paste a Transfermarkt link (or paste one anywhere on the page). Physical data and
  Impect are matched automatically by name + date of birth / club.
- **Impect** (`#/impect`): import or sync Impect Scouting short lists (each list maps to a board role;
  centre-back lists split LCB/RCB by foot), or browse every player in our Impect competitions.
- **Staff** (`#/staff`, admins): set each person's sign-in email, add staff.

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
src/lib/transfermarkt.js       Profile + search scraping
src/lib/tm_match.js            Bulk Transfermarkt matching (confirms by date of birth)
src/lib/impect.js              Impect login, player pool, matching, Scouting short lists
src/lib/impect_kpi.js          Live KPI category percentiles per player
src/lib/impect_categories.js   KPI category definitions (generated from the metric-stability study)
src/lib/card_options.js        Which player card seasons and positions can be requested
src/lib/cards.js               Player card jobs for the worker, and where the PDFs and PNGs are saved
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
