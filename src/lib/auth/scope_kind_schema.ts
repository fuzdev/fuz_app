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
 * `create_scope_kind_registry(consumer_kinds)` and pass the result to
 * `create_role_registry` so `RoleSpec.applicable_scope_kinds` can be
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

import { format_issue, parse, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import {
	create_name_schema,
	format_name_length_message,
	format_name_pattern_message
} from './name_schema.ts';

/** The message of a scope-kind name longer than `NAME_LENGTH_MAX`. */
export const SCOPE_KIND_NAME_LENGTH_MESSAGE = format_name_length_message('Scope-kind');

/** The message of a scope-kind name off `NAME_REGEX`. */
export const SCOPE_KIND_NAME_PATTERN_MESSAGE = format_name_pattern_message('Scope-kind');

/**
 * Valid scope-kind name strings: a registered name, and the
 * `scope_kind` the grant inputs take. The shared name grammar
 * (`auth/name_schema.ts`), at most `NAME_LENGTH_MAX` UTF-16 code units, which
 * bounds a registered name and the tag where it enters — the grant inputs
 * (`role_grant_offer_create`, `role_grant_assign`) copy it into the row and
 * its audit metadata — so no registry declares a kind the grant inputs would
 * refuse. Off the grammar is the index-side `'GLOBAL'` token. A string it
 * refuses gets `SCOPE_KIND_NAME_LENGTH_MESSAGE` or
 * `SCOPE_KIND_NAME_PATTERN_MESSAGE`; a value that is no string, fuz_schema's
 * message. Twin of the Rust spine's `is_valid_name`.
 */
export const ScopeKindName = create_name_schema('Scope-kind');
export type ScopeKindName = Infer<typeof ScopeKindName>;

/**
 * Per-scope-kind metadata. `description` is admin-UI-facing copy
 * (mirrors `RoleSpec.description`). Open shape so v2 can extend without
 * a breaking change.
 */
export interface ScopeKindMeta {
	description?: string;
}

/** The result of `create_scope_kind_registry` — the metadata map. */
export interface ScopeKindRegistry {
	/**
	 * Map of every registered scope-kind to its metadata. Keyed by name.
	 * Read at startup by admin / codegen surfaces, and by
	 * `create_role_registry` to check every `RoleSpec.applicable_scope_kinds`
	 * entry.
	 */
	scope_kinds: ReadonlyMap<string, ScopeKindMeta>;
}

/**
 * Create a scope-kind registry from the consumer-declared set.
 *
 * Open registry — no builtins. The `'GLOBAL'` token used inside the
 * partial unique indexes on `role_grant` and `role_grant_offer` is not a
 * registry entry (it's an index expression only), and no consumer can
 * declare it because the regex rejects uppercase.
 *
 * Call once at server init. Pass the result into `create_role_registry`'s
 * optional `scope_kinds` parameter so each role's
 * `applicable_scope_kinds` entries are validated against this set at
 * construction time. v1 keeps `applicable_scope_kinds` informative-only
 * (registry-membership validation only); v2 may add INSERT-time
 * `(role, scope_kind)` enforcement once the shape is clear from real
 * consumer usage.
 *
 * @param consumer_kinds - the consumer-declared scope-kind set with optional metadata
 * @returns `{scope_kinds}` — the metadata map
 *
 * @throws Error if any `consumer_kinds` key fails `ScopeKindName` (its grammar or its length cap) or appears more than once
 *
 * @example
 * ```ts
 * // visiones
 * const {scope_kinds} = create_scope_kind_registry({
 *   classroom: {description: 'A classroom — teacher and student role_grants scope here.'},
 * });
 * ```
 */
export const create_scope_kind_registry = (
	consumer_kinds: Record<string, ScopeKindMeta>
): ScopeKindRegistry => {
	const names = Object.keys(consumer_kinds);

	const seen: Set<string> = new Set();
	for (const name of names) {
		const parsed = parse(ScopeKindName, name);
		if (!parsed.ok) {
			throw new Error(`Invalid scope-kind name "${name}": ${format_issue(parsed.issues[0]!)}`);
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate scope-kind name "${name}"`);
		}
		seen.add(name);
	}

	const scope_kinds: Map<string, ScopeKindMeta> = new Map();
	for (const name of names) {
		scope_kinds.set(name, consumer_kinds[name]!);
	}

	return { scope_kinds };
};
