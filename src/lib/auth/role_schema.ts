/**
 * Role system — builtin roles, role specs, and extensible role registry factory.
 *
 * Defines the authorization policy vocabulary: which roles exist, their
 * required credential types, the scope kinds each role applies to, and
 * the grant paths through which each role can be granted. Each role
 * gets a structured `RoleSpec`; the factory `create_role_registry` merges
 * builtins with consumer-declared specs and validates every cross-axis
 * field against the corresponding open registries
 * (`create_credential_type_registry`, `create_scope_kind_registry`,
 * `create_grant_path_registry`) at construction time so misconfigurations
 * fire at server startup, not at first call.
 *
 * `RoleSpec` carries the four cross-axis fields that the dispatcher
 * branches on: credential type, scope kind, grant path, and the
 * role-name itself. v1 keeps the cross-axis fields informative-only
 * (registry-membership validation, no INSERT-time enforcement); v2 may
 * add `(role, scope_kind)` enforcement once the shape is clear from
 * real consumer usage.
 *
 * @module
 */

import { format_issue, parse, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import {
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	type CredentialTypeRegistry
} from './credential_type_schema.ts';
import {
	GRANT_PATH_ADMIN,
	GRANT_PATH_BOOTSTRAP,
	type GrantPathRegistry
} from './grant_path_schema.ts';
import {
	create_name_schema,
	format_name_length_message,
	format_name_pattern_message
} from './name_schema.ts';
import type { ScopeKindRegistry } from './scope_kind_schema.ts';

/** The message of a role name longer than `NAME_LENGTH_MAX`. */
export const ROLE_NAME_LENGTH_MESSAGE = format_name_length_message('Role');

/** The message of a role name off `NAME_REGEX`. */
export const ROLE_NAME_PATTERN_MESSAGE = format_name_pattern_message('Role');

/**
 * Valid role name: the shared name grammar (`auth/name_schema.ts`), lowercase
 * letters and underscores, no leading, trailing or consecutive underscores, at
 * most `NAME_LENGTH_MAX` characters. A role string is caller-chosen text until
 * it passes the grammar, and the grant verbs record the role they refuse in a
 * failure audit row, so the grammar bounds its length too. A string it
 * refuses gets `ROLE_NAME_LENGTH_MESSAGE` or `ROLE_NAME_PATTERN_MESSAGE`; a
 * value that is no string, fuz_schema's message.
 */
export const RoleName = create_name_schema('Role');
export type RoleName = Infer<typeof RoleName>;

// Builtin roles — provided by fuz_app, always available.

/** System-level role. Requires daemon token (filesystem proof). Controls the keep. */
export const ROLE_KEEPER = 'keeper';

/** App-level administrative role. Granted via the admin path. */
export const ROLE_ADMIN = 'admin';

/** The builtin role names as a const tuple. */
export const BUILTIN_ROLES = [ROLE_KEEPER, ROLE_ADMIN] as const;

/** A builtin role name, `keeper` or `admin`. */
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/**
 * Whether `name` is a builtin role (`keeper` / `admin`).
 *
 * Builtin roles are **global-only**: no grant path binds one to a scope
 * (`role_grant_assign`, `role_grant_offer_create`, and
 * `role_grant_offer_accept` refuse it), and every gate that reads one checks
 * the global grant, so a scoped builtin row confers nothing.
 *
 * @param name - the role name to check
 * @returns `true` for `keeper` or `admin`
 */
export const is_builtin_role = (name: string): name is BuiltinRole =>
	name === ROLE_KEEPER || name === ROLE_ADMIN;

/**
 * Configuration for a role.
 *
 * Each role declares the credential types its holders are meant to use, the
 * scope kinds it applies to, and the grant paths through which it can
 * be granted. Every cross-axis field is an open-registry string array —
 * `required_credential_types` against `create_credential_type_registry`,
 * `applicable_scope_kinds` against `create_scope_kind_registry`,
 * `grant_paths` against `create_grant_path_registry`. Pass the registry
 * results to `create_role_registry` and every entry is checked at
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
 * `builtin_role_specs`.
 */
export interface RoleSpec {
	/** Unique role name. Must match `RoleName` — the name grammar and its length cap; collisions with builtins throw. */
	name: string;
	/** Admin-UI-facing copy describing the role's intent. */
	description?: string;
	/**
	 * Credential types whose holders are meant to exercise this role.
	 * Informative only: each entry is checked at construction time against
	 * the `credential_types` registry passed to `create_role_registry`, but no
	 * middleware or dispatcher reads it per request — a route or action
	 * gates credentials with its own `auth.credential_types` (the keeper
	 * verbs declare `['daemon_token']` there). Empty array = any
	 * authenticated credential type.
	 */
	required_credential_types?: ReadonlyArray<string>;
	/**
	 * Scope kinds at which this role's role_grants may be granted. Each
	 * entry is checked at construction time against the `scope_kinds`
	 * registry passed to `create_role_registry`. Empty array = global only.
	 * v1 keeps this informative-only (no INSERT-time enforcement).
	 */
	applicable_scope_kinds?: ReadonlyArray<string>;
	/**
	 * Grant paths through which this role can be granted. Each entry is
	 * checked at construction time against the `grant_paths` registry
	 * passed to `create_role_registry`. Drives downstream defaults:
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
 * — read once at startup by `create_role_registry` and the action
 * factories that fall back to builtins when no consumer `roles` is
 * supplied. `ReadonlyMap` encodes the contract; runtime mutation has
 * no effect on already-built role registries (the factory copies entries
 * into a fresh `Map`).
 */
export const builtin_role_specs: ReadonlyMap<string, RoleSpec> = new Map<string, RoleSpec>([
	[
		ROLE_KEEPER,
		{
			name: ROLE_KEEPER,
			description:
				'System-level role; controls the keep. Requires the daemon-token credential and lands via the bootstrap grant path.',
			required_credential_types: [CREDENTIAL_TYPE_DAEMON_TOKEN],
			applicable_scope_kinds: [],
			grant_paths: [GRANT_PATH_BOOTSTRAP]
		}
	],
	[
		ROLE_ADMIN,
		{
			name: ROLE_ADMIN,
			description:
				'App-level administrative role. Web-grantable through the admin path; manages users and content.',
			required_credential_types: [],
			applicable_scope_kinds: [],
			grant_paths: [GRANT_PATH_ADMIN]
		}
	]
]);

/** Optional registries to validate `RoleSpec` cross-axis fields against at construction time. */
export interface CreateRoleRegistryOptions {
	/** Pass `create_credential_type_registry()` to validate `RoleSpec.required_credential_types` entries. */
	credential_types?: CredentialTypeRegistry;
	/** Pass `create_scope_kind_registry()` to validate `RoleSpec.applicable_scope_kinds` entries. */
	scope_kinds?: ScopeKindRegistry;
	/** Pass `create_grant_path_registry()` to validate `RoleSpec.grant_paths` entries. */
	grant_paths?: GrantPathRegistry;
}

/** The result of `create_role_registry` — the spec map for all roles. */
export interface RoleRegistry {
	/** Specs for every role (builtins + app-defined). Keyed by role name. */
	role_specs: ReadonlyMap<string, RoleSpec>;
}

const validate_registry_membership = (
	role_name: string,
	field: 'required_credential_types' | 'applicable_scope_kinds' | 'grant_paths',
	values: ReadonlyArray<string> | undefined,
	registry: ReadonlyMap<string, unknown> | null
): void => {
	if (!registry || !values) return;
	for (const value of values) {
		if (!registry.has(value)) {
			throw new Error(
				`Role "${role_name}" declares ${field}="${value}" which is not a registered ${field.replace(
					/s$/,
					''
				)}`
			);
		}
	}
};

/**
 * Create the role spec map that extends the builtins with app-defined
 * roles.
 *
 * Call once at server init. The `role_specs` map is read by the admin / self-service factories to derive
 * their default eligibility filters from `RoleSpec.grant_paths`, and by the
 * cell grant verbs to refuse an unregistered role principal.
 * `RoleSpec.required_credential_types` is validated here but enforced
 * nowhere — credential gating lives on each route's and action's
 * `auth.credential_types`.
 *
 * Construction-time guards (all fire on misconfiguration):
 *
 * 1. Every `consumer_roles[i].name` matches `RoleName` — the name grammar
 *    and its `NAME_LENGTH_MAX` length cap.
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
 *    `create_grant_path_registry()`.)
 *
 * @param consumer_roles - app-defined role specs
 * @param options - optional registries for cross-axis validation
 * @returns `{role_specs}` — the full spec map
 *
 * @throws Error if any `consumer_roles` entry fails any of the construction-time guards above
 *
 * @example
 * ```ts
 * // visiones — opt into all four registries for full construction-time validation
 * const credential_types = create_credential_type_registry();
 * const scope_kinds = create_scope_kind_registry({
 *   classroom: {description: 'A classroom — teacher and student role_grants scope here.'},
 * });
 * const grant_paths = create_grant_path_registry();
 *
 * const {role_specs} = create_role_registry(
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
export const create_role_registry = (
	consumer_roles: ReadonlyArray<RoleSpec>,
	options: CreateRoleRegistryOptions = {}
): RoleRegistry => {
	const credential_types_registry = options.credential_types?.credential_types ?? null;
	const scope_kinds_registry = options.scope_kinds?.scope_kinds ?? null;
	const grant_paths_registry = options.grant_paths?.grant_paths ?? null;

	const seen: Set<string> = new Set();
	for (const spec of consumer_roles) {
		const parsed = parse(RoleName, spec.name);
		if (!parsed.ok) {
			throw new Error(`Invalid role name "${spec.name}": ${format_issue(parsed.issues[0]!)}`);
		}
		if (builtin_role_specs.has(spec.name)) {
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
			credential_types_registry
		);
		validate_registry_membership(
			spec.name,
			'applicable_scope_kinds',
			spec.applicable_scope_kinds,
			scope_kinds_registry
		);
		validate_registry_membership(spec.name, 'grant_paths', spec.grant_paths, grant_paths_registry);
	}

	const role_specs: Map<string, RoleSpec> = new Map(builtin_role_specs);
	for (const spec of consumer_roles) {
		role_specs.set(spec.name, spec);
	}

	return { role_specs };
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
	grant_path: string
): boolean => {
	const spec = role_specs.get(role);
	return !!spec?.grant_paths?.includes(grant_path);
};

/** Filter helper: list every role whose `grant_paths` includes the given path. */
export const list_roles_with_grant_path = (
	role_specs: ReadonlyMap<string, RoleSpec>,
	grant_path: string
): Array<string> => {
	const out: Array<string> = [];
	for (const [name, spec] of role_specs) {
		if (spec.grant_paths?.includes(grant_path)) out.push(name);
	}
	return out;
};
