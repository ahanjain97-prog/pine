// Which player cards can be made for a player: league seasons (never the cup) in our three leagues,
// and in each, the card positions with at least one match share. The card worker renders the PDF;
// PINE only decides what may be requested.

import { impectGet, iterations as impectIterations } from "./impect.js";
import { BENCHMARK_LEAGUES, mapLimit } from "./impect_kpi.js";

export const MIN_CARD_SHARE = 1;

// Card positions in pitch order (also the tie-break order).
export const CARD_POSITIONS = {
  CB: "Centre-Back", LB: "Left-Back", RB: "Right-Back", DM: "Defensive Mid", CM: "Central Mid",
  AM: "Attacking Mid", LW: "Left Winger", RW: "Right Winger", CF: "Centre-Forward",
};
// Impect position -> card position. Goalkeepers have no card.
const CARD_CODE = {
  CENTRAL_DEFENDER: "CB", LEFT_WINGBACK_DEFENDER: "LB", RIGHT_WINGBACK_DEFENDER: "RB",
  DEFENSE_MIDFIELD: "DM", CENTRAL_MIDFIELD: "CM", ATTACKING_MIDFIELD: "AM", OFFENSIVE_MIDFIELD: "AM",
  LEFT_WINGER: "LW", RIGHT_WINGER: "RW", CENTER_FORWARD: "CF",
};
const ORDER = Object.keys(CARD_POSITIONS);

const cardSeason = (it) => it.type !== "Cup" && BENCHMARK_LEAGUES.includes(it.competition);
const round = (v) => Math.round(v * 100) / 100;

// Folds Impect player rows ({ playerId, position, matchShare }) into playerId -> card position -> match share.
export function addShares(index, rows) {
  for (const r of rows) {
    const code = CARD_CODE[r.position];
    if (!code) continue;
    const mine = index.get(r.playerId) || new Map();
    mine.set(code, (mine.get(code) || 0) + (Number(r.matchShare) || 0));
    index.set(r.playerId, mine);
  }
  return index;
}

// iterations: the player's Impect iterations ({ id, competition, season, type });
// shares: iteration id -> Map(card position -> match share) for this player.
export function cardOptions(iterations, shares) {
  const seasons = iterations
    .filter(cardSeason)
    .map((it) => ({
      iteration_id: it.id,
      competition: it.competition,
      season: String(it.season),
      positions: [...(shares.get(it.id) || new Map())]
        .filter(([, share]) => share >= MIN_CARD_SHARE)
        .sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
        .map(([code, share]) => ({ code, label: CARD_POSITIONS[code], match_share: round(share) })),
    }))
    .filter((s) => s.positions.length)
    .sort((a, b) => b.season.localeCompare(a.season) || b.positions[0].match_share - a.positions[0].match_share);
  const top = seasons[0];
  return { seasons, default: top ? { iteration_id: top.iteration_id, position: top.positions[0].code } : null };
}

/* ---------- match shares for every player in one iteration, stored in SQLite ---------- */
// A closed season (older than the newest card season) is fetched once and kept. The current season is
// rebuilt when its build is over 12 hours old, in the background: requests are served from the stored
// rows meanwhile. Only a season that has never been built makes a request wait.
const building = new WeakMap(); // db -> Map(iteration id -> promise of the build in flight)

async function fetchShares(iterationId) {
  const index = new Map();
  const squads = await impectGet(`/v5/customerapi/iterations/${iterationId}/squads`);
  // player-scores rows carry position and matchShare and are a quarter the size of player-kpis.
  await mapLimit(squads, 4, async (s) =>
    addShares(index, await impectGet(`/v5/customerapi/iterations/${iterationId}/squads/${s.id}/player-scores`, { store: false })));
  return index;
}

function saveShares(db, iterationId, index) {
  db.tx(() => {
    db.run("DELETE FROM card_shares WHERE iteration_id = ?", iterationId);
    for (const [playerId, shares] of index) {
      for (const [position, share] of shares) {
        db.run("INSERT INTO card_shares(iteration_id, impect_id, position, match_share) VALUES (?,?,?,?)", iterationId, playerId, position, share);
      }
    }
    db.run("INSERT INTO card_share_builds(iteration_id, built_at) VALUES (?, datetime('now')) ON CONFLICT(iteration_id) DO UPDATE SET built_at = excluded.built_at", iterationId);
  });
}

const inFlightFor = (db) => building.get(db) || building.set(db, new Map()).get(db);

// Concurrent callers share one build per iteration.
function build(db, iterationId) {
  const inFlight = inFlightFor(db);
  if (!inFlight.has(iterationId)) {
    inFlight.set(iterationId, fetchShares(iterationId)
      .then((index) => saveShares(db, iterationId, index))
      .finally(() => inFlight.delete(iterationId)));
  }
  return inFlight.get(iterationId);
}

// null = never built; "fresh" = nothing to do; "stale" = a current season due for a rebuild.
function buildState(db, it, newest) {
  const row = db.get("SELECT built_at > datetime('now', '-12 hours') AS fresh FROM card_share_builds WHERE iteration_id = ?", it.id);
  if (!row) return null;
  const closed = String(it.season) < newest;
  return closed || row.fresh ? "fresh" : "stale";
}

async function cardIterations() {
  const its = (await impectIterations()).filter(cardSeason);
  return { its, newest: its.reduce((m, it) => (String(it.season) > m ? String(it.season) : m), "") };
}

function refreshInBackground(db, it) {
  if (inFlightFor(db).has(it.id)) return;
  build(db, it.id).catch((e) => console.warn(`card seasons: rebuilding iteration ${it.id} failed: ${e.message}`));
}

// Builds every card season that has never been built and rebuilds stale current ones, one at a time.
// Run at startup; a failure is logged and the pass moves on.
export async function warmCardShares(db) {
  const { its, newest } = await cardIterations();
  const done = { built: 0, refreshed: 0, failed: 0 };
  for (const it of its) {
    const state = buildState(db, it, newest);
    if (state === "fresh") continue;
    try {
      await build(db, it.id);
      done[state ? "refreshed" : "built"]++;
    } catch (e) {
      done.failed++;
      console.warn(`card seasons: building iteration ${it.id} failed: ${e.message}`);
    }
  }
  return done;
}

export async function playerCardOptions(db, impectId) {
  const { its, newest } = await cardIterations();
  const missing = [];
  for (const it of its) {
    const state = buildState(db, it, newest);
    if (!state) missing.push(it);
    else if (state === "stale") refreshInBackground(db, it);
  }
  await mapLimit(missing, 2, (it) => build(db, it.id));

  const shares = new Map();
  for (const r of db.all("SELECT iteration_id, position, match_share FROM card_shares WHERE impect_id = ?", Number(impectId))) {
    const mine = shares.get(r.iteration_id) || new Map();
    mine.set(r.position, r.match_share);
    shares.set(r.iteration_id, mine);
  }
  return cardOptions(its.filter((it) => shares.has(it.id)), shares);
}
