---
'@fuzdev/fuz_app': minor
---

feat: `to_api_token_id(token)` in `auth/api_token.ts` derives a raw API token's public id — `API_TOKEN_ID_PREFIX` (`tok_`) and the first `API_TOKEN_ID_BODY_LENGTH` (12) characters of the body — and throws on a value not `is_api_token_shaped`; `generate_api_token` derives its `id` through it, and `API_TOKEN_ID_REGEX` is built from the two constants (the same pattern)
