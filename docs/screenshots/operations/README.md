# Operations navigation

The top bar groups Database, Activity and Staff under a click-operated Operations
dropdown. Staff is visible only to admins. Operations stays selected on all three
pages and on player profiles; the current destination is highlighted inside it.

| View | Light | Dark |
|---|---|---|
| Desktop (1440 × 900) | [Screenshot](desktop-light.png) | [Screenshot](desktop-dark.png) |
| Phone (390 × 844) | [Screenshot](phone-light.png) | [Screenshot](phone-dark.png) |

Screenshots use the isolated `node scripts/preview-analysis.mjs` server with
three fictional players (Jamie Rivers, Taylor Vale and Casey Brook), example
clubs, and demo staff names added only to its disposable database. There are no
staff reports, verdicts, decisions or board rankings in the fixture.

Browser verification covered both themes and viewport sizes, every destination,
click and touch interaction, Enter/Space opening, Tab navigation, Escape with
focus return, click-away dismissal, selecting the current page, browser Back,
player-profile highlighting, phone menu bounds and clipping, dismissal when the
nav scrolls or the viewport resizes, and non-admin Staff visibility and access.
No JavaScript errors or horizontal document overflow occurred in these checks.

Automated checks: `npm run check`, `npm test` (204 passing), and
`python3 -m unittest discover -s scripts -p '*_test.py' -v` (13 passing).
