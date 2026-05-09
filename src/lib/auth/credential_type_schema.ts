/**
 * Credential-type registry — how a request was authenticated.
 *
 * Three builtins: `session` (cookie-based), `api_token` (HTTP Bearer
 * token), `daemon_token` (filesystem proof for the keeper account).
 * Open-string registry on top so consumers can declare additional
 * credential types (e.g. `'sso_assertion'`, `'agent_token'`) without an
 * upstream release. `RoleSpec.required_credential_types` references
 * entries from this registry; v1 keeps the field informative-only
 * (consumed by `auth/middleware.ts` and the dispatcher). Mirrors the
 * open-registry pattern used for `RoleName`, `ScopeKindName`,
 * `GrantPathName`, and `AuditEventTypeName`.
 *
 * The Hono-side wire-validated `CredentialType` Zod enum (in
 * `hono_context.ts`) is the closed-set narrow type middleware sets on
 * the context; the constants below are the source of truth for those
 * three string values. Future builtin credential types added here
 * propagate to the wire enum by editing the import list.
 *
 * @module
 */

import {z} from 'zod';

/**
 * Letter (lowercase a-z) start and end (or single letter), with letters
 * and underscores in between. Mirrors `RoleName`, `ScopeKindName`,
 * `GrantPathName`. Rejects empty strings, leading or trailing
 * underscores, uppercase, and digits.
 */
export const CREDENTIAL_TYPE_NAME_REGEX = /^[a-z][a-z_]*[a-z]$|^[a-z]$/;

/** Zod schema for valid credential-type name strings. */
export const CredentialTypeName = z
	.string()
	.regex(
		CREDENTIAL_TYPE_NAME_REGEX,
		'Credential-type names must be lowercase letters and underscores (a-z_), no leading/trailing underscore',
	);
export type CredentialTypeName = z.infer<typeof CredentialTypeName>;

// Builtin credential types — provided by fuz_app, always available.

/** Cookie-based session credential. */
export const CREDENTIAL_TYPE_SESSION = 'session';

/**
 * HTTP `Authorization: Bearer` API token credential. The wire literal
 * `'api_token'` aligns with the `api_token` storage table name; the
 * constant is named `_API_TOKEN` (not `_BEARER`) to keep wire and
 * storage nomenclature in lockstep.
 */
export const CREDENTIAL_TYPE_API_TOKEN = 'api_token';

/** Daemon-token credential — filesystem proof for the keeper account. */
export const CREDENTIAL_TYPE_DAEMON_TOKEN = 'daemon_token';

/** The builtin credential-type names as a const tuple. */
export const BUILTIN_CREDENTIAL_TYPES = [
	CREDENTIAL_TYPE_SESSION,
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
] as const;

/** Zod enum for builtin credential types only. */
export const BuiltinCredentialType = z.enum(BUILTIN_CREDENTIAL_TYPES);
export type BuiltinCredentialType = z.infer<typeof BuiltinCredentialType>;

/**
 * Per-credential-type metadata. `description` is admin-UI-facing copy
 * (mirrors `RoleSpec.description` and `ScopeKindMeta.description`).
 * Open shape so v2 can extend without a breaking change.
 */
export interface CredentialTypeMeta {
	description?: string;
}

/**
 * Builtin credential-type metadata. Not overridable by consumers.
 *
 * Typed `ReadonlyMap` for the contract — but JS Maps don't honor
 * `Object.freeze` for `.set` / `.delete` / `.clear` (they mutate
 * internal slots, not own properties), so freeze adds no runtime guard
 * here. Read once at startup by `create_credential_type_schema`;
 * runtime mutation has no effect on already-built schemas.
 */
export const BUILTIN_CREDENTIAL_TYPE_META: ReadonlyMap<string, CredentialTypeMeta> = new Map([
	[
		CREDENTIAL_TYPE_SESSION,
		{description: 'Cookie-based session credential, signed and validated server-side.'},
	],
	[
		CREDENTIAL_TYPE_API_TOKEN,
		{description: 'HTTP Authorization: Bearer API token credential, hashed at rest.'},
	],
	[
		CREDENTIAL_TYPE_DAEMON_TOKEN,
		{description: 'Filesystem-proof daemon-token credential, scoped to the keeper account.'},
	],
]);

/** The result of `create_credential_type_schema` — a Zod schema and metadata map. */
export interface CredentialTypeSchemaResult {
	/**
	 * Zod schema that validates credential-type name strings against the
	 * registered set (builtins + consumer-declared). Use at I/O
	 * boundaries (admin UIs, codegen) and as the construction-time check
	 * inside `create_role_schema` for every
	 * `RoleSpec.required_credential_types` entry.
	 */
	CredentialType: z.ZodType<string>;
	/**
	 * Map of every registered credential-type to its metadata. Keyed by
	 * name. Read at startup by admin / codegen surfaces.
	 */
	credential_types: ReadonlyMap<string, CredentialTypeMeta>;
}

/**
 * Create a credential-type schema from the builtin set plus optional
 * consumer-declared additions.
 *
 * Builtins (`session`, `api_token`, `daemon_token`) are always present;
 * consumer entries that collide with a builtin name throw at
 * construction. Pass the result into `create_role_schema`'s optional
 * `credential_types` parameter so each role's
 * `required_credential_types` entries are validated against this set
 * at construction time.
 *
 * @param consumer_types - optional consumer-declared credential-type set with optional metadata
 * @returns `{CredentialType, credential_types}` — Zod schema and metadata map
 *
 * @throws Error if any `consumer_types` key fails the `CredentialTypeName` regex, collides with a builtin name, or appears more than once
 *
 * @example
 * ```ts
 * // simple — builtins only
 * const {CredentialType, credential_types} = create_credential_type_schema();
 *
 * // with consumer extensions
 * const {CredentialType} = create_credential_type_schema({
 *   sso_assertion: {description: 'OIDC SSO assertion bound to an IdP-asserted account.'},
 * });
 * ```
 */
export const create_credential_type_schema = (
	consumer_types: Record<string, CredentialTypeMeta> = {},
): CredentialTypeSchemaResult => {
	const consumer_names = Object.keys(consumer_types);

	const seen: Set<string> = new Set();
	for (const name of consumer_names) {
		const parsed = CredentialTypeName.safeParse(name);
		if (!parsed.success) {
			throw new Error(`Invalid credential-type name "${name}": ${parsed.error.issues[0]!.message}`);
		}
		if (BUILTIN_CREDENTIAL_TYPE_META.has(name)) {
			throw new Error(`Consumer credential-type "${name}" collides with builtin credential-type`);
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate credential-type name "${name}"`);
		}
		seen.add(name);
	}

	const all_names = [...BUILTIN_CREDENTIAL_TYPES, ...consumer_names];
	const CredentialType = z.enum(all_names as [string, ...Array<string>]);

	const credential_types: Map<string, CredentialTypeMeta> = new Map(BUILTIN_CREDENTIAL_TYPE_META);
	for (const name of consumer_names) {
		credential_types.set(name, consumer_types[name]!);
	}

	return {CredentialType, credential_types};
};
