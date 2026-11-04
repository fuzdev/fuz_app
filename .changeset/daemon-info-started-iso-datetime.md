---
'@fuzdev/fuz_app': minor
---

break: peer `@fuzdev/fuz_schema` `^0.5.2`, and `DaemonInfo.started` (`testing/daemon_info.ts`) is `pipe(string, iso_datetime)`: an RFC 3339 date and time in UTC with a four-digit year, seconds, a fraction of up to 9 digits or none, and `Z` — what `new Date().toISOString()` writes for any current date. `read_daemon_info` now answers null, with its `Invalid daemon.json` warning, for a file whose `started` is any other string — an offset, a date alone, an impossible date. To migrate: install `@fuzdev/fuz_schema` 0.5.2, and write `started` with `new Date().toISOString()` when calling `write_daemon_info` directly.
