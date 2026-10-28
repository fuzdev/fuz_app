---
'@fuzdev/fuz_app': minor
---

fix: an RPC `POST` whose body is a response (`{jsonrpc, id, result | error}`) answers `invalid_request` on `id: null`, as a notification does and as the Rust spine answers both, rather than echoing its `id`, and only a refused request envelope carries the DEV-only `data.issues`; `create_rpc_envelope_cases` gains the response-shaped-body case, so a consumer's `describe_rpc_attack_surface_tests` and `describe_rpc_adversarial_cross_tests` run it against its own backends
