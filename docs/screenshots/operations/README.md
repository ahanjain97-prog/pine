# Operations navigation

Big Board, Short Board, NCAA and Activity remain individual top-bar tabs.
Operations groups Review, Database, Impect, Analysis and Staff. Review is visible
only to the review team, and Staff only to admins. Operations stays selected on
its pages and on player profiles, with the current destination highlighted in
the dropdown. Pending reviews appear on both Operations and its Review link.

| View | Light | Dark |
|---|---|---|
| Operations, desktop (1440 × 900) | [Screenshot](desktop-light.png) | [Screenshot](desktop-dark.png) |
| Operations, phone (390 × 844) | [Screenshot](phone-light.png) | [Screenshot](phone-dark.png) |

Screenshots use an isolated local server with a disposable database and provider
access disabled by `scripts/fixtures/offline-fetch.mjs`. Three fictional players
(Jamie Rivers, Taylor Vale and Casey Brook), example clubs and demo staff names
are added only to that database. There are no staff reports, verdicts, decisions
or board rankings in the fixture.

Browser verification covered both themes and viewport sizes, every dropdown and
top-level destination, click and touch interaction, Enter/Space opening, Tab
navigation, Escape with focus return, click-away dismissal, browser Back,
player-profile highlighting, phone menu bounds and clipping, resize dismissal,
the NCAA database view, review-team visibility, and admin-only Staff visibility.
Pending-review badges were verified at startup and after polling, including
clearing the count; opening the dropdown rotates only the caret, not the badge.
No JavaScript errors or horizontal document overflow occurred in these checks.

Automated checks: `npm run check`, `npm test` (204 passing), and
`python3 -m unittest discover -s scripts -p '*_test.py' -v` (13 passing).
