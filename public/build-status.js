// Fixed worker codes only. Raw provider errors and local paths stay on the worker.
export const BUILD_FAILURES = {
  not_covered: "This season is not covered by the provider.",
  no_minutes: "No playing minutes were found for this player in this season.",
  position_unavailable: "This player has no data for the requested position.",
  goalkeeper: "Goalkeeper builds are not supported.",
  data_missing: "Required build data is missing.",
  data_mismatch: "Provider data still disagrees after automatic repair. The build stopped to avoid incorrect stats.",
  provider_unavailable: "The data provider is unavailable. Automatic recovery could not complete.",
  build_timeout: "The build reached its 15-minute limit.",
  render_failed: "The card could not be drawn.",
  failed: "The build failed unexpectedly. Check the worker log using this job ID.",
};
export const BUILD_PROGRESS = {
  fetching_events: "Refreshing missing or stale match events",
  reconciling_data: "Repairing season data automatically",
  retrying_provider: "Retrying the data provider automatically",
};
export const buildFailure = code => BUILD_FAILURES[code] || BUILD_FAILURES.failed;
export const buildProgress = code => BUILD_PROGRESS[code] || "";
