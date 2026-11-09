# Boards and Operations navigation

The top bar groups Big Board, Short Board and NCAA under Boards, and Database,
Impect, Activity and Staff under Operations. Staff is visible only to admins. Each menu
stays selected on its pages, with the current destination highlighted inside it.
Operations also stays selected on player profiles. Opening either menu closes
the other.

| View | Light | Dark |
|---|---|---|
| Boards, desktop (1440 × 900) | [Screenshot](boards-desktop-light.png) | [Screenshot](boards-desktop-dark.png) |
| Boards, phone (390 × 844) | [Screenshot](boards-phone-light.png) | [Screenshot](boards-phone-dark.png) |
| Operations, desktop (1440 × 900) | [Screenshot](desktop-light.png) | [Screenshot](desktop-dark.png) |
| Operations, phone (390 × 844) | [Screenshot](phone-light.png) | [Screenshot](phone-dark.png) |

Screenshots use an isolated local server with a disposable database and provider
access disabled by `scripts/fixtures/offline-fetch.mjs`. Three fictional players
(Jamie Rivers, Taylor Vale and Casey Brook), example clubs and demo staff names
are added only to that database. There are no staff reports, verdicts, decisions
or board rankings in the fixture.

Browser verification covered both themes and viewport sizes, every destination,
click and touch interaction, Enter/Space opening, Tab navigation, Escape with
focus return, click-away dismissal, selecting the current page, browser Back,
player-profile highlighting, phone menu bounds and clipping, dismissal when the
nav scrolls or the viewport resizes, and non-admin Staff visibility and access.
Boards checks also covered all three destinations, the NCAA database view,
legacy Short Board links, returning via browser Back, the separate Review tab,
and mutual dismissal when switching between Boards and Operations.
Impect checks covered dropdown navigation, direct links, active Operations and
Impect highlighting, browser Back, and availability for non-admin staff.
No JavaScript errors or horizontal document overflow occurred in these checks.

Automated checks: `npm run check`, `npm test` (204 passing), and
`python3 -m unittest discover -s scripts -p '*_test.py' -v` (13 passing).
