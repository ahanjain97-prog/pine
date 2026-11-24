// Links every player on the Options tab to Impect, in PINE or not, and works out the two tags staff filter on:
// good minutes (this season's league minutes) and good data (his KPI profile: the average percentile of his
// position's categories against the pooled USL Championship / League One / Next Pro benchmark, the same scoring
// as the player page). Results live in roster_decision_impect, keyed like the decisions, so a new upload keeps
// them; it runs after each upload and twice a day, in the background, a player at a time.
import { clubsAgree } from "./free_agents.js";
import { matchName, nameIndex } from "./ncaa.js";
import { BENCHMARK_LEAGUES } from "./impect_kpi.js";

export const GOOD_MINUTES = 1000;   // league minutes this season
export const GOOD_DATA = 60;        // average category percentile at his main position
const COMPETITION = { USLC: "USL Championship", USL1: "USL League One", MLSNP: "MLS Next Pro" };
const bare = (s) => String(s || "").replace(/,?\s+(jr|sr|ii|iii|iv)\.?\s*$/i, "").trim();
const inSeason = (it, season) => String(it.season || "").includes(String(season));

export const enrichState = { running: false, last_run: null, matched: 0, scored: 0, total: 0, error: null };

// The Impect player for one decision: his PINE profile's link when he has one; otherwise a name match among the
// players of that league this season (falling back to anyone whose current squad agrees with the club).
const indexOf = (list) => nameIndex(list.map((p) => ({ id: p.impect_id, name: bare(p.name) })));
export function findImpect(d, pool, linked) {
  if (linked) return pool.byId.get(linked) || null;
  const name = bare(d.name);
  const comp = COMPETITION[d.league];
  if (comp && pool.bySeasonComp.has(comp)) {
    pool.indexes ||= new Map();
    if (!pool.indexes.has(comp)) pool.indexes.set(comp, indexOf(pool.bySeasonComp.get(comp)));
    const m = matchName(pool.indexes.get(comp), name);
    if (m) return pool.byId.get(m.id) || null;
  }
  const m = matchName(indexOf(pool.players.filter((p) => clubsAgree(d.club, p.squad))), name);
  return m ? pool.byId.get(m.id) || null : null;
}

// His league season to score: the decision's own league this season, else any benchmark league this season.
export function scoringIteration(player, league, season) {
  const its = (player?.iterations || []).filter((i) => inSeason(i, season) && BENCHMARK_LEAGUES.includes(i.competition));
  return its.find((i) => i.competition === COMPETITION[league]) || its[its.length - 1] || null;
}

// The tags' numbers from a KPI card (src/lib/impect_kpi.js playerKpiCard).
export function summarizeCard(card) {
  if (!card || card.empty) return null;
  const minutes = (card.positions || []).reduce((s, p) => s + (p.minutes || 0), 0);
  const pct = (card.categories || []).filter((c) => !c.composite && Number.isFinite(c.percentile)).map((c) => c.percentile);
  return { minutes, group: card.position, data_pct: pct.length ? Math.round(pct.reduce((a, b) => a + b, 0) / pct.length) : null,
    iteration_id: card.iteration?.id ?? null, competition: card.iteration?.competition ?? null, squad: card.squad ?? null };
}

const yieldNow = () => new Promise((r) => setImmediate(r));

// One pass over the latest season's decisions. Injected Impect calls keep it testable offline.
export async function enrichOptions(db, { playerPool, playerKpiCard, season = null } = {}) {
  if (enrichState.running) return enrichState;
  enrichState.running = true;
  enrichState.error = null;
  try {
    season ??= db.get("SELECT max(season) AS s FROM roster_decisions").s;
    if (!season) return enrichState;
    const raw = await playerPool();
    const players = raw.players || [];
    const byId = new Map(players.map((p) => [p.impect_id, p]));
    const bySeasonComp = new Map();
    for (const p of players) for (const it of p.iterations || []) {
      if (!inSeason(it, season)) continue;
      if (!bySeasonComp.has(it.competition)) bySeasonComp.set(it.competition, new Map());
      bySeasonComp.get(it.competition).set(p.impect_id, p); // once per player, however many iterations
    }
    for (const [c, m] of bySeasonComp) bySeasonComp.set(c, [...m.values()]);
    const pool = { players, byId, bySeasonComp };
    const rows = db.all(`SELECT DISTINCT d.club, d.name, d.league, p.impect_id AS linked FROM roster_decisions d
      LEFT JOIN players p ON p.id = d.player_id WHERE d.season = ?`, season);
    let matched = 0, scored = 0;
    for (const d of rows) {
      const ip = findImpect(d, pool, d.linked);
      let s = null;
      const it = ip && scoringIteration(ip, d.league, season);
      if (it) {
        try { s = summarizeCard(await playerKpiCard(ip.impect_id, { iterationId: it.id })); } catch { s = null; }
      }
      if (ip) matched++;
      if (s?.data_pct != null || s?.minutes) scored++;
      db.run(`INSERT INTO roster_decision_impect(season, club, name, impect_id, impect_name, impect_squad, impect_competition, iteration_id,
          minutes, position_group, data_pct, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(season, club, name) DO UPDATE SET impect_id = excluded.impect_id, impect_name = excluded.impect_name,
          impect_squad = excluded.impect_squad, impect_competition = excluded.impect_competition, iteration_id = excluded.iteration_id,
          minutes = excluded.minutes, position_group = excluded.position_group, data_pct = excluded.data_pct, checked_at = excluded.checked_at`,
        season, d.club, d.name, ip?.impect_id ?? null, ip?.name ?? null, s?.squad ?? ip?.squad ?? null, s?.competition ?? ip?.competition ?? null,
        s?.iteration_id ?? null, s?.minutes ?? null, s?.group ?? null, s?.data_pct ?? null);
      await yieldNow(); // a player at a time, so PINE stays responsive
    }
    Object.assign(enrichState, { last_run: new Date().toISOString(), matched, scored, total: rows.length });
    return enrichState;
  } catch (e) {
    enrichState.error = String(e.message || e).slice(0, 200);
    return enrichState;
  } finally { enrichState.running = false; }
}
