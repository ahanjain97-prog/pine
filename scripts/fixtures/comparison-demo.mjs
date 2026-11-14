// Fictional comparison data for browser QA and public screenshots. Never club data.
export const demoPlayers = [
  { id: 10001, impect_id: 501, name: 'Alex Mercer', club: 'Harbor FC', position: 'Central Midfield' },
  { id: 10002, impect_id: 502, name: 'Leo Santos', club: 'Riverside FC', position: 'Central Midfield' },
  { id: 10003, impect_id: 503, name: 'Noah Turner', club: 'Summit FC', position: 'Centre-Back' },
  { id: 10004, impect_id: null, name: 'Finn Ellis', club: 'Valley FC', position: 'Left-Back' },
];
const groups = [{ group: 'MID', label: 'Defensive / Central Mid', match_share: 19.2, eligible: true, impect_positions: [{ name: 'CENTRAL_MIDFIELD', match_share: 19.2 }] }, { group: 'FB', label: 'Full-Back', match_share: 2.1, eligible: false, impect_positions: [{ name: 'LEFT_WINGBACK_DEFENDER', match_share: 2.1 }] }];
export function demoKpi(id, query) {
  const side = id === 10002 ? 1 : 0;
  if (id === 10003) return { empty: true, reason: 'No KPI season available for this fictional player.', available_iterations: [] };
  const iteration = Number(query.get('iteration')) || (side ? 1918 : 1916), season = [1248, 1236].includes(iteration) ? '2025' : '2026';
  const position = query.get('position') === 'FB' && !side ? 'FB' : 'MID';
  const definitions = [
    ['build', 'On-Ball', 'Circulation', 72, 76, ['Pass completion', 'Progressive passes']],
    ['build', 'On-Ball', 'Ball security', 84, 52, ['Turnovers', 'Failed passes']],
    ['build', 'On-Ball', 'Line-breaking passing', 58, 88, ['Packing per pass', 'Goal threat from passes']],
    ['build', 'On-Ball', 'Carrying & dribbling', 63, 60, ['Progressive carries', 'Take-ons won']],
    ['attack', 'Final third', 'Chance creation', 43, 78, ['Expected assists', 'Shot assists']],
    ['attack', 'Final third', 'Shooting', 36, 55, ['Shots', 'Non-penalty xG']],
    ['defending', 'Defending', 'Defending overall', 82, 58, ['Ball wins', 'Second balls']],
    ['defending', 'Defending', 'Ball winning', 85, 57, ['Interceptions', 'Ball wins']],
    ['defstyle', 'Defending style', 'Defensive workload', 77, 45, ['Defensive actions', 'Duels']],
  ];
  return { iteration: { id: iteration, season, competition: side ? 'USL Championship' : 'USL League One' },
    available_iterations: [{ id: side ? 1918 : 1916, season: '2026', competition: side ? 'USL Championship' : 'USL League One', type: 'League' }, { id: side ? 1236 : 1248, season: '2025', competition: side ? 'USL Championship' : 'USL League One', type: 'League' }],
    squad: side ? 'Riverside FC' : 'Harbor FC', position, position_label: position === 'MID' ? 'Defensive / Central Mid' : 'Full-Back', positions: side ? groups.slice(0, 1) : groups,
    metric_kinds: [{ id: 'volume', name: 'How much', note: 'More is not automatically better' }, { id: 'mistake', name: 'Mistakes', note: 'Higher means fewer mistakes' }], cohort_built_at: '2026-10-01T12:00:00Z',
    peer_count: 142, minutes: side ? 1562 : 1728, match_share: position === 'FB' ? 2.1 : 19.2, eligible: position !== 'FB', min_share_used: 5,
    benchmark_competitions: ['USL Championship', 'MLS Next Pro', 'USL League One'],
    phases: [...new Map(definitions.map(([id, name]) => [id, { id, name }])).values()],
    categories: definitions.map(([phase, , name, a, b, metrics], i) => ({ name, label: name, phase, percentile: side ? b : a,
      description: `Fictional ${name.toLowerCase()} category for interface review.`,
      ...(name === 'Defending overall' ? { outlook: { expected: side ? 55 : 68, low: side ? 36 : 48, high: side ? 73 : 84 } } : {}),
      components: metrics.map((label, j) => ({ metric: `demo_${i}_${j}`, label, kind: i === 1 ? 'mistake' : 'volume', inverted: i === 1,
        value: i === 4 && j === 0 ? (side ? .173 : .011) : i === 1 && j === 0 ? 0 : side ? 4.2 : 6.1,
        percentile: Math.max(0, (side ? b : a) - j * 8), definition: 'Fictional metric, with the original unit and orientation retained.' })) })),
  };
}
const labels = ['Sprint Count Per 90', 'Sprinting Distance Per 90 (+25)', 'HSR Count Per 90', 'High Intensity Count Per 90',
  'High Intensity Distance Per 90', 'Running Distance Per 90 (15-20)', 'HSR Distance Per 90 (20-25)', 'Total Distance Per 90',
  'Max Speed', 'Acceleration Count Per 90', 'Deceleration Count Per 90', 'Peak Acceleration', 'Peak Deceleration', 'Distance Per Minute'];
export function demoPhysical(id) {
  const side = id === 10002 ? 1 : 0;
  const row = (season, league = 'Example League') => ({ key: `${id}|${season}|${league}`, season, league, team: side ? 'Riverside FC' : 'Harbor FC', grp: 'MID', pos: 'CM', mins: side ? 1412 : 1605, pool: 62,
    raw: [side ? 10.6 : 18.2, side ? 234 : 320, 34, 47, 945, 1800, 670, 9800, 31.4, 0, 33, 4.5, 4.1, 111],
    pct: side ? [53, 60, 69, 71, 56, 82, 66, 57, 61, 0, 55, 67, 64, 58] : [88, 83, 72, 74, 77, 69, 71, 64, 58, 0, 55, 72, 69, 74] });
  return { candidates: [], confirmed: false, meta: { site: 'https://example.com/physical', groups: [], metrics: labels.map((l, i) => ({ k: `phys_${i}`, l })) }, linked: id > 10002 ? [] : [row('2026'), row('2025'), ...(side ? [row('2026', 'Other League')] : [])] };
}
export function demoCards(id) {
  if (id > 10002) return { cards: [] };
  return { cards: [1, 2].map(v => ({ id: (id === 10002 ? 20 : 10) + v, iteration_id: 1916,
    season: '2026', competition: 'USL League One', position: 'CM', status: 'done',
    has_image: 1, has_snapshot: v === 1 ? 1 : 0, generated_at: v === 1 ? '2026-10-03 12:00:00' : '2026-09-01 12:00:00', data_as_of: '2026-10-01' })) };
}
export function demoSnapshot(card) {
  const side = card > 20, pid = side ? 502 : 501;
  return { schema: 1, data_as_of: '2026-10-01', render_input: { schema_version: 16, id: `player-${pid}-1916-cm`, iteration: 1916,
    subject: { id: pid, club: side ? 'Riverside FC' : 'Harbor FC', season: 2026, league: 'USL1', profiles: [{ group: 'CM', ms: 19.2,
      percentiles: { IMPECT_SCORE_PXT: side ? 76 : 61, OFFENSIVE_IMPECT_SCORE_PXT: side ? 83 : 56, DEFENSIVE_IMPECT_SCORE_PXT: side ? 52 : 82,
        IMPECT_SCORE_PACKING: side ? 72 : 80, OFFENSIVE_IMPECT_SCORE_PACKING: side ? 85 : 68, DEFENSIVE_IMPECT_SCORE_PACKING: side ? 49 : 86,
        IMPECT_WITHOUT_FOULS_AND_SET_PIECES_SCORE_PXT: side ? 74 : 59 },
      grid: [
        ['IMPECT_SCORE_PACKING', 'Overall packing', 'overall', 80, 72],
        ['BYPASSED_OPPONENTS_RECEIVING', 'Receiving between lines', 'receiving', 71, 67],
        ['SUCCESSFUL_PASSES', 'Completed passes', 'passing', 72, 76],
        ['PXT_PASS_PRO', 'Goal threat from passes', 'passing', 58, 88],
        ['BYPASSED_OPPONENTS_BY_ACTION_DRIBBLE', 'Progressive carrying', 'carrying', 63, 60],
        ['BALL_LOSS_ADDED_OPPONENTS', 'Turnover cost', 'passing', 90, 56],
        ['EXPECTED_GOAL_ASSISTS', 'Chance creation', 'shooting', 43, 78],
        ['SHOT_XG', 'Expected goals', 'shooting', 36, 55],
        ['BALL_WIN_NUMBER', 'Ball winning', 'defending', 85, 57],
        ['WON_GROUND_DUELS', 'Ground duels won', 'defending', 82, 58],
        ['NUMBER_OF_PRESSES', 'Pressing volume', 'defending', 77, 45],
        ['CORNER_SCORE', 'Corner delivery', 'set_pieces', 99, 99],
      ].map(([metric, name, bucket, a, b]) => ({ metric, name, bucket, percentile: side ? b : a,
        value: metric === 'CORNER_SCORE' || metric === 'BALL_LOSS_ADDED_OPPONENTS' && !side ? 0 : side ? 3.4 : 5.1,
        rare: metric === 'CORNER_SCORE', direction: metric === 'BALL_LOSS_ADDED_OPPONENTS' ? 'lower' : metric === 'NUMBER_OF_PRESSES' ? 'none' : 'higher', code: metric === 'NUMBER_OF_PRESSES' ? 'D' : 'R' })) }] },
    value: { PxT: ['IMPECT_SCORE_PXT', 'OFFENSIVE_IMPECT_SCORE_PXT', 'DEFENSIVE_IMPECT_SCORE_PXT'],
      Packing: ['IMPECT_SCORE_PACKING', 'OFFENSIVE_IMPECT_SCORE_PACKING', 'DEFENSIVE_IMPECT_SCORE_PACKING'] },
    grid: { source: '/demo/metric_grid.yml', ledger: 'demo.csv' }, provenance: { sha256: { '/demo/metric_grid.yml': 'a'.repeat(64) } }, events: { position: 'CM' } } };

}
export function demoCardImage(card) {
  const side = card > 20, name = side ? 'LEO SANTOS' : 'ALEX MERCER';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="850" viewBox="0 0 1200 850"><rect width="1200" height="850" fill="#fbf9f3"/><rect width="1200" height="130" fill="#203e28"/><text x="48" y="58" font-size="35" fill="white" font-family="Arial">${name}</text><text x="48" y="98" font-size="19" fill="#d9e2d4" font-family="Arial">2026 · Central midfield · Fictional demonstration card</text><text x="48" y="192" font-family="Arial" font-size="23" fill="#203e28">VALUE &amp; METRIC PROFILE</text>${['Passing', 'Carrying', 'Chance creation', 'Ball winning', 'Receiving', 'Shooting'].map((label, i) => `<text x="48" y="${250 + i * 72}" font-size="21" fill="#203e28" font-family="Arial">${label}</text><rect x="340" y="${229 + i * 72}" width="700" height="28" fill="#e4dfd0"/><rect x="340" y="${229 + i * 72}" width="${([58, 63, 43, 85, 71, 36][i] + (side ? (i % 2 ? -15 : 20) : 0)) * 7}" height="28" fill="${side ? '#a45c16' : '#28608d'}"/>`).join('')}<text x="48" y="790" font-family="Arial" font-size="17" fill="#6d6a5d">Fictional data for public interface review. No scouting findings.</text></svg>`;
}
