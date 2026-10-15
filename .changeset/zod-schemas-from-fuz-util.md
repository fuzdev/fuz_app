---
'@fuzdev/fuz_app': minor
---

**breaking** feat: the Zod schemas and walkers that `@fuzdev/fuz_util` `0.75.0` removed move here; the peer floor of `@fuzdev/fuz_util` is `>=0.75.0` and `@fuzdev/fuz_schema` is `^0.2.2`

- `primitive_schemas.ts` adds `Uuid`, `UuidWithDefault`, and `create_uuid` (were `@fuzdev/fuz_util/id.ts`), `Datetime`, `DatetimeNow`, and `get_datetime_now` (were `@fuzdev/fuz_util/datetime.ts`), and `Blake3Hash` and `FactHashSchema` (were `@fuzdev/fuz_util/hash_schemas.ts`), with the same runtime behavior; the new `zod.ts` has the walkers `zod_unwrap_def`, `zod_get_base_type`, `zod_get_innermost_type`, `zod_get_schema_keys`, `zod_get_field_schema`, `zod_unwrap_to_object`, `zod_extract_fields`, and the `ZodFieldInfo` type (were `@fuzdev/fuz_util/zod.ts`)
- to upgrade: import those names from `@fuzdev/fuz_app/primitive_schemas.ts` in place of `@fuzdev/fuz_util/id.ts` and `@fuzdev/fuz_util/datetime.ts`, `Blake3Hash` and `FactHashSchema` from it in place of `@fuzdev/fuz_util/hash_schemas.ts`, and the walkers from `@fuzdev/fuz_app/zod.ts` in place of `@fuzdev/fuz_util/zod.ts`; `FactHash`, `FACT_HASH_PREFIX`, `FACT_HASH_EXACT`, and `is_fact_hash` stay in `@fuzdev/fuz_util/hash_schemas.ts`
- not carried, as nothing used them: `is_uuid`, `UUID_MATCHER`, `ClientIdCreator`, `create_client_id_creator`, `zod_to_subschema`, `ZOD_WRAPPER_TYPES`, `zod_is_optional`, `zod_is_nullable`, `zod_has_default`, and `zod_maybe_get_field_schema`; `zod_extract_fields` still reports what the three predicates did, as `required`, `nullable`, and `has_default`
- `FactHashSchema` outputs `@fuzdev/fuz_util`'s `FactHash`, now `@fuzdev/fuz_schema`'s `Branded<string, 'FactHash'>`, in place of Zod's `.brand('FactHash')`, so a parsed hash passes to `FactStore` and the `fact_hash_*` functions; it is `z.string().regex(FACT_HASH_EXACT)` typed `z.ZodString & z.ZodType<FactHash, string>`, so it composes and generates JSON Schema as before. A value branded by Zod's `.brand('FactHash')` no longer fits `FactHash`
- the brand only matches when `@fuzdev/fuz_util` and the app resolve one copy of `@fuzdev/fuz_schema`; check with `npm ls @fuzdev/fuz_schema`
