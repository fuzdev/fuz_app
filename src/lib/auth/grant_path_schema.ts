/**
 * Grant-path registry — the surfaces through which a role can be
 * granted to an actor.
 *
 * Four builtins:
 *
 * - `admin` — granted by an admin via `role_grant_offer_create` (subject to
 *   the consumer's `authorize` callback) or admin-side direct grant.
 * - `self_service` — toggled by the holder themselves via
 *   `self_service_role_set` (allowlisted by `eligible_roles`).
 * - `system` — granted by system code paths (signup, automation, etc.)
 *   that don't fit either of the above.
 * - `bootstrap` — granted exactly once during the bootstrap flow
 *   (`keeper`, `admin` on a fresh install).
 *
 * Open registry on top so consumers can declare additional paths
 * (e.g. `'invite_only'`, `'sso_assertion'`) without an upstream release.
 * `RoleSpec.grant_paths` references entries from this registry; the
 * default for `admin_actions.grantable_roles` is `grant_paths.includes('admin')`,
 * the default for `self_service_role_actions` eligibility is
 * `grant_paths.includes('self_service')`. Mirrors the open-registry
 * pattern used for `RoleName`, `ScopeKindName`, `CredentialTypeName`,
 * and `AuditEventTypeName`.
 *
 * @module
 */

import { format_issue, parse, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { create_name_schema } from './name_schema.ts';

/**
 * Valid grant-path name strings: the shared name grammar
 * (`auth/name_schema.ts`), runs of lowercase letters joined by single
 * underscores, at most `NAME_LENGTH_MAX` characters.
 */
export const GrantPathName = create_name_schema('Grant-path');
export type GrantPathName = Infer<typeof GrantPathName>;

// Builtin grant paths — provided by fuz_app, always available.

/** Admin-mediated grant — `role_grant_offer_create` plus admin-direct flows. */
export const GRANT_PATH_ADMIN = 'admin';

/** Self-service grant — caller toggles their own role_grant via `self_service_role_set`. */
export const GRANT_PATH_SELF_SERVICE = 'self_service';

/** System-mediated grant — signup hooks, automation, internal service flows. */
export const GRANT_PATH_SYSTEM = 'system';

/** Bootstrap grant — one-shot flow during the keep's first-run bootstrap. */
export const GRANT_PATH_BOOTSTRAP = 'bootstrap';

/** The builtin grant-path names as a const tuple. */
export const BUILTIN_GRANT_PATHS = [
	GRANT_PATH_ADMIN,
	GRANT_PATH_SELF_SERVICE,
	GRANT_PATH_SYSTEM,
	GRANT_PATH_BOOTSTRAP
] as const;

/** A builtin grant-path name. */
export type BuiltinGrantPath = (typeof BUILTIN_GRANT_PATHS)[number];

/**
 * Per-grant-path metadata. `description` is admin-UI-facing copy
 * (mirrors `RoleSpec.description` and `ScopeKindMeta.description`).
 * Open shape so v2 can extend without a breaking change.
 */
export interface GrantPathMeta {
	description?: string;
}

/**
 * Builtin grant-path metadata. Not overridable by consumers.
 *
 * Typed `ReadonlyMap` for the contract — but JS Maps don't honor
 * `Object.freeze` for `.set` / `.delete` / `.clear` (they mutate
 * internal slots, not own properties), so freeze adds no runtime guard
 * here. Read once at startup by `create_grant_path_registry`; runtime
 * mutation has no effect on already-built schemas.
 */
export const builtin_grant_path_meta: ReadonlyMap<string, GrantPathMeta> = new Map([
	[
		GRANT_PATH_ADMIN,
		{
			description:
				'Admin-mediated grant — admin offers via `role_grant_offer_create` or direct grant.'
		}
	],
	[
		GRANT_PATH_SELF_SERVICE,
		{
			description:
				'Self-service grant — caller toggles their own role_grant via `self_service_role_set`.'
		}
	],
	[
		GRANT_PATH_SYSTEM,
		{ description: 'System-mediated grant — signup, automation, or internal service flows.' }
	],
	[
		GRANT_PATH_BOOTSTRAP,
		{ description: 'Bootstrap grant — one-shot flow during the keep’s first-run bootstrap.' }
	]
]);

/** The result of `create_grant_path_registry` — the metadata map. */
export interface GrantPathRegistry {
	/**
	 * Map of every registered grant-path to its metadata. Keyed by
	 * name. Read at startup by admin / codegen surfaces.
	 */
	grant_paths: ReadonlyMap<string, GrantPathMeta>;
}

/**
 * Create a grant-path registry from the builtin set plus optional
 * consumer-declared additions.
 *
 * Builtins (`admin`, `self_service`, `system`, `bootstrap`) are always
 * present; consumer entries that collide with a builtin name throw at
 * construction. Pass the result into `create_role_registry`'s optional
 * `grant_paths` parameter so each role's `grant_paths` entries are
 * validated against this set at construction time.
 *
 * @param consumer_paths - optional consumer-declared grant-path set with optional metadata
 * @returns `{grant_paths}` — the metadata map
 *
 * @throws Error if any `consumer_paths` key fails `GrantPathName` (its grammar or its length cap), collides with a builtin name, or appears more than once
 *
 * @example
 * ```ts
 * // simple — builtins only
 * const {grant_paths} = create_grant_path_registry();
 *
 * // with consumer extensions
 * const {grant_paths} = create_grant_path_registry({
 *   invite_only: {description: 'Granted by claiming a consumer-issued invite.'},
 * });
 * ```
 */
export const create_grant_path_registry = (
	consumer_paths: Record<string, GrantPathMeta> = {}
): GrantPathRegistry => {
	const consumer_names = Object.keys(consumer_paths);

	const seen: Set<string> = new Set();
	for (const name of consumer_names) {
		const parsed = parse(GrantPathName, name);
		if (!parsed.ok) {
			throw new Error(`Invalid grant-path name "${name}": ${format_issue(parsed.issues[0]!)}`);
		}
		if (builtin_grant_path_meta.has(name)) {
			throw new Error(`Consumer grant-path "${name}" collides with builtin grant-path`);
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate grant-path name "${name}"`);
		}
		seen.add(name);
	}

	const grant_paths: Map<string, GrantPathMeta> = new Map(builtin_grant_path_meta);
	for (const name of consumer_names) {
		grant_paths.set(name, consumer_paths[name]!);
	}

	return { grant_paths };
};
