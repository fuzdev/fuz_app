---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `format_db_status` renders the Rust `fuz_db` report layout

- `format_db_status` now prints the same body as the Rust twin's `format_db_status`, byte for byte for a connected status: lowercase `tables:` / `migrations:`, table rows directly under the count, one aligned line per namespace with its state (`up-to-date`, `PENDING <n>`, or `DIVERGED`), `applied/declared`, and `latest:` (the last applied name, `(none)` when nothing is applied), then a `diverged:` or `pending:` detail line
- the `migrations:` header always prints, even with no namespaces; the `Connection: OK` line is gone; a failed connection renders `  connection: FAILED (<error>)`
- divergence detail quotes names in backticks (`` database has `cell_v0`, code has `full_cell_schema` ``), matching the Rust `Divergence` `Display`
- the output ends in a newline — a script printing it with `console.log` should `trimEnd()` it first
- fix: a binary-older namespace (more applied than the code declares) reports `applied/declared` (`3/2`), not `3/3`
- add `display_db_url`, the twin of the Rust CLI's URL display, for a status script's `url:` line: it renders `postgres://[user@]host:port[/dbname]` from the URL as node-postgres reads it (a `user`, `host`, or `port` query parameter overriding the URL's), percent-encodes the user and database name, never prints the password, query, or fragment, and prints `(not a URL; hidden)` when there is no plain host, the user looks misparsed, or the URL holds a malformed escape
