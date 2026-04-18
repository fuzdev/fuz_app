---
'@fuzdev/fuz_app': minor
---

feat(actions): per-token WS socket tracking + `create_ws_auth_guard`

- `AUTH_API_TOKEN_ID_KEY` Hono context var; set by bearer auth to `api_token.id`, cleared by session and daemon-token middleware.
- `BackendWebsocketTransport.add_connection(ws, token_hash, account_id, api_token_id?)` — tracks the authenticating token so `token_revoke` can close just that socket via the new `close_sockets_for_token(api_token_id)`. Internal bookkeeping collapsed from three parallel maps into one `Map<Uuid, ConnectionIdentity>` (new exported type).
- `create_ws_auth_guard(transport, log)` — mirrors `create_sse_auth_guard`; dispatches `session_revoke` / `token_revoke` / `session_revoke_all` / `token_revoke_all` / `password_change` to the right closer. Ignores `outcome=failure`.
