/**
 * Credential-type registry — how a request was authenticated.
 *
 * Three builtins: `session` (cookie-based), `api_token` (HTTP Bearer
 * token), `daemon_token` (filesystem proof for the keeper account).
 * Open-string registry on top so consumers can declare additional
 * credential types (e.g. `'sso_assertion'`, `'agent_token'`) without an
 * upstream release. `RoleSpec.required_credential_types` references
 * entries from this registry; v1 keeps the field informative-only —
 * validated at construction, enforced nowhere; routes and actions gate
 * with `auth.credential_types`. Mirrors the
 * open-registry pattern used for `RoleName`, `ScopeKindName`,
 * `GrantPathName`, and `AuditEventTypeName`.
 *
 * `BuiltinCredentialType` is the closed set middleware sets on the Hono
 * context (`hono_context.ts`) and the audit log records — middleware only
 * ever authenticates through a builtin. Consumer-declared types live in
 * the registry `create_credential_type_registry` builds, consulted when
 * validating `RoleSpec.required_credential_types`.
 *
 * @module
 */

import { format_issue, parse, type Infer } from '@fuzdev/fuz_schema/schema.ts';

import { create_name_schema } from './name_schema.ts';

/**
 * Valid credential-type name strings: the shared name grammar
 * (`auth/name_schema.ts`), runs of lowercase letters joined by single
 * underscores, at most `NAME_LENGTH_MAX` characters.
 */
export const CredentialTypeName = create_name_schema('Credential-type');
export type CredentialTypeName = Infer<typeof CredentialTypeName>;

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
	CREDENTIAL_TYPE_DAEMON_TOKEN
] as const;

/** A builtin credential-type name, the closed set middleware authenticates through. */
export type BuiltinCredentialType = (typeof BUILTIN_CREDENTIAL_TYPES)[number];

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
 * here. Read once at startup by `create_credential_type_registry`;
 * runtime mutation has no effect on already-built schemas.
 */
export const builtin_credential_type_meta: ReadonlyMap<string, CredentialTypeMeta> = new Map([
	[
		CREDENTIAL_TYPE_SESSION,
		{ description: 'Cookie-based session credential, signed and validated server-side.' }
	],
	[
		CREDENTIAL_TYPE_API_TOKEN,
		{ description: 'HTTP Authorization: Bearer API token credential, hashed at rest.' }
	],
	[
		CREDENTIAL_TYPE_DAEMON_TOKEN,
		{ description: 'Filesystem-proof daemon-token credential, scoped to the keeper account.' }
	]
]);

/** The result of `create_credential_type_registry` — the metadata map. */
export interface CredentialTypeRegistry {
	/**
	 * Map of every registered credential-type to its metadata. Keyed by
	 * name. Read at startup by admin / codegen surfaces.
	 */
	credential_types: ReadonlyMap<string, CredentialTypeMeta>;
}

/**
 * Create a credential-type registry from the builtin set plus optional
 * consumer-declared additions.
 *
 * Builtins (`session`, `api_token`, `daemon_token`) are always present;
 * consumer entries that collide with a builtin name throw at
 * construction. Pass the result into `create_role_registry`'s optional
 * `credential_types` parameter so each role's
 * `required_credential_types` entries are validated against this set
 * at construction time.
 *
 * @param consumer_types - optional consumer-declared credential-type set with optional metadata
 * @returns `{credential_types}` — the metadata map
 *
 * @throws Error if any `consumer_types` key fails `CredentialTypeName` (its grammar or its length cap), collides with a builtin name, or appears more than once
 *
 * @example
 * ```ts
 * // simple — builtins only
 * const {credential_types} = create_credential_type_registry();
 *
 * // with consumer extensions
 * const {credential_types} = create_credential_type_registry({
 *   sso_assertion: {description: 'OIDC SSO assertion bound to an IdP-asserted account.'},
 * });
 * ```
 */
export const create_credential_type_registry = (
	consumer_types: Record<string, CredentialTypeMeta> = {}
): CredentialTypeRegistry => {
	const consumer_names = Object.keys(consumer_types);

	const seen: Set<string> = new Set();
	for (const name of consumer_names) {
		const parsed = parse(CredentialTypeName, name);
		if (!parsed.ok) {
			throw new Error(`Invalid credential-type name "${name}": ${format_issue(parsed.issues[0]!)}`);
		}
		if (builtin_credential_type_meta.has(name)) {
			throw new Error(`Consumer credential-type "${name}" collides with builtin credential-type`);
		}
		if (seen.has(name)) {
			throw new Error(`Duplicate credential-type name "${name}"`);
		}
		seen.add(name);
	}

	const credential_types: Map<string, CredentialTypeMeta> = new Map(builtin_credential_type_meta);
	for (const name of consumer_names) {
		credential_types.set(name, consumer_types[name]!);
	}

	return { credential_types };
};
