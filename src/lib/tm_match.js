// Bulk Transfermarkt matching for players added from Impect.
//
// Search by name, shortlist on age/club/country, then confirm with date of birth before linking.
// Anything unconfirmed is reported for one-click review instead of guessed. Requests are spaced out.

import { searchTmPlayers, fetchTmPlayer } from "./transfermarkt.js";

const state = {
  running: false, started_at: null, finished_at: null, stopped_reason: null,
  total: 0, done: 0, linked: 0, unsure: 0, no_match: 0, failed: 0,
  current: null, results: [],
};

export const matchState = () => ({ ...state, results: state.results.slice(-80) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.random() * ms * 0.6;

function score(player, cand, teamOverlap) {
  const reasons = [];
  if (player.age != null && cand.age != null && Math.abs(cand.age - player.age) <= 1) reasons.push("age");
  if (player.club && cand.club && teamOverlap(player.club, cand.club)) reasons.push("club");
  if (player.citizenship?.length && cand.citizenship.some((x) => player.citizenship.includes(x))) reasons.push("country");
  return reasons;
}

/**
 * players:  [{ id, name, birthdate, club, citizenship, age }]
 * onLink:   async (player, profile) => void   — writes the profile to the database
 * isTaken:  (tmId, playerId) => boolean       — another PINE player already uses that Transfermarkt id
 */
export async function runBulkMatch({ players, onLink, isTaken, teamOverlap, delayMs = 2500, limit = null }) {
  if (state.running) return matchState();
  const queue = limit ? players.slice(0, limit) : players;
  Object.assign(state, {
    running: true, started_at: new Date().toISOString(), finished_at: null, stopped_reason: null,
    total: queue.length, done: 0, linked: 0, unsure: 0, no_match: 0, failed: 0, current: null, results: [],
  });

  (async () => {
    let consecutiveFailures = 0;
    for (const player of queue) {
      state.current = player.name;
      try {
        const found = await searchTmPlayers(player.name);
        await sleep(jitter(delayMs));
        const ranked = found
          .map((c) => ({ ...c, reasons: score(player, c, teamOverlap) }))
          .sort((a, b) => b.reasons.length - a.reasons.length);
        const shortlist = ranked.filter((c) => c.reasons.length >= 2 || (ranked.length === 1 && c.reasons.length >= 1));

        let linked = null;
        let checked = 0;
        for (const cand of shortlist.slice(0, 3)) {
          if (isTaken(cand.tm_id, player.id)) continue;
          const profile = await fetchTmPlayer(cand.url);
          checked++;
          await sleep(jitter(delayMs));
          const dobAgrees = player.birthdate && profile.birthdate && player.birthdate === profile.birthdate;
          const strongWithoutDob = !player.birthdate && cand.reasons.length === 3 && shortlist.length === 1;
          if (dobAgrees || strongWithoutDob) {
            await onLink(player, profile);
            linked = { name: profile.name, url: profile.tm_url, club: profile.club, by: dobAgrees ? "name + date of birth" : "name, age, club and country" };
            break;
          }
        }
        consecutiveFailures = 0;
        if (linked) {
          state.linked++;
          state.results.push({ player: player.name, id: player.id, outcome: "linked", detail: `${linked.name} (${linked.club || "no club"}) — ${linked.by}` });
        } else if (!found.length) {
          state.no_match++;
          state.results.push({ player: player.name, id: player.id, outcome: "no_match", detail: "no Transfermarkt results" });
        } else {
          state.unsure++;
          state.results.push({
            player: player.name, id: player.id, outcome: "unsure",
            detail: checked ? "date of birth didn't match any candidate" : `${found.length} result(s), none close enough`,
          });
        }
      } catch (e) {
        consecutiveFailures++;
        state.failed++;
        state.results.push({ player: player.name, id: player.id, outcome: "failed", detail: e.message });
        await sleep(jitter(delayMs * 2));
        if (consecutiveFailures >= 5) {
          state.stopped_reason = `Stopped after 5 failures in a row (last: ${e.message}). Transfermarkt may be blocking us.`;
          break;
        }
      } finally {
        state.done++;
      }
    }
    state.running = false;
    state.current = null;
    state.finished_at = new Date().toISOString();
  })();

  return matchState();
}
