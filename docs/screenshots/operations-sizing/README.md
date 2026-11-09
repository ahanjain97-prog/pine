# Operations dropdown sizing

The dropdown explicitly uses its content height and packs grid rows at the top.
This prevents the tall, widely spaced menu reported on the Staff page.

| View | Light | Dark |
|---|---|---|
| Desktop (1280 × 720) | [Screenshot](desktop-light.png) | [Screenshot](desktop-dark.png) |
| Phone (390 × 844) | [Screenshot](phone-light.png) | [Screenshot](phone-dark.png) |

Screenshots use WebKit with a disposable local database, fictional staff names,
example.test email addresses and provider access disabled by
`scripts/fixtures/offline-fetch.mjs`.

Verified in Chromium and WebKit at both widths and in both themes: compact menu
and link heights, 2 px row gaps, viewport bounds, selected destination, shrinking
to three links without Staff, Enter/Space opening, Escape dismissal and focus
return, click-away dismissal, and navigation to Database. No JavaScript errors or
horizontal document overflow occurred. The reported stretching did not reproduce
in the current browser engines before the change; sizing is now explicit instead
of depending on their automatic popover sizing.

Validation: `npm run check` (38 files), `npm test` (204 passing), and
`python3 -m unittest discover -s scripts -p '*_test.py' -v` (13 passing).
