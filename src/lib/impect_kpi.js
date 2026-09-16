// Live Impect KPI category profiles.
//
// Reimplements impect_metric_stability/build_position_clusters.py + player_percentiles.py against the
// live Customer API: match-share-weighted season values per player and position group, 1%-winsorized
// z-scores within the iteration x position cohort, direction flipped for inverted metrics, equal-weight
// category means needing at least half their components, and average-rank percentiles among peers above
// a match-share floor. Verified to reproduce the study's saved cards exactly.

import { impectGet, iterations as impectIterations, getImpectPlayer } from "./impect.js";
import { CATEGORIES, POSITION_MAP, POSITION_LABEL, MIN_MATCH_SHARE, ALL_METRICS } from "./impect_categories.js";

const TTL_MS = 12 * 60 * 60 * 1000;
const METRICS = new Set(ALL_METRICS);

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
      label: d.details?.label || d.name,
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

/* ---------- statistics (match pandas' behaviour) ---------- */
const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

function winsorizedZ(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length < 8 || new Set(valid).size < 3) return values.map(() => null);
  const sorted = [...valid].sort((a, b) => a - b);
  const lo = quantile(sorted, 0.01);
  const hi = quantile(sorted, 0.99);
  const clipped = values.map((v) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : null));
  const present = clipped.filter((v) => v !== null);
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  const sd = Math.sqrt(present.reduce((a, b) => a + (b - mean) ** 2, 0) / (present.length - 1));
  if (!Number.isFinite(sd) || sd === 0) return values.map(() => null);
  return clipped.map((v) => (v === null ? null : (v - mean) / sd));
}

// Average-rank percentile (pandas rank(method="average", pct=True) * 100); nulls stay null.
function rankPct(values) {
  const ordered = values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = values.map(() => null);
  const n = ordered.length;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && ordered[j + 1][0] === ordered[i][0]) j++;
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) out[ordered[k][1]] = (avgRank / n) * 100;
    i = j + 1;
  }
  return out;
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
    impectGet(`/v5/customerapi/iterations/${iterationId}/squads/${squad.id}/player-kpis`),
    impectGet(`/v5/customerapi/iterations/${iterationId}/squads/${squad.id}/player-scores`),
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
        p = { playerId: r.playerId, group, matchShare: 0, playDuration: 0, squadShares: new Map(), sums: new Map(), weights: new Map() };
        byKey.set(key, p);
      }
      p.matchShare += r.matchShare;
      p.playDuration += r.playDuration;
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

  // Category scores, computed across everyone in the iteration and position (no minutes floor here).
  for (const [group, list] of byGroup) {
    const cats = CATEGORIES[group];
    if (!cats) continue;
    const zByMetric = {};
    for (const m of new Set(Object.values(cats).flat())) {
      const sign = defs.meta.get(m)?.inverted ? -1 : 1;
      const z = winsorizedZ(list.map((p) => (Number.isFinite(p.values[m]) ? p.values[m] : null)));
      zByMetric[m] = z.map((v) => (v === null ? null : v * sign));
    }
    list.forEach((p, i) => {
      p.categories = {};
      for (const [cat, mets] of Object.entries(cats)) {
        const vals = mets.map((m) => zByMetric[m][i]).filter((v) => v !== null);
        p.categories[cat] = vals.length >= Math.ceil(mets.length / 2) ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      }
    });
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
export async function playerKpiCard(impectId, { iterationId = null, minShare = MIN_MATCH_SHARE } = {}) {
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
    let row = null;
    for (const list of co.byGroup.values()) {
      for (const p of list) if (p.playerId === id && (!row || p.matchShare > row.matchShare)) row = p;
    }
    if (!row) continue;

    const floor = Math.min(Number(minShare) || MIN_MATCH_SHARE, row.matchShare);
    const peers = co.byGroup.get(row.group).filter((p) => p.matchShare >= floor);
    const me = peers.findIndex((p) => p.playerId === id);
    const cats = CATEGORIES[row.group] || {};
    const categories = Object.entries(cats).map(([name, mets]) => {
      const pct = rankPct(peers.map((p) => p.categories?.[name] ?? null));
      return {
        name,
        score: round(row.categories?.[name], 3),
        percentile: round(pct[me], 1),
        components: mets.map((m) => {
          const meta = defs.meta.get(m) || {};
          const sign = meta.inverted ? -1 : 1;
          const mp = rankPct(peers.map((p) => (Number.isFinite(p.values[m]) ? p.values[m] * sign : null)));
          return {
            metric: m,
            label: meta.label || m,
            definition: meta.definition,
            inverted: Boolean(meta.inverted),
            value: round(row.values[m], 3),
            percentile: round(mp[me], 1),
          };
        }),
      };
    });

    return {
      iteration: { id: it.id, competition: it.competition, season: it.season },
      available_iterations: available,
      position: row.group,
      position_label: POSITION_LABEL[row.group] || row.group,
      squad: row.squad,
      match_share: round(row.matchShare),
      minutes: Math.round(row.playDuration / 60),
      peer_count: peers.length,
      min_share_used: round(floor),
      min_share_default: MIN_MATCH_SHARE,
      cohort_built_at: new Date(co.at).toISOString(),
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
