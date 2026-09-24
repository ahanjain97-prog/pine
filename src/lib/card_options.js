// Which player cards can be made for a player: league seasons (never the cup) in our three leagues,
// and in each, the card positions with at least one match share. The card worker renders the PDF;
// PINE only decides what may be requested.

import { impectGet, iterations as impectIterations, getImpectPlayer } from "./impect.js";
import { BENCHMARK_LEAGUES, mapLimit } from "./impect_kpi.js";

const TTL_MS = 12 * 60 * 60 * 1000;
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

/* ---------- match shares for every player in one iteration ---------- */
const indexes = new Map(); // iterationId -> { data } | { promise }

async function buildIndex(iterationId) {
  const index = new Map();
  const squads = await impectGet(`/v5/customerapi/iterations/${iterationId}/squads`);
  // player-scores rows carry position and matchShare and are a quarter the size of player-kpis.
  await mapLimit(squads, 4, async (s) =>
    addShares(index, await impectGet(`/v5/customerapi/iterations/${iterationId}/squads/${s.id}/player-scores`, { store: false })));
  return { at: Date.now(), index };
}

async function sharesIndex(iterationId) {
  const hit = indexes.get(iterationId);
  if (hit?.data && Date.now() - hit.data.at < TTL_MS) return hit.data.index;
  if (hit?.promise) return hit.promise;
  const promise = buildIndex(iterationId)
    .then((data) => {
      indexes.set(iterationId, { data });
      return data.index;
    })
    .catch((e) => {
      indexes.delete(iterationId);
      throw e;
    });
  indexes.set(iterationId, { promise });
  return promise;
}

export async function playerCardOptions(impectId) {
  const id = Number(impectId);
  const [player, its] = await Promise.all([getImpectPlayer(id), impectIterations()]);
  const byId = new Map(its.map((i) => [i.id, i]));
  const mine = (player?.iterations || []).map((i) => byId.get(i.id) || i).filter(cardSeason);
  const found = await mapLimit(mine, 2, (i) => sharesIndex(i.id));
  return cardOptions(mine, new Map(mine.map((i, n) => [i.id, found[n].get(id)])));
}
