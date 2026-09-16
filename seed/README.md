If `pine-seed.sqlite` is present here and the server finds no database at `PINE_DB` (or `data/pine.db`),
it copies this snapshot in on startup. Used once to move the local database onto the hosted volume;
an existing database is never overwritten. Delete the snapshot after the move.
