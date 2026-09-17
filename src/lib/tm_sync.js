export const TM_FIELDS = [
  "name", "birthdate", "birthplace", "height_cm", "foot", "position", "club", "club_tm_id", "club_logo_url",
  "league", "league_code", "joined", "contract_expires", "loan_from", "loan_contract_expires", "agent",
  "market_value_eur", "market_value_display", "national_team", "photo_url", "shirt_number", "tm_id", "tm_url",
];

export const MANUAL_TM_FIELDS = [
  "name", "birthdate", "birthplace", "height_cm", "foot", "position", "club", "league", "joined",
  "contract_expires", "loan_from", "agent", "market_value_display", "national_team", "photo_url",
];

// Keep hidden Transfermarkt metadata aligned with the visible field a person edited.
const RELATED_FIELDS = {
  club: ["club", "club_tm_id", "club_logo_url"],
  league: ["league", "league_code"],
  position: ["position", "other_positions"],
  market_value_display: ["market_value_display", "market_value_eur"],
};

export function manualTmOverrides(player, changes) {
  const overrides = new Set(player.tm_overrides || []);
  for (const field of MANUAL_TM_FIELDS) {
    if (!(field in changes) || changes[field] === player[field]) continue;
    for (const related of RELATED_FIELDS[field] || [field]) overrides.add(related);
  }
  return [...overrides].sort();
}

export function releaseTmOverrides(overrides, fields) {
  const next = new Set(overrides || []);
  for (const field of fields.filter((f) => MANUAL_TM_FIELDS.includes(f))) {
    for (const related of RELATED_FIELDS[field] || [field]) next.delete(related);
  }
  return [...next].sort();
}

export function tmConflicts(player, profile) {
  const overrides = new Set(player.tm_overrides || []);
  return MANUAL_TM_FIELDS
    .filter((field) => overrides.has(field) && profile[field] !== undefined && profile[field] !== player[field])
    .map((field) => ({ field, current: player[field], transfermarkt: profile[field] }));
}

export function tmSyncFields(player, profile, syncedAt = new Date().toISOString()) {
  const overrides = new Set(player.tm_overrides || []);
  const fields = Object.fromEntries(
    TM_FIELDS.filter((field) => profile[field] !== undefined && !overrides.has(field))
      .map((field) => [field, profile[field]])
  );
  if (!overrides.has("citizenship")) fields.citizenship = profile.citizenship;
  if (!overrides.has("other_positions")) fields.other_positions = profile.other_positions;
  fields.tm_synced_at = syncedAt;
  return fields;
}
