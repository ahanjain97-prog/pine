# Contributing to PINE

PINE is the recruitment database and big board for Portland Hearts of Pine: a small Node server
(Hono + the built-in `node:sqlite`) and a no-build vanilla JS front end. See the README for what
each file does.

## Get it running

Needs Node 22.13 or newer.

```bash
git clone https://github.com/ahanjain97-prog/pine.git
cd pine
npm install
cp .env.example .env
npm start            # http://localhost:8787
```

That's enough to work on almost everything. A fresh local database is created on first start with
the six staff members, and `PINE_AUTH=off` in `.env.example` means there is no sign-in: pick a name
from the menu in the top bar. Add players by pasting any Transfermarkt link.

Impect features (short lists, KPI profiles, player linking) need Impect credentials in `.env`. Without
them those panels say Impect isn't configured; everything else works.

## Making a change

1. Branch from `main` and keep each pull request to one change.
2. Run `npm run check` (syntax-checks every server and browser file).
3. Try it in the browser. For anything visual, check a desktop width and a phone width (about
   400 px), in both light and dark mode.
4. Open a pull request saying what changed and why. Add screenshots for UI changes.

Match the code around you: plain JavaScript, no build step, no framework. Please ask before adding a
dependency.

## Ground rules (this repo is public)

- **Never commit** `.env`, anything in `data/`, or any database file (`*.db`, `*.sqlite`). `.gitignore`
  covers these; double-check `git status` before you commit.
- **No real club data** in code, issues, pull requests or screenshots: no staff notes, verdicts,
  club decisions or board rankings. Use made-up players or public Transfermarkt info.
- **No live addresses or passwords** in issues or pull requests.
- **Transfermarkt:** be polite. No tight request loops; space requests out and cache results.
- **Impect Scouting short lists** come from an undocumented backend that can change without notice.
  Code that uses it should fail with a clear message rather than break the page.

## How deploys work

Merging into `main` does **not** deploy by itself. A deploy uploads a checkout of `main` to Railway with
`npx @railway/cli up`, run either by a maintainer or by anyone holding a Railway project token
(`RAILWAY_TOKEN=… npx @railway/cli up --service pine`). The live database sits on a Railway volume and is
never replaced by a deploy. A deploy restarts the app, so avoid deploying while a Transfermarkt bulk match
is running.

## Access

Anyone can fork the repo and open a pull request. If you're on staff and want to push branches
directly, ask Ahan to add you as a collaborator.
