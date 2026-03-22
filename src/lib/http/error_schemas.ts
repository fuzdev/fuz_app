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

import {z} from 'zod';

import type {RouteAuth} from './route_spec.js';

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

/** Rate limiter rejected the request. */
export const ERROR_RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded' as const;

/** Username or password is wrong (intentionally vague for enumeration prevention). */
export const ERROR_INVALID_CREDENTIALS = 'invalid_credentials' as const;

/** Request body exceeds the maximum allowed size. */
export const ERROR_PAYLOAD_TOO_LARGE = 'payload_too_large' as const;

// --- Origin & bearer token verification ---

/** Request origin not in allowlist. */
export const ERROR_FORBIDDEN_ORIGIN = 'forbidden_origin' as const;

/** Request referer not in allowlist. */
export const ERROR_FORBIDDEN_REFERER = 'forbidden_referer' as const;

/** Bearer token sent with Origin/Referer header (browser context). */
export const ERROR_BEARER_REJECTED_BROWSER = 'bearer_token_rejected_in_browser_context' as const;

/** Bearer token failed validation (missing, malformed, or revoked). */
export const ERROR_INVALID_TOKEN = 'invalid_token' as const;

/** Token references a deleted account. */
export const ERROR_ACCOUNT_NOT_FOUND = 'account_not_found' as const;

// --- Keeper / daemon token ---

/** Keeper routes require daemon_token credential type. */
export const ERROR_KEEPER_REQUIRES_DAEMON_TOKEN = 'keeper_requires_daemon_token' as const;

/** Daemon token header present but malformed or not matching current/previous token. */
export const ERROR_INVALID_DAEMON_TOKEN = 'invalid_daemon_token' as const;

/** Daemon token valid but keeper account not yet resolved (pre-bootstrap). */
export const ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED = 'keeper_account_not_configured' as const;

/** Keeper account ID set but account row not found. */
export const ERROR_KEEPER_ACCOUNT_NOT_FOUND = 'keeper_account_not_found' as const;

// --- Bootstrap ---

/** Bootstrap lock already acquired — system already bootstrapped. */
export const ERROR_ALREADY_BOOTSTRAPPED = 'already_bootstrapped' as const;

/** Bootstrap token file not found on disk. */
export const ERROR_TOKEN_FILE_MISSING = 'token_file_missing' as const;

/** Bootstrap endpoint called but no token path configured. */
export const ERROR_BOOTSTRAP_NOT_CONFIGURED = 'bootstrap_not_configured' as const;

// --- Signup / Invites ---

/** No unclaimed invite matches the signup credentials. */
export const ERROR_NO_MATCHING_INVITE = 'no_matching_invite' as const;

/** Signup conflict — username or email already taken (intentionally vague for enumeration prevention). */
export const ERROR_SIGNUP_CONFLICT = 'signup_conflict' as const;

/** Invite not found (for delete operations). */
export const ERROR_INVITE_NOT_FOUND = 'invite_not_found' as const;

/** Invite must have at least an email or username. */
export const ERROR_INVITE_MISSING_IDENTIFIER = 'invite_missing_identifier' as const;

/** An unclaimed invite already exists for this email or username. */
export const ERROR_INVITE_DUPLICATE = 'invite_duplicate' as const;

/** An account already exists with this invite's username. */
export const ERROR_INVITE_ACCOUNT_EXISTS_USERNAME = 'invite_account_exists_username' as const;

/** An account already exists with this invite's email. */
export const ERROR_INVITE_ACCOUNT_EXISTS_EMAIL = 'invite_account_exists_email' as const;

// --- Admin routes ---

/** Admin tried to grant a role that is not web-grantable. */
export const ERROR_ROLE_NOT_WEB_GRANTABLE = 'role_not_web_grantable' as const;

/** Permit ID not found or not owned by the target actor. */
export const ERROR_PERMIT_NOT_FOUND = 'permit_not_found' as const;

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

// --- Standard error shapes ---
// Using z.looseObject — error responses may carry extra context fields.

/** Base API error — all JSON error responses have at least `{error: string}`. */
export const ApiError = z.looseObject({error: z.string()});
export type ApiError = z.infer<typeof ApiError>;

/**
 * Input validation error — returned when the request body fails Zod parsing.
 *
 * `issues` contains the Zod validation issues for diagnostic display.
 */
export const ValidationError = z.looseObject({
	error: z.string(),
	issues: z.array(
		z.looseObject({
			code: z.string(),
			message: z.string(),
			path: z.array(z.union([z.string(), z.number()])),
		}),
	),
});
export type ValidationError = z.infer<typeof ValidationError>;

/** Permission error — returned by `require_role()` when the required role is missing. */
export const PermissionError = z.looseObject({
	error: z.literal(ERROR_INSUFFICIENT_PERMISSIONS),
	required_role: z.string(),
});
export type PermissionError = z.infer<typeof PermissionError>;

/** Keeper credential error — returned by `require_keeper` when credential type is wrong. */
export const KeeperError = z.looseObject({
	error: z.literal(ERROR_KEEPER_REQUIRES_DAEMON_TOKEN),
	credential_type: z.string(),
});
export type KeeperError = z.infer<typeof KeeperError>;

/** Rate limit error — returned when a rate limiter rejects the request. */
export const RateLimitError = z.looseObject({
	error: z.literal(ERROR_RATE_LIMIT_EXCEEDED),
	retry_after: z.number(),
});
export type RateLimitError = z.infer<typeof RateLimitError>;

/** Payload too large error — returned when the request body exceeds the size limit. */
export const PayloadTooLargeError = z.looseObject({
	error: z.literal(ERROR_PAYLOAD_TOO_LARGE),
});
export type PayloadTooLargeError = z.infer<typeof PayloadTooLargeError>;

/** Foreign key violation error — returned when a delete is blocked by references. */
export const ForeignKeyError = z.looseObject({
	error: z.literal(ERROR_FOREIGN_KEY_VIOLATION),
});
export type ForeignKeyError = z.infer<typeof ForeignKeyError>;

/**
 * Error schema map — maps HTTP status codes to Zod schemas.
 *
 * Used on `RouteSpec.errors` and internally by `derive_error_schemas`.
 */
export type RouteErrorSchemas = Partial<Record<number, z.ZodType>>;

/**
 * Rate limit key type — declares what a route's rate limiter is keyed on.
 *
 * - `'ip'` — per-IP rate limiting (bootstrap, password change, bearer auth)
 * - `'account'` — per-account rate limiting (keyed on submitted identifier)
 * - `'both'` — both per-IP and per-account (login)
 */
export type RateLimitKey = 'ip' | 'account' | 'both';

/**
 * Derive error schemas from a route's auth requirement, input schema, and rate limit config.
 *
 * Returns the error schemas that middleware will auto-produce for this route.
 * Route handlers can declare additional error schemas via `RouteSpec.errors`;
 * explicit entries override auto-derived ones for the same status code.
 *
 * Derivation rules:
 * - **Has input schema** (non-null) or **has params schema** or **has query schema**: 400 (validation error with issues)
 * - **auth: authenticated**: 401
 * - **auth: role**: 401 + 403 (with `required_role`)
 * - **auth: keeper**: 401 + 403 (keeper-specific)
 * - **rate_limit**: 429 (rate limit exceeded with `retry_after`)
 *
 * @param auth - the route's auth requirement
 * @param has_input - whether the route has a non-null input schema
 * @param has_params - whether the route has a params schema
 * @param has_query - whether the route has a query schema
 * @param rate_limit - the rate limit key type, if any
 * @returns error schemas keyed by HTTP status code
 */
export const derive_error_schemas = (
	auth: RouteAuth,
	has_input: boolean,
	has_params = false,
	has_query = false,
	rate_limit?: RateLimitKey,
): RouteErrorSchemas => {
	const errors: RouteErrorSchemas = {};

	if (has_input || has_params || has_query) {
		errors[400] = ValidationError;
	}

	switch (auth.type) {
		case 'none':
			break;
		case 'authenticated':
			errors[401] = ApiError;
			break;
		case 'role':
			errors[401] = ApiError;
			errors[403] = PermissionError;
			break;
		case 'keeper':
			errors[401] = ApiError;
			errors[403] = KeeperError;
			break;
	}

	if (rate_limit) {
		errors[429] = RateLimitError;
	}

	return errors;
};
