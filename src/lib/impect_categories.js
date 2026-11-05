// Impect KPI categories, generated from impect_metric_stability/build_position_clusters.py (CATEGORY_CONFIG).
// Equal-weight, direction-consistent z-score categories; every metric belongs to one category per position.
// Regenerate rather than hand-edit if the study changes.

import { DEFENDING_INPUTS } from "./defending.js";

export const POSITION_MAP = {
  GOALKEEPER: "GK", CENTRAL_DEFENDER: "CB", LEFT_WINGBACK_DEFENDER: "FB", RIGHT_WINGBACK_DEFENDER: "FB",
  // Defensive and central midfielders are one benchmark group (MID, below), pooled per player.
  DEFENSE_MIDFIELD: "MID", CENTRAL_MIDFIELD: "MID", ATTACKING_MIDFIELD: "AM",
  LEFT_WINGER: "W", RIGHT_WINGER: "W", CENTER_FORWARD: "ST",
};

export const POSITION_LABEL = {
  GK: "Goalkeeper", CB: "Centre-Back", FB: "Full-Back", MID: "Defensive / Central Mid",
  AM: "Attacking Mid", W: "Winger", ST: "Striker",
};

// Match-share floor for the peer cohort (player_percentiles.py uses 5.0).
export const MIN_MATCH_SHARE = 5;

export const CATEGORIES = {
  GK: {
    "Shot-stopping quality": [
      "score__GK_PREVENTED_GOALS_TOTAL_SHOT_XG",
      "score__GK_PREVENTED_GOALS_TOTAL_SHOT_XG_PERCENT",
      "score__GK_PREVENTED_GOALS_TOTAL_POSTSHOT_XG",
      "score__GK_PREVENTED_GOALS_TOTAL_POSTSHOT_XG_PERCENT",
    ],
    "Shot-type save profile": [
      "score__GK_PREVENTED_GOALS_POST_SHOT_XG_BY_ACTION1V1_AGAINST_GK_SHOT_RATIO",
      "score__GK_PREVENTED_GOALS_POST_SHOT_XG_BY_ACTION_CLOSE_RANGE_SHOT_RATIO",
      "score__GK_PREVENTED_GOALS_POST_SHOT_XG_BY_ACTION_HEADER_SHOT_RATIO",
      "score__GK_PREVENTED_GOALS_POST_SHOT_XG_BY_ACTION_LONG_RANGE_SHOT_RATIO",
      "score__GK_PREVENTED_GOALS_POST_SHOT_XG_BY_ACTION_MID_RANGE_SHOT_RATIO",
    ],
    "High-ball command": [
      "score__GK_CAUGHT_HIGH_BALLS_PERCENT",
      "score__GK_CAUGHT_AND_PUNCHED_HIGH_BALLS_PERCENT",
      "kpi__WON_AERIAL_DUELS_DEF",
      "score__RATIO_AERIAL_DUELS_DEFENSIVE",
      "score__DEFENSIVE_HEADER_SCORE",
    ],
    "Sweeping and interventions": [
      "score__GK_DEFENSIVE_TOUCHES_OUTSIDE_OWN_BOX",
      "score__LOOSE_BALL_REGAIN_SCORE",
      "score__INTERCEPTION_SCORE",
      "score__CLEARANCE_SCORE",
      "kpi__BALL_WIN_NUMBER",
      "kpi__PXT_DEFEND",
    ],
    "Short circulation": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Distribution security": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__PXT_PASS_FAIL",
      "kpi__BALL_LOSS_ADDED_OPPONENTS",
    ],
    "Long distribution and restarts": [
      "score__GK_SUCCESSFUL_LAUNCHES_PERCENT",
      "score__GOAL_KICK_SCORE",
      "score__CHIPPED_PASS_SCORE",
      "score__DIAGONAL_PASS_SCORE",
      "kpi__PXT_SETPIECE_PRO",
    ],
    "Line-breaking distribution": [
      "kpi__PXT_PASS_PRO",
      "kpi__BYPASSED_DEFENDERS",
      "kpi__BYPASSED_OPPONENTS_MIDFIELD",
      "kpi__BYPASSED_OPPONENTS_WO_VERIFICATION",
      "kpi__BYPASSED_OPPONENTS_RAW",
    ],
  },
  CB: {
    "Build-up circulation": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Ball security": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__PXT_PASS_FAIL",
      "kpi__BALL_LOSS_ADDED_OPPONENTS",
    ],
    "Line-breaking distribution": [
      "kpi__PXT_PASS_PRO",
      "kpi__BYPASSED_DEFENDERS",
      "kpi__BYPASSED_OPPONENTS_MIDFIELD",
      "kpi__BYPASSED_OPPONENTS_WO_VERIFICATION",
      "kpi__BYPASSED_OPPONENTS_RAW",
    ],
    "Carrying out of pressure": [
      "kpi__DISTANCE_TO_GOAL_COVERED_DRIBBLE",
      "kpi__PXT_DRIBBLE",
      "kpi__PXT_DRIBBLE_PRO",
      "score__DRIBBLE_SCORE",
      "kpi__NUMBER_OF_FOULS_WON",
    ],
    "Pressing activity": [
      "kpi__NUMBER_OF_PRESSES",
      "kpi__NUMBER_OF_PRESSES_BUILD_UP",
      "kpi__NUMBER_OF_PRESSES_BETWEEN_THE_LINES",
      "kpi__NUMBER_OF_PRESSES_COUNTER_PRESS",
    ],
    "Interceptions and recoveries": [
      "kpi__BALL_WIN_NUMBER",
      "score__INTERCEPTION_SCORE",
      "score__LOOSE_BALL_REGAIN_SCORE",
      "kpi__SECOND_BALL_START",
      "kpi__SECOND_BALL_WIN",
      "score__BLOCK_SCORE",
    ],
    "Ground defending": [
      "kpi__WON_GROUND_DUELS_DEF",
      "kpi__LOST_GROUND_DUELS_DEF",
      "score__RATIO_GROUND_DUELS_DEFENSIVE",
      "score__NUMBER_OF_GROUND_DUELS",
      "score__GROUND_DUEL_SCORE",
    ],
    "Aerial defending": [
      "kpi__WON_AERIAL_DUELS_DEF",
      "kpi__LOST_AERIAL_DUELS_DEF",
      "score__RATIO_AERIAL_DUELS_DEFENSIVE",
      "score__DEFENSIVE_HEADER_SCORE",
      "score__AERIAL_DUELS_NUMBER_IN_PACKING_ZONE_CB",
    ],
    "Set-piece and box threat": [
      "score__OFFENSIVE_HEADER_SCORE",
      "kpi__WON_AERIAL_DUELS_OFF",
      "score__HEADER_SHOT_SCORE",
      "score__AVAILABILITY_IN_THE_BOX_SCORE",
      "kpi__SHOT_XG",
      "kpi__SHOT_AT_GOAL_NUMBER",
    ],
  },
  FB: {
    "Build-up circulation": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Ball security": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__PXT_PASS_FAIL",
      "kpi__BALL_LOSS_ADDED_OPPONENTS",
    ],
    "Line-breaking progression": [
      "kpi__PXT_PASS_PRO",
      "kpi__BYPASSED_DEFENDERS",
      "kpi__BYPASSED_OPPONENTS_MIDFIELD",
      "kpi__BYPASSED_OPPONENTS_WO_VERIFICATION",
      "kpi__BYPASSED_OPPONENTS_RAW",
    ],
    "Wide receiving and overlaps": [
      "kpi__PXT_REC",
      "kpi__BYPASSED_DEFENDERS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING",
      "score__AVAILABILITY_OUT_WIDE_SCORE",
      "score__AVAILABILITY_FDR_SCORE",
      "kpi__DISTANCE_TO_GOAL_COVERED_FDR",
    ],
    "Carrying and attacking 1v1": [
      "kpi__DISTANCE_TO_GOAL_COVERED_DRIBBLE",
      "kpi__PXT_DRIBBLE",
      "kpi__PXT_DRIBBLE_PRO",
      "score__DRIBBLE_SCORE",
      "kpi__WON_GROUND_DUELS_OFF",
      "kpi__NUMBER_OF_FOULS_WON",
    ],
    "Crossing and chance creation": [
      "kpi__EXPECTED_SHOT_ASSISTS",
      "kpi__SHOT_ASSISTS",
      "kpi__SHOT_CREATING_ACTIONS",
      "kpi__EXPECTED_GOAL_ASSISTS",
      "score__LOW_CROSS_SCORE",
      "score__HIGH_CROSS_SCORE",
    ],
    "Pressing activity": [
      "kpi__NUMBER_OF_PRESSES",
      "kpi__NUMBER_OF_PRESSES_BUILD_UP",
      "kpi__NUMBER_OF_PRESSES_BETWEEN_THE_LINES",
      "kpi__NUMBER_OF_PRESSES_COUNTER_PRESS",
    ],
    "Interceptions and recoveries": [
      "kpi__BALL_WIN_NUMBER",
      "score__INTERCEPTION_SCORE",
      "score__LOOSE_BALL_REGAIN_SCORE",
      "kpi__SECOND_BALL_START",
      "kpi__SECOND_BALL_WIN",
      "score__BLOCK_SCORE",
    ],
    "Ground defending": [
      "kpi__WON_GROUND_DUELS_DEF",
      "kpi__LOST_GROUND_DUELS_DEF",
      "score__RATIO_GROUND_DUELS_DEFENSIVE",
      "score__NUMBER_OF_GROUND_DUELS",
      "score__GROUND_DUEL_SCORE",
    ],
    "Aerial defending": [
      "kpi__WON_AERIAL_DUELS_DEF",
      "kpi__LOST_AERIAL_DUELS_DEF",
      "score__RATIO_AERIAL_DUELS_DEFENSIVE",
      "score__DEFENSIVE_HEADER_SCORE",
      "score__AERIAL_DUELS_NUMBER_IN_PACKING_ZONE_CB",
    ],
  },
  DM: {
    "Circulation and tempo": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Ball security": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__PXT_PASS_FAIL",
      "kpi__BALL_LOSS_ADDED_OPPONENTS",
    ],
    "Line-breaking progression": [
      "kpi__PXT_PASS_PRO",
      "kpi__BYPASSED_DEFENDERS",
      "kpi__BYPASSED_OPPONENTS_MIDFIELD",
      "kpi__BYPASSED_OPPONENTS_WO_VERIFICATION",
      "kpi__BYPASSED_OPPONENTS_RAW",
    ],
    "Receiving and positioning": [
      "kpi__PXT_REC",
      "kpi__BYPASSED_DEFENDERS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING_DUETO_VERIFICATION",
      "score__AVAILABILITY_BTL_SCORE",
      "score__AVAILABILITY_IN_THE_BOX_SCORE",
    ],
    "Chance creation": [
      "kpi__EXPECTED_SHOT_ASSISTS",
      "kpi__SHOT_ASSISTS",
      "kpi__SHOT_CREATING_ACTIONS",
      "kpi__EXPECTED_GOAL_ASSISTS",
      "kpi__SHOT_XG_FROM_PASSES",
      "kpi__ASSISTS",
    ],
    "Carrying and pressure escape": [
      "kpi__DISTANCE_TO_GOAL_COVERED_DRIBBLE",
      "kpi__PXT_DRIBBLE",
      "kpi__PXT_DRIBBLE_PRO",
      "score__DRIBBLE_SCORE",
      "kpi__WON_GROUND_DUELS_OFF",
      "kpi__NUMBER_OF_FOULS_WON",
    ],
    "Pressing activity": [
      "kpi__NUMBER_OF_PRESSES",
      "kpi__NUMBER_OF_PRESSES_BUILD_UP",
      "kpi__NUMBER_OF_PRESSES_BETWEEN_THE_LINES",
      "kpi__NUMBER_OF_PRESSES_COUNTER_PRESS",
    ],
    "Interceptions and recoveries": [
      "kpi__BALL_WIN_NUMBER",
      "score__INTERCEPTION_SCORE",
      "score__LOOSE_BALL_REGAIN_SCORE",
      "kpi__SECOND_BALL_START",
      "kpi__SECOND_BALL_WIN",
      "score__BLOCK_SCORE",
    ],
    "Ground defending": [
      "kpi__WON_GROUND_DUELS_DEF",
      "kpi__LOST_GROUND_DUELS_DEF",
      "score__RATIO_GROUND_DUELS_DEFENSIVE",
      "score__NUMBER_OF_GROUND_DUELS",
      "score__GROUND_DUEL_SCORE",
    ],
    "Aerial defending": [
      "kpi__WON_AERIAL_DUELS_DEF",
      "kpi__LOST_AERIAL_DUELS_DEF",
      "score__RATIO_AERIAL_DUELS_DEFENSIVE",
      "score__DEFENSIVE_HEADER_SCORE",
      "score__AERIAL_DUELS_NUMBER_IN_PACKING_ZONE_CB",
    ],
  },
  CM: {
    "Circulation and tempo": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Ball security and directness": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__PXT_PASS_FAIL",
      "kpi__BALL_LOSS_ADDED_OPPONENTS",
    ],
    "Line-breaking progression": [
      "kpi__PXT_PASS_PRO",
      "kpi__BYPASSED_DEFENDERS",
      "kpi__BYPASSED_OPPONENTS_MIDFIELD",
      "kpi__BYPASSED_OPPONENTS_WO_VERIFICATION",
      "kpi__BYPASSED_OPPONENTS_RAW",
    ],
    "Receiving and movement": [
      "kpi__PXT_REC",
      "kpi__BYPASSED_DEFENDERS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING_DUETO_VERIFICATION",
      "score__AVAILABILITY_BTL_SCORE",
      "score__AVAILABILITY_IN_THE_BOX_SCORE",
    ],
    "Chance creation": [
      "kpi__EXPECTED_SHOT_ASSISTS",
      "kpi__SHOT_ASSISTS",
      "kpi__SHOT_CREATING_ACTIONS",
      "kpi__EXPECTED_GOAL_ASSISTS",
      "kpi__SHOT_XG_FROM_PASSES",
      "kpi__ASSISTS",
    ],
    "Shooting threat": [
      "kpi__SHOT_AT_GOAL_NUMBER",
      "kpi__SHOT_AT_GOAL_NUMBER_ON_TARGET",
      "kpi__SHOT_XG",
      "kpi__POSTSHOT_XG",
      "kpi__GOALS",
    ],
    "Carrying and attacking 1v1": [
      "kpi__DISTANCE_TO_GOAL_COVERED_DRIBBLE",
      "kpi__PXT_DRIBBLE",
      "kpi__PXT_DRIBBLE_PRO",
      "score__DRIBBLE_SCORE",
      "kpi__WON_GROUND_DUELS_OFF",
      "kpi__NUMBER_OF_FOULS_WON",
    ],
    "Pressing and ball winning": [
      "kpi__NUMBER_OF_PRESSES",
      "kpi__NUMBER_OF_PRESSES_BUILD_UP",
      "kpi__NUMBER_OF_PRESSES_BETWEEN_THE_LINES",
      "kpi__NUMBER_OF_PRESSES_COUNTER_PRESS",
      "kpi__BALL_WIN_NUMBER",
      "score__INTERCEPTION_SCORE",
    ],
    "Ground duels": [
      "kpi__WON_GROUND_DUELS",
      "kpi__LOST_GROUND_DUELS",
      "score__NUMBER_OF_GROUND_DUELS",
      "score__RATIO_GROUND_DUELS",
      "score__GROUND_DUEL_SCORE",
    ],
    "Aerial duels": [
      "kpi__WON_AERIAL_DUELS",
      "kpi__LOST_AERIAL_DUELS",
      "score__AERIAL_DUELS_NUMBER",
      "score__RATIO_AERIAL_DUELS",
      "score__OFFENSIVE_HEADER_SCORE",
      "score__DEFENSIVE_HEADER_SCORE",
    ],
  },
  AM: {
    "Circulation and link play": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Ball security and directness": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__REVERSE_PLAY_ADDED_OPPONENTS",
      "score__RATIO_REVERSE_PLAY_ADDED_OPPONENTS",
    ],
    "Line-breaking progression": [
      "kpi__PXT_PASS_PRO",
      "kpi__BYPASSED_DEFENDERS",
      "kpi__BYPASSED_OPPONENTS_MIDFIELD",
      "kpi__BYPASSED_OPPONENTS_WO_VERIFICATION",
      "kpi__BYPASSED_OPPONENTS_RAW",
    ],
    "Receiving and movement": [
      "kpi__PXT_REC",
      "kpi__BYPASSED_DEFENDERS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING_DUETO_VERIFICATION",
      "score__AVAILABILITY_BTL_SCORE",
      "score__AVAILABILITY_IN_THE_BOX_SCORE",
    ],
    "Chance creation": [
      "kpi__EXPECTED_SHOT_ASSISTS",
      "kpi__SHOT_ASSISTS",
      "kpi__SHOT_CREATING_ACTIONS",
      "kpi__EXPECTED_GOAL_ASSISTS",
      "kpi__SHOT_XG_FROM_PASSES",
      "kpi__ASSISTS",
    ],
    "Shooting threat": [
      "kpi__SHOT_AT_GOAL_NUMBER",
      "kpi__SHOT_AT_GOAL_NUMBER_ON_TARGET",
      "kpi__SHOT_XG",
      "kpi__POSTSHOT_XG",
      "kpi__GOALS",
    ],
    "Finishing quality": [
      "score__RATIO_POSTSHOT_XG_SHOT_XG",
      "score__RATIO_GOALS_SHOT_XG",
      "score__RATIO_GOALS_POSTSHOT_XG",
      "score__RATIO_SHOTS_ON_TARGET",
      "score__RATIO_SHOTS_PER_GOAL",
    ],
    "Carrying and attacking 1v1": [
      "kpi__DISTANCE_TO_GOAL_COVERED_DRIBBLE",
      "kpi__PXT_DRIBBLE",
      "kpi__PXT_DRIBBLE_PRO",
      "score__DRIBBLE_SCORE",
      "kpi__WON_GROUND_DUELS_OFF",
      "kpi__NUMBER_OF_FOULS_WON",
    ],
    "Pressing and ball winning": [
      "kpi__NUMBER_OF_PRESSES",
      "kpi__NUMBER_OF_PRESSES_BUILD_UP",
      "kpi__NUMBER_OF_PRESSES_BETWEEN_THE_LINES",
      "kpi__NUMBER_OF_PRESSES_COUNTER_PRESS",
      "kpi__BALL_WIN_NUMBER",
      "score__INTERCEPTION_SCORE",
    ],
    "Aerial and physical duels": [
      "kpi__WON_AERIAL_DUELS",
      "score__AERIAL_DUELS_NUMBER",
      "score__RATIO_AERIAL_DUELS",
      "score__NUMBER_OF_GROUND_DUELS",
      "kpi__WON_GROUND_DUELS",
      "score__RATIO_GROUND_DUELS",
    ],
  },
  W: {
    "Circulation and link play": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Ball security and directness": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__REVERSE_PLAY_ADDED_OPPONENTS",
      "score__RATIO_REVERSE_PLAY_ADDED_OPPONENTS",
    ],
    "Line-breaking progression": [
      "kpi__PXT_PASS_PRO",
      "kpi__BYPASSED_DEFENDERS",
      "kpi__BYPASSED_OPPONENTS_MIDFIELD",
      "kpi__BYPASSED_OPPONENTS_WO_VERIFICATION",
      "kpi__BYPASSED_OPPONENTS_RAW",
    ],
    "Receiving and movement": [
      "kpi__PXT_REC",
      "kpi__BYPASSED_DEFENDERS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING_DUETO_VERIFICATION",
      "score__AVAILABILITY_BTL_SCORE",
      "score__AVAILABILITY_IN_THE_BOX_SCORE",
    ],
    "Chance creation": [
      "kpi__EXPECTED_SHOT_ASSISTS",
      "kpi__SHOT_ASSISTS",
      "kpi__SHOT_CREATING_ACTIONS",
      "kpi__EXPECTED_GOAL_ASSISTS",
      "kpi__SHOT_XG_FROM_PASSES",
      "kpi__ASSISTS",
    ],
    "Shooting threat": [
      "kpi__SHOT_AT_GOAL_NUMBER",
      "kpi__SHOT_AT_GOAL_NUMBER_ON_TARGET",
      "kpi__SHOT_XG",
      "kpi__POSTSHOT_XG",
      "kpi__GOALS",
    ],
    "Finishing quality": [
      "score__RATIO_POSTSHOT_XG_SHOT_XG",
      "score__RATIO_GOALS_SHOT_XG",
      "score__RATIO_GOALS_POSTSHOT_XG",
      "score__RATIO_SHOTS_ON_TARGET",
      "score__RATIO_SHOTS_PER_GOAL",
    ],
    "Carrying and attacking 1v1": [
      "kpi__DISTANCE_TO_GOAL_COVERED_DRIBBLE",
      "kpi__PXT_DRIBBLE",
      "kpi__PXT_DRIBBLE_PRO",
      "score__DRIBBLE_SCORE",
      "kpi__WON_GROUND_DUELS_OFF",
      "kpi__NUMBER_OF_FOULS_WON",
    ],
    "Pressing and ball winning": [
      "kpi__NUMBER_OF_PRESSES",
      "kpi__NUMBER_OF_PRESSES_BUILD_UP",
      "kpi__NUMBER_OF_PRESSES_BETWEEN_THE_LINES",
      "kpi__NUMBER_OF_PRESSES_COUNTER_PRESS",
      "kpi__BALL_WIN_NUMBER",
      "score__INTERCEPTION_SCORE",
    ],
    "Aerial and physical duels": [
      "kpi__WON_AERIAL_DUELS",
      "score__AERIAL_DUELS_NUMBER",
      "score__RATIO_AERIAL_DUELS",
      "score__NUMBER_OF_GROUND_DUELS",
      "kpi__WON_GROUND_DUELS",
      "score__RATIO_GROUND_DUELS",
    ],
  },
  ST: {
    "Link play and circulation": [
      "score__TOTAL_TOUCHES",
      "score__SUCCESSFUL_PASSES_CLEAN",
      "kpi__EXPECTED_PASSES",
      "score__PASS_COMPLETION_OVER_EXPECTED",
      "score__RATIO_PASSING_ACCURACY",
    ],
    "Ball security": [
      "kpi__BALL_LOSS_NUMBER",
      "kpi__CRITICAL_BALL_LOSS_NUMBER",
      "score__UNSUCCESSFUL_PASSES_CLEAN",
      "kpi__PXT_PASS_FAIL",
      "kpi__BALL_LOSS_ADDED_OPPONENTS",
    ],
    "Receiving and box movement": [
      "kpi__PXT_REC",
      "kpi__BYPASSED_DEFENDERS_RECEIVING",
      "kpi__BYPASSED_OPPONENTS_RECEIVING",
      "score__AVAILABILITY_BTL_SCORE",
      "score__AVAILABILITY_FDR_SCORE",
      "score__AVAILABILITY_IN_THE_BOX_SCORE",
    ],
    "Hold-up play and ground duels": [
      "score__HOLD_UP_PLAY_SCORE",
      "kpi__WON_GROUND_DUELS_OFF",
      "kpi__LOST_GROUND_DUELS_OFF",
      "score__RATIO_GROUND_DUELS_OFFENSIVE",
      "score__NUMBER_OF_GROUND_DUELS",
      "kpi__NUMBER_OF_FOULS_WON",
    ],
    "Chance creation": [
      "kpi__EXPECTED_SHOT_ASSISTS",
      "kpi__SHOT_ASSISTS",
      "kpi__SHOT_CREATING_ACTIONS",
      "kpi__EXPECTED_GOAL_ASSISTS",
      "kpi__SHOT_XG_FROM_PASSES",
      "kpi__ASSISTS",
    ],
    "Shooting threat": [
      "kpi__SHOT_AT_GOAL_NUMBER",
      "kpi__SHOT_AT_GOAL_NUMBER_ON_TARGET",
      "kpi__SHOT_XG",
      "kpi__POSTSHOT_XG",
      "kpi__GOALS",
    ],
    "Finishing quality": [
      "score__RATIO_POSTSHOT_XG_SHOT_XG",
      "score__RATIO_GOALS_SHOT_XG",
      "score__RATIO_GOALS_POSTSHOT_XG",
      "score__RATIO_SHOTS_ON_TARGET",
      "score__RATIO_SHOTS_PER_GOAL",
    ],
    "Carrying and attacking 1v1": [
      "kpi__DISTANCE_TO_GOAL_COVERED_DRIBBLE",
      "kpi__PXT_DRIBBLE",
      "kpi__PXT_DRIBBLE_PRO",
      "score__DRIBBLE_SCORE",
    ],
    "Pressing and ball winning": [
      "kpi__NUMBER_OF_PRESSES",
      "kpi__NUMBER_OF_PRESSES_BUILD_UP",
      "kpi__NUMBER_OF_PRESSES_BETWEEN_THE_LINES",
      "kpi__NUMBER_OF_PRESSES_COUNTER_PRESS",
      "kpi__BALL_WIN_NUMBER",
      "score__INTERCEPTION_SCORE",
    ],
    "Aerial target play": [
      "kpi__WON_AERIAL_DUELS_OFF",
      "kpi__LOST_AERIAL_DUELS_OFF",
      "score__RATIO_AERIAL_DUELS_OFFENSIVE",
      "score__AERIAL_DUELS_NUMBER",
      "score__OFFENSIVE_HEADER_SCORE",
      "score__HEADER_SHOT_SCORE",
    ],
  },
};

// Defending v2 (impect_metric_stability/evaluate_defending_v2.py; derived metrics in defending.js). The study's
// defending categories counted actions, which measure how much a team defends: for centre-backs, pressing and
// interception volumes went with conceding MORE. Each position now has two sets:
//   - Defending (ranked as quality): metrics that held up for players who changed clubs AND whose new clubs
//     conceded less, in 2022-25 and again in the 2026 holdout (mover r >= 0.2; incoming r > 0.1 in both);
//   - Defending style (described, not a quality ranking): duels, workload and Impect's packing regain value,
//     which describe the role but didn't pass.
// Pressing is shown only where it went with conceding less: possession-adjusted press volume for full-backs and
// midfielders (evaluate_back6_defending.py). For centre-backs it went with conceding more, for wingers and
// strikers it was negative or untestable, and where a player presses (build-up, between the lines, counter-press)
// mattered nowhere, so those positions and splits show no pressing.
const DEFENDING_V2 = {
  CB: {
    "Ball winning (possession-adjusted)": ["derived__PADJ_BALL_WINS", "derived__PADJ_LOOSE_BALL_REGAINS"],
    "Aerial dominance": ["derived__AERIAL_WIN_SHRUNK", "derived__PADJ_AERIAL_DUELS", "score__DEFENSIVE_HEADER_SCORE"],
    "Where he wins the ball": ["score__RATIO_REMOVED_OPPONENTS"],
    "Duel profile": ["derived__GROUND_WIN_SHRUNK", "derived__PADJ_GROUND_DUELS"],
    "Defensive workload": ["kpi__BALL_WIN_NUMBER", "score__INTERCEPTION_SCORE", "kpi__SECOND_BALL_WIN", "score__CLEARANCE_SCORE",
      "score__BLOCK_SCORE"],
    "Regain value": ["score__RATIO_ADDED_TEAMMATES", "score__INTERVENTIONS_SCORE_PACKING"],
  },
  FB: {
    "Where he wins the ball": ["score__RATIO_REMOVED_OPPONENTS"],
    "Pressing (possession-adjusted)": ["derived__PADJ_PRESSES"],
    "Duel profile": ["derived__GROUND_WIN_SHRUNK", "derived__AERIAL_WIN_SHRUNK", "derived__PADJ_GROUND_DUELS", "derived__PADJ_AERIAL_DUELS"],
    "Defensive workload": ["kpi__BALL_WIN_NUMBER", "score__INTERCEPTION_SCORE", "score__LOOSE_BALL_REGAIN_SCORE", "kpi__SECOND_BALL_WIN",
      "score__CLEARANCE_SCORE", "score__BLOCK_SCORE", "score__DEFENSIVE_HEADER_SCORE"],
    "Regain value": ["score__RATIO_ADDED_TEAMMATES", "score__INTERVENTIONS_SCORE_PACKING"],
  },
  MID: {
    "Ball winning (possession-adjusted)": ["derived__PADJ_BALL_WINS", "derived__PADJ_INTERCEPTIONS"],
    "Pressing (possession-adjusted)": ["derived__PADJ_PRESSES"],
    "Duel profile": ["derived__GROUND_WIN_SHRUNK", "derived__AERIAL_WIN_SHRUNK", "derived__PADJ_GROUND_DUELS", "derived__PADJ_AERIAL_DUELS"],
    "Defensive workload": ["kpi__BALL_WIN_NUMBER", "score__LOOSE_BALL_REGAIN_SCORE", "kpi__SECOND_BALL_WIN", "score__CLEARANCE_SCORE",
      "score__BLOCK_SCORE", "score__DEFENSIVE_HEADER_SCORE"],
    "Regain value": ["score__RATIO_ADDED_TEAMMATES", "score__INTERVENTIONS_SCORE_PACKING", "score__RATIO_REMOVED_OPPONENTS"],
  },
};
const pick = (set, names) => Object.fromEntries(names.map((name) => [name, set[name]]));
CATEGORIES.CB = { ...pick(CATEGORIES.CB, ["Build-up circulation", "Ball security", "Line-breaking distribution",
  "Carrying out of pressure", "Set-piece and box threat"]), ...DEFENDING_V2.CB };
CATEGORIES.FB = { ...pick(CATEGORIES.FB, ["Build-up circulation", "Ball security", "Line-breaking progression",
  "Wide receiving and overlaps", "Carrying and attacking 1v1", "Crossing and chance creation"]), ...DEFENDING_V2.FB };
// The combined midfield group (DEFENSE_MIDFIELD + CENTRAL_MIDFIELD): the study's DM categories on the ball, the CM
// set's shooting threat (so a box-to-box player's shooting still counts), and Defending v2.
// Attackers keep the ball-winning half of the study's "Pressing and ball winning".
for (const g of ["AM", "W", "ST"]) {
  CATEGORIES[g] = Object.fromEntries(Object.entries(CATEGORIES[g]).map(([name, metrics]) => (name === "Pressing and ball winning"
    ? ["Ball winning", metrics.filter((m) => !m.startsWith("kpi__NUMBER_OF_PRESSES"))] : [name, metrics])));
}
CATEGORIES.MID = { ...pick(CATEGORIES.DM, ["Circulation and tempo", "Ball security", "Line-breaking progression",
  "Receiving and positioning", "Chance creation"]), "Shooting threat": CATEGORIES.CM["Shooting threat"],
  ...pick(CATEGORIES.DM, ["Carrying and pressure escape"]), ...DEFENDING_V2.MID };

// Every metric a category shows, plus the Impect inputs PINE derives others from (derived__ names aren't Impect's).
export const ALL_METRICS = [...new Set([...Object.values(CATEGORIES).flatMap((c) => Object.values(c).flat()), ...DEFENDING_INPUTS])];
