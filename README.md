# PINE: Player Identification Network Evaluation

Recruitment database and big board for Portland Hearts of Pine. One place for every player we track:
Transfermarkt profile, Impect link, physical data, a comment section for each staff member
(Ray, Ahan, Ford, Bobby, Alex, Yuta), pass / hold / fail verdicts, and a ranked big board by position and role.

## Run it locally

Needs Node 22.13+ (uses the built-in `node:sqlite`).

```bash
cd ~/pine
npm install
npm start            # http://localhost:8787
```

Sign in with a staff email. Until email delivery is set up, the 6-digit code is printed in the terminal
running PINE (and filled in automatically while `PINE_DEV_SHOW_CODE=1`).

## Configuration (`.env`, never committed)

| Variable | Purpose |
|---|---|
| `IMPECT_USERNAME`, `IMPECT_PASSWORD` | Impect account used for the Customer API and Scouting short lists |
| `PINE_SITE_PASSWORD` | One shared password in front of the whole site (browser prompt; username can be anything, e.g. `pine`). Delete the line to remove it. |
| `PINE_ADMIN_EMAIL` | Email for the seeded admin account, used only when the database is first created. |
| `PINE_AUTH=off` | Currently on: no sign-in; pick who you are from the name menu in the top bar. Delete this line to require email sign-in again. |
| `PINE_DEV_SHOW_CODE=1` | Local only: returns the sign-in code to the browser. **Remove before hosting.** |
| `RESEND_API_KEY`, `MAIL_FROM` | Email sign-in codes via [Resend](https://resend.com) instead of printing them |
| `APP_URL` | Public URL once hosted (`https://…` turns on secure cookies) |
| `PORT` | Default 8787 |
| `PINE_DB` | SQLite file, default `data/pine.db` |
| `PHYS_DATA_URL` | Physical data JSON, default the player-physical-data site |

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
- **Staff** (`#/staff`, admins): set each person's sign-in email, add staff.

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
src/server.js            Hono app + all /api routes, serves public/
src/db.js                SQLite schema, staff seed, activity log
src/auth.js              Email one-time codes + session cookies
src/roles.js             Positions/roles, Impect list-name -> role hints
src/lib/transfermarkt.js Profile + search scraping
src/lib/impect.js        Impect login, player pool, matching, Scouting short lists
src/lib/physical.js      Physical data loading + matching
public/                  index.html, app.js (no build step), styles.css
data/pine.db             The database; back this file up
```

## Hosting (Railway, live)

Deployed on Railway behind `PINE_SITE_PASSWORD`, with sign-in off (`PINE_AUTH=off`). The live address is kept out of this repo.

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

## Hosting (not done yet)

The app is a single Node process with a SQLite file, so the lowest-effort hosts are ones with a persistent
disk: Railway, Fly.io or Render (about $5–7/month). Cloudflare Workers + D1 is free but needs the
database layer ported (the `db.js` wrapper keeps that contained). Before going live: remove
`PINE_DEV_SHOW_CODE`, set `APP_URL`, add Resend for sign-in emails, and add each staff member's email.
