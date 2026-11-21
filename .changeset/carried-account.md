---
'@fuzdev/fuz_app': minor
---

break: the authorization phase builds on the account the credential leg read, and an account removed after that read answers 401, never 500

- break: `ResolvedAuth`'s arms carry `account: Account` (the row the credential leg read) in place of `account_id`; the daemon-token leg reads its keeper's row per request (a missing keeper is no credential). `create_test_resolved_auth` takes `{account}`
- break: `apply_authorization_phase(deps, account, auth, acting)` takes the `Account | null` the credential leg read, reading the account again only when it finds no actor; `resolve_acting_actor` answers the actor row (`{ok: true, actor}`) or `account_removed`; `build_request_context(deps, account, actor)` reads only the role grants and never answers `null`; `build_account_context` is removed. `get_public_account_id(route)` is now `get_public_account(route)`, answering the `Account`
- break: `ERROR_ACCOUNT_VANISHED` and `REST_ACCOUNT_VANISHED` are removed with the 500 they named; surfaces no longer list it. An account-grain handler whose account is deleted after the credential leg runs on the row that leg read, as on the Rust spine. An actor-grain call finds no actor and answers the dead credential's 401 `authentication_required` (RPC `unauthenticated`) when the account was removed — `no_actors_on_account` stays the 500 for a live account with no actor. `derive_route_errors` declares that 401 on every route with an actor axis, actor-optional included, so consumers' surface snapshots move
- fix: `account_verify` re-reads the account live and answers the dead credential's 401 for one removed since the credential leg, as account status already answered the anonymous 401 (the Rust spine now does both)
