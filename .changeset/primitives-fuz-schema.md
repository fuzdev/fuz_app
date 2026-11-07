---
'@fuzdev/fuz_app': minor
---

break: fuz_app's own schemas are all `@fuzdev/fuz_schema`, the primitives take their plain names, their Zod forms move to `zod_schemas.ts`, and nothing else in fuz_app imports Zod at runtime.

**The primitives.** `primitive_schemas_fuz.ts` is gone: its schemas are in `primitive_schemas.ts` under the names they had — `bounded_string`, `Username`, `UsernameCanonical`, `UsernameProvided`, `Email`, `Uuid`, `UuidWithDefault`, `Timestamp`, `FactHashSchema`, `Blake3Hash` (with `BLAKE3_HASH_REGEX`, `BLAKE3_HASH_MESSAGE`, `USERNAME_CANONICAL_REGEX`), `ACTING_ACTOR_DESCRIPTION` and `ActingActor` — in place of the Zod schemas `primitive_schemas.ts` held. `ActingActor` is no longer exported from `http/auth_shape.ts`. `UUID_REGEX` is exported. The types keep their names and shapes: `Uuid` is `Branded<string, 'Uuid'>` as before, so `import type {Uuid}` from `primitive_schemas.ts` is unchanged.

**The Zod forms**, for apps whose schemas are still Zod, are in the new `zod_schemas.ts`, the one fuz_app module that imports Zod at runtime: `ZodUuid` (was the Zod `Uuid`), `ZodUuidWithDefault`, `ZodFactHashSchema`, `ZodUsername`, `ZodEmail` (was the Zod `Email`), and `ZodActingActor` (was `ActingActor` of `http/auth_shape.ts`), each with the verdicts, outputs and JSON Schema it had; and `Datetime`, `DatetimeNow` and `get_datetime_now`, same names, new module. The Zod `bounded_string` is removed: build on the fuz_schema `bounded_string`. `input_schema_declares_acting` matches `ZodActingActor` by reference as it did the Zod `ActingActor`, through `register_zod_acting_actor` (`http/auth_shape.ts`, internal), which `zod_schemas.ts` calls when it loads; the registry-time invariant 2 errors name `ZodActingActor`.

**Codegen.** `generate_action_method_enums` emits fuz_schema `one_of` method enums (`ActionMethod` and its siblings) with `Infer` types, importing `{one_of, type Infer}` from `@fuzdev/fuz_schema/schema.ts` in place of `z.enum` and `z.infer`. `ActionInputs` / `ActionOutputs` still type each schema by its own library, `z.infer` for a Zod one.

**The testing seams.** The `_testing_*` action specs of `testing/cross_backend/testing_reset_actions.ts` are fuz_schema, each accepting and refusing what it did; `_testing_mint_session`'s `expires_in_seconds` writes `maximum: -1` where it wrote `exclusiveMaximum: 0`, the same integers. Their refusals carry fuz_schema's issue text, and a non-integer `expires_in_seconds`, `count`, `size` or `seconds` is `kind: 'safe_integer'` where it was `'integer'`, and one past the safe integers `'safe_integer'` where it was `'min_value'` or `'max_value'`. The schema-snapshot and migration-tracker schemas of `testing/schema_introspect.ts` (`SchemaSnapshot`, `TableSnapshot`, `ColumnSnapshot`, `SequenceSnapshot`, `EnumTypeSnapshot`, `MigrationTracker`, `MigrationTrackerEntry`) are `strip_object`s. `ConformancePrincipal`, `ConformanceActingBinding`, `ConformanceCaseRequest`, `ConformanceCaseExpectation`, `ConformanceCaseXfail` and `ConformanceCase` (`testing/cross_backend/conformance_case.ts`) are types only, no longer schemas; nothing parsed them.

**The dual-library layer** reads a consumer's Zod schema without importing Zod: `is_zod_schema`, `is_schema_validation_error`, `is_null_schema`, `is_void_schema` and `is_strict_object_schema` by the schema's traits, through the new `zod_has_trait` (`zod.ts`), which answers as Zod's `instanceof` does; `schema_to_surface` and `to_field_json_schema` by the schema's own `.toJSONSchema()`. `format_issues` writes Zod issues as `z.prettifyError` wrote them, the same text. `zod` stays a required peer.

**Migration.**

1. Regenerate (`gro gen`): `action_metatypes.ts` holds `one_of` enums, and a generated file that held only those enums imports no Zod.
2. A generated enum's `.options` is `.def`; a Zod schema that embeds one wraps it, `z.enum(ActionMethod.def)`.
3. A Zod schema embedding a primitive takes its Zod form from `zod_schemas.ts`: `Uuid` → `ZodUuid`, `UuidWithDefault` → `ZodUuidWithDefault`, `FactHashSchema` → `ZodFactHashSchema`, `Username` → `ZodUsername`, `Email` → `ZodEmail`, and `ActingActor` of `http/auth_shape.ts` → `ZodActingActor` (the dispatcher finds only that schema in a Zod input). `Datetime`, `DatetimeNow` and `get_datetime_now` import from `zod_schemas.ts`. A schema ported to fuz_schema takes the plain names from `primitive_schemas.ts`.
4. `X.safeParse(v)` on a primitive becomes fuz_schema's `parse(X, v)` or `is(X, v)`, and `X.parse(v)` becomes `parse_or_throw(X, v)`.
5. Imports from `primitive_schemas_fuz.ts` move to `primitive_schemas.ts`, dropping any alias that told the two apart.
6. A value use of a `Conformance*` schema is a type use.
7. Review a committed surface snapshot only if an input moved from `ZodActingActor` to `ActingActor`: the `acting` node's `description` moves after its `pattern`, the same content.
