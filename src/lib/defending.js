// Defending v2: metrics PINE derives from Impect's for the centre-back, full-back and midfield benchmarks.
//
// Impect's defensive KPIs are counts, and counts mostly measure how much a team defends: a centre-back's
// pressing and interception volumes went with his team conceding MORE. Validated on players who changed
// clubs (impect_metric_stability/evaluate_defending_v2.py, 2022-25, 2026 held out), PINE ranks:
//   - action counts scaled for the team's possession (StatsBomb's sigmoid), so defending a lot doesn't flatter;
//   - duel win rates pulled toward the league average by sample size (beta-binomial pseudo-duels), so 3 of 4
//     doesn't outrank 40 of 60.

// Pseudo-duels at the league rate, fitted per position group from the spread between players (2022-25).
export const SHRINK_K = { CB: { ground: 117, aerial: 43 }, FB: { ground: 79, aerial: 37 }, MID: { ground: 94, aerial: 42 } };

// Multiplier for a team with this share of the ball (0-1): 1 at 50%, more for teams that defend less.
export const padj = (possession) => 2 / (1 + Math.exp(-0.1 * (100 * possession - 50)));

const DUELS = {
  ground: ["kpi__WON_GROUND_DUELS_DEF", "kpi__LOST_GROUND_DUELS_DEF"],
  aerial: ["kpi__WON_AERIAL_DUELS_DEF", "kpi__LOST_AERIAL_DUELS_DEF"],
};
const SCALED = {
  derived__PADJ_BALL_WINS: ["kpi__BALL_WIN_NUMBER"],
  derived__PADJ_INTERCEPTIONS: ["score__INTERCEPTION_SCORE"],
  derived__PADJ_LOOSE_BALL_REGAINS: ["score__LOOSE_BALL_REGAIN_SCORE"],
  derived__PADJ_PRESSES: ["kpi__NUMBER_OF_PRESSES"],
  derived__PADJ_SECOND_BALL_STARTS: ["kpi__SECOND_BALL_START"],
  derived__PADJ_SECOND_BALL_WINS: ["kpi__SECOND_BALL_WIN"],
  derived__PADJ_GROUND_DUELS: DUELS.ground,
  derived__PADJ_AERIAL_DUELS: DUELS.aerial,
};

// Impect metrics the derived ones are built from, fetched whether or not a category shows them.
export const DEFENDING_INPUTS = [...new Set([...Object.values(SCALED).flat(), ...Object.values(DUELS).flat()])];

const ADJ = "Scaled for his team's possession (StatsBomb's adjustment), so a player on a side that defends a lot isn't flattered.";
export const DERIVED_META = {
  derived__PADJ_BALL_WINS: { label: "Ball wins, possession-adjusted", definition: `Ball wins per match. ${ADJ}` },
  derived__PADJ_INTERCEPTIONS: { label: "Interceptions, possession-adjusted", definition: `Impect's interception score. ${ADJ}` },
  derived__PADJ_LOOSE_BALL_REGAINS: { label: "Loose-ball regains, possession-adjusted", definition: `Impect's loose-ball regain score. ${ADJ}` },
  derived__PADJ_PRESSES: { label: "Presses, possession-adjusted", definition: `Presses per match. ${ADJ}` },
  derived__PADJ_SECOND_BALL_STARTS: { label: "Second balls contested, possession-adjusted",
    definition: `Actions that start a second-ball phase (a header into a duel, a block, a contested clearance) per match. ${ADJ}` },
  derived__PADJ_SECOND_BALL_WINS: { label: "Second balls won, possession-adjusted",
    definition: `Loose balls brought under control after a second-ball phase, per match. ${ADJ}` },
  derived__PADJ_GROUND_DUELS: { label: "Defensive ground duels, possession-adjusted", definition: `Defensive ground duels contested per match. ${ADJ}` },
  derived__PADJ_AERIAL_DUELS: { label: "Defensive aerial duels, possession-adjusted", definition: `Defensive aerial duels contested per match. ${ADJ}` },
  derived__GROUND_WIN_SHRUNK: { label: "Defensive ground duel win rate, sample-adjusted (0-1)",
    definition: "Share of defensive ground duels won, pulled toward the league average when he has contested few." },
  derived__AERIAL_WIN_SHRUNK: { label: "Defensive aerial duel win rate, sample-adjusted (0-1)",
    definition: "Share of defensive aerial duels won, pulled toward the league average when he has contested few." },
};

const weighted = (shares, valueOf) => {
  let sum = 0, weight = 0;
  for (const [key, w] of shares) {
    const v = valueOf(key);
    if (Number.isFinite(v) && w > 0) { sum += v * w; weight += w; }
  }
  return weight > 0 ? sum / weight : null;
};

// Adds the derived metrics to one league season's player rows (p.values, p.matchShare, p.squadShares as
// squad name -> match share). possession: squad name -> share of the ball (0-1). A squad with no possession
// figure counts as 50%, which leaves its counts unscaled.
export function addDefending(players, possession) {
  const pools = new Map(); // group -> { ground: [won, n], aerial: [won, n] }, totals for the league rate
  for (const p of players) {
    if (!SHRINK_K[p.group]) continue;
    const mult = padj(weighted(p.squadShares, (s) => possession.get(s)) ?? 0.5);
    for (const [name, inputs] of Object.entries(SCALED)) {
      const vals = inputs.map((m) => p.values[m]);
      p.values[name] = vals.every(Number.isFinite) ? vals.reduce((a, b) => a + b, 0) * mult : null;
    }
    const pool = pools.get(p.group) || { ground: [0, 0], aerial: [0, 0] };
    for (const [kind, [won, lost]] of Object.entries(DUELS)) {
      const w = p.values[won], l = p.values[lost];
      if (!Number.isFinite(w) || !Number.isFinite(l)) continue;
      pool[kind][0] += w * p.matchShare;
      pool[kind][1] += (w + l) * p.matchShare;
    }
    pools.set(p.group, pool);
  }
  for (const p of players) {
    const pool = pools.get(p.group);
    if (!pool) continue;
    for (const [kind, [won, lost]] of Object.entries(DUELS)) {
      const key = `derived__${kind.toUpperCase()}_WIN_SHRUNK`;
      const w = p.values[won], l = p.values[lost], [poolWon, poolN] = pool[kind];
      if (!Number.isFinite(w) || !Number.isFinite(l) || !(poolN > 0)) { p.values[key] = null; continue; }
      const k = SHRINK_K[p.group][kind];
      p.values[key] = (w * p.matchShare + k * (poolWon / poolN)) / ((w + l) * p.matchShare + k);
    }
  }
  return players;
}
