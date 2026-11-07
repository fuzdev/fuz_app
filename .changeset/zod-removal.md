---
'@fuzdev/fuz_app': minor
---

break: fuz_app is `@fuzdev/fuz_schema` only — Zod is gone from its schemas, signatures and dependencies; every slot that took a Zod or a fuz_schema schema takes a fuz_schema schema

break: `zod` is no longer a peer dependency, optional or otherwise

break: the `@fuzdev/fuz_schema` peer is `^0.5.6` (composable `Branded` / `Flavored`)

break: codegen types the call surfaces by each input schema's input type — the new `ActionCallInputs` — so callers pass what the schema accepts before its parse (run `gro gen`)

**Renamed to fuz_schema's names** (no aliases):

- `ValidationSchema` → `AnySchema` (`@fuzdev/fuz_schema/schema.ts`)
- `ValidationOutput<T>` / `ValidationInput<T>` → `Infer<T>` / `InferInput<T>`
- `AnyIssue` → `SchemaIssue`
- `ParseAnyResult<T>` → `SchemaResult<T>`
- `parse_any(schema, value)` → `parse(schema, value)`, same `{ok, value}` / `{ok: false, issues}` result

**Removed:**

- `zod.ts`, every export: `zod_has_trait`, `zod_unwrap_def`, `zod_get_base_type`, `zod_get_innermost_type`, `zod_get_schema_layers`, `zod_unwrap_to_object`, `zod_get_schema_keys`, `zod_get_field_schema`, `zod_maybe_get_field_schema`, `zod_extract_fields` — read a schema with `@fuzdev/fuz_schema/introspect.ts` (`get_schema_entries`, `get_schema_fields`, `unwrap_schema`); `SchemaFieldInfo` moves to `http/schema_helpers.ts`
- `zod_schemas.ts`, every export: `ZodUuid`, `ZodUuidWithDefault`, `ZodFactHashSchema`, `ZodUsername`, `ZodEmail`, `ZodActingActor` → the fuz_schema primitives of `primitive_schemas.ts` (`Uuid`, `UuidWithDefault`, `FactHashSchema`, `Username`, `Email`, `ActingActor`); `Datetime`, `DatetimeNow` and `get_datetime_now` have no replacement here — the wire timestamp is `Timestamp`, and an app keeping a branded datetime defines its own
- `schema_issues.ts`: `is_zod_schema`, `assert_zod_schema`, `is_zod_issue`
- `schema_meta.ts`: `SchemaFieldMeta` → fuz_schema's `SchemaMeta`, which carries `invalid_reason`, `empty_input_handler_guarded`, `sensitivity` and `readOnly` by declaration merging; `schema_meta_value` → `get_schema_meta` (`@fuzdev/fuz_schema/introspect.ts`); `schema_invalid_reason` → `get_schema_meta(schema, 'invalid_reason')`; `schema_sensitivity` → `find_schema_sensitivity` (`sensitivity.ts`)
- `http/auth_shape.ts`: `register_zod_acting_actor` (internal) — `input_schema_declares_acting` finds `ActingActor` alone

**Narrowed to fuz_schema:**

- `assert_validation_schema` refuses anything that is no fuz_schema schema, its error ending `is not a @fuzdev/fuz_schema schema`; spec registration, `schema_to_surface` and codegen throw it
- `format_issues` writes `format_issue` lines; `is_schema_validation_error` is `err instanceof SchemaError`; `issue_is_on_input` and `unknown_key_targets` read `SchemaIssue`s
- `to_wire_issues(issues)` drops its second parameter, the parsed input, which only Zod issues read; `WireIssue` is unchanged on the wire
- `RouteSpec.params` / `query` are `AnySchema`; `RemoteNotificationActionSpec.output` is `typeof void`
- `expect_output` (`testing/cross_backend/cross_rpc.ts`) and `rpc_call_typed` (`testing/rpc_helpers.ts`) take a `Schema<T, any>`
- `is_null_schema`, `is_void_schema`, `is_strict_object_schema`, `schema_to_surface`, `to_input_params`, `safe_parse_dropping_unknown_keys`, `input_schema_declares_acting`, `is_empty_input_handler_guarded`, `schema_has_sensitive_field`, `resolve_invalid_reason`, `resolve_issues_invalid_reason`, `create_audit_log_config`'s metadata schemas, and the testing generators (`to_object_schema_view`, `to_field_json_schema`, `detect_format`, `generate_valid_value`, `generate_valid_object`, `generate_valid_body`, `generate_valid_string_param`, `generate_input_test_cases` and the params and query generators) take an `AnySchema`; `ObjectSchemaView.field_schema` answers one
- `SchemaFieldInfo.base_type` keeps its names (`'enum'` for a `one_of`, `'union'` for a `variant`, …)

**Codegen.** `generate_action_inputs_outputs` emits `ActionCallInputs` beside `ActionInputs` and `ActionOutputs`, importing `type {Infer, InferInput}` and never `z`:

- `ActionCallInputs[method]` is `InferInput<typeof spec.input>` — what a caller passes. `FrontendActionsApi` (`generate_frontend_actions_api`) and `BackendActionsApi` (`generate_backend_actions_api`) type their `input` by it, so a `with_default` field is optional for the caller, and a `Uuid` param takes a string.
- `ActionInputs[method]` stays `Infer<typeof spec.input>` — the parsed value a handler, an action event (`ActionEventDatas`) or a notification receiver reads, defaults filled. `ActionOutputs` is unchanged.

**Migration.**

1. Rename the imports above, taking `AnySchema`, `Infer`, `InferInput`, `SchemaIssue`, `SchemaResult` and `parse` from `@fuzdev/fuz_schema/schema.ts`.
2. Port any remaining Zod schema a spec, route, event or audit config holds to fuz_schema; a Zod schema in one now fails registration.
3. Run `gro gen`: `action_collections.ts` gains `ActionCallInputs`, and the generated call surfaces import it in place of `ActionInputs`. A hand-written call-side type naming `ActionInputs[method]` for what a caller passes moves to `ActionCallInputs[method]`.
4. Call `to_wire_issues(issues)` with one argument.

**Fixed:** `generate_valid_string_param` finds a value for a URL integer whose bounds sit past its `transform` (`db_routes`' `query_int` shape) and exclude the small candidates, reading every `min_value` / `max_value` in the schema, where it answered `null`.
