/**
 * Role system — builtin roles, role specs, and extensible role schema factory.
 *
 * Defines the authorization policy vocabulary: which roles exist, their
 * required credential types, the scope kinds each role applies to, and
 * the grant paths through which each role can be granted. Each role
 * gets a structured `RoleSpec`; the factory `create_role_schema` merges
 * builtins with consumer-declared specs and validates every cross-axis
 * field against the corresponding open registries
 * (`create_credential_type_schema`, `create_scope_kind_schema`,
 * `create_grant_path_schema`) at construction time so misconfigurations
 * fire at server startup, not at first call.
 *
 * The `RoleSpec` shape replaces the pre-Step-2 flat
 * `RoleOptions` (`requires_daemon_token` / `web_grantable` booleans).
 * The boolean → registry lift surfaces the four axes the dispatcher
 * already secretly walks: credential type, scope kind, grant path,
 * and the role-name itself. v1 keeps the cross-axis fields informative-
 * only (registry-membership validation, no INSERT-time enforcement);
 * v2 may add `(role, scope_kind)` enforcement once the shape is clear
 * from real consumer usage.
 *
 * @module
 */

import {z} from 'zod';

import {
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	type CredentialTypeSchemaResult,
} from './credential_type_schema.js';
import {
	GRANT_PATH_ADMIN,
	GRANT_PATH_BOOTSTRAP,
	type GrantPathSchemaResult,
} from './grant_path_schema.js';
import type {ScopeKindSchemaResult} from './scope_kind_schema.js';

/** Valid role name: lowercase letters and underscores, no leading/trailing underscore. */
export const RoleName = z
	.string()
	.regex(
		/^[a-z][a-z_]*[a-z]$|^[a-z]$/,
		'Role names must be lowercase letters and underscores (a-z_), no leading/trailing underscore',
	);
export type RoleName = z.infer<typeof RoleName>;

// Builtin roles — provided by fuz_app, always available.

/** System-level role. Requires daemon token (filesystem proof). Controls the keep. */
export const ROLE_KEEPER = 'keeper';

/** App-level administrative role. Granted via the admin path. */
export const ROLE_ADMIN = 'admin';

/** The builtin role names as a const tuple. */
export const BUILTIN_ROLES = [ROLE_KEEPER, ROLE_ADMIN] as const;

/** Zod schema for builtin roles only. */
export const BuiltinRole = z.enum(BUILTIN_ROLES);
export type BuiltinRole = z.infer<typeof BuiltinRole>;

/**
 * Configuration for a role.
 *
 * Each role declares the credential types its holders must use, the
 * scope kinds it applies to, and the grant paths through which it can
 * be granted. Every cross-axis field is an open-registry string array —
 * `required_credential_types` against `create_credential_type_schema`,
 * `applicable_scope_kinds` against `create_scope_kind_schema`,
 * `grant_paths` against `create_grant_path_schema`. Pass the registry
 * results to `create_role_schema` and every entry is checked at
 * construction time.
 *
 * Empty arrays carry meaning:
 *
 * - `required_credential_types: []` — any authenticated credential type
 *   may exercise the role (the default for app-defined roles).
 * - `applicable_scope_kinds: []` — the role applies at the global scope
 *   only (no `scope_kind` / `scope_id` set on its role_grants). This is the
 *   default for app-defined roles; consumers add scope kinds explicitly.
 * - `grant_paths: []` — the role has no grant path declared in this
 *   registry; it is unreachable through admin / self-service / system
 *   flows. Only useful for diagnostic snapshotting.
 *
 * Builtins (`keeper`, `admin`) ship preconfigured in
 * `BUILTIN_ROLE_SPECS_BY_NAME`.
 */
export interface RoleSpec {
	/** Unique role name. Must match `RoleName` regex; collisions with builtins throw. */
	name: string;
	/** Admin-UI-facing copy describing the role's intent. */
	description?: string;
	/**
	 * Credential types whose holders are permitted to exercise this
	 * role. Each entry is checked at construction time against the
	 * `credential_types` registry passed to `create_role_schema`. Empty
	 * array = any authenticated credential type.
	 */
	required_credential_types?: ReadonlyArray<string>;
	/**
	 * Scope kinds at which this role's role_grants may be granted. Each
	 * entry is checked at construction time against the `scope_kinds`
	 * registry passed to `create_role_schema`. Empty array = global only.
	 * v1 keeps this informative-only (no INSERT-time enforcement).
	 */
	applicable_scope_kinds?: ReadonlyArray<string>;
	/**
	 * Grant paths through which this role can be granted. Each entry is
	 * checked at construction time against the `grant_paths` registry
	 * passed to `create_role_schema`. Drives downstream defaults:
	 *
	 * - `admin_actions.grantable_roles` ⊇ {role : `'admin'` ∈ grant_paths}
	 * - `self_service_role_actions` default eligibility ⊇ {role : `'self_service'` ∈ grant_paths}
	 *
	 * Empty array = role is not granted via any registered path (only
	 * exists for diagnostic / future use).
	 */
	grant_paths?: ReadonlyArray<string>;
}

/**
 * Builtin role specs, keyed by role name. Not overridable by consumers
 * — read once at startup by `create_role_schema` and the action
 * factories that fall back to builtins when no consumer `roles` is
 * supplied. `ReadonlyMap` encodes the contract; runtime mutation has
 * no effect on already-built role schemas (the factory copies entries
 * into a fresh `Map`).
 */
export const BUILTIN_ROLE_SPECS_BY_NAME: ReadonlyMap<string, RoleSpec> = new Map<string, RoleSpec>([
	[
		ROLE_KEEPER,
		{
			name: ROLE_KEEPER,
			description:
				'System-level role; controls the keep. Requires the daemon-token credential and lands via the bootstrap grant path.',
			required_credential_types: [CREDENTIAL_TYPE_DAEMON_TOKEN],
			applicable_scope_kinds: [],
			grant_paths: [GRANT_PATH_BOOTSTRAP],
		},
	],
	[
		ROLE_ADMIN,
		{
			name: ROLE_ADMIN,
			description:
				'App-level administrative role. Web-grantable through the admin path; manages users and content.',
			required_credential_types: [],
			applicable_scope_kinds: [],
			grant_paths: [GRANT_PATH_ADMIN],
		},
	],
]);

/** Optional registries to validate `RoleSpec` cross-axis fields against at construction time. */
export interface CreateRoleSchemaOptions {
	/** Pass `create_credential_type_schema()` to validate `RoleSpec.required_credential_types` entries. */
	credential_types?: CredentialTypeSchemaResult;
	/** Pass `create_scope_kind_schema()` to validate `RoleSpec.applicable_scope_kinds` entries. */
	scope_kinds?: ScopeKindSchemaResult;
	/** Pass `create_grant_path_schema()` to validate `RoleSpec.grant_paths` entries. */
	grant_paths?: GrantPathSchemaResult;
}

/** The result of `create_role_schema` — a Zod schema and spec map for all roles. */
export interface RoleSchemaResult {
	/** Zod schema that validates role strings. Use at I/O boundaries (grant endpoint, role_grant queries). */
	Role: z.ZodType<string>;
	/** Specs for every role (builtins + app-defined). Keyed by role name. */
	role_specs: ReadonlyMap<string, RoleSpec>;
}

const validate_registry_membership = (
	role_name: string,
	field: 'required_credential_types' | 'applicable_scope_kinds' | 'grant_paths',
	values: ReadonlyArray<string> | undefined,
	registry: ReadonlyMap<string, unknown> | null,
): void => {
	if (!registry || !values) return;
	for (const value of values) {
		if (!registry.has(value)) {
			throw new Error(
				`Role "${role_name}" declares ${field}="${value}" which is not a registered ${field.replace(/s$/, '')}`,
			);
		}
	}
};

/**
 * Create a role schema and spec map that extends the builtins with
 * app-defined roles.
 *
 * Call once at server init. The returned `Role` schema validates role
 * strings at I/O boundaries (grant endpoint, role_grant queries). The
 * `role_specs` map is read by middleware for `required_credential_types`
 * checks and by admin / self-service factories to derive their default
 * eligibility filters from `RoleSpec.grant_paths`.
 *
 * Construction-time guards (all fire on misconfiguration):
 *
 * 1. Every `consumer_roles[i].name` matches `RoleName` regex.
 * 2. No two consumer roles share a name.
 * 3. No consumer role collides with a builtin (`keeper` / `admin`).
 * 4. When `options.credential_types` is supplied, every entry in
 *    `required_credential_types` is registered in that map.
 * 5. When `options.scope_kinds` is supplied, every entry in
 *    `applicable_scope_kinds` is registered in that map. (Builtins
 *    declare empty `applicable_scope_kinds`, so they pass any registry.)
 * 6. When `options.grant_paths` is supplied, every entry in
 *    `grant_paths` is registered in that map. (Builtins use only
 *    `'admin'` and `'bootstrap'`, both of which are builtin grant
 *    paths, so they pass the default registry from
 *    `create_grant_path_schema()`.)
 *
 * @param consumer_roles - app-defined role specs
 * @param options - optional registries for cross-axis validation
 * @returns `{Role, role_specs}` — Zod schema and full spec map
 *
 * @throws Error if any `consumer_roles` entry fails any of the construction-time guards above
 *
 * @example
 * ```ts
 * // visiones — opt into all four registries for full construction-time validation
 * const credential_types = create_credential_type_schema();
 * const scope_kinds = create_scope_kind_schema({
 *   classroom: {description: 'A classroom — teacher and student role_grants scope here.'},
 * });
 * const grant_paths = create_grant_path_schema();
 *
 * const {Role, role_specs} = create_role_schema(
 *   [
 *     {
 *       name: 'teacher',
 *       description: 'Educator role. Web-grantable; applies at classroom scope.',
 *       grant_paths: ['admin'],
 *       applicable_scope_kinds: ['classroom'],
 *     },
 *   ],
 *   {credential_types, scope_kinds, grant_paths},
 * );
 * ```
 */
export const create_role_schema = (
	consumer_roles: ReadonlyArray<RoleSpec>,
	options: CreateRoleSchemaOptions = {},
): RoleSchemaResult => {
	const credential_types_registry = options.credential_types?.credential_types ?? null;
	const scope_kinds_registry = options.scope_kinds?.scope_kinds ?? null;
	const grant_paths_registry = options.grant_paths?.grant_paths ?? null;

	const seen: Set<string> = new Set();
	for (const spec of consumer_roles) {
		const parsed = RoleName.safeParse(spec.name);
		if (!parsed.success) {
			throw new Error(`Invalid role name "${spec.name}": ${parsed.error.issues[0]!.message}`);
		}
		if (BUILTIN_ROLE_SPECS_BY_NAME.has(spec.name)) {
			throw new Error(`App role "${spec.name}" collides with builtin role`);
		}
		if (seen.has(spec.name)) {
			throw new Error(`Duplicate role name "${spec.name}"`);
		}
		seen.add(spec.name);

		validate_registry_membership(
			spec.name,
			'required_credential_types',
			spec.required_credential_types,
			credential_types_registry,
		);
		validate_registry_membership(
			spec.name,
			'applicable_scope_kinds',
			spec.applicable_scope_kinds,
			scope_kinds_registry,
		);
		validate_registry_membership(spec.name, 'grant_paths', spec.grant_paths, grant_paths_registry);
	}

	const role_specs: Map<string, RoleSpec> = new Map(BUILTIN_ROLE_SPECS_BY_NAME);
	for (const spec of consumer_roles) {
		role_specs.set(spec.name, spec);
	}

	const all_names = [...role_specs.keys()];
	const Role = z.enum(all_names as [string, ...Array<string>]);

	return {Role, role_specs};
};

/**
 * Predicate over a `RoleSpec` map: does the named role include the given
 * grant path? Returns `false` for unknown roles. Used by
 * `admin_actions.create_admin_actions` (path = `'admin'`) and
 * `self_service_role_actions.create_self_service_role_actions` (path =
 * `'self_service'`) to derive their default eligibility filters.
 */
export const role_has_grant_path = (
	role_specs: ReadonlyMap<string, RoleSpec>,
	role: string,
	grant_path: string,
): boolean => {
	const spec = role_specs.get(role);
	return !!spec?.grant_paths?.includes(grant_path);
};

/** Filter helper: list every role whose `grant_paths` includes the given path. */
export const list_roles_with_grant_path = (
	role_specs: ReadonlyMap<string, RoleSpec>,
	grant_path: string,
): Array<string> => {
	const out: Array<string> = [];
	for (const [name, spec] of role_specs) {
		if (spec.grant_paths?.includes(grant_path)) out.push(name);
	}
	return out;
};
