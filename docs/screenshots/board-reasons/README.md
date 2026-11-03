# Board reasons — screenshots and browser checks

All players, clubs, placements, review events and written reasons are synthetic.
Staff names are the repository's default seed accounts. No real club notes,
verdicts, decisions or board rankings are included.

Each flow below was exercised in the running app at **1440 × 1000** (desktop)
and **400 × 1000** (phone), in both light and dark mode. Dialog images are native
browser element captures; history images show the actual Board history panel.

| Flow | Desktop light | Desktop dark | Phone light | Phone dark |
| --- | --- | --- | --- | --- |
| Player page: add role | [View](desktop-light-player-add.png) | [View](desktop-dark-player-add.png) | [View](phone-light-player-add.png) | [View](phone-dark-player-add.png) |
| Board + picker: add existing player | [View](desktop-light-board-add.png) | [View](desktop-dark-board-add.png) | [View](phone-light-board-add.png) | [View](phone-dark-board-add.png) |
| Add player with two roles | [View](desktop-light-new-player-add.png) | [View](desktop-dark-new-player-add.png) | [View](phone-light-new-player-add.png) | [View](phone-dark-new-player-add.png) |
| Transfermarkt Add player with role | [View](desktop-light-tm-player-add.png) | [View](desktop-dark-tm-player-add.png) | [View](phone-light-tm-player-add.png) | [View](phone-dark-tm-player-add.png) |
| NCAA + BB | [View](desktop-light-ncaa-add.png) | [View](desktop-dark-ncaa-add.png) | [View](phone-light-ncaa-add.png) | [View](phone-dark-ncaa-add.png) |
| Duplicate into a new role | [View](desktop-light-duplicate-add.png) | [View](desktop-dark-duplicate-add.png) | [View](phone-light-duplicate-add.png) | [View](phone-dark-duplicate-add.png) |
| Duplicate into an existing unstarred role | [View](desktop-light-duplicate-promote.png) | [View](desktop-dark-duplicate-promote.png) | [View](phone-light-duplicate-promote.png) | [View](phone-dark-duplicate-promote.png) |
| Player page: star on | [View](desktop-light-player-promote.png) | [View](desktop-dark-player-promote.png) | [View](phone-light-player-promote.png) | [View](phone-dark-player-promote.png) |
| Board card: star on | [View](desktop-light-card-promote.png) | [View](desktop-dark-card-promote.png) | [View](phone-light-card-promote.png) | [View](phone-dark-card-promote.png) |
| Player page: star off | [View](desktop-light-player-drop.png) | [View](desktop-dark-player-drop.png) | [View](phone-light-player-drop.png) | [View](phone-dark-player-drop.png) |
| Board card: star off, Other requires note | [View](desktop-light-card-drop-other.png) | [View](desktop-dark-card-drop-other.png) | [View](phone-light-card-drop-other.png) | [View](phone-dark-card-drop-other.png) |
| Short Board card: star off | [View](desktop-light-short-board-drop.png) | [View](desktop-dark-short-board-drop.png) | [View](phone-light-short-board-drop.png) | [View](phone-dark-short-board-drop.png) |
| Player page: remove Big Board role | [View](desktop-light-take-off.png) | [View](desktop-dark-take-off.png) | [View](phone-light-take-off.png) | [View](phone-dark-take-off.png) |
| Add player without a board role: optional reason | [View](desktop-light-track-optional.png) | [View](desktop-dark-track-optional.png) | [View](phone-light-track-optional.png) | [View](phone-dark-track-optional.png) |
| Board history after add/promote/drop/remove | [View](desktop-light-board-history.png) | [View](desktop-dark-board-history.png) | [View](phone-light-board-history.png) | [View](phone-dark-board-history.png) |

All four passes also checked:

- Server rejection of reasonless adds, star transitions, removals, copies and
  player creation with roles, before data changes; reasonless staff Impect role
  imports are rejected before provider access.
- Cancel/Escape preserves the existing picker/form and leaves the board unchanged.
  Cancelling a duplicate retains the original card and clears drag styling.
- Other requires a nonblank note, and every new role in multi-role creation gets
  its own history row. Optional tracking can save fields or skip them entirely.
- Reranks and role transfers need no written reason and preserve stars and reason
  links. For the off-screen phone transfer, the test dispatches HTML5 drag events;
  the copy and cancellation flows use browser pointer drags.
- Existing entries retain the requested legacy hover text. New entries show their
  role's explanation; reasons also appear in Activity and persist after removal.
- No card/dialog overflow or JavaScript errors occurred.

Transfermarkt requests use synthetic upstream HTML at the QA network boundary;
the real preview, parser, creation and reason-validation code runs. No external
provider requests or production database writes were made.
