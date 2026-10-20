---
'@fuzdev/fuz_app': minor
---

fix: `account_token_create` refuses an over-cap scope with 400 and dedups method names

- a `scope` whose stored document would pass `MAX_TOKEN_SCOPE_BYTES` answers `400 invalid_params` before anything is written, instead of `500` from the insert
- `token_scope_from_input` collapses duplicate `methods` (first occurrence kept), so `account_token_list` labels a `['a', 'a']` scope `1 methods`, as the Rust spine does
