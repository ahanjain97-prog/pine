# Shared summary states

Captured from the local app with fictional players and summaries in an isolated SQLite database.
Desktop: 1440 × 1000. Phone: 400 × 1000. Both light and dark themes were checked.

Saving replaces the editor with readable text and a Saved marker. Edit reopens the saved text;
Cancel discards edits. Delete asks for confirmation and returns the panel to its empty state.
Failed requests keep the text and offer a retry. Saving a summary preserves unfinished staff notes.

Existing summaries appear as saved immediately: the view reads the same `players.summary` field
as before. There is no migration, copying, or automatic resave. Opening the editor and cancelling
does not write to the database. Existing activity rows remain intact; the activity log records
who edited the summary and when, but does not store earlier versions of the summary text.

| State | Desktop light | Desktop dark | Phone light | Phone dark |
| --- | --- | --- | --- | --- |
| Empty / deleted | [View](desktop-light-empty.png) | [View](desktop-dark-empty.png) | [View](phone-light-empty.png) | [View](phone-dark-empty.png) |
| New draft | [View](desktop-light-new.png) | [View](desktop-dark-new.png) | [View](phone-light-new.png) | [View](phone-dark-new.png) |
| Saving | [View](desktop-light-saving.png) | [View](desktop-dark-saving.png) | [View](phone-light-saving.png) | [View](phone-dark-saving.png) |
| Saved | [View](desktop-light-saved.png) | [View](desktop-dark-saved.png) | [View](phone-light-saved.png) | [View](phone-dark-saved.png) |
| Editing | [View](desktop-light-editing.png) | [View](desktop-dark-editing.png) | [View](phone-light-editing.png) | [View](phone-dark-editing.png) |
| Delete confirmation | [View](desktop-light-delete.png) | [View](desktop-dark-delete.png) | [View](phone-light-delete.png) | [View](phone-dark-delete.png) |
| Failed save | [View](desktop-light-save-error.png) | [View](desktop-dark-save-error.png) | [View](phone-light-save-error.png) | [View](phone-dark-save-error.png) |

[Player page in context](desktop-light-player.png).

Browser checks used the actual local API and database for create, edit, reload persistence,
cancel, delete, and preservation of another composer's draft. Delayed and failed requests were
intercepted to check pending controls, retry, and retention of the existing saved summary on a
failed deletion. Empty/unchanged saves are disabled; HTML-like text is displayed literally and
long words wrap. All four size/theme combinations passed without page errors or horizontal overflow.

Compatibility was also checked against a database created with the pre-change `main` code.
Existing summaries (including spaces, paragraph breaks, Unicode, and HTML-like text) appeared
in the saved view and reopened unchanged for editing. Empty values retained their original
database values. Viewing and cancelling edits issued no write requests, and the stored summaries,
player update timestamps, and existing activity rows were identical before and after the checks.
