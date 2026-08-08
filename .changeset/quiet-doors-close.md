---
'@fuzdev/fuz_app': patch
---

fix: an unreadable token file now closes the bootstrap window

`POST /api/account/bootstrap` returned `404 token_file_missing` and left
`bootstrap_status.available` set, so every later request took the same leg and
wrote another `bootstrap` failure audit row — one INSERT per request from any
unauthenticated caller, for the life of the process. `check_bootstrap_status`
already reads an unreadable file as unavailable at startup, so the boot check
and the request path disagreed about the same condition. Reachable by deleting
the token or narrowing its permissions after boot.

They now agree: the first such failure flips `available` to `false`, later
requests take the write-free `403 already_bootstrapped` short-circuit, and
`GET /api/account/status` stops advertising a window that can't be walked
through.

**Behavior change on the error path.** A deployment whose token file becomes
unreadable mid-window now needs the file restored **and** the server restarted
before bootstrap reopens. Bootstrap could not have succeeded in that state
either way; the refusal is just sticky now.

Converges with the Rust spine's `bootstrap_handler`.
