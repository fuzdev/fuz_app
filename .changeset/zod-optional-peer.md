---
'@fuzdev/fuz_app': minor
---

break: `zod` is an optional peer dependency — an app with no Zod installed typechecks against fuz_app's published types, and an app with Zod infers the same types it did.

**Structural Zod types.** Every public signature outside the Zod-only modules (`zod_schemas.ts`, the `zod.ts` walkers) names a Zod schema by structure, with no type from the `zod` module. New in `schema_issues.ts`: `ZodSchemaLike<TOutput, TInput>` (a schema by its `_zod` internals, `ZodSchemaLikeInternals`; its output and input are read from `_zod` exactly as `z.output` and `z.input` read them), `ZodObjectLike` (a Zod object schema), `ZodVoidLike` (`z.void()`), `ZodIssueLike` (a Zod issue by its `code`, `path`, `message`) and `ZodErrorLike` (a thrown Zod failure by its `issues`).

**What changed shape:**

- `ValidationSchema` is `ZodSchemaLike | AnySchema` (was `z.ZodType | AnySchema`); `ValidationOutput` / `ValidationInput` read `_zod.output` / `_zod.input`, the same types `z.output` / `z.input` give.
- `AnyIssue` is `ZodIssueLike | SchemaIssue` (was `z.core.$ZodIssue | SchemaIssue`), so `ParseAnyResult`'s `issues` too: a Zod issue's kind-specific fields (`keys`, `expected`, …) need a narrowing cast to `z.core.$ZodIssue`.
- `is_zod_schema` and `assert_zod_schema` narrow to `ZodSchemaLike` (were `z.ZodType`), `is_zod_issue` to `ZodIssueLike`, `is_schema_validation_error` to `ZodErrorLike | SchemaError` — read Zod's methods on the narrowed value as `z.ZodType` (and a `ZodErrorLike` as `z.ZodError`, for `err.format()` or `z.treeifyError(err)`). `ZodSchemaLike` is the classic API only, as `is_zod_schema` accepts: a `zod/mini` schema is refused at compile time.
- `RouteSpec.params` / `query` are `ZodObjectLike | AnySchema` (were `z.ZodObject | AnySchema`); `RemoteNotificationActionSpec.output` is `ZodVoidLike | typeof void` (was `z.ZodVoid | …`).
- `expect_output` (`testing/cross_backend/cross_rpc.ts`) and `rpc_call_typed` (`testing/rpc_helpers.ts`) take `ZodSchemaLike<T> | Schema<T, any>`; `schema_meta_value`, `schema_invalid_reason` and `schema_sensitivity` (`schema_meta.ts`) take a `ZodSchemaLike`.
- `SchemaFieldInfo` moves from `zod.ts` to `http/schema_helpers.ts`.

An app using Zod sees the same inference: `T` of `expect_output(r, z.object({a: z.string()}))` is `{a: string}`, `parse_any`'s value and a handler bound by `rpc_action` type as before, and every Zod schema still satisfies `ValidationSchema` — pinned by `src/test/schema_issues.zod_like.test.ts`.
