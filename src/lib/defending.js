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

// Ball security per touch, every outfield group: Impect's loss counts are per match, so a player who is rarely on
// the ball looked secure and the category went with WORSE goal difference; per touch it turned positive
// (impect_metric_stability evaluate_onball_detail.py: back six +2.5 points a season, front +7.4, 20th vs 80th pct).
const PER_TOUCH = {
  derived__BALL_LOSSES_PER_TOUCH: "kpi__BALL_LOSS_NUMBER",
  derived__CRITICAL_LOSSES_PER_TOUCH: "kpi__CRITICAL_BALL_LOSS_NUMBER",
};
const TOUCHES = "score__TOTAL_TOUCHES";

// Impect metrics the derived ones are built from, fetched whether or not a category shows them.
export const DEFENDING_INPUTS = [...new Set([...Object.values(SCALED).flat(), ...Object.values(DUELS).flat(),
  ...Object.values(PER_TOUCH), TOUCHES])];

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
  derived__BALL_LOSSES_PER_TOUCH: { label: "Ball losses per touch", inverted: true,
    definition: "Ball losses divided by touches, so a player who is on the ball a lot isn't marked down for it." },
  derived__CRITICAL_LOSSES_PER_TOUCH: { label: "Dangerous ball losses per touch", inverted: true,
    definition: "Losses that lead to an opponent chance, divided by touches." },
};

const weighted = (shares, valueOf) => {
  let sum = 0, weight = 0;
  for (const [key, w] of shares) {
    const v = valueOf(key);
    if (Number.isFinite(v) && w > 0) { sum += v * w; weight += w; }
  }
  return weight > 0 ? sum / weight : null;
};

// Adds ball losses per touch to one league season's player rows (every group).
export function addBallSecurity(players) {
  for (const p of players) {
    const touches = p.values[TOUCHES];
    for (const [name, count] of Object.entries(PER_TOUCH)) {
      const v = p.values[count];
      p.values[name] = Number.isFinite(v) && touches > 0 ? v / touches : null;
    }
  }
  return players;
}

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

// How far one season's Defending overall can be trusted. r: season-to-season correlation of the score for players
// who changed clubs, at the typical sample (matches = median match shares of established players), from
// impect_metric_stability evaluate_back6_composite.py. Smaller samples are trusted less (Spearman-Brown).
export const DEFENDING_RELIABILITY = { CB: { r: 0.52, matches: 18.4 }, FB: { r: 0.34, matches: 15.5 }, MID: { r: 0.45, matches: 15.6 } };

const normCdf = (z) => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI))); // Polya, |error| < 0.003
function normInv(p) { // Acklam's rational approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Where his true defending level likely sits among peers, from one season's Defending overall percentile: the
// observed z is pulled toward the median by the score's reliability R at this sample. The true level, standardised
// among peers, is ~ N(sqrt(R) z, 1 - R): an 80% range, which widens toward 10-90 as the sample shrinks.
export function defendingOutlook(percentile, matchShare, group) {
  const rel = DEFENDING_RELIABILITY[group];
  if (!rel || !Number.isFinite(percentile) || !(matchShare > 0)) return null;
  const per = rel.r / (rel.matches - (rel.matches - 1) * rel.r); // reliability of one match
  const R = (matchShare * per) / (1 + (matchShare - 1) * per);
  const z = normInv(Math.min(99.5, Math.max(0.5, percentile)) / 100);
  const mean = Math.sqrt(R) * z, sd = Math.sqrt(1 - R), pct = (v) => Math.round(100 * normCdf(v));
  return { expected: pct(mean), low: pct(mean - 1.2816 * sd), high: pct(mean + 1.2816 * sd), reliability: Math.round(R * 100) / 100 };
}
