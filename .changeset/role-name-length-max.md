---
'@fuzdev/fuz_app': minor
---

**breaking** fix: a role name is at most 64 characters — `RoleName` gains the cap (new `ROLE_NAME_LENGTH_MAX`), so every consumer of the grammar holds it. A `role` longer than that on `role_grant_assign`, `role_grant_offer_create` or `self_service_role_set` is refused `invalid_params` at input validation, where an all-lowercase string of any length used to pass the grammar and reach a failure audit row; `create_role_schema` throws at assembly on a consumer role longer than 64 characters, as does a self-service eligible role. No migration and no column constraint: a longer role already stored is untouched, and fails the output schemas that declare `RoleName`

- testing: `describe_role_grant_role_grammar_cross_tests` adds an over-length all-lowercase role to its off-grammar cases, and a role exactly at the cap to its control, and asserts the two controls' failure rows are present. A twin-impl consumer's other backend caps role names at 64 too, or the suite fails
