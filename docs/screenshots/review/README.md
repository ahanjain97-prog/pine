# Big Board review flag

Captured from the running app on 2026-11-03 at 1440 × 1050 (desktop) and
400 × 1000 (phone), using browser light/dark media emulation.
Stale cards use a soft red fill, a solid REVIEW pill beside the name and a visible
review-age line, following the supplied design reference. The Big Board threshold
remains 28 days; Short Board and NCAA views are unchanged.

The players are real public player identities from the existing local snapshot.
All board placements, ranks and stars are demonstration data. No club notes,
verdicts, decisions or real board order were copied. Only the last qualifying
activity timestamp was retained, represented by a local `marked_reviewed` event
without the original action details or author. Players without qualifying
activity keep their original PINE creation timestamp.

- **Alex Krehl** demonstrates a stale starred player in two roles. His retained
  review date is September 16; the tooltip read **Last review 47 days ago**.
- **Brendan McSorley** demonstrates the no-qualifying-activity fallback to his
  September 15 creation date.
- **Aboubacar Camara** was marked reviewed using the new player-page button in
  this isolated database; his card has no flag beside the stale cards.
- `big-board-key.png` shows the new Key entry.
- `big-board-detail-light.png` and `big-board-detail-dark.png` show the refined
  cards up close, including the stale starred and freshly reviewed examples.
- `mark-reviewed.png` shows the player-page button.

Browser checks also verified that marking Alex reviewed clears both of his flags,
and that Short Board and NCAA views do not show the flag. No JavaScript errors
or card overflow occurred at either width in either theme.
