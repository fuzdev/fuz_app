/**
 * Role system — builtin roles, role options, and extensible role schema factory.
 *
 * Defines the authorization policy vocabulary: which roles exist, what
 * capabilities they require (daemon token, web grantability), and a factory
 * for extending with app-defined roles.
 *
 * @module
 */

import {z} from 'zod';

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

/** App-level administrative role. Web-grantable, manages users and content. */
export const ROLE_ADMIN = 'admin';

/** The builtin role names as a const tuple. */
export const BUILTIN_ROLES = [ROLE_KEEPER, ROLE_ADMIN] as const;

/** Zod schema for builtin roles only. */
export const BuiltinRole = z.enum(BUILTIN_ROLES);
export type BuiltinRole = z.infer<typeof BuiltinRole>;

// Role configuration — metadata per role, used by middleware and UI.

/**
 * Configuration for a role.
 *
 * Builtin roles have fixed configs. App-defined roles get sensible defaults
 * (`requires_daemon_token: false`, `web_grantable: true`).
 */
export interface RoleOptions {
	/** If true, exercising this role requires daemon token authentication. Only `keeper` for now. */
	requires_daemon_token?: boolean;
	/** If true, admins can grant this role via the web UI. Default `true`. */
	web_grantable?: boolean;
}

/** Builtin role configs. Not overridable by consumers. */
export const BUILTIN_ROLE_OPTIONS: ReadonlyMap<string, Required<RoleOptions>> = new Map([
	[ROLE_KEEPER, {requires_daemon_token: true, web_grantable: false}],
	[ROLE_ADMIN, {requires_daemon_token: false, web_grantable: true}],
]);

/** The result of `create_role_schema` — a Zod schema and config map for all roles. */
export interface RoleSchemaResult {
	/** Zod schema that validates role strings. Use at I/O boundaries (grant endpoint, permit queries). */
	Role: z.ZodType<string>;
	/** Options for every role (builtins + app-defined). Keyed by role name. */
	role_options: ReadonlyMap<string, Required<RoleOptions>>;
}

/**
 * Create a role schema and config map that extends the builtins with app-defined roles.
 *
 * Call once at server init. The returned `Role` schema validates role strings
 * at I/O boundaries (grant endpoint, permit queries). The `role_options` map
 * is used by middleware to check `requires_daemon_token` and by admin UI to
 * filter `web_grantable` roles.
 *
 * @param app_roles - app-defined roles with optional config overrides
 * @returns `{Role, role_options}` — Zod schema and full config map
 *
 * @example
 * ```ts
 * // visiones
 * const {Role, role_options} = create_role_schema({
 *   teacher: {},
 * });
 * // Role validates 'keeper' | 'admin' | 'teacher'
 * // role_options has all 3 entries with defaults applied
 * ```
 */
export const create_role_schema = <T extends string>(
	app_roles: Record<T, RoleOptions>,
): RoleSchemaResult => {
	const app_role_names = Object.keys(app_roles) as Array<T>;

	// Validate role names and no collisions with builtins
	for (const name of app_role_names) {
		RoleName.parse(name);
		if (BUILTIN_ROLE_OPTIONS.has(name)) {
			throw new Error(`App role "${name}" collides with builtin role`);
		}
	}

	const all_names = [...BUILTIN_ROLES, ...app_role_names];
	const Role = z.enum(all_names as [string, ...Array<string>]);

	const role_options: Map<string, Required<RoleOptions>> = new Map(BUILTIN_ROLE_OPTIONS);
	for (const name of app_role_names) {
		const config = app_roles[name];
		role_options.set(name, {
			requires_daemon_token: config.requires_daemon_token ?? false,
			web_grantable: config.web_grantable ?? true,
		});
	}

	return {Role, role_options};
};
