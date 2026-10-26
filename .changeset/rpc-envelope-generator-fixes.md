---
'@fuzdev/fuz_app': minor
---

fix: `create_rpc_envelope_cases` pins its anonymous non-object `GET` params ordering case on a read that requires an identity, no longer on an identity-optional read whose anonymous caller is admitted; `generate_valid_value` picks a number inside the schema's bounds (`.negative()`, `.min(n)`) instead of always `1`
