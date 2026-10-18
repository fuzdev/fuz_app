---
'@fuzdev/fuz_app': minor
---

feat: refuse malformed bearer tokens before the database and return a parsed scope from `query_validate_api_token`

- `query_validate_api_token` returns `ValidatedApiToken` — the row with `scope` parsed to a `TokenScope` (it still refuses a row whose stored scope is unreadable); callers drop their own `parse_stored_token_scope` call
- the bearer middleware soft-fails a value that fails `is_api_token_shaped` (`secret_fuz_token_` plus exactly 43 base64url chars) before any query; tests that mock the lookup need well-formed bearer values — `create_test_raw_api_token` in `testing/entities.ts` makes them
- adds `API_TOKEN_ENTROPY_BYTES`, `API_TOKEN_BODY_LENGTH`, `API_TOKEN_REGEX`, and `is_api_token_shaped` to `auth/api_token.ts`, `create_test_validated_api_token` to `testing/entities.ts`, and the `malformed_bearer` conformance principal; the `browser_bearer_replay` equivalence group is renamed `bearer_soft_fail`
