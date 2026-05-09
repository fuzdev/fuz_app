/**
 * Grant-path registry — the surfaces through which a role can be
 * granted to an actor.
 *
 * Four builtins:
 *
 * - `admin` — granted by an admin via `permit_offer_create` (subject to
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

import {z} from 'zod';

/**
 * Letter (lowercase a-z) start and end (or single letter), with letters
 * and underscores in between. Mirrors `RoleName`, `ScopeKindName`,
 * `CredentialTypeName`. Rejects empty strings, leading or trailing
 * underscores, uppercase, and digits.
 */
export const GRANT_PATH_NAME_REGEX = /^[a-z][a-z_]*[a-z]$|^[a-z]$/;

/** Zod schema for valid grant-path name strings. */
export const GrantPathName = z
	.string()
	.regex(
		GRANT_PATH_NAME_REGEX,
		'Grant-path names must be lowercase letters and underscores (a-z_), no leading/trailing underscore',
	);
export type GrantPathName = z.infer<typeof GrantPathName>;

// Builtin grant paths — provided by fuz_app, always available.

/** Admin-mediated grant — `permit_offer_create` plus admin-direct flows. */
export const GRANT_PATH_ADMIN = 'admin';

/** Self-service grant — caller toggles their own permit via `self_service_role_set`. */
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
	GRANT_PATH_BOOTSTRAP,
] as const;

/** Zod enum for builtin grant paths only. */
export const BuiltinGrantPath = z.enum(BUILTIN_GRANT_PATHS);
export type BuiltinGrantPath = z.infer<typeof BuiltinGrantPath>;

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
 * here. Read once at startup by `create_grant_path_schema`; runtime
 * mutation has no effect on already-built schemas.
 */
export const BUILTIN_GRANT_PATH_META: ReadonlyMap<string, GrantPathMeta> = new Map([
	[
		GRANT_PATH_ADMIN,
		{
			description: 'Admin-mediated grant — admin offers via `permit_offer_create` or direct grant.',
		},
	],
	[
		GRANT_PATH_SELF_SERVICE,
		{
			description:
				'Self-service grant — caller toggles their own permit via `self_service_role_set`.',
		},
	],
	[
		GRANT_PATH_SYSTEM,
		{description: 'System-mediated grant — signup, automation, or internal service flows.'},
	],
	[
		GRANT_PATH_BOOTSTRAP,
		{description: 'Bootstrap grant — one-shot flow during the keep’s first-run bootstrap.'},
	],
]);

/** The result of `create_grant_path_schema` — a Zod schema and metadata map. */
export interface GrantPathSchemaResult {
	/**
	 * Zod schema that validates grant-path name strings against the
	 * registered set (builtins + consumer-declared). Use at I/O
	 * boundaries (admin UIs, codegen) and as the construction-time check
	 * inside `create_role_schema` for every `RoleSpec.grant_paths`
	 * entry.
	 */
	GrantPath: z.ZodType<string>;
	/**
	 * Map of every registered grant-path to its metadata. Keyed by
	 * name. Read at startup by admin / codegen surfaces.
	 */
	grant_paths: ReadonlyMap<string, GrantPathMeta>;
}

/**
 * Create a grant-path schema from the builtin set plus optional
 * consumer-declared additions.
 *
 * Builtins (`admin`, `self_service`, `system`, `bootstrap`) are always
 * present; consumer entries that collide with a builtin name throw at
 * construction. Pass the result into `create_role_schema`'s optional
 * `grant_paths` parameter so each role's `grant_paths` entries are
 * validated against this set at construction time.
 *
 * @param consumer_paths - optional consumer-declared grant-path set with optional metadata
 * @returns `{GrantPath, grant_paths}` — Zod schema and metadata map
 *
 * @throws Error if any `consumer_paths` key fails the `GrantPathName` regex, collides with a builtin name, or appears more than once
 *
 * @example
 * ```ts
 * // simple — builtins only
 * const {GrantPath, grant_paths} = create_grant_path_schema();
 *
 * // with consumer extensions
 * const {GrantPath} = create_grant_path_schema({
 *   invite_only: {description: 'Granted by claiming a consumer-issued invite.'},
 * });
 * ```
 */
export const create_grant_path_schema = (
	consumer_paths: Record<string, GrantPathMeta> = {},
): GrantPathSchemaResult => {
	const consumer_names = Object.keys(consumer_paths);

	const seen: Set<string> = new Set();
	for (const name of consumer_names) {
		const parsed = GrantPathName.safeParse(name);
		if (!parsed.success) {
			throw new Error(`Invalid grant-path name "${name}": ${parsed.error.issues[0]!.message}`);
		}
		if (BUILTIN_GRANT_PATH_META.has(name)) {
			throw new Error(`Consumer grant-path "${name}" collides with builtin grant-path`);
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate grant-path name "${name}"`);
		}
		seen.add(name);
	}

	const all_names = [...BUILTIN_GRANT_PATHS, ...consumer_names];
	const GrantPath = z.enum(all_names as [string, ...Array<string>]);

	const grant_paths: Map<string, GrantPathMeta> = new Map(BUILTIN_GRANT_PATH_META);
	for (const name of consumer_names) {
		grant_paths.set(name, consumer_paths[name]!);
	}

	return {GrantPath, grant_paths};
};
