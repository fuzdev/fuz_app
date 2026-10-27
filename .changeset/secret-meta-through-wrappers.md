---
'@fuzdev/fuz_app': patch
---

fix: `env_schema_to_surface` reads `sensitivity` through every wrapping layer of a field — optional, nullable, default, prefault, nonoptional, catch, readonly, both sides of a pipe (so `.transform()`, `z.preprocess()` and `.pipe(secret)`), `z.lazy()`, and every member of a union or intersection — so `.meta({sensitivity: 'secret'}).optional()` is masked in `log_startup_summary` instead of logged in clear, and `description` through its optional, nullable, default, prefault, transform and pipe layers; new `schema_sensitivity(schema)` (`schema_meta.ts`) answers `'secret'` when any reachable layer declares it, and `schema_meta_value(schema, key)` reads any `SchemaFieldMeta` key along the wrapper chain, the outermost declaration winning, `schema_invalid_reason` now built on it
