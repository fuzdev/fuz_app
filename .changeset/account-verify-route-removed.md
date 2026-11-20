---
'@fuzdev/fuz_app': minor
---

break: the `GET /verify` route is removed — the `account_verify` RPC action is the credential probe

- break: `create_account_route_specs` no longer mounts `GET /verify` (the empty-body nginx `auth_request` shim), which the Rust spine never served; the path answers 404 on both spines now. A deployment gating with `auth_request` needs a probe route of its own; `account_verify` answers the typed account over RPC
- break: `create_account_route_shapes` returns `[login, logout, password]` — a positional destructure of four shapes loses its second slot
- break: `TOKEN_SURFACES` no longer lists `account_verify`, and the `TokenSurface` type narrows with it; the spine mounts no route declaring `surface:account_verify`
- break (testing): `rest_auth_route_suffixes` and `RestAuthRouteSuffix` lose `'/verify'`, so `find_auth_route(specs, '/verify', …)` throws
