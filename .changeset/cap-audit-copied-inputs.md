---
'@fuzdev/fuz_app': minor
---

**breaking** fix: three caller-supplied strings that are copied into audit metadata are length-capped at input validation, counted in UTF-16 code units — `account_token_create`'s `name` at 255 (new `API_TOKEN_NAME_LENGTH_MAX`), the `kind` on `cell_create` and on the `cell_list` filter at 64 (new `CELL_KIND_LENGTH_MAX`), and the `scope_kind` on `role_grant_offer_create` and `role_grant_assign` at 64 (new `SCOPE_KIND_LENGTH_MAX`). A longer value is refused `invalid_params`, where it used to be stored and written to the audit log up to the body cap. `ScopeKindName` gains the same cap, so `create_scope_kind_schema` throws on a registered kind longer than 64 characters. No migration and no column constraint: a longer value already stored is untouched, but a cell whose `kind` is longer than 64 can no longer be selected by the `cell_list` `kind` filter

- testing: `describe_token_lifetime_cross_tests` gains a case (a `name` at the cap mints and reads back whole; one unit past it is `invalid_params`), `describe_cell_crud_cross_tests` gains a case (the same for `kind`, on create and as a list filter). A twin-impl consumer's other backend holds the same caps, counted in UTF-16 code units, or the suites fail
