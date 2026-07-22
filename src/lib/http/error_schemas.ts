/**
 * Standard error response schemas and error code constants for fuz_app routes.
 *
 * Defines `ERROR_*` constants (single source of truth for machine-parseable
 * error codes), Zod schemas for error response shapes, a type for error schema
 * maps, and `derive_error_schemas` to auto-populate middleware-produced errors
 * from a route's auth requirement and input schema.
 *
 * Used in `RouteSpec.errors` and `MiddlewareSpec.errors` for surface
 * introspection and DEV-mode validation.
 *
 * @module
 */

import { z } from 'zod';

import { needs_actor, type RouteAuth } from './auth_shape.ts';

// --- Core: Validation (auto-derived by route spec middleware) ---

/** Request body failed Zod validation. */
export const ERROR_INVALID_REQUEST_BODY = 'invalid_request_body' as const;

/** Request body is not valid JSON or not an object. */
export const ERROR_INVALID_JSON_BODY = 'invalid_json_body' as const;

/** URL path params failed Zod validation. */
export const ERROR_INVALID_ROUTE_PARAMS = 'invalid_route_params' as const;

/** URL query params failed Zod validation. */
export const ERROR_INVALID_QUERY_PARAMS = 'invalid_query_params' as const;

// --- Core: Authentication & authorization (auto-derived by auth middleware) ---

/** No valid session or bearer token. */
export const ERROR_AUTHENTICATION_REQUIRED = 'authentication_required' as const;

/** Authenticated but missing required role. */
export const ERROR_INSUFFICIENT_PERMISSIONS = 'insufficient_permissions' as const;

/**
 * Route requires a credential type the request didn't arrive on.
 * Symmetric with `ERROR_INSUFFICIENT_PERMISSIONS` + `required_roles`:
 * the body carries `required_credential_types: ReadonlyArray<string>`
 * — what the route demanded, not what arrived. Today the only
 * credential gate is keeper (`['daemon_token']`); future gates
 * (`agent_token`, `group_actor_token`) reuse the same literal and
 * label themselves through the array.
 */
export const ERROR_CREDENTIAL_TYPE_REQUIRED = 'credential_type_required' as const;

/** Rate limiter rejected the request. */
export const ERROR_RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded' as const;

/** Username or password is wrong (intentionally vague for enumeration prevention). */
export const ERROR_INVALID_CREDENTIALS = 'invalid_credentials' as const;

/** Request body exceeds the maximum allowed size. */
export const ERROR_PAYLOAD_TOO_LARGE = 'payload_too_large' as const;

// --- Origin & bearer token verification ---

/** Request origin not in allowlist. */
export const ERROR_FORBIDDEN_ORIGIN = 'forbidden_origin' as const;

/** Bearer token failed validation (missing, malformed, or revoked). */
export const ERROR_INVALID_TOKEN = 'invalid_token' as const;

/** Token references a deleted account. */
export const ERROR_ACCOUNT_NOT_FOUND = 'account_not_found' as const;

/**
 * Multi-actor account requires the request to carry an explicit `acting`
 * field naming the actor the request is acting as, so the dispatcher's
 * authorization phase doesn't pick a default actor silently. Returned
 * with the available actors so the client can prompt.
 */
export const ERROR_ACTOR_REQUIRED = 'actor_required' as const;

/**
 * Supplied `acting` field does not name an actor on the authenticated
 * account.
 */
export const ERROR_ACTOR_NOT_ON_ACCOUNT = 'actor_not_on_account' as const;

/**
 * Authenticated account exists but has no actors. Server invariant
 * violation — signup / bootstrap always create an actor in the same
 * transaction. Surfaced from the dispatcher's authorization phase as a
 * 500 so the operator sees the corruption signal rather than a confusing
 * 4xx. Distinct from `ERROR_ACCOUNT_VANISHED`: the actor list was
 * enumerated successfully and came back empty.
 */
export const ERROR_NO_ACTORS_ON_ACCOUNT = 'no_actors_on_account' as const;

/**
 * Authentication validated an account, but a follow-up read in the
 * authorization phase came back null — the account or its named actor
 * row was deleted between the credential check and the dispatcher's
 * `build_request_context` / `build_account_context` step. Torn read,
 * not a missing-actor invariant violation. Surfaced as 500 so the
 * operator sees the race signal; clients can retry. Distinct from
 * `ERROR_ACCOUNT_NOT_FOUND` (stale token referencing a long-deleted
 * account, raised at credential validation) and
 * `ERROR_NO_ACTORS_ON_ACCOUNT` (the actor list enumerated empty).
 */
export const ERROR_ACCOUNT_VANISHED = 'account_vanished' as const;

// --- Keeper / daemon token ---

/** Keeper account ID set but account row not found. */
export const ERROR_KEEPER_ACCOUNT_NOT_FOUND = 'keeper_account_not_found' as const;

// --- Bootstrap ---

/** Bootstrap lock already acquired — system already bootstrapped. */
export const ERROR_ALREADY_BOOTSTRAPPED = 'already_bootstrapped' as const;

/** Bootstrap token file not found on disk. */
export const ERROR_TOKEN_FILE_MISSING = 'token_file_missing' as const;

// --- Signup / Invites ---

/** No unclaimed invite matches the signup credentials. */
export const ERROR_NO_MATCHING_INVITE = 'no_matching_invite' as const;

/** Signup conflict — username or email already taken (intentionally vague for enumeration prevention). */
export const ERROR_SIGNUP_CONFLICT = 'signup_conflict' as const;

/** Invite not found (for delete operations). */
export const ERROR_INVITE_NOT_FOUND = 'invite_not_found' as const;

/** An unclaimed invite already exists for this email or username. */
export const ERROR_INVITE_DUPLICATE = 'invite_duplicate' as const;

/** An account already exists with this invite's username. */
export const ERROR_INVITE_ACCOUNT_EXISTS_USERNAME = 'invite_account_exists_username' as const;

/** An account already exists with this invite's email. */
export const ERROR_INVITE_ACCOUNT_EXISTS_EMAIL = 'invite_account_exists_email' as const;

// --- Admin routes ---

/** Admin tried to grant a role that is not web-grantable. */
export const ERROR_ROLE_NOT_WEB_GRANTABLE = 'role_not_web_grantable' as const;

/** Role grant ID not found or not owned by the target actor. */
export const ERROR_ROLE_GRANT_NOT_FOUND = 'role_grant_not_found' as const;

/** Query parameter `event_type` is not a valid audit event type. */
export const ERROR_INVALID_EVENT_TYPE = 'invalid_event_type' as const;

// --- DB table browser ---

/** DELETE blocked by a foreign key constraint. */
export const ERROR_FOREIGN_KEY_VIOLATION = 'foreign_key_violation' as const;

/** Table name not found in `information_schema`. */
export const ERROR_TABLE_NOT_FOUND = 'table_not_found' as const;

/** Table has no primary key constraint (cannot delete by PK). */
export const ERROR_TABLE_NO_PRIMARY_KEY = 'table_no_primary_key' as const;

/** Row with the given PK value not found. */
export const ERROR_ROW_NOT_FOUND = 'row_not_found' as const;

/** Database health-check query failed (connectivity or query error). */
export const ERROR_DATABASE_CONNECTION_FAILED = 'database_connection_failed' as const;

// --- Standard error shapes ---
// Using z.looseObject — error responses may carry extra context fields.

/** Base API error — all JSON error responses have at least `{error: string}`. */
export const ApiError = z.looseObject({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;

/**
 * Input validation error — returned when params / query / body fails Zod
 * parsing, or when the request body is not valid JSON.
 *
 * `error` is one of the four validation codes the framework emits.
 * `issues` carries Zod's validation issues for diagnostic display on the
 * three schema-failure cases (`invalid_request_body`,
 * `invalid_route_params`, `invalid_query_params`). The field is optional:
 * the `invalid_json_body` case (request body parse failure or non-object
 * root) emits no `issues`, and the schema-failure cases emit them only in
 * development — production omits them (via `dev_only`) so error responses
 * don't leak input-schema structure to callers.
 */
export const ValidationError = z.looseObject({
	error: z.enum([
		ERROR_INVALID_REQUEST_BODY,
		ERROR_INVALID_JSON_BODY,
		ERROR_INVALID_ROUTE_PARAMS,
		ERROR_INVALID_QUERY_PARAMS
	]),
	issues: z
		.array(
			z.looseObject({
				code: z.string(),
				message: z.string(),
				path: z.array(z.union([z.string(), z.number()]))
			})
		)
		.optional()
});
export type ValidationError = z.infer<typeof ValidationError>;

/**
 * Permission error — returned by `require_role()` and the dispatcher's
 * post-authorization role gate when the actor's role_grants don't include any
 * of the route's `auth.roles`.
 *
 * `required_roles` carries the full disjunction the route declared
 * (`auth.roles` from the new flat-record shape). Single-role specs surface
 * as a one-element array; multi-role disjunctions show every admittable
 * role so clients can render targeted copy ("requires admin or steward").
 */
export const PermissionError = z.looseObject({
	error: z.literal(ERROR_INSUFFICIENT_PERMISSIONS),
	required_roles: z.array(z.string()).readonly()
});
export type PermissionError = z.infer<typeof PermissionError>;

/**
 * Credential-type error — returned by the dispatcher's post-authorization
 * credential gate (and the `require_credential_types` REST middleware) when
 * the request's credential type isn't in the route's
 * `auth.credential_types` allowlist.
 *
 * `required_credential_types` carries what the route declared
 * (`['daemon_token']` for keeper; future gates carry their own labels).
 * Symmetric with `PermissionError`'s `required_roles`: clients see what
 * the route demanded, not what their credential is.
 */
export const CredentialTypeRequiredError = z.looseObject({
	error: z.literal(ERROR_CREDENTIAL_TYPE_REQUIRED),
	required_credential_types: z.array(z.string()).readonly()
});
export type CredentialTypeRequiredError = z.infer<typeof CredentialTypeRequiredError>;

/** Rate limit error — returned when a rate limiter rejects the request. */
export const RateLimitError = z.looseObject({
	error: z.literal(ERROR_RATE_LIMIT_EXCEEDED),
	retry_after: z.number()
});
export type RateLimitError = z.infer<typeof RateLimitError>;

/** Payload too large error — returned when the request body exceeds the size limit. */
export const PayloadTooLargeError = z.looseObject({
	error: z.literal(ERROR_PAYLOAD_TOO_LARGE)
});
export type PayloadTooLargeError = z.infer<typeof PayloadTooLargeError>;

/** Foreign key violation error — returned when a delete is blocked by references. */
export const ForeignKeyError = z.looseObject({
	error: z.literal(ERROR_FOREIGN_KEY_VIOLATION)
});
export type ForeignKeyError = z.infer<typeof ForeignKeyError>;

/**
 * Authorization-phase failure shapes. Surfaced when the dispatcher's
 * `apply_authorization_phase` rejects a request before the handler runs —
 * the route is acting-aware (input declares `acting?: ActingActor` or
 * auth requires role_grants), but actor resolution failed.
 *
 * 400: `actor_required` (with `available[]`) for unspecified-actor on
 * a multi-actor account; `actor_not_on_account` for a supplied actor
 * id that doesn't belong to the authenticated account.
 *
 * 500: `no_actors_on_account` for a signup-invariant violation (the
 * actor list enumerated empty); `account_vanished` for a torn-read
 * race (account/actor row deleted between credential validation and
 * the dispatcher's follow-up read).
 *
 * Used by `derive_error_schemas` when `auth.actor !== 'none'` so the
 * merged error surface matches what the dispatcher actually emits.
 */
export const ActorRequiredError = z.looseObject({
	error: z.literal(ERROR_ACTOR_REQUIRED),
	available: z.array(z.looseObject({ id: z.string(), name: z.string() }))
});
export type ActorRequiredError = z.infer<typeof ActorRequiredError>;

export const ActorNotOnAccountError = z.looseObject({
	error: z.literal(ERROR_ACTOR_NOT_ON_ACCOUNT)
});
export type ActorNotOnAccountError = z.infer<typeof ActorNotOnAccountError>;

export const NoActorsOnAccountError = z.looseObject({
	error: z.literal(ERROR_NO_ACTORS_ON_ACCOUNT)
});
export type NoActorsOnAccountError = z.infer<typeof NoActorsOnAccountError>;

export const AccountVanishedError = z.looseObject({
	error: z.literal(ERROR_ACCOUNT_VANISHED)
});
export type AccountVanishedError = z.infer<typeof AccountVanishedError>;

/**
 * Error schema map — maps HTTP status codes to Zod schemas.
 *
 * Used on `RouteSpec.errors` and internally by `derive_error_schemas`.
 */
export type RouteErrorSchemas = Partial<Record<number, z.ZodType>>;

/**
 * Rate limit key type — declares what a route or RPC action's rate limiter
 * is keyed on.
 *
 * - `'ip'` — per-IP rate limiting (bootstrap, password change, bearer auth)
 * - `'account'` — per-account rate limiting. On REST auth routes the key is
 *   the submitted identifier (login). On RPC actions (post-auth) the key is
 *   the resolved actor id (`request_context.actor.id`) — separate namespace.
 * - `'both'` — both keys.
 */
export const RateLimitKey = z.enum(['ip', 'account', 'both']);
export type RateLimitKey = z.infer<typeof RateLimitKey>;

/**
 * Derive error schemas from a route's auth requirement, input schema, and rate limit config.
 *
 * Returns the error schemas that middleware will auto-produce for this route.
 * Route handlers can declare additional error schemas via `RouteSpec.errors`;
 * explicit entries override auto-derived ones for the same status code.
 *
 * Derivation rules under the new flat-record auth shape:
 * - **Has input / params / query schema**: 400 (`ValidationError`).
 * - **`auth.account === 'required'`** or **`auth.actor === 'required'`**: 401
 *   (`ApiError`) — pre-validation 401 fires when the credential isn't there.
 *   `'optional'` does not derive 401.
 * - **`auth.roles?.length`**: 403 (`PermissionError` carrying `required_roles`).
 * - **`auth.credential_types?.length`**: 403 (`CredentialTypeRequiredError`
 *   carrying `required_credential_types` — symmetric with `PermissionError`).
 *   Today the only credential gate is keeper; future gates reuse the literal.
 * - **`auth.actor !== 'none'`** (`'optional'` or `'required'`): extends 400
 *   with `ActorRequiredError` / `ActorNotOnAccountError` and adds 500 union
 *   of `NoActorsOnAccountError` / `AccountVanishedError`. The dispatcher's
 *   authorization phase emits these whenever it tries to resolve an actor.
 * - **rate_limit**: 429 (`RateLimitError` with `retry_after`).
 */
export interface DeriveErrorSchemasOptions {
	auth: RouteAuth;
	has_input?: boolean;
	has_params?: boolean;
	has_query?: boolean;
	rate_limit?: RateLimitKey;
}

export const derive_error_schemas = ({
	auth,
	has_input = false,
	has_params = false,
	has_query = false,
	rate_limit
}: DeriveErrorSchemasOptions): RouteErrorSchemas => {
	const errors: RouteErrorSchemas = {};

	const has_validation = has_input || has_params || has_query;
	if (needs_actor(auth)) {
		errors[400] = has_validation
			? z.union([ValidationError, ActorRequiredError, ActorNotOnAccountError])
			: z.union([ActorRequiredError, ActorNotOnAccountError]);
		errors[500] = z.union([NoActorsOnAccountError, AccountVanishedError]);
	} else if (has_validation) {
		errors[400] = ValidationError;
	}

	// 401 fires when the dispatcher's pre-validation gate rejects an
	// unauthenticated caller — `account === 'required'` (no credential) or
	// `actor === 'required'` (no credential to resolve an actor against,
	// per registry-time invariant 3 forbidding accountless actors in v1).
	if (auth.account === 'required' || auth.actor === 'required') {
		errors[401] = ApiError;
	}

	// 403 fires when `auth.roles` or `auth.credential_types` rejects a
	// resolved request context. With both axes set, the 403 body could be
	// either shape — emit the union so DEV-mode error-schema validation
	// accepts whichever the dispatcher produced.
	const has_role_gate = !!auth.roles?.length;
	const has_credential_gate = !!auth.credential_types?.length;
	if (has_role_gate && has_credential_gate) {
		errors[403] = z.union([PermissionError, CredentialTypeRequiredError]);
	} else if (has_role_gate) {
		errors[403] = PermissionError;
	} else if (has_credential_gate) {
		errors[403] = CredentialTypeRequiredError;
	}

	if (rate_limit) {
		errors[429] = RateLimitError;
	}

	return errors;
};
