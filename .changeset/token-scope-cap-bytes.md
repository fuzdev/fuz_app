---
'@fuzdev/fuz_app': minor
---

break: the token-scope cap `MAX_TOKEN_SCOPE_BYTES` (`auth/token_scope.ts`) counts UTF-8 bytes of the document's compact JSON, as the Rust spine does, where it counted UTF-16 code units. `account_token_create` refuses a scope over 4096 bytes that is within 4096 code units, one with non-ASCII method names, with `invalid_params` and `ERROR_TOKEN_SCOPE_INVALID`, and its message gives the size in bytes; a stored token whose scope is such a document now fails closed, as it already did on the Rust spine: refused as a bearer and listed `unreadable`. `parse_token_scope` and `parse_stored_token_scope` measure the compact serialization of the parsed document, so a document handed back as text, such as the spaced text Postgres prints a `jsonb` as, is held to the cap it was minted under. The new `testing/token_scope_fixtures.ts` builds scope documents to a size.
