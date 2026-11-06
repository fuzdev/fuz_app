/**
 * Standard error response schemas and error code constants for fuz_app routes.
 *
 * Defines `ERROR_*` constants (single source of truth for machine-parseable
 * error codes, which double as JSON-RPC `data.reason`s), the per-code REST
 * error definitions (`rest_error`, one `REST_*` per code a route or middleware
 * answers, each with its HTTP status and its body as a `@fuzdev/fuz_schema`
 * schema), a type for error schema maps, and `derive_route_errors`, the
 * definitions the framework answers a route with from its method, auth
 * requirement, and input slots.
 *
 * Used in `RouteSpec.errors` and `MiddlewareSpec.errors`, which each route's
 * error map (`http/route_errors.ts`) unions with the derived definitions for
 * the surface, the DEV error check, and the test helpers.
 *
 * @module
 */

import {
	array,
	integer,
	literal,
	loose_object,
	min_value,
	number,
	optional,
	pipe,
	string,
	boolean,
	union,
	type AnySchema,
	type Infer,
	type Schema,
	type SchemaEntries,
	type SchemaObjectInput,
	type SchemaObjectOutput
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

import { needs_actor, type RouteAuth } from './auth_shape.ts';
import { WireIssue } from '../schema_issues.ts';
import type { RateLimitKey } from '../rate_limiter.ts';
import type { RouteMethod } from './route_spec.ts';

// --- Core: Validation (auto-derived by route spec middleware) ---

/** Request body failed its input schema. */
export const ERROR_INVALID_REQUEST_BODY = 'invalid_request_body' as const;

/** Request body is not valid JSON or not an object. */
export const ERROR_INVALID_JSON_BODY = 'invalid_json_body' as const;

/** URL path params failed their schema. */
export const ERROR_INVALID_ROUTE_PARAMS = 'invalid_route_params' as const;

/** URL query params failed their schema. */
export const ERROR_INVALID_QUERY_PARAMS = 'invalid_query_params' as const;

/**
 * An RPC call's `params` hold an own `__proto__` key, at any depth — refused
 * by the dispatcher (`invalid_params`) before the input schema runs. See
 * `json_has_own_proto_key`.
 */
export const ERROR_PARAMS_PROTO_KEY = 'params_proto_key' as const;

// --- Core: Authentication & authorization (auto-derived by auth middleware) ---

/** No valid session or bearer token. */
export const ERROR_AUTHENTICATION_REQUIRED = 'authentication_required' as const;

/** Authenticated but missing required role. */
export const ERROR_INSUFFICIENT_PERMISSIONS = 'insufficient_permissions' as const;

/**
 * Route requires a credential type the request didn't arrive on.
 * Symmetric with `ERROR_INSUFFICIENT_PERMISSIONS` + `required_roles`:
 * the body carries `required_credential_types: Array<string>`
 * — what the route demanded, not what arrived. Today the only
 * credential gate is keeper (`['daemon_token']`); future gates
 * (`agent_token`, `group_actor_token`) reuse the same literal and
 * label themselves through the array.
 */
export const ERROR_CREDENTIAL_TYPE_REQUIRED = 'credential_type_required' as const;

/**
 * The credential is admitted on this channel, but the specific token's scope
 * does not grant the requested capability.
 *
 * The body carries `required_scope: string` in the stable
 * `<section>:<id>` capability format — `rpc:<method>` for an action,
 * `surface:<name>` for a non-RPC surface. Distinct from
 * `credential_type_required` (which is about the *channel*) and from
 * `insufficient_permissions` (about the *account's* roles): this one says the
 * account could do it but this token was minted narrower.
 */
export const ERROR_TOKEN_SCOPE_REQUIRED = 'token_scope_required' as const;

/** Rate limiter rejected the request. */
export const ERROR_RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded' as const;

/** Username or password is wrong (intentionally vague for enumeration prevention). */
export const ERROR_INVALID_CREDENTIALS = 'invalid_credentials' as const;

/** Request body exceeds the maximum allowed size. */
export const ERROR_PAYLOAD_TOO_LARGE = 'payload_too_large' as const;

/**
 * A pool checkout failed — the database is unavailable (503). The flat REST
 * reason of the JSON-RPC `service_unavailable` a `DbCheckoutError` maps to;
 * the Rust spine's `fuz_http::SERVICE_UNAVAILABLE_REASON`.
 */
export const ERROR_SERVICE_UNAVAILABLE = 'service_unavailable' as const;

/** Request `Content-Length` header is not a plain run of ASCII digits. */
export const ERROR_INVALID_CONTENT_LENGTH = 'invalid_content_length' as const;

// --- Origin & bearer token verification ---

/** Request origin not in allowlist. */
export const ERROR_FORBIDDEN_ORIGIN = 'forbidden_origin' as const;

/**
 * The request's `Host` names a host the server doesn't answer to — the Rust
 * spine's DNS-rebinding gate (`host_gate`), its `FORBIDDEN_HOST_REASON`. The
 * TS spine has no host gate; a surface describing a Rust server that mounts
 * one declares it.
 */
export const ERROR_FORBIDDEN_HOST = 'forbidden_host' as const;

/**
 * A `POST` whose `Content-Type` the route refuses: anything but
 * `application/json` on a JSON route, a CORS-safelisted type or none on a
 * `raw_body` one. See `http/simple_request.ts`.
 */
export const ERROR_UNSUPPORTED_CONTENT_TYPE = 'unsupported_content_type' as const;

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

// --- Declared input reasons (paged reads) ---
// each is a field's `invalid_reason` (`schema_meta.ts`): every refusal of the
// field carries it, whatever the fault — a wrong type or an unsafe integer
// included; each is named `<field>_invalid`

/** `limit` on a paged read refused — out of `[1, max]`, or not an integer. */
export const ERROR_LIMIT_INVALID = 'limit_invalid' as const;

/** `offset` on a paged read refused — negative, or not a safe integer. */
export const ERROR_OFFSET_INVALID = 'offset_invalid' as const;

/** `audit_log_list`'s `since_seq` cursor refused — negative, or not a safe integer. */
export const ERROR_SINCE_SEQ_INVALID = 'since_seq_invalid' as const;

/** `audit_log_list`'s `outcome` filter refused — not `'success'` or `'failure'`. */
export const ERROR_OUTCOME_INVALID = 'outcome_invalid' as const;

// --- DB table browser ---

/** DELETE blocked by a foreign key constraint. */
export const ERROR_FOREIGN_KEY_VIOLATION = 'foreign_key_violation' as const;

/** Table name not found in `information_schema`. */
export const ERROR_TABLE_NOT_FOUND = 'table_not_found' as const;

/**
 * Table has no single-column primary key, so there is no column the row-`DELETE`
 * can target: either no primary key at all, or a composite one (a single-column
 * `WHERE` on one member of a composite key over-matches).
 */
export const ERROR_TABLE_NO_PRIMARY_KEY = 'table_no_primary_key' as const;

/**
 * Table is excluded from row deletion by policy — the audit trail and the
 * framework's singleton bookkeeping rows (`bootstrap_lock`, `app_settings`,
 * `schema_version`), whose invariants live in the domain layer rather than in
 * a generic storage endpoint. See `http/db_routes.ts`'s `NON_DELETABLE_TABLES`.
 */
export const ERROR_TABLE_NOT_DELETABLE = 'table_not_deletable' as const;

/** Row with the given PK value not found. */
export const ERROR_ROW_NOT_FOUND = 'row_not_found' as const;

/** Database health-check query failed (connectivity or query error). */
export const ERROR_DATABASE_CONNECTION_FAILED = 'database_connection_failed' as const;

// --- Readiness (`GET /ready`) ---

/** The live database lacks a table or column the deploy expects (`db/schema_ready.ts`). */
export const ERROR_SCHEMA_DRIFT = 'schema_drift' as const;

/** The readiness check could not query the database. */
export const ERROR_DB_UNREACHABLE = 'db_unreachable' as const;

// --- Catch-all ---

/**
 * An unexpected failure — the catch layer's answer to an error no route
 * declares (`{error: 'internal_error', message?}`, the message DEV-only).
 */
export const ERROR_INTERNAL_ERROR = 'internal_error' as const;

// --- REST error definitions ---
// one per (status, code) a route or middleware answers; a body is a
// `loose_object` — error responses may carry extra context fields (`message`,
// a thrown error's flattened `data`), and a client reads them

/** The entries of a definition's body schema: `error`, its code, beside its fields. */
export type RestErrorEntries<TCode extends string, TFields extends SchemaEntries> = {
	error: Schema<TCode, TCode, 'literal', TCode>;
} & TFields;

/** The body schema of a definition, `loose_object({error: literal(code), ...fields})`. */
export type RestErrorSchema<TCode extends string, TFields extends SchemaEntries> = Schema<
	SchemaObjectOutput<RestErrorEntries<TCode, TFields>> & Record<string, unknown>,
	SchemaObjectInput<RestErrorEntries<TCode, TFields>> & Record<string, unknown>,
	'loose_object',
	RestErrorEntries<TCode, TFields>
>;

/** The body a definition puts on the wire. */
export type RestErrorBody<TCode extends string, TFields extends SchemaEntries> = Infer<
	RestErrorSchema<TCode, TFields>
>;

/**
 * A REST error definition: one code at one HTTP status, with the fields its
 * body carries beside `error`. The status lives here and not on the `ERROR_*`
 * constant, which is also a JSON-RPC `data.reason` with no fixed status.
 *
 * The same code may have more than one definition, each a shape of its own
 * (`REST_AUTHENTICATION_REQUIRED` and `REST_AUTHENTICATION_REQUIRED_BOOTSTRAP`).
 */
export interface RestErrorDef<
	TStatus extends number = number,
	TCode extends string = string,
	TFields extends SchemaEntries = SchemaEntries
> {
	readonly status: TStatus;
	readonly code: TCode;
	/** The body's entries beside `error`. */
	readonly fields: TFields;
	/** `loose_object({error: literal(code), ...fields})`, what the surface and the DEV check read. */
	readonly schema: RestErrorSchema<TCode, TFields>;
	/** Response headers a definition derives from its body (`Retry-After`). */
	headers?(body: RestErrorBody<TCode, TFields>): Record<string, string>;
}

/** Refuses a widened `number` or `string`, so a definition names one status and one code. */
type Exact<T, TWide> = TWide extends T ? never : T;

/**
 * The grammar of an `error` code: a lowercase ASCII letter, then lowercase
 * letters, digits, and `_` — a code, never prose. Prose goes in `message`.
 */
export const REST_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The characters a code can't start with, beside an uppercase letter. */
type CodeHeadRefused = '_' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** Characters prose has and a code doesn't, beside an uppercase letter. */
type CodeCharRefused = ' ' | '-' | '.' | ',' | ':' | '/' | "'" | '!' | '?';

/**
 * Refuses, at the type level, only the forms plainly off
 * `REST_ERROR_CODE_PATTERN`: empty, holding an uppercase letter, starting with
 * a digit or `_`, or holding a space or one of a few punctuation marks. Other
 * characters (`@`, `#`, `(`, non-ASCII), and a code typed as a union, pass
 * it. The runtime check in `rest_error` is the authority on the grammar.
 */
type RestErrorCode<T extends string> = T extends ''
	? never
	: T extends Lowercase<T>
		? T extends `${CodeHeadRefused}${string}`
			? never
			: T extends `${string}${CodeCharRefused}${string}`
				? never
				: T
		: never;

/**
 * Whether a value is an `error` code, by `REST_ERROR_CODE_PATTERN`.
 *
 * @param value - the value to test
 */
export const is_rest_error_code = (value: unknown): value is string =>
	typeof value === 'string' && REST_ERROR_CODE_PATTERN.test(value);

/**
 * Define a REST error: its status, its code, and the fields its body carries
 * beside `error`.
 *
 * @param status - the HTTP status it answers at, a literal
 * @param code - the `error` code, a literal matching `REST_ERROR_CODE_PATTERN`, usually an `ERROR_*` constant
 * @param fields - the body's other entries
 * @param headers - the response headers to derive from a body
 * @returns the definition, its body schema a `loose_object`
 * @throws Error when `code` is not an error code (`REST_ERROR_CODE_PATTERN`), or
 *   when `fields` has an own `error` entry, which would replace the code
 */
// @__NO_SIDE_EFFECTS__
export const rest_error = <
	const TStatus extends number,
	const TCode extends string,
	// a definition with no fields beside `error` has no entries
	// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type
	const TFields extends SchemaEntries = Record<never, never>
>(
	status: Exact<TStatus, number>,
	code: Exact<RestErrorCode<TCode>, string>,
	fields?: TFields,
	headers?: (body: RestErrorBody<TCode, TFields>) => Record<string, string>
): RestErrorDef<TStatus, TCode, TFields> => {
	if (fields && Object.hasOwn(fields, 'error')) {
		throw new Error(
			`rest_error: fields of ${JSON.stringify(code)} hold an \`error\` entry, which would replace its code`
		);
	}
	if (!is_rest_error_code(code)) {
		throw new Error(
			`rest_error: ${JSON.stringify(code)} is not an error code (${REST_ERROR_CODE_PATTERN.source}) — put prose in \`message\``
		);
	}
	const def_fields = (fields ?? {}) as TFields;
	const schema = loose_object({
		error: literal(code as TCode),
		...def_fields
	}) as unknown as RestErrorSchema<TCode, TFields>;
	return headers
		? { status, code, fields: def_fields, schema, headers }
		: { status, code, fields: def_fields, schema };
};

/**
 * Whether two definitions are the same: one object, or the same status, code,
 * and `headers`, with the same schema at every field.
 *
 * @param a - one definition
 * @param b - the other
 */
export const same_rest_error = (a: RestErrorDef, b: RestErrorDef): boolean => {
	if (a === b) return true;
	if (a.status !== b.status || a.code !== b.code || a.headers !== b.headers) return false;
	const a_keys = Object.keys(a.fields);
	const b_fields: Record<string, unknown> = b.fields;
	return (
		a_keys.length === Object.keys(b.fields).length &&
		a_keys.every((key) => Object.hasOwn(b_fields, key) && b_fields[key] === a.fields[key])
	);
};

/**
 * A list of definitions with each repeat after its first left out
 * (`same_rest_error`), in list order.
 *
 * @param defs - the definitions
 * @returns the distinct definitions
 */
export const dedupe_rest_errors = (defs: Iterable<RestErrorDef>): Array<RestErrorDef> => {
	const distinct: Array<RestErrorDef> = [];
	for (const def of defs) {
		if (!distinct.some((seen) => same_rest_error(seen, def))) distinct.push(def);
	}
	return distinct;
};

/**
 * Build an error-schema map from a list of definitions, grouped by status.
 * A status with one definition maps to its schema, and one with more to a
 * `union` of their schemas in list order — two shapes of one code included,
 * each a branch; a definition listed twice counts once (`dedupe_rest_errors`).
 *
 * @param defs - the definitions
 * @returns the error schemas, keyed by status
 */
export const to_error_schemas = (defs: Iterable<RestErrorDef>): ErrorSchemas => {
	const by_status: Map<number, Array<AnySchema>> = new Map();
	for (const { status, schema } of dedupe_rest_errors(defs)) {
		const schemas = by_status.get(status);
		if (schemas) schemas.push(schema);
		else by_status.set(status, [schema]);
	}
	const errors: ErrorSchemas = {};
	for (const [status, schemas] of by_status) {
		errors[status] = schemas.length === 1 ? schemas[0]! : union(schemas);
	}
	return errors;
};

/**
 * The validation issues a 400 input refusal carries, as `WireIssue`s,
 * whichever schema library refused: optional, since the framework emits them
 * only in development (`dev_only`), so error responses don't leak
 * input-schema structure to callers.
 */
const INPUT_ISSUES = optional(array(WireIssue));

// 400: input validation, the route's own middleware
export const REST_INVALID_REQUEST_BODY = rest_error(400, ERROR_INVALID_REQUEST_BODY, {
	issues: INPUT_ISSUES
});
export const REST_INVALID_JSON_BODY = rest_error(400, ERROR_INVALID_JSON_BODY);
export const REST_INVALID_ROUTE_PARAMS = rest_error(400, ERROR_INVALID_ROUTE_PARAMS, {
	issues: INPUT_ISSUES
});
export const REST_INVALID_QUERY_PARAMS = rest_error(400, ERROR_INVALID_QUERY_PARAMS, {
	issues: INPUT_ISSUES
});
// 400: the body limit
export const REST_INVALID_CONTENT_LENGTH = rest_error(400, ERROR_INVALID_CONTENT_LENGTH);
// 400 and 500: the authorization phase, which resolves the acting actor on a
// route whose `auth.actor` is not `'none'` (`derive_route_errors`)
/** No `acting` selector on a multi-actor account; `available` lists the account's actors. */
export const REST_ACTOR_REQUIRED = rest_error(400, ERROR_ACTOR_REQUIRED, {
	available: array(loose_object({ id: string, name: string }))
});
/** The `acting` selector names an actor that isn't the account's. */
export const REST_ACTOR_NOT_ON_ACCOUNT = rest_error(400, ERROR_ACTOR_NOT_ON_ACCOUNT);
// 400: the table browser's row `DELETE`
export const REST_TABLE_NOT_DELETABLE = rest_error(400, ERROR_TABLE_NOT_DELETABLE);
export const REST_TABLE_NO_PRIMARY_KEY = rest_error(400, ERROR_TABLE_NO_PRIMARY_KEY);

// 401
export const REST_AUTHENTICATION_REQUIRED = rest_error(401, ERROR_AUTHENTICATION_REQUIRED);
/** `GET /api/account/status`'s anonymous answer: the same code, with the bootstrap status. */
export const REST_AUTHENTICATION_REQUIRED_BOOTSTRAP = rest_error(
	401,
	ERROR_AUTHENTICATION_REQUIRED,
	{ bootstrap_available: optional(boolean) }
);
export const REST_INVALID_CREDENTIALS = rest_error(401, ERROR_INVALID_CREDENTIALS);
/** The bootstrap token didn't match. */
export const REST_INVALID_TOKEN = rest_error(401, ERROR_INVALID_TOKEN);

// 403: the auth gates; each names what the route demanded, not what the caller holds
/**
 * The role gate's refusal (`require_role`, and the dispatcher's): the actor
 * holds none of the route's `auth.roles`. `required_roles` is the whole
 * disjunction, so a client can say "requires admin or steward".
 */
export const REST_INSUFFICIENT_PERMISSIONS = rest_error(403, ERROR_INSUFFICIENT_PERMISSIONS, {
	required_roles: meta(array(string), { readOnly: true })
});
/**
 * The credential-type gate's refusal (`require_credential_types`, and the
 * dispatcher's): the request's credential type is not in the route's
 * `auth.credential_types`, which `required_credential_types` carries.
 */
export const REST_CREDENTIAL_TYPE_REQUIRED = rest_error(403, ERROR_CREDENTIAL_TYPE_REQUIRED, {
	required_credential_types: meta(array(string), { readOnly: true })
});
/**
 * The token-scope gate's refusal (`require_token_scope`, and
 * `token_scope_surface_denial`): a narrowed api token reaches a capability its
 * scope does not admit. `required_scope` is the route's `auth.required_scope`,
 * verbatim. See `docs/security.md` §Token scoping.
 */
export const REST_TOKEN_SCOPE_REQUIRED = rest_error(403, ERROR_TOKEN_SCOPE_REQUIRED, {
	required_scope: string
});
// 403: the origin check, bootstrap, signup
export const REST_FORBIDDEN_ORIGIN = rest_error(403, ERROR_FORBIDDEN_ORIGIN);
// 403: the Rust spine's host gate
export const REST_FORBIDDEN_HOST = rest_error(403, ERROR_FORBIDDEN_HOST);
export const REST_ALREADY_BOOTSTRAPPED = rest_error(403, ERROR_ALREADY_BOOTSTRAPPED);
export const REST_NO_MATCHING_INVITE = rest_error(403, ERROR_NO_MATCHING_INVITE);

// 404
export const REST_TOKEN_FILE_MISSING = rest_error(404, ERROR_TOKEN_FILE_MISSING);
export const REST_TABLE_NOT_FOUND = rest_error(404, ERROR_TABLE_NOT_FOUND);
export const REST_ROW_NOT_FOUND = rest_error(404, ERROR_ROW_NOT_FOUND);

// 409
/** A delete blocked by rows that reference the row. */
export const REST_FOREIGN_KEY_VIOLATION = rest_error(409, ERROR_FOREIGN_KEY_VIOLATION);
export const REST_SIGNUP_CONFLICT = rest_error(409, ERROR_SIGNUP_CONFLICT);

// 413, 415
/** The body limit's refusal: the request body exceeds the size limit. */
export const REST_PAYLOAD_TOO_LARGE = rest_error(413, ERROR_PAYLOAD_TOO_LARGE);
/** A `POST` route refuses the request's `Content-Type`. */
export const REST_UNSUPPORTED_CONTENT_TYPE = rest_error(415, ERROR_UNSUPPORTED_CONTENT_TYPE);

/** The rate limiter's refusal; `retry_after` is in seconds, `Retry-After` its ceiling. */
export const REST_RATE_LIMIT_EXCEEDED = rest_error(
	429,
	ERROR_RATE_LIMIT_EXCEEDED,
	{ retry_after: pipe(number, integer, min_value(0)) },
	(body) => ({ 'Retry-After': String(Math.ceil(body.retry_after)) })
);

// 500: the authorization phase, and the catch layer any route can answer with
/** The account's actors enumerated empty, a signup invariant broken. */
export const REST_NO_ACTORS_ON_ACCOUNT = rest_error(500, ERROR_NO_ACTORS_ON_ACCOUNT);
/** The account or actor row was deleted between credential validation and the actor read. */
export const REST_ACCOUNT_VANISHED = rest_error(500, ERROR_ACCOUNT_VANISHED);
export const REST_INTERNAL_ERROR = rest_error(500, ERROR_INTERNAL_ERROR);

// 503: a failed pool checkout any route can answer with, and the health and readiness checks
export const REST_SERVICE_UNAVAILABLE = rest_error(503, ERROR_SERVICE_UNAVAILABLE);
export const REST_DATABASE_CONNECTION_FAILED = rest_error(503, ERROR_DATABASE_CONNECTION_FAILED);
export const REST_SCHEMA_DRIFT = rest_error(503, ERROR_SCHEMA_DRIFT);
export const REST_DB_UNREACHABLE = rest_error(503, ERROR_DB_UNREACHABLE);

/**
 * Error schema map — an HTTP status to the schema of every body a route
 * answers at it, built from definitions by `to_error_schemas`.
 */
export type ErrorSchemas = Record<number, AnySchema>;

/**
 * What `derive_route_errors` reads of a route: its method, auth requirement,
 * which input slots it has, and its rate limit key.
 */
export interface DeriveRouteErrorsOptions {
	method: RouteMethod;
	auth: RouteAuth;
	/** Whether the route has a body schema, an `input` other than `null`. */
	has_input?: boolean;
	has_params?: boolean;
	has_query?: boolean;
	rate_limit?: RateLimitKey;
}

/**
 * Derive the error definitions the framework answers a route with, from its
 * method, auth requirement, input slots, and rate limit — each narrowed to
 * what the route's own middleware can emit.
 *
 * Route handlers declare additional definitions via `RouteSpec.errors`; the
 * route's error map (`resolve_route_error_map`) is the union of these, the
 * applying middleware's, and the route's own.
 *
 * Derivation rules:
 * - **A body**, an `input` other than `null` on a method other than `GET`:
 *   400 `invalid_request_body` and `invalid_json_body`. A `GET` reads no body.
 * - **`params`**: 400 `invalid_route_params`. **`query`**: 400
 *   `invalid_query_params`.
 * - **`auth.account === 'required'`** or **`auth.actor === 'required'`**: 401
 *   `authentication_required` — the pre-authorization gate's refusal when the
 *   credential isn't there. `'optional'` does not derive 401.
 * - **`auth.required_scope`**: 403 `token_scope_required` (carrying
 *   `required_scope`). **`auth.credential_types?.length`**: 403
 *   `credential_type_required` (carrying `required_credential_types`).
 *   **`auth.roles?.length`**: 403 `insufficient_permissions` (carrying
 *   `required_roles`). In the order the gates fire; a route with more than
 *   one has each.
 * - **`auth.actor !== 'none'`**: 400 `actor_required` and
 *   `actor_not_on_account`, and 500 `no_actors_on_account` and
 *   `account_vanished` — what the dispatcher's authorization phase emits
 *   when it resolves an actor.
 * - **`rate_limit`**: 429 `rate_limit_exceeded` (with `retry_after`).
 * - **`POST`**: 415 `unsupported_content_type` (see
 *   `is_post_content_type_refused` in `http/simple_request.ts`).
 *
 * @param options - what the derivation reads of the route
 * @returns the definitions, in the order above
 */
export const derive_route_errors = ({
	method,
	auth,
	has_input = false,
	has_params = false,
	has_query = false,
	rate_limit
}: DeriveRouteErrorsOptions): Array<RestErrorDef> => {
	const defs: Array<RestErrorDef> = [];

	// the input middleware runs on a body only off `GET` (`create_input_validation`)
	if (has_input && method !== 'GET') {
		defs.push(REST_INVALID_REQUEST_BODY, REST_INVALID_JSON_BODY);
	}
	if (has_params) defs.push(REST_INVALID_ROUTE_PARAMS);
	if (has_query) defs.push(REST_INVALID_QUERY_PARAMS);
	if (needs_actor(auth)) {
		defs.push(
			REST_ACTOR_REQUIRED,
			REST_ACTOR_NOT_ON_ACCOUNT,
			REST_NO_ACTORS_ON_ACCOUNT,
			REST_ACCOUNT_VANISHED
		);
	}

	// 401 fires when the dispatcher's pre-authorization gate rejects an
	// unauthenticated caller — `account === 'required'` (no credential) or
	// `actor === 'required'` (no credential to resolve an actor against,
	// per registry-time invariant 3 forbidding accountless actors in v1).
	if (auth.account === 'required' || auth.actor === 'required') {
		defs.push(REST_AUTHENTICATION_REQUIRED);
	}

	// 403 fires from any of three gates: the token-scope refusal
	// (`auth.required_scope`, pre-authorization), the credential-type gate, and
	// the role gate (both post-authorization), in the order they fire
	if (auth.required_scope !== undefined) defs.push(REST_TOKEN_SCOPE_REQUIRED);
	if (auth.credential_types?.length) defs.push(REST_CREDENTIAL_TYPE_REQUIRED);
	if (auth.roles?.length) defs.push(REST_INSUFFICIENT_PERMISSIONS);

	if (rate_limit) defs.push(REST_RATE_LIMIT_EXCEEDED);

	if (method === 'POST') defs.push(REST_UNSUPPORTED_CONTENT_TYPE);

	return defs;
};
