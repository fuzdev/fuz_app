---
'@fuzdev/fuz_app': minor
---

break: the cell family's wire schemas are `@fuzdev/fuz_schema`, two inputs closed on both spines, and the outputs held to the rows both spines write.

**What moved.** Every schema of `auth/cell_action_specs.ts`, `cell_grant_action_specs.ts`, `cell_field_action_specs.ts`, `cell_item_action_specs.ts`, `cell_audit_action_specs.ts`, `cell_data_schema.ts`, and `cell_relation_list_limit.ts`, and the audit metadata of `cell_audit_metadata.ts`, `cell_grant_audit_metadata.ts`, `cell_field_audit_metadata.ts`, and `cell_item_audit_metadata.ts`: `CellData` is a `loose_object`, `CellPolicy` a `loose_object({})`, `CellPath`, `CellFieldName`, and `CellItemPosition` `brand`s, `CellGrantPrincipalInput` a `variant` on `kind`, `CellVisibility`, `CellGrantLevel`, and `CellModerationDecision` `one_of`s, and `CellListInput` a `with_default_fn` that reads an omitted input as a fresh `{}`. The inputs declare the fuz_schema `ActingActor`. The types keep their names, read by `Infer`; `CellData` is `{label?: string; summary?: string} & Record<string, unknown>`. `cell_audit_events` is a `Readonly<Record<string, AnySchema>>`, and the grant and moderate metadata reuse `CellGrantLevel` and `CellModerationDecision`. New: `CellModeration`, the `one_of` of a cell's `moderation` marker. Renamed: `CELL_AUDIT_LIST_DEFAULT_LIMIT` → `CELL_AUDIT_LIST_EVENTS_MAX`, the fixed count of events `cell_audit_list` returns, which takes no `limit`. The Rust `fuz_cell::CELL_AUDIT_LIST_DEFAULT_LIMIT` is renamed alike.

**Inputs: the same verdicts, but two.** Every other input accepts and refuses what it did, with the same output, but for an own `__proto__` key at the top of `data`, `policy`, or `with_data_patch`, which Zod's copy dropped and the schema now keeps; the RPC dispatcher refuses such a key ahead of the schema on both spines (`params_proto_key`), so no call reaches the store with one. The issues of a refusal, which only DEV responses carry, are fuz_schema's: a principal with an unknown or missing `kind` is one `variant` issue at `principal.kind`, and a `CellItemPosition` off on both length and alphabet (the empty string) gets the length issue alone, where Zod added the alphabet's.

**Inputs: two refusals, on both spines.** Each is `invalid_params` (400, `-32602`, the generic message, no `data.reason`) from the schema step, ahead of every handler check, and the Rust spine (the `fuz_cell` crate of [fuz](https://github.com/fuzdev/fuz)) refuses the same at decode:

- `cell_grant_create`'s role-shaped principal takes a `RoleName` (the shared name grammar, at most `NAME_LENGTH_MAX`) where it took any non-empty string. A non-empty role off the grammar reached the handler before, on both spines: a manager got `cell_grant_unknown_role`, anyone else the 404 mask. A role on the grammar that isn't registered is still `cell_grant_unknown_role`.
- `cell_list`'s `moderation` filter takes a `CellModeration` (`'pending'`, `'approved'`, `'rejected'`) where it took any string, which matched no cell. A list naming another marker was an empty page and is now refused.

A Rust consumer builds against a fuz checkout that carries both refusals, so the two spines answer alike: the cell crates are path dependencies, with no version to bump.

**The surface: the input moves.** The `limit` of `cell_list`, `cell_field_list`, and `cell_item_list` is written `minimum: 1` in place of `exclusiveMinimum: 0`, the same integers. The grant principal's `role` is written as the name grammar's `maxLength` and `pattern` in place of `minLength: 1`, and `cell_list`'s `moderation` as the `enum` of the three markers, its `description` now ending " Another value is refused." A node's `description` is written after an `anyOf` where Zod wrote it first, which a snapshot compared as text shows and one compared as JSON doesn't.

**Generated action files.** `generate_action_specs_record` annotates the `ActionSpecs` const with its type (`export const ActionSpecs: ActionSpecs = {...}`, no `as const`), a type alias whose members are `readonly`. Inferred, the const's type wrote every spec's schema types out, and with the cell specs a consumer compiled with `declaration: true` hit TS7056 ("The inferred type of this node exceeds the maximum length the compiler will serialize") at the const. Reads are unchanged: `ActionSpecs[method]`, `keyof typeof ActionSpecs`, and the `ActionSpecs` type give the same types, and `Object.values(ActionSpecs)` stays typed by the specs, so `action_specs` checks each against `ActionSpecUnion`.

**Outputs: tightened, output-only.** Each refuses what it took before, and the browser RPC client checks outputs in production, so a row off these fails there too:

- `CellJson.created_at`, `updated_at`, `deleted_at`, and the `created_at` of `GrantJson`, `FieldJson`, `ItemJson`, and `CellAuditEventJson` are `Timestamp`s (`format: date-time` with its pattern), as both spines' `to_char` projection writes them
- `CellJson.moderation` is `null` or `CellModeration` (`'pending'`, `'approved'`, `'rejected'`), the markers the create authorizer's verdict and `cell_moderate` write
- `CellJson.kind` is at most `CELL_KIND_LENGTH_MAX` (64) UTF-16 code units, as `cell_create` takes it
- `FieldJson.name` is a `CellFieldName`, as `cell_field_set` takes it
- `GrantJson.role` is `null` or a `RoleName` (the shared name grammar)
- `CellAuditEventJson.seq` is a safe integer, `event_type` an `AuditEventTypeName`, and `outcome` an `AuditOutcome`, as on `AuditLogEventJson`

`CellPolicySetAuditMetadata.policy` and `previous_policy` are `nullable(CellPolicy)`, the same verdicts as the record they were.

**Before upgrading.** `CellJson.kind` past 64 can exist on rows created before 0.136.0, when the input cap landed; such rows, and any `moderation` or timestamp written outside the handlers, fail the browser client's output check, which runs in production. Audit such rows before upgrading.

**To migrate:**

1. A per-kind data schema that extended `CellData` with `.extend({...})` spreads its `def` instead: `loose_object({...CellData.def, field})`, or `object({...CellData.def, field})` for a strict one; a refined one spreads into the bare object and pipes it (`pipe(object({...}), check(...))`). fuz_schema has no url kind, so a `z.url()` field becomes a `check`, e.g. `pipe(string, check((v: string) => URL.canParse(v)))`, held to the verdict the consumer had: Zod 4's bare `z.url()` trims the string, accepts what `URL.canParse` takes, and outputs the trimmed string with ASCII tabs and newlines removed. `URL.canParse` itself strips leading and trailing C0 controls and spaces, so a port that doesn't trim refuses a URL edged with non-ASCII whitespace (e.g. U+00A0, U+FEFF) that Zod accepted, and no longer rewrites the value.
2. `X.safeParse(v)` becomes fuz_schema's `parse(X, v)` (`{ok: true, value}` or `{ok: false, issues}`), or `is(X, v)` for the verdict alone; `X.parse(v)` becomes `parse_or_throw(X, v)`. A `catch` that tests for `ZodError` tests for `SchemaError` (`is_schema_validation_error` takes both, so a `validate_data` or `validate_policy` may throw either). Mixed throwers keep working: a `validate_data` or `validate_policy` still written in Zod throws a `ZodError`, which fuz_app catches and turns into `invalid_params` as before.
3. A Zod schema that embeds a cell schema (an output holding a `CellJson`, an input holding a `CellPath`) can't: port it to fuz_schema. `z.infer<typeof CellJson>` becomes `Infer<typeof CellJson>`, or the exported type.
4. Reads of a schema's parts go through `def`: `X.shape.key` → `X.def.key`, `CellListInput.unwrap().shape` → `CellListInput.def.schema.def`, an enum's `.options` → `.def`.
5. `CELL_AUDIT_LIST_DEFAULT_LIMIT` → `CELL_AUDIT_LIST_EVENTS_MAX`, in TypeScript and in Rust.
6. A client that grants to a role it names from user text checks it with `is_valid_name` first, or reads the 400; a client that filters `cell_list` by a marker it doesn't control narrows it to `CellModeration` first.
7. Rows written outside the handlers (seeds, fixtures, direct SQL) hold to the output rules above, or the outputs carrying them fail.
8. Run `gro gen` to regenerate the generated action files (`action_collections.ts`, which now types a fuz_schema spec's rows with `Infer`, and declares `ActionSpecs` by its type) as well as any committed surface snapshot, and review the snapshot: the `limit` nodes, the two inputs, and the outputs above, and nothing else. Written as JSON Schema, `CellPolicySetAuditMetadata`'s `policy` and `previous_policy` drop `propertyNames` and gain the `CellPolicy` description.
