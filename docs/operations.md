# Running the server: what to look at

For whoever keeps the server going (Howard, or a person at a terminal). Everything here is also in the app:
**Settings > System** shows it to the owner.

## The start line

Every start prints one line that says what came up:

```
[cleftbot] build 979469a, node v22.x, database /opt/hq/bot-hq-local/data/bothq.db (DB_PATH): 1 account(s), 5 bot(s), 1972 rows
```

If the app shows the wrong bots after a restart, read this line first: it names the database that was opened
and what is in it. `(default path)` instead of `(DB_PATH)` means the path is not pinned in `.env`.

## Settings > System

| Check | Turns yellow or red when |
|---|---|
| Database | SQLite's own check found a problem |
| Database log | the write-ahead log has grown past 256 MB |
| Other database files | another `*.db` file sits beside the live one (move it away) |
| Daily snapshots | the last copy failed, or none was made for two days |
| Off-site backup | the last run failed, or none ran for 9 days (red after 16) |
| Disk space | less than 10 GB or 10% free (red under 2 GB or 3%) |
| each bot's agent | the agent does not answer |
| a link (Sheldon) | the Slack link is down for more than a few minutes |
| Routines | the scheduler is off on this server |
| Errors in the last hour | anything was logged as an error (the latest is named) |
| Server load | everything waited more than 1.5 s on one piece of work, or memory is high |

A check that stays red for two looks in a row (five minutes) sends the owner a notification, once a day per
problem, and takes it down when the problem is over.

**Recent problems** is the server's own warnings and errors, kept across restarts. "Clear the list" empties
it once read. **Copy report** puts the whole page on the clipboard as text.

## Finding one failure

Every API answer has an `X-Request-Id` header. When the server itself fails (a 500), the error shown in the
app ends with `(ref 3fa9c1d2)` and the log has the same reference:

```
journalctl -u bot-hq-local | grep 'ref 3fa9c1d2'
```

## Sign-ins

Settings > Account lists the devices signed in. Helper programs (Claude threads, tests) are counted on one
line; one that is not used for two weeks is signed out by the server. People's devices sign out by
themselves 30 days after their last use.

## Updates

When the server stops for an update it tells the connected apps first. They show "The server is updating"
and reconnect as soon as it answers; reads that hit the restart are tried again by themselves.

## Settings that matter here (`.env`)

| Setting | What it does |
|---|---|
| `DB_PATH` | the live database; keep it pinned |
| `ALLOW_EMPTY_DB=1` | start on an empty database although one with accounts sits beside it |
| `DB_SNAPSHOTS_KEEP` | daily copies kept in `data/snapshots` (default 14, 0 = off) |
| `DB_SNAPSHOTS_DIR` | another folder for those copies |
| `CLEFT_AUDIT_LOG` | the maintainer's log the "last update" line is read from |
| `BACKUP_HISTORY_FILE` | the off-site backup's history the backup check reads |
