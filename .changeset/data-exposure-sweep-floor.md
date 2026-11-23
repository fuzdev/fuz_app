---
'@fuzdev/fuz_app': minor
---

break: `describe_data_exposure_tests`' 2xx sweep sends each public route as an authenticated account too, fails a non-public route's request whose credential didn't authenticate, and fails when it saw no data to check

- feat: a public route is swept anonymously and again as an authenticated account (a fresh account for a mutation) — a public route may answer an authenticated caller with more, as the status route names the account, and before only its anonymous answer was checked
- fix: a mutation sent as the authed principal runs on a fresh account (`round_trip_uses_fresh_account`, the round trip's rule), so one that ends its session (`POST /logout`) no longer leaves every later authenticated route sent on a revoked session
- break: a non-public route's request whose credential is refused as unauthenticated (`is_unauthenticated_refusal`: a 401 reading `authentication_required` or naming no reason) fails the test, naming the route and principal — before it was skipped as a non-2xx, so a dead credential left its route unchecked. A public route's 401 is its own answer and isn't read this way, on either pass
- break: `all 2xx responses pass field blocklists` fails when no 2xx JSON response carried data (a key besides `ok` at any depth, what the blocklists walk). A sweep whose every request was refused or acknowledged with `{ok: true}` alone passed with nothing checked; a suite now failing this way has path params no route accepts (`param_values`) or nothing but acknowledgments to sweep
