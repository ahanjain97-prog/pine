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

PINE is invite-only. An administrator sends an email invitation from the Staff page, Clerk verifies the
person's email and signs them in, and PINE records their work under their name and email.

## Configuration (`.env`, never committed)

| Variable | Purpose |
|---|---|
| `IMPECT_USERNAME`, `IMPECT_PASSWORD` | Impect account used for the Customer API and Scouting short lists |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk instance keys; use development keys locally and production keys on Railway |
| `CLERK_AUTHORIZED_PARTIES` | Optional comma-separated trusted origins; defaults to `APP_URL` |
| `PINE_ADMIN_EMAIL` | Bootstrap/fallback administrator email; an existing user's admin setting remains authoritative |
| `APP_URL` | Public application URL, also used as Clerk's trusted origin |
| `PORT` | Default 8787 |
| `PINE_DB` | SQLite file, default `data/pine.db` |
| `PHYS_DATA_URL` | Physical data JSON, default the player-physical-data site |
| `PINE_BACKUP_TOKEN` | Long random bearer token used only by the unattended backup download script |

## Clerk setup

1. Create a Clerk application and set **Access mode** to **Invite-only**.
2. Enable email verification codes or email links, require first and last name during sign-up, and disable
   user-managed email changes.
3. Set Clerk's home and fallback redirect URL to the PINE `APP_URL`; add and verify the production domain.
4. Add the development keys to `.env`; add the production keys, `APP_URL`, and `PINE_ADMIN_EMAIL` to Railway.
5. Send the initial `PINE_ADMIN_EMAIL` invitation once from the Clerk dashboard. Further invitations happen in PINE.
6. Before the first production deploy, use the old Staff page to put the exact invited email on every
   existing staff row. First login then connects Clerk to that row without changing its PINE id or history.

The first user whose verified email matches `PINE_ADMIN_EMAIL` receives admin access. Later invitations,
deactivation, and admin changes happen from PINE's Staff page.

## What's where

- **Big Board** (`#/board`): pitch layout of all 11 positions and 25 roles from the depth chart. Drag cards
  to rank within a role or move between roles; drag to "Not on the board" to take a player off. Card stripe
  = club decision, dots = the six staff verdicts.
- **Database** (`#/players`): sortable and filterable table of everyone, with CSV export.
- **Player page**: Transfermarkt info (sync button), club decision, staff verdict summary, board roles
  (with up/down ranking), shared summary, one evaluation section per staff member (only you can write
  in yours), physical percentiles, Impect link, lists, and history.
- **Add player**: paste a Transfermarkt link (or paste one anywhere on the page). Physical data and
  Impect are matched automatically by name + date of birth / club.
- **Impect** (`#/impect`): import or sync Impect Scouting short lists (each list maps to a board role;
  centre-back lists split LCB/RCB by foot), or browse every player in our Impect competitions.
- **Staff** (`#/staff`, admins): invite staff, resend or revoke invitations, deactivate access and manage admins.

## Data sources

- **Transfermarkt**: server-side scrape of the public profile page and quick search.
- **Impect Customer API** (`api.impect.com/v5/customerapi`): iterations, squads and players for
  MLS NEXT Pro, USL Championship, USL League One and USL Cup; used for search, import and linking.
- **Impect Scouting short lists** (`api.impect.com/v1/scouting/player-short-lists`): the backend behind
  scouting.impect.com. It isn't part of Impect's documented API, so it could change without notice.
- **Physical data**: `site_data.json` from the player-physical-data site (percentiles within
  league / season / position group). Links open that site's card for the same player.

## Layout

```
src/server.js                  Hono app, all /api routes, serves public/
src/db.js                      SQLite schema, staff seed, activity log
src/auth.js                    Clerk sessions, invitations and local-user linking
src/roles.js                   Positions/roles, Impect list-name -> role hints
src/lib/transfermarkt.js       Profile + search scraping
src/lib/tm_match.js            Bulk Transfermarkt matching (confirms by date of birth)
src/lib/impect.js              Impect login, player pool, matching, Scouting short lists
src/lib/impect_kpi.js          Live KPI category percentiles per player
src/lib/impect_categories.js   KPI category definitions (generated from the metric-stability study)
src/lib/physical.js            Physical data loading + matching
src/lib/backup.js              Daily database snapshots + download
public/                        index.html, app.js (no build step), styles.css
scripts/check.mjs              npm run check: syntax-check every file
scripts/pull-backup.sh         Pull a database snapshot to a Mac (daily via com.pine.backup.plist)
data/pine.db                   The local database (never committed)
```

## Hosting (Railway, live)

Deployed on Railway with invite-only Clerk authentication. The live address is kept out of this repo.

- Railway project `pine`, service `pine`, environment `production`. This folder is linked, so the Railway CLI works from `~/pine`.
- The database lives on the `pine-volume` disk mounted at `/app/data` (500 MB). Deploys never touch it.
- Settings (Impect login, passwords, `APP_URL`) are Railway variables; the local `.env` is not uploaded.
- Deploy code changes: `cd ~/pine && npx @railway/cli up --detach`
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
