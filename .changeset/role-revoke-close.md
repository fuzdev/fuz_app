---
'@fuzdev/fuz_app': minor
---

break: `role_grant_revoke` of a global grant and a `self_service_role_set` disable close the account's connections gated on the revoked role themselves, after the revocation commits (`queue_connection_close`, `{kind: 'role'}`), instead of only through the revocation guard reacting to the `role_grant_revoke` audit row — that row is written on the pool, fail-open, so a failed write left a demoted account's role-gated sockets and audit stream open; the guard now repeats the close, as for every other revocation, and an endpoint mounted with `register_action_ws` whose registry joined `deps.connection_closer` closes on a role revoke with no guard registered. `create_role_grant_offer_actions` and `create_self_service_role_actions` take `RevokingActionFactoryDeps`, so `connection_closer` is required. To migrate: pass `connection_closer` (`AppDeps` already carries it; hand-built deps on a backend with no live-connection surface pass `noop_connection_closer`)
