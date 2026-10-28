---
'@fuzdev/fuz_app': minor
---

break: `ConnectionRegistry.register_pending` and `add_connection` take the connection's `ConnectionIdentity` — `(ws, identity, abort_controller?)`, as the Rust `ConnectionRegistry::register_pending(sender, identity, signal)` — instead of the positional `token_hash, account_id, api_token_id?, abort_controller?, required_roles?`. To migrate: `registry.add_connection(ws, hash, account_id, token_id, controller, roles)` is `registry.add_connection(ws, {session_hash: hash, account_id, api_token_id: token_id, required_roles: roles}, controller)`, with `null` for an absent hash or token id and `[]` for an ungated endpoint
