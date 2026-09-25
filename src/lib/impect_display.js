// How the KPI profile presents the study's categories. The study names the same idea differently at
// each position ("Build-up circulation", "Circulation and tempo", "Link play and circulation" are one
// set of metrics), so the page shows one name per idea, groups categories by phase of play, and sorts
// each category's metrics by what kind of number they are. impect_categories.js is generated from the
// study, so the presentation lives here and survives a regeneration.

export const PHASES = [
  { id: "gk", name: "Goalkeeping", desc: "Stopping shots, claiming high balls and sweeping behind the line" },
  { id: "build", name: "Build-up play", desc: "Keeping, moving and progressing the ball" },
  { id: "attack", name: "Final third", desc: "Getting on the ball high up, creating and shooting" },
  { id: "defend", name: "Defending & duels", desc: "Pressing, winning the ball back, ground and aerial contests" },
];
const OTHER = { id: "other", name: "Other", desc: "" };

// Study category name -> [shown name, phase, what it covers].
const CATEGORY_DISPLAY = {
  "Shot-stopping quality": ["Shot-stopping", "gk", "Goals prevented against the shot and post-shot xG faced."],
  "Shot-type save profile": ["Saves by shot type", "gk", "Goals prevented against post-shot xG, split by the type of shot."],
  "High-ball command": ["High balls", "gk", "Catching and punching crosses, and defensive aerial duels."],
  "Sweeping and interventions": ["Sweeping", "gk", "Defending outside the box: touches, interceptions, clearances and ball wins."],

  "Short circulation": ["Circulation", "build", "How much of the ball the player has, and how reliably passes are completed."],
  "Build-up circulation": ["Circulation", "build", "How much of the ball the player has, and how reliably passes are completed."],
  "Circulation and tempo": ["Circulation", "build", "How much of the ball the player has, and how reliably passes are completed."],
  "Circulation and link play": ["Circulation", "build", "How much of the ball the player has, and how reliably passes are completed."],
  "Link play and circulation": ["Circulation", "build", "How much of the ball the player has, and how reliably passes are completed."],
  "Distribution security": ["Ball security", "build", "Losing the ball: turnovers, dangerous turnovers, failed passes and the threat they give away."],
  "Ball security": ["Ball security", "build", "Losing the ball: turnovers, dangerous turnovers, failed passes and the threat they give away."],
  // Attacking mids and wingers: losses plus how often play goes backwards (centre mids: see below).
  "Ball security and directness": ["Ball security & directness", "build", "Losing the ball, and how often play goes backwards."],
  "Line-breaking distribution": ["Line-breaking passing", "build", "Passes that take opponents out of the game and add goal threat."],
  "Line-breaking progression": ["Line-breaking passing", "build", "Passes that take opponents out of the game and add goal threat."],
  "Long distribution and restarts": ["Long distribution", "build", "Launches, goal kicks, chipped and diagonal passes, and set-piece threat."],
  "Carrying out of pressure": ["Carrying & dribbling", "build", "Carrying the ball towards goal, the threat it adds, and beating opponents."],
  "Carrying and pressure escape": ["Carrying & dribbling", "build", "Carrying the ball towards goal, the threat it adds, and beating opponents."],
  "Carrying and attacking 1v1": ["Carrying & dribbling", "build", "Carrying the ball towards goal, the threat it adds, and beating opponents."],

  "Receiving and positioning": ["Receiving & movement", "attack", "Getting on the ball between the lines and in the box, and the threat added on receipt."],
  "Receiving and movement": ["Receiving & movement", "attack", "Getting on the ball between the lines and in the box, and the threat added on receipt."],
  "Wide receiving and overlaps": ["Wide receiving & overlaps", "attack", "Getting on the ball out wide and from deep runs, and the threat added on receipt."],
  "Receiving and box movement": ["Receiving & box movement", "attack", "Getting on the ball between the lines, in behind and in the box."],
  "Chance creation": ["Chance creation", "attack", "Shot assists, expected assists and shot-creating actions."],
  "Crossing and chance creation": ["Crossing & chance creation", "attack", "Crosses, shot assists, expected assists and shot-creating actions."],
  "Shooting threat": ["Shooting", "attack", "How often the player shoots and hits the target, and the quality of those chances."],
  "Finishing quality": ["Finishing", "attack", "Scoring and hitting the target relative to the quality of the chances."],
  "Set-piece and box threat": ["Set-piece & box threat", "attack", "Attacking headers, presence in the box, and shots."],

  "Pressing activity": ["Pressing", "defend", "How often the player presses: in the opponent's build-up, between the lines and after losing the ball."],
  "Pressing and ball winning": ["Pressing & ball winning", "defend", "Presses, plus ball wins and interceptions."],
  "Interceptions and recoveries": ["Interceptions & recoveries", "defend", "Ball wins, interceptions, loose and second balls, and blocks."],
  "Ground defending": ["Ground defending", "defend", "Defensive ground duels: how many, and how many won and lost."],
  "Ground duels": ["Ground duels", "defend", "Ground duels with and without the ball: how many, and how many won and lost."],
  "Aerial defending": ["Aerial defending", "defend", "Defensive aerial duels and headers."],
  "Aerial duels": ["Aerial duels", "defend", "Aerial duels and headers at both ends."],
  "Aerial and physical duels": ["Aerial & ground duels", "defend", "Aerial and ground duels: how many, and how many won."],
  "Hold-up play and ground duels": ["Hold-up play & ground duels", "defend", "Holding the ball up, and attacking ground duels."],
  "Aerial target play": ["Aerial target play", "defend", "Attacking aerial duels, headers and headed shots."],
};
// The one study name that covers two different metric sets: at centre mid it is plain ball security.
const POSITION_OVERRIDES = {
  "CM|Ball security and directness": CATEGORY_DISPLAY["Ball security"],
};

export function categoryDisplay(group, name) {
  const d = POSITION_OVERRIDES[`${group}|${name}`] || CATEGORY_DISPLAY[name];
  return d ? { label: d[0], phase: d[1], description: d[2] } : { label: name, phase: OTHER.id, description: null };
}

// The phases a card uses, in reading order.
export function phasesFor(ids) {
  const used = new Set(ids);
  return [...PHASES, OTHER].filter((p) => used.has(p.id));
}

// What kind of number each metric is, so the drill-down can say how to read its percentile.
export const METRIC_KINDS = [
  { id: "rate", name: "How well", note: "Success rates and efficiency" },
  { id: "volume", name: "How much", note: "Per match: a high percentile means more, not necessarily better" },
  { id: "mistake", name: "Mistakes", note: "A high percentile means fewer" },
  { id: "score", name: "Impect scores", note: "Impect's own composite ratings" },
];

export function metricKind(metric) {
  const name = String(metric).split("__").pop();
  if (/LOSS|LOST|UNSUCCESSFUL|_FAIL/.test(name)) return "mistake";
  if (/_SCORE$/.test(name)) return "score";
  if (/RATIO|PERCENT|OVER_EXPECTED|PREVENTED_GOALS/.test(name)) return "rate";
  return "volume";
}

const SHORT_LEAGUE = { "USL Championship": "USL-C", "MLS Next Pro": "MLSNP", "USL League One": "USL1" };
export const shortLeague = (competition) => SHORT_LEAGUE[competition] || competition;
