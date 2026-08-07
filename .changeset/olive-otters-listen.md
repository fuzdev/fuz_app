---
'@fuzdev/fuz_app': patch
---

fix: brand `session_id` on the `AccountSessionsRpc` adapter, and require `fuz_util >=0.68.0`

`SessionId` became a branded type in 0.105.0, but `AccountSessionsRpc.revoke`
kept declaring `{session_id: string}`. fuz_app's own code compiled because
`AccountSessionsState.submit_revoke` widened the id back to `string` on the way
through — so the gap was invisible in-repo and only surfaced in consumers,
where adapting a typed RPC client to the interface fails to assign a plain
`string` to the branded parameter. `AccountSessionsRpc.revoke` and
`AccountSessionsState.submit_revoke` now take `SessionId`; `AuthSessionJson.id`
already is one, so consumers wiring the adapter from their generated client
compile without a cast.

The `@fuzdev/fuz_util` peer range moves from `>=0.65.2` to `>=0.68.0`. The
published bundle imports `@fuzdev/fuz_util/hash_schemas.ts`, which does not
exist below 0.68 — a consumer satisfying the old range installed cleanly and
then failed at import with `Cannot find package`. The range now states what the
code actually needs.
