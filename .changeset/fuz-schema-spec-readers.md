---
'@fuzdev/fuz_app': patch
---

fix: the runtime readers of a spec's schema take a `@fuzdev/fuz_schema` schema as well as a Zod one, and throw naming the schema for a value of neither library: `schema_has_sensitive_field` (the frontend HTTP transport's GET-or-POST choice, which threw `layer.meta is not a function` for any fuz_schema input) reads a fuz_schema input with `find_schema_meta` and `structural`, so a read whose fuz_schema input carries a `'secret'` or `'personal'` value at any depth is sent as a `POST`; `is_empty_input_handler_guarded` reads a fuz_schema input's own `meta`, and `SchemaMeta` gains `empty_input_handler_guarded`; `create_broadcast_api` validates through `parse_any`; `EventSpec.params` is a `ValidationSchema`, validated through `parse_any` by `create_validated_broadcaster` and the SSE round-trip helpers. `parse_any` throws on a schema of neither library, where it threw a `TypeError`. New in `schema_issues.ts`: `is_zod_schema` and `assert_zod_schema`.
