// Live Impect KPI category profiles.
//
// Match-share-weighted season values, pooled same-season positional references and a secondary
// league reference. Both normalization and ranking use qualified players; low-sample targets
// retain raw values but receive no percentiles. Scoring lives in impect_benchmark.js.

import { impectGet, iterations as impectIterations, getImpectPlayer } from "./impect.js";
import { CATEGORIES, POSITION_MAP, POSITION_LABEL, MIN_MATCH_SHARE, ALL_METRICS } from "./impect_categories.js";
import { benchmark, fixedFloor } from "./impect_benchmark.js";

const BENCHMARK_LEAGUES = ["USL Championship", "MLS Next Pro", "USL League One"];

const TTL_MS = 12 * 60 * 60 * 1000;
const METRICS = new Set(ALL_METRICS);
// Every pXT KPI is a change in the team's goal threat per match, but Impect's labels ("Progressive
// passes", "Receiving") read like counts, which is confusing next to real counts such as bypassed
// opponents. PXT_PASS_FAIL is stored as a negative number, so higher (nearer zero) is better.
export const DISPLAY_OVERRIDES = {
  kpi__PXT_DRIBBLE: "Dribble goal threat (pXT)",
  kpi__PXT_DRIBBLE_PRO: "Progressive dribble goal threat (pXT)",
  kpi__PXT_PASS_PRO: "Progressive pass goal threat (pXT)",
  kpi__PXT_PASS_FAIL: "Goal threat lost to failed passes (pXT)",
  kpi__PXT_SETPIECE_PRO: "Set-piece goal threat (pXT)",
  kpi__PXT_REC: "Receiving goal threat (pXT)",
  kpi__PXT_DEFEND: "Defensive goal-threat swing (pXT)",
};

/* ---------- metric definitions (labels, meanings, direction) ---------- */
let defsCache = null;
async function definitions() {
  if (defsCache && Date.now() - defsCache.at < TTL_MS) return defsCache;
  const [kpis, scores] = await Promise.all([
    impectGet("/v5/customerapi/kpis"),
    impectGet("/v5/customerapi/player-scores"),
  ]);
  const meta = new Map();
  const kpiById = new Map();
  const scoreById = new Map();
  const add = (metric, d, index, id) => {
    if (!METRICS.has(metric)) return;
    index.set(id, metric);
    meta.set(metric, {
      label: DISPLAY_OVERRIDES[metric] || d.details?.label || d.name,
      definition: d.details?.definition || null,
      meaning: d.details?.meaning || null,
      inverted: Boolean(d.inverted),
    });
  };
  for (const d of kpis) add(`kpi__${d.name}`, d, kpiById, d.id);
  for (const d of scores) add(`score__${d.name}`, d, scoreById, d.id);
  defsCache = { at: Date.now(), meta, kpiById, scoreById };
  return defsCache;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/* ---------- cohort: every player in one competition season ---------- */
const cohorts = new Map(); // iterationId -> { at, data } | { promise }

async function fetchSquad(iterationId, squad, defs) {
  const [kpiRows, scoreRows] = await Promise.all([
    // Raw rows carry every Impect KPI; only the reduced cohort is cached (raw caching exhausted the heap).
    impectGet(`/v5/customerapi/iterations/${iterationId}/squads/${squad.id}/player-kpis`, { store: false }),
    impectGet(`/v5/customerapi/iterations/${iterationId}/squads/${squad.id}/player-scores`, { store: false }),
  ]);
  const scoreByKey = new Map(scoreRows.map((r) => [`${r.playerId}|${r.position}`, r]));
  return kpiRows.map((r) => {
    const metrics = {};
    for (const { kpiId, value } of r.kpis || []) {
      const m = defs.kpiById.get(kpiId);
      if (m) metrics[m] = value;
    }
    for (const { playerScoreId, value } of scoreByKey.get(`${r.playerId}|${r.position}`)?.playerScores || []) {
      const m = defs.scoreById.get(playerScoreId);
      if (m) metrics[m] = value;
    }
    return {
      playerId: r.playerId,
      position: r.position,
      squadName: squad.name,
      matchShare: Number(r.matchShare) || 0,
      playDuration: Number(r.playDuration) || 0,
      metrics,
    };
  });
}

async function buildCohort(iterationId) {
  const defs = await definitions();
  const squads = await impectGet(`/v5/customerapi/iterations/${iterationId}/squads`);
  const perSquad = await mapLimit(squads, 4, (s) => fetchSquad(iterationId, s, defs));

  // Season totals per player and broad position: match-share-weighted means, per-metric denominators.
  const byKey = new Map();
  for (const rows of perSquad) {
    for (const r of rows) {
      const group = POSITION_MAP[r.position];
      if (!group) continue;
      const key = `${r.playerId}|${group}`;
      let p = byKey.get(key);
      if (!p) {
        p = { playerId: r.playerId, group, matchShare: 0, playDuration: 0, exact: {}, squadShares: new Map(), sums: new Map(), weights: new Map() };
        byKey.set(key, p);
      }
      p.matchShare += r.matchShare;
      p.playDuration += r.playDuration;
      p.exact[r.position] = (p.exact[r.position] || 0) + r.matchShare;
      p.squadShares.set(r.squadName, (p.squadShares.get(r.squadName) || 0) + r.matchShare);
      for (const [m, v] of Object.entries(r.metrics)) {
        if (!Number.isFinite(v)) continue;
        p.sums.set(m, (p.sums.get(m) || 0) + v * r.matchShare);
        p.weights.set(m, (p.weights.get(m) || 0) + r.matchShare);
      }
    }
  }

  const byGroup = new Map();
  for (const p of byKey.values()) {
    p.values = {};
    for (const [m, sum] of p.sums) {
      const w = p.weights.get(m);
      p.values[m] = w > 0 ? sum / w : null;
    }
    p.squad = [...p.squadShares.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    delete p.sums;
    delete p.weights;
    delete p.squadShares;
    if (!byGroup.has(p.group)) byGroup.set(p.group, []);
    byGroup.get(p.group).push(p);
  }

  return { at: Date.now(), iterationId, byGroup };
}

async function cohort(iterationId) {
  const hit = cohorts.get(iterationId);
  if (hit?.data && Date.now() - hit.data.at < TTL_MS) return hit.data;
  if (hit?.promise) return hit.promise;
  const promise = buildCohort(iterationId)
    .then((data) => {
      cohorts.set(iterationId, { data });
      return data;
    })
    .catch((e) => {
      cohorts.delete(iterationId);
      throw e;
    });
  cohorts.set(iterationId, { promise });
  return promise;
}

const round = (v, n = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);

/* ---------- one player's card ---------- */
export async function playerKpiCard(impectId, { iterationId = null, minShare = MIN_MATCH_SHARE, position = null } = {}) {
  const id = Number(impectId);
  const [pool, its, defs] = await Promise.all([getImpectPlayer(id), impectIterations(), definitions()]);
  const byId = new Map(its.map((i) => [i.id, i]));
  const seasons = (pool?.iterations || [])
    .map((i) => ({ ...(byId.get(i.id) || i) }))
    .sort((a, b) => String(b.season).localeCompare(String(a.season)) || (a.type === "Cup" ? 1 : 0) - (b.type === "Cup" ? 1 : 0));
  const available = seasons.map((i) => ({ id: i.id, competition: i.competition, season: i.season, type: i.type || null }));
  const wanted = iterationId ? seasons.filter((i) => i.id === Number(iterationId)) : seasons.filter((i) => i.type !== "Cup");

  for (const it of wanted.slice(0, 3)) {
    const co = await cohort(it.id);
    // Every position group the player logged this season, most-played first; benchmark the chosen one.
    const mine = [...co.byGroup.values()].flatMap((list) => list.filter((p) => p.playerId === id))
      .sort((a, b) => b.matchShare - a.matchShare);
    if (!mine.length) continue;
    const row = mine.find((p) => p.group === String(position || "").toUpperCase()) || mine[0];

    const floor = fixedFloor(minShare, MIN_MATCH_SHARE);
    const cats = CATEGORIES[row.group] || {};
    const refs = BENCHMARK_LEAGUES.map((name) => its.find((i) =>
      i.competition === name && String(i.season) === String(it.season) && i.type !== "Cup"
    )).filter(Boolean);
    // Older seasons may not have all three leagues. Expose actual coverage; do not
    // silently shrink the pool if an available league fails to load.
    if (!refs.some((i) => i.id === it.id)) continue;
    const cohorts = await mapLimit(refs, 2, (i) => cohort(i.id));
    // League-adjusted pooling: tag reference rows with their league so each KPI is standardised
    // within its own league before the three leagues are ranked together.
    const pooledRows = cohorts.flatMap((c) => (c.byGroup.get(row.group) || []).map((p) => ({ ...p, league: c.iterationId })));
    const pooled = benchmark({ ...row, league: it.id }, pooledRows, cats, defs.meta, floor, { byLeague: true });
    const league = benchmark(row, co.byGroup.get(row.group), cats, defs.meta, floor);
    const categories = pooled.categories.map((c, i) => ({
      ...c, percentile: round(c.percentile, 1), score: round(c.score, 3),
      league_percentile: round(league.categories[i].percentile, 1),
      league_peer_count: league.categories[i].peer_count,
      components: c.components.map((m, j) => ({ ...m,
        label: m.label || m.metric, value: round(m.value, 3), percentile: round(m.percentile, 1),
        league_percentile: round(league.categories[i].components[j].percentile, 1),
        league_peer_count: league.categories[i].components[j].peer_count,
      })),
    }));

    return {
      iteration: { id: it.id, competition: it.competition, season: it.season },
      available_iterations: available,
      position: row.group,
      position_label: POSITION_LABEL[row.group] || row.group,
      positions: mine.map((p) => ({
        group: p.group, label: POSITION_LABEL[p.group] || p.group,
        match_share: round(p.matchShare), minutes: Math.round(p.playDuration / 60), eligible: p.matchShare >= floor,
        impect_positions: Object.entries(p.exact || {}).sort((a, b) => b[1] - a[1]).map(([name, s]) => ({ name, match_share: round(s) })),
      })),
      squad: row.squad,
      match_share: round(row.matchShare),
      minutes: Math.round(row.playDuration / 60),
      peer_count: pooled.peers,
      league_peer_count: league.peers,
      eligible: pooled.eligible,
      league_adjusted: pooled.league_adjusted,
      benchmark_competitions: refs.map((i) => i.competition),
      missing_benchmark_competitions: BENCHMARK_LEAGUES.filter((name) => !refs.some((i) => i.competition === name)),
      reference_sources: refs.map((i, n) => ({ competition: i.competition, iteration_id: i.id,
        fetched_at: new Date(cohorts[n].at).toISOString() })),
      min_share_used: round(floor),
      min_share_default: MIN_MATCH_SHARE,
      cohort_built_at: new Date(Math.min(...cohorts.map((c) => c.at))).toISOString(),
      categories,
    };
  }

  return {
    empty: true,
    available_iterations: available,
    reason: available.length
      ? "No Impect minutes in a league season we can rank (cup-only or no recorded position)."
      : "This player has no Impect season data in our competitions.",
  };
}
