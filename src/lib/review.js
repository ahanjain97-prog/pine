import { logActivity } from "../db.js";

export const REVIEW_AFTER_DAYS = 28;
export const SHORT_BOARD_REVIEW_AFTER_DAYS = 14;

// Staff review only: syncs, imports, card requests and hidden history never reset the clock.
const REVIEW_ACTIONS = [
  "added_note", "edited_note", "set_verdict", "set_decision",
  "added_role", "moved_on_board", "copied_on_board", "marked_reviewed",
];

// One grouped query for every board player, shared across all of their roles. No backfill.
export function boardLastReviews(db) {
  return new Map(db.all(`
    SELECT p.id, coalesce(max(datetime(a.created_at)), p.created_at) AS last_review_at
    FROM players p LEFT JOIN activity a ON a.player_id = p.id
      AND a.hidden = 0 AND a.user_id IS NOT NULL
      AND a.action IN (${REVIEW_ACTIONS.map(() => "?").join(",")})
    WHERE EXISTS (SELECT 1 FROM board_entries b WHERE b.player_id = p.id)
    GROUP BY p.id`, ...REVIEW_ACTIONS).map((r) => [r.id, r.last_review_at]));
}

export function registerReview(app, { db, getPlayer }) {
  app.post("/api/players/:id/review", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Not signed in" }, 401);
    const p = getPlayer(c.req.param("id"));
    logActivity(db, user.id, p.id, "marked_reviewed");
    return c.json({ ok: true });
  });
}
