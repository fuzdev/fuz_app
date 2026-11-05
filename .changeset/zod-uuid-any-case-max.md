---
'@fuzdev/fuz_app': patch
---

fix: the Zod `Uuid` (and so `UuidWithDefault` and `ActingActor`) takes the max UUID in any case, lowercased, as RFC 9562 §4, the fuz_schema twin in `primitive_schemas_fuz.ts`, and the Rust spine's `is_valid_uuid` read it, where `z.uuid()` took it in lowercase only: an upper- or mixed-case `FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF` in a `Uuid` input, params or query field, `?acting=` included, now passes validation (answering, say, not-found or `actor_not_on_account` instead of `invalid_params` / `invalid_query_params`), as on the Rust spine. Every other string gets the verdict and output it got. Issues and JSON Schema keep `format: 'uuid'`; the JSON Schema `pattern` of every `Uuid` field (in `AppSurface` and anything rendered from it) is now fuz_schema's `uuid` pattern string, so a committed surface snapshot regenerates with only that string changed.
