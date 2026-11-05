/**
 * Scope-kind registry for role_grants and role_grant offers.
 *
 * Role grants have a polymorphic `scope_id` that references whatever entity
 * the consumer chooses (a classroom, a tenant, a workspace, etc.); the
 * `scope_kind` column tags each row with a machine-readable kind so
 * admin UIs, codegen, and (in v2) registry-time `(role, scope_kind)`
 * compatibility checks can read it without re-deriving from `scope_id`.
 *
 * `scope_kind` is encoded as nullable paired with the existing nullable
 * `scope_id` — both null for global, both non-null for scoped, mismatch
 * rejected at the DB layer by the `role_grant_scope_kind_paired` /
 * `role_grant_offer_scope_kind_paired` CHECK constraints. There is no
 * `'global'` magic-string value; the global case is unambiguously
 * `(scope_kind=NULL, scope_id=NULL)`.
 *
 * Open registry, no builtins. Consumers declare their kinds via
 * `create_scope_kind_schema(consumer_kinds)` and pass the result to
 * `create_role_schema` so `RoleSpec.applicable_scope_kinds` can be
 * validated at construction time. Mirrors the open-string registry
 * pattern used for `RoleName`, `AuditEventTypeName`, and `CredentialTypeName`.
 *
 * The literal `'GLOBAL'` (uppercase) appears as an index expression
 * inside the partial unique indexes on `role_grant` and `role_grant_offer`
 * (`COALESCE(scope_kind, 'GLOBAL')`), never as a registry entry. It is off
 * the `ScopeKindName` grammar, so no registry declares it and the grant
 * inputs (`role_grant_offer_create`, `role_grant_assign`) refuse it: a row
 * written through them never holds it. One written by other means could,
 * and with the all-zeros `scope_id` it would share a global grant's index
 * key.
 *
 * @module
 */

import { z } from 'zod';

import { bounded_string } from '../primitive_schemas.ts';

/**
 * Runs of lowercase letters (a-z) joined by single underscores, the grammar
 * of `RoleName`, `CredentialTypeName` and `GrantPathName` too. Rejects empty
 * strings, leading, trailing or consecutive underscores, uppercase, digits,
 * and the index-side `'GLOBAL'` token.
 */
export const SCOPE_KIND_NAME_REGEX = /^[a-z]+(?:_[a-z]+)*$/;

/**
 * Maximum length of a `scope_kind`, in UTF-16 code units (what
 * `String.length` measures; enforced by `bounded_string`). Part of the
 * `ScopeKindName` grammar, which bounds a registered name and the tag where
 * it enters — the grant inputs (`role_grant_offer_create`,
 * `role_grant_assign`) copy it into the row and its audit metadata — so no
 * registry declares a kind the grant inputs would refuse. Same value as
 * `ROLE_NAME_LENGTH_MAX`, whose grammar the name shares, and as the Rust
 * spine's `SCOPE_KIND_LENGTH_MAX`.
 */
export const SCOPE_KIND_LENGTH_MAX = 64;

/**
 * Zod schema for valid scope-kind name strings: a registered name, and the
 * `scope_kind` the grant inputs take. Twin of the Rust spine's
 * `is_valid_scope_kind_name`.
 */
export const ScopeKindName = bounded_string({
	max: SCOPE_KIND_LENGTH_MAX,
	max_message: `Scope-kind names must be at most ${SCOPE_KIND_LENGTH_MAX} characters`
}).regex(
	SCOPE_KIND_NAME_REGEX,
	'Scope-kind names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
);
export type ScopeKindName = z.infer<typeof ScopeKindName>;

/**
 * Per-scope-kind metadata. `description` is admin-UI-facing copy
 * (mirrors `RoleSpec.description`). Open shape so v2 can extend without
 * a breaking change.
 */
export interface ScopeKindMeta {
	description?: string;
}

/** The result of `create_scope_kind_schema` — a Zod schema and metadata map. */
export interface ScopeKindSchemaResult {
	/**
	 * Zod schema that validates scope-kind name strings against the
	 * registered set. Use at I/O boundaries (admin UIs, codegen) and as
	 * the construction-time check inside `create_role_schema` for every
	 * `RoleSpec.applicable_scope_kinds` entry.
	 */
	ScopeKind: z.ZodType<string>;
	/**
	 * Map of every registered scope-kind to its metadata. Keyed by name.
	 * Read at startup by admin / codegen surfaces.
	 */
	scope_kinds: ReadonlyMap<string, ScopeKindMeta>;
}

/**
 * Create a scope-kind schema from a consumer-declared registry.
 *
 * Open registry — no builtins. The `'GLOBAL'` token used inside the
 * partial unique indexes on `role_grant` and `role_grant_offer` is not a
 * registry entry (it's an index expression only), and no consumer can
 * declare it because the regex rejects uppercase.
 *
 * Call once at server init. Pass the result into `create_role_schema`'s
 * optional `scope_kinds` parameter so each role's
 * `applicable_scope_kinds` entries are validated against this set at
 * construction time. v1 keeps `applicable_scope_kinds` informative-only
 * (registry-membership validation only); v2 may add INSERT-time
 * `(role, scope_kind)` enforcement once the shape is clear from real
 * consumer usage.
 *
 * @param consumer_kinds - the consumer-declared scope-kind set with optional metadata
 * @returns `{ScopeKind, scope_kinds}` — Zod schema and metadata map
 *
 * @throws Error if any `consumer_kinds` key fails the `ScopeKindName` regex or appears more than once
 *
 * @example
 * ```ts
 * // visiones
 * const {ScopeKind, scope_kinds} = create_scope_kind_schema({
 *   classroom: {description: 'A classroom — teacher and student role_grants scope here.'},
 * });
 * ```
 */
export const create_scope_kind_schema = (
	consumer_kinds: Record<string, ScopeKindMeta>
): ScopeKindSchemaResult => {
	const names = Object.keys(consumer_kinds);

	const seen: Set<string> = new Set();
	for (const name of names) {
		const parsed = ScopeKindName.safeParse(name);
		if (!parsed.success) {
			throw new Error(`Invalid scope-kind name "${name}": ${parsed.error.issues[0]!.message}`);
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate scope-kind name "${name}"`);
		}
		seen.add(name);
	}

	const ScopeKind: z.ZodType<string> =
		names.length === 0 ? z.never() : z.enum(names as [string, ...Array<string>]);

	const scope_kinds: Map<string, ScopeKindMeta> = new Map();
	for (const name of names) {
		scope_kinds.set(name, consumer_kinds[name]!);
	}

	return { ScopeKind, scope_kinds };
};
