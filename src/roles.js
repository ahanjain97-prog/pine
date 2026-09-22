// Board positions and roles (from the Hearts of Pine depth-chart graphic).
// `area` is the CSS grid area the position box occupies on the pitch board.
// Role codes are stored in board_entries and their number is the displayed #, so removing a role
// (AM2) leaves every other role's code and number unchanged.
export const POSITIONS = [
  { code: "FWD", label: "Forward", area: "fwd", roles: [["FWD1", "Complete"], ["FWD2", "Target"], ["FWD3", "FWD/Winger Aux"]] },
  { code: "LW", label: "Left Wing", area: "lw", roles: [["LW1", "High & Wide Winger"], ["LW2", "Inverted Winger"]] },
  { code: "AM", label: "Attacking Mid", area: "am", roles: [["AM1", "Between Lines #10"], ["AM3", "Second Striker"]] },
  { code: "RW", label: "Right Wing", area: "rw", roles: [["RW1", "High & Wide Winger"], ["RW2", "Inverted Winger"]] },
  { code: "CM", label: "Central Mid", area: "cm", roles: [["CM1", "Ball-Playing CM"], ["CM2", "Blue Collar CM"]] },
  { code: "CDM", label: "Defensive Mid", area: "cdm", roles: [["CDM1", "Single-Pivot CDM"], ["CDM2", "Aux - Young Player"]] },
  { code: "LB", label: "Left Back", area: "lb", roles: [["LB1", "Wingback"], ["LB2", "4-Back LB"]] },
  { code: "LCB", label: "Left CB", area: "lcb", roles: [["LCB1", "Ball-Playing CB"], ["LCB2", "Defensive CB"]] },
  { code: "RCB", label: "Right CB", area: "rcb", roles: [["RCB1", "Defensive CB"], ["RCB2", "Ball-Playing CB"], ["RCB3", "Aux CB/RB"]] },
  { code: "RB", label: "Right Back", area: "rb", roles: [["RB1", "4-Back RB"], ["RB2", "Wingback"]] },
  { code: "GK", label: "Goalkeeper", area: "gk", roles: [["GK1", "GK #1"], ["GK2", "GK #2"]] },
];

export const ROLES = Object.fromEntries(
  POSITIONS.flatMap((p) => p.roles.map(([code, label]) => [code, { code, label, position: p.code, num: Number(code.match(/\d+$/)[0]) }]))
);

export const DECISIONS = ["pass", "hold", "fail"];

// The chart has a ball-playing and a defensive CB on each side, so list imports can split centre backs by foot.
export const SPLIT_ROLES = {
  CB_BP: { label: "Ball-Playing CB (LCB #1 if left-footed, else RCB #2)", left: "LCB1", right: "RCB2" },
  CB_DEF: { label: "Defensive CB (LCB #2 if left-footed, else RCB #1)", left: "LCB2", right: "RCB1" },
};

export function resolveRole(role, foot) {
  if (!role) return null;
  if (SPLIT_ROLES[role]) return /left/i.test(foot || "") ? SPLIT_ROLES[role].left : SPLIT_ROLES[role].right;
  return ROLES[role] ? role : null;
}

// Impect Scouting list name ("PHOP Inverted LW") -> board role. Order matters: more specific first.
const LIST_ROLE_HINTS = [
  [/target striker|target/, "FWD2"],
  [/(st|fwd|striker)\s*\/\s*winger aux|winger aux/, "FWD3"],
  [/true striker|complete/, "FWD1"],
  [/high (&|and) wide lw/, "LW1"],
  [/inverted lw/, "LW2"],
  [/high (&|and) wide rw/, "RW1"],
  [/inverted rw/, "RW2"],
  [/between (the )?lines/, "AM1"],
  [/second striker/, "AM3"],
  [/ball[- ]playing cm/, "CM1"],
  [/blue collar/, "CM2"],
  [/single[- ]pivot/, "CDM1"],
  [/young player/, "CDM2"],
  [/cb\s*\/\s*rb aux|aux cb/, "RCB3"],
  [/ball[- ]playing cb/, "CB_BP"],
  [/defensive cb/, "CB_DEF"],
  [/left wing ?back|lb wing ?back/, "LB1"],
  [/4[- ]back lb/, "LB2"],
  [/4[- ]back rb/, "RB1"],
  [/right wing ?back|rb wing ?back/, "RB2"],
  [/\bgk\b|goalkeeper|keeper/, "GK1"],
];
export function suggestListRole(name) {
  const n = String(name || "").toLowerCase();
  return LIST_ROLE_HINTS.find(([re]) => re.test(n))?.[1] || null;
}

export const IMPECT_POSITION_LABEL = {
  GOALKEEPER: "Goalkeeper", LEFT_WINGBACK_DEFENDER: "Left-Back", RIGHT_WINGBACK_DEFENDER: "Right-Back",
  CENTRAL_DEFENDER: "Centre-Back", DEFENSE_MIDFIELD: "Defensive Midfield", CENTRAL_MIDFIELD: "Central Midfield",
  ATTACKING_MIDFIELD: "Attacking Midfield", LEFT_WINGER: "Left Winger", RIGHT_WINGER: "Right Winger", CENTER_FORWARD: "Centre-Forward",
};

// Transfermarkt / Impect position -> suggested board position.
export function suggestPosition(position, foot) {
  const p = String(position || "").toLowerCase();
  if (/goal/.test(p)) return "GK";
  if (/centre-back|center-back|central_defender|centre back/.test(p)) return /left/.test(foot || "") ? "LCB" : "RCB";
  if (/left-back|left back|left_wingback/.test(p)) return "LB";
  if (/right-back|right back|right_wingback/.test(p)) return "RB";
  if (/defensive midfield|defense_midfield/.test(p)) return "CDM";
  if (/central midfield|central_midfield/.test(p)) return "CM";
  if (/attacking midfield|attacking_midfield|second striker/.test(p)) return "AM";
  if (/left winger|left midfield|left_winger/.test(p)) return "LW";
  if (/right winger|right midfield|right_winger/.test(p)) return "RW";
  if (/forward|striker|center_forward/.test(p)) return "FWD";
  return null;
}
