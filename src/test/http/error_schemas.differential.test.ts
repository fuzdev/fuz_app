/**
 * The REST error schemas — the standard shapes, every `REST_*` definition's
 * body, the route entries built from definitions, and the action manifest —
 * `@fuzdev/fuz_schema` schemas, held to the Zod schemas they replaced, rebuilt
 * here. Over each schema's valid bodies and every variant of them one edit
 * away (a node replaced by a value of the pool, a key dropped, a key added),
 * the verdict and the output are Zod's, and the surface writes the same JSON
 * Schema, as a value: `to_json_schema` writes a `readOnly` annotation after
 * the node's keywords, where Zod wrote it first. One declared difference: the
 * rate limit's `retry_after` is a non-negative integer, where Zod took any
 * number — both spines send whole seconds. An input holding a `Date`, which a
 * loose object keeps where Zod copies it into a plain object, is held to Zod's
 * verdict alone: no JSON body holds one.
 *
 * What `derive_route_errors` derives is no port of the Zod derivation — it
 * narrows to the slots a route has — and `error_schemas.test.ts` holds it.
 *
 * Every definition's status and code are pinned here, and the table is the
 * module's whole set: a definition added or dropped fails it.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is, string as string_schema, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import * as error_schemas from '#lib/http/error_schemas.ts';
import {
	AccountVanishedError,
	ActorNotOnAccountError,
	ActorRequiredError,
	ApiError,
	CredentialTypeRequiredError,
	ERROR_ACCOUNT_VANISHED,
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_ACTOR_REQUIRED,
	ERROR_CREDENTIAL_TYPE_REQUIRED,
	ERROR_FOREIGN_KEY_VIOLATION,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_NO_ACTORS_ON_ACCOUNT,
	ERROR_PAYLOAD_TOO_LARGE,
	ERROR_RATE_LIMIT_EXCEEDED,
	ERROR_TOKEN_SCOPE_REQUIRED,
	ERROR_UNSUPPORTED_CONTENT_TYPE,
	ForeignKeyError,
	InvalidInputError,
	NoActorsOnAccountError,
	PayloadTooLargeError,
	PermissionError,
	RateLimitError,
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP,
	REST_RATE_LIMIT_EXCEEDED,
	dedupe_rest_errors,
	rest_error,
	same_rest_error,
	to_error_schemas,
	TokenScopeRequiredError,
	UnsupportedContentTypeError,
	type RestErrorDef
} from '#lib/http/error_schemas.ts';
import { parse_any, type ValidationSchema } from '#lib/schema_issues.ts';
import { resolve_route_errors, schema_to_surface } from '#lib/http/schema_helpers.ts';
import { AuthAxisState } from '#lib/http/auth_shape.ts';
import { RateLimitKey } from '#lib/rate_limiter.ts';
import { ActionManifest, ActionManifestEntry } from '#lib/testing/cross_backend/action_manifest.ts';
import {
	AccountStatusUnauthenticatedError,
	create_account_route_shapes
} from '#lib/auth/account_route_schema.ts';
import { create_signup_route_shape } from '#lib/auth/signup_route_schema.ts';
import { bootstrap_route_shape } from '#lib/auth/bootstrap_route_schema.ts';
import { create_serve_fact_route_spec } from '#lib/server/serve_fact_route.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

// --- the Zod copies, as the library wrote them ---

const ZodWireIssue = z.looseObject({
	kind: z.string(),
	path: z.array(z.union([z.string(), z.number()])),
	expected: z.string(),
	received: z.string(),
	message: z.string()
});
const ZodApiError = z.looseObject({ error: z.string() });
const ZodValidationError = z.looseObject({
	error: z.enum([
		ERROR_INVALID_REQUEST_BODY,
		ERROR_INVALID_JSON_BODY,
		ERROR_INVALID_ROUTE_PARAMS,
		ERROR_INVALID_QUERY_PARAMS
	]),
	issues: z.array(ZodWireIssue).optional()
});
const ZodPermissionError = z.looseObject({
	error: z.literal(ERROR_INSUFFICIENT_PERMISSIONS),
	required_roles: z.array(z.string()).readonly()
});
const ZodCredentialTypeRequiredError = z.looseObject({
	error: z.literal(ERROR_CREDENTIAL_TYPE_REQUIRED),
	required_credential_types: z.array(z.string()).readonly()
});
const ZodTokenScopeRequiredError = z.looseObject({
	error: z.literal(ERROR_TOKEN_SCOPE_REQUIRED),
	required_scope: z.string()
});
const ZodRateLimitError = z.looseObject({
	error: z.literal(ERROR_RATE_LIMIT_EXCEEDED),
	retry_after: z.number()
});
const ZodPayloadTooLargeError = z.looseObject({ error: z.literal(ERROR_PAYLOAD_TOO_LARGE) });
const ZodUnsupportedContentTypeError = z.looseObject({
	error: z.literal(ERROR_UNSUPPORTED_CONTENT_TYPE)
});
const ZodForeignKeyError = z.looseObject({ error: z.literal(ERROR_FOREIGN_KEY_VIOLATION) });
const ZodActorRequiredError = z.looseObject({
	error: z.literal(ERROR_ACTOR_REQUIRED),
	available: z.array(z.looseObject({ id: z.string(), name: z.string() }))
});
const ZodActorNotOnAccountError = z.looseObject({ error: z.literal(ERROR_ACTOR_NOT_ON_ACCOUNT) });
const ZodNoActorsOnAccountError = z.looseObject({ error: z.literal(ERROR_NO_ACTORS_ON_ACCOUNT) });
const ZodAccountVanishedError = z.looseObject({ error: z.literal(ERROR_ACCOUNT_VANISHED) });
/** A route's single-code error entry, as the routes wrote it. */
const zod_error = (code: string) => z.looseObject({ error: z.literal(code) });

const ZodAuthAxisState = z.enum(['none', 'optional', 'required']);
const ZodRateLimitKey = z.enum(['ip', 'account', 'both']);
const ZodActionManifestEntry = z.strictObject({
	method: z.string(),
	input: z.enum(['void', 'object']),
	side_effects: z.boolean(),
	account: ZodAuthAxisState,
	actor: ZodAuthAxisState,
	roles: z.array(z.string()),
	credential_types: z.array(z.string()),
	rate_limit: ZodRateLimitKey.nullable()
});
const ZodActionManifest = z.strictObject({ methods: z.array(ZodActionManifestEntry) });

// --- the inputs ---

const BASE_POOL: ReadonlyArray<unknown> = [
	undefined,
	null,
	true,
	false,
	0,
	-0,
	1,
	-1,
	1.5,
	NaN,
	Infinity,
	'',
	'a',
	'admin',
	[],
	['a'],
	[1],
	[{}],
	{},
	{ a: 1 },
	() => 0,
	1n,
	new Date(0)
];

const clone = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(clone)
		: value !== null && typeof value === 'object' && !(value instanceof Date)
			? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
			: value;

/**
 * Every variant of `sample` one edit away: each node replaced by each value of
 * `pool`, each key of an object dropped, a key added to each object, and an
 * element added to each array.
 */
const variants_of = (sample: unknown, pool: ReadonlyArray<unknown>): Array<unknown> => {
	const out: Array<unknown> = [...pool];
	const container = sample !== null && typeof sample === 'object';
	if (!container) return out;
	if (Array.isArray(sample)) {
		for (const v of pool) out.push([...sample.map(clone), clone(v)]);
		sample.forEach((child, i) => {
			for (const v of variants_of(child, pool)) {
				const next = sample.map(clone);
				next[i] = v;
				out.push(next);
			}
		});
		return out;
	}
	const entries = Object.entries(sample);
	out.push({ ...(clone(sample) as object), extra: 1 });
	for (const [key, child] of entries) {
		const { [key]: _, ...dropped } = clone(sample) as Record<string, unknown>;
		out.push(dropped);
		for (const v of variants_of(child, pool)) {
			out.push({ ...(clone(sample) as object), [key]: v });
		}
	}
	return out;
};

// `JSON.stringify` gives `undefined` for `undefined` and a function, whatever its type says
const show = (value: unknown): string => {
	const text: string | undefined = JSON.stringify(value, (_, v) =>
		typeof v === 'bigint' || typeof v === 'function' || typeof v === 'number' ? String(v) : v
	);
	return text ?? String(value);
};

const holds_date = (value: unknown): boolean =>
	value instanceof Date ||
	(value !== null && typeof value === 'object' && Object.values(value).some(holds_date));

/**
 * Asserts `fuz` gives Zod's verdict and output on `input`, or the verdict
 * `declared` gives where a difference is declared; returns the verdict.
 */
const assert_same = (
	label: string,
	fuz: ValidationSchema,
	zod: z.ZodType,
	input: unknown,
	declared?: Declared
): boolean => {
	const zod_result = zod.safeParse(input);
	const fuz_result = parse_any(fuz, input);
	const expected = declared ? declared(input, zod_result.success) : zod_result.success;
	assert.strictEqual(fuz_result.ok, expected, label);
	if (fuz_result.ok && !holds_date(input)) {
		assert.deepStrictEqual(fuz_result.value, zod_result.data, label);
	}
	return fuz_result.ok;
};

/** A declared difference: the verdict the fuz_schema form gives where Zod's is `zod_ok`. */
type Declared = (input: unknown, zod_ok: boolean) => boolean;

/** The rate limit's `retry_after` is a non-negative integer, where Zod took any number. */
const RETRY_AFTER_INTEGER: Declared = (input, zod_ok) => {
	const retry_after = (input as { retry_after?: unknown } | null)?.retry_after;
	return zod_ok && Number.isInteger(retry_after) && (retry_after as number) >= 0;
};

/** The Zod surface of a rate limit body with `retry_after` moved to what the definition writes. */
const move_retry_after = (json: unknown): unknown => {
	const node = json as { properties: Record<string, unknown> };
	assert.deepStrictEqual(node.properties.retry_after, { type: 'number' });
	return {
		...node,
		properties: { ...node.properties, retry_after: { type: 'integer', minimum: 0 } }
	};
};

// a JSON Schema node with its keys sorted, so the comparison is of values
const sort_keys = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(sort_keys)
		: value !== null && typeof value === 'object'
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((k) => [k, sort_keys((value as Record<string, unknown>)[k])])
				)
			: value;

const WIRE_ISSUE = {
	kind: 'string',
	path: ['a', 0],
	expected: 'string',
	received: 'number',
	message: 'a.0: expected string'
};
const ACTOR = { id: '0d6f7c1e-5a3b-4c2d-8e9f-0123456789ab', name: 'alice' };

interface Row {
	name: string;
	fuz: AnySchema;
	zod: z.ZodType;
	samples: ReadonlyArray<unknown>;
	pool?: ReadonlyArray<unknown>;
	declared?: Declared;
	/** The declared move of the Zod surface, to what the fuz_schema form writes. */
	move?: (json: unknown) => unknown;
}

const CODE_POOL: ReadonlyArray<unknown> = [
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_ACTOR_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	'invalid_request_body ',
	'INVALID_JSON_BODY'
];

const STANDARD_ROWS: Array<Row> = [
	{ name: 'ApiError', fuz: ApiError, zod: ZodApiError, samples: [{ error: 'x' }] },
	{
		name: 'InvalidInputError',
		fuz: InvalidInputError,
		zod: ZodValidationError,
		samples: [
			{ error: ERROR_INVALID_REQUEST_BODY, issues: [WIRE_ISSUE] },
			{ error: ERROR_INVALID_JSON_BODY },
			{ error: ERROR_INVALID_ROUTE_PARAMS, issues: [] },
			{ error: ERROR_INVALID_QUERY_PARAMS, issues: [WIRE_ISSUE, { ...WIRE_ISSUE, path: [] }] }
		],
		pool: CODE_POOL
	},
	{
		name: 'PermissionError',
		fuz: PermissionError,
		zod: ZodPermissionError,
		samples: [{ error: ERROR_INSUFFICIENT_PERMISSIONS, required_roles: ['admin', 'keeper'] }],
		pool: CODE_POOL
	},
	{
		name: 'CredentialTypeRequiredError',
		fuz: CredentialTypeRequiredError,
		zod: ZodCredentialTypeRequiredError,
		samples: [{ error: ERROR_CREDENTIAL_TYPE_REQUIRED, required_credential_types: ['session'] }]
	},
	{
		name: 'TokenScopeRequiredError',
		fuz: TokenScopeRequiredError,
		zod: ZodTokenScopeRequiredError,
		samples: [{ error: ERROR_TOKEN_SCOPE_REQUIRED, required_scope: 'surface:audit_stream' }]
	},
	{
		name: 'RateLimitError',
		fuz: RateLimitError,
		zod: ZodRateLimitError,
		samples: [
			{ error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 60 },
			{ error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 0 }
		],
		pool: [0.5, -1, 2 ** 53],
		declared: RETRY_AFTER_INTEGER,
		move: move_retry_after
	},
	{
		name: 'PayloadTooLargeError',
		fuz: PayloadTooLargeError,
		zod: ZodPayloadTooLargeError,
		samples: [{ error: ERROR_PAYLOAD_TOO_LARGE }]
	},
	{
		name: 'UnsupportedContentTypeError',
		fuz: UnsupportedContentTypeError,
		zod: ZodUnsupportedContentTypeError,
		samples: [{ error: ERROR_UNSUPPORTED_CONTENT_TYPE }]
	},
	{
		name: 'ForeignKeyError',
		fuz: ForeignKeyError,
		zod: ZodForeignKeyError,
		samples: [{ error: ERROR_FOREIGN_KEY_VIOLATION }]
	},
	{
		name: 'ActorRequiredError',
		fuz: ActorRequiredError,
		zod: ZodActorRequiredError,
		samples: [
			{ error: ERROR_ACTOR_REQUIRED, available: [ACTOR] },
			{ error: ERROR_ACTOR_REQUIRED, available: [] }
		]
	},
	{
		name: 'ActorNotOnAccountError',
		fuz: ActorNotOnAccountError,
		zod: ZodActorNotOnAccountError,
		samples: [{ error: ERROR_ACTOR_NOT_ON_ACCOUNT }]
	},
	{
		name: 'NoActorsOnAccountError',
		fuz: NoActorsOnAccountError,
		zod: ZodNoActorsOnAccountError,
		samples: [{ error: ERROR_NO_ACTORS_ON_ACCOUNT }]
	},
	{
		name: 'AccountVanishedError',
		fuz: AccountVanishedError,
		zod: ZodAccountVanishedError,
		samples: [{ error: ERROR_ACCOUNT_VANISHED }]
	},
	{
		name: 'AccountStatusUnauthenticatedError',
		fuz: AccountStatusUnauthenticatedError,
		zod: z.looseObject({
			error: z.literal('authentication_required'),
			bootstrap_available: z.boolean().optional()
		}),
		samples: [
			{ error: 'authentication_required' },
			{ error: 'authentication_required', bootstrap_available: true }
		]
	},
	{ name: 'AuthAxisState', fuz: AuthAxisState, zod: ZodAuthAxisState, samples: ['none'] },
	{
		name: 'RateLimitKey',
		fuz: RateLimitKey,
		zod: ZodRateLimitKey,
		samples: ['ip', 'account', 'both'],
		pool: ['IP', 'ip ', 'none']
	}
];

const MANIFEST_ENTRY = {
	method: 'account_verify',
	input: 'void',
	side_effects: false,
	account: 'required',
	actor: 'none',
	roles: ['admin'],
	credential_types: [],
	rate_limit: null
};
const MANIFEST_ROWS: Array<Row> = [
	{
		name: 'ActionManifestEntry',
		fuz: ActionManifestEntry,
		zod: ZodActionManifestEntry,
		samples: [MANIFEST_ENTRY, { ...MANIFEST_ENTRY, input: 'object', rate_limit: 'both' }],
		pool: ['ip', 'object', 'optional', 'Required']
	},
	{
		name: 'ActionManifest',
		fuz: ActionManifest,
		zod: ZodActionManifest,
		samples: [{ methods: [MANIFEST_ENTRY] }, { methods: [] }]
	}
];

/** Each definition: its status, its code, and the zod copy of its body, by its export name. */
const DEFINITIONS: Record<
	string,
	{ status: number; code: string; zod: z.ZodType; sample: object }
> = {
	REST_INVALID_REQUEST_BODY: {
		status: 400,
		code: 'invalid_request_body',
		zod: z.looseObject({
			error: z.literal('invalid_request_body'),
			issues: z.array(ZodWireIssue).optional()
		}),
		sample: { error: 'invalid_request_body', issues: [WIRE_ISSUE] }
	},
	REST_INVALID_JSON_BODY: {
		status: 400,
		code: 'invalid_json_body',
		zod: zod_error('invalid_json_body'),
		sample: { error: 'invalid_json_body' }
	},
	REST_INVALID_ROUTE_PARAMS: {
		status: 400,
		code: 'invalid_route_params',
		zod: z.looseObject({
			error: z.literal('invalid_route_params'),
			issues: z.array(ZodWireIssue).optional()
		}),
		sample: { error: 'invalid_route_params', issues: [WIRE_ISSUE] }
	},
	REST_INVALID_QUERY_PARAMS: {
		status: 400,
		code: 'invalid_query_params',
		zod: z.looseObject({
			error: z.literal('invalid_query_params'),
			issues: z.array(ZodWireIssue).optional()
		}),
		sample: { error: 'invalid_query_params', issues: [] }
	},
	REST_INVALID_CONTENT_LENGTH: {
		status: 400,
		code: 'invalid_content_length',
		zod: zod_error('invalid_content_length'),
		sample: { error: 'invalid_content_length' }
	},
	REST_ACTOR_REQUIRED: {
		status: 400,
		code: 'actor_required',
		zod: ZodActorRequiredError,
		sample: { error: 'actor_required', available: [ACTOR] }
	},
	REST_ACTOR_NOT_ON_ACCOUNT: {
		status: 400,
		code: 'actor_not_on_account',
		zod: ZodActorNotOnAccountError,
		sample: { error: 'actor_not_on_account' }
	},
	REST_TABLE_NOT_DELETABLE: {
		status: 400,
		code: 'table_not_deletable',
		zod: zod_error('table_not_deletable'),
		sample: { error: 'table_not_deletable' }
	},
	REST_TABLE_NO_PRIMARY_KEY: {
		status: 400,
		code: 'table_no_primary_key',
		zod: zod_error('table_no_primary_key'),
		sample: { error: 'table_no_primary_key' }
	},
	REST_AUTHENTICATION_REQUIRED: {
		status: 401,
		code: 'authentication_required',
		zod: zod_error('authentication_required'),
		sample: { error: 'authentication_required' }
	},
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP: {
		status: 401,
		code: 'authentication_required',
		zod: z.looseObject({
			error: z.literal('authentication_required'),
			bootstrap_available: z.boolean().optional()
		}),
		sample: { error: 'authentication_required', bootstrap_available: false }
	},
	REST_INVALID_CREDENTIALS: {
		status: 401,
		code: 'invalid_credentials',
		zod: zod_error('invalid_credentials'),
		sample: { error: 'invalid_credentials' }
	},
	REST_INVALID_TOKEN: {
		status: 401,
		code: 'invalid_token',
		zod: zod_error('invalid_token'),
		sample: { error: 'invalid_token' }
	},
	REST_INSUFFICIENT_PERMISSIONS: {
		status: 403,
		code: 'insufficient_permissions',
		zod: ZodPermissionError,
		sample: { error: 'insufficient_permissions', required_roles: ['admin'] }
	},
	REST_CREDENTIAL_TYPE_REQUIRED: {
		status: 403,
		code: 'credential_type_required',
		zod: ZodCredentialTypeRequiredError,
		sample: { error: 'credential_type_required', required_credential_types: ['daemon_token'] }
	},
	REST_TOKEN_SCOPE_REQUIRED: {
		status: 403,
		code: 'token_scope_required',
		zod: ZodTokenScopeRequiredError,
		sample: { error: 'token_scope_required', required_scope: 'surface:fact_bare' }
	},
	REST_FORBIDDEN_ORIGIN: {
		status: 403,
		code: 'forbidden_origin',
		zod: zod_error('forbidden_origin'),
		sample: { error: 'forbidden_origin' }
	},
	REST_ALREADY_BOOTSTRAPPED: {
		status: 403,
		code: 'already_bootstrapped',
		zod: zod_error('already_bootstrapped'),
		sample: { error: 'already_bootstrapped' }
	},
	REST_NO_MATCHING_INVITE: {
		status: 403,
		code: 'no_matching_invite',
		zod: zod_error('no_matching_invite'),
		sample: { error: 'no_matching_invite' }
	},
	REST_TOKEN_FILE_MISSING: {
		status: 404,
		code: 'token_file_missing',
		zod: zod_error('token_file_missing'),
		sample: { error: 'token_file_missing' }
	},
	REST_TABLE_NOT_FOUND: {
		status: 404,
		code: 'table_not_found',
		zod: zod_error('table_not_found'),
		sample: { error: 'table_not_found' }
	},
	REST_ROW_NOT_FOUND: {
		status: 404,
		code: 'row_not_found',
		zod: zod_error('row_not_found'),
		sample: { error: 'row_not_found' }
	},
	REST_FOREIGN_KEY_VIOLATION: {
		status: 409,
		code: 'foreign_key_violation',
		zod: ZodForeignKeyError,
		sample: { error: 'foreign_key_violation' }
	},
	REST_SIGNUP_CONFLICT: {
		status: 409,
		code: 'signup_conflict',
		zod: zod_error('signup_conflict'),
		sample: { error: 'signup_conflict' }
	},
	REST_PAYLOAD_TOO_LARGE: {
		status: 413,
		code: 'payload_too_large',
		zod: ZodPayloadTooLargeError,
		sample: { error: 'payload_too_large' }
	},
	REST_UNSUPPORTED_CONTENT_TYPE: {
		status: 415,
		code: 'unsupported_content_type',
		zod: ZodUnsupportedContentTypeError,
		sample: { error: 'unsupported_content_type' }
	},
	REST_RATE_LIMIT_EXCEEDED: {
		status: 429,
		code: 'rate_limit_exceeded',
		zod: ZodRateLimitError,
		sample: { error: 'rate_limit_exceeded', retry_after: 30 }
	},
	REST_NO_ACTORS_ON_ACCOUNT: {
		status: 500,
		code: 'no_actors_on_account',
		zod: ZodNoActorsOnAccountError,
		sample: { error: 'no_actors_on_account' }
	},
	REST_ACCOUNT_VANISHED: {
		status: 500,
		code: 'account_vanished',
		zod: ZodAccountVanishedError,
		sample: { error: 'account_vanished' }
	},
	REST_INTERNAL_ERROR: {
		status: 500,
		code: 'internal_error',
		zod: zod_error('internal_error'),
		sample: { error: 'internal_error', message: 'boom' }
	},
	REST_SERVICE_UNAVAILABLE: {
		status: 503,
		code: 'service_unavailable',
		zod: zod_error('service_unavailable'),
		sample: { error: 'service_unavailable' }
	},
	REST_DATABASE_CONNECTION_FAILED: {
		status: 503,
		code: 'database_connection_failed',
		zod: zod_error('database_connection_failed'),
		sample: { error: 'database_connection_failed', connected: false, type: 'pglet' }
	},
	REST_SCHEMA_DRIFT: {
		status: 503,
		code: 'schema_drift',
		zod: zod_error('schema_drift'),
		sample: { error: 'schema_drift' }
	},
	REST_DB_UNREACHABLE: {
		status: 503,
		code: 'db_unreachable',
		zod: zod_error('db_unreachable'),
		sample: { error: 'db_unreachable' }
	}
};

const is_rest_error_def = (value: unknown): value is RestErrorDef =>
	value !== null &&
	typeof value === 'object' &&
	'status' in value &&
	'code' in value &&
	'schema' in value;

const exported_defs = (): Array<[string, RestErrorDef]> =>
	(Object.entries(error_schemas) as Array<[string, unknown]>).filter(
		(e): e is [string, RestErrorDef] => is_rest_error_def(e[1])
	);

const DEFINITION_ROWS: Array<Row> = exported_defs().map(([name, def]) => ({
	name,
	fuz: def.schema,
	zod: DEFINITIONS[name]?.zod ?? z.never(),
	samples: [DEFINITIONS[name]?.sample ?? {}],
	pool: name === 'REST_RATE_LIMIT_EXCEEDED' ? [...CODE_POOL, 0.5, -1] : CODE_POOL,
	...(name === 'REST_RATE_LIMIT_EXCEEDED' && {
		declared: RETRY_AFTER_INTEGER,
		move: move_retry_after
	})
}));

const log = new Logger('test', { level: 'off' });
const login_shape = create_account_route_shapes({ login_account_rate_limited: true }).find(
	(shape) => shape.path === '/login'
);
const signup_shape = create_signup_route_shape({ signup_account_rate_limited: true });
const fact_spec = create_serve_fact_route_spec({ facts_dir: '/facts', log });

/** A route shape's own errors at a status, the schema its definitions there group into. */
const own_errors_at = (
	shape: { readonly errors?: ReadonlyArray<RestErrorDef> } | undefined,
	status: number
): AnySchema | undefined => to_error_schemas(shape?.errors ?? [])[status];

/** The route entries built from definitions, against the Zod-era literals they were. */
const ROUTE_ENTRY_ROWS: Array<[name: string, schema: ValidationSchema | undefined, code: string]> =
	[
		['POST /login 401', own_errors_at(login_shape, 401), 'invalid_credentials'],
		['POST /signup 403', own_errors_at(signup_shape, 403), 'no_matching_invite'],
		['POST /signup 409', own_errors_at(signup_shape, 409), 'signup_conflict'],
		['POST /bootstrap 401', own_errors_at(bootstrap_route_shape, 401), 'invalid_token'],
		['POST /bootstrap 403', own_errors_at(bootstrap_route_shape, 403), 'already_bootstrapped'],
		['POST /bootstrap 404', own_errors_at(bootstrap_route_shape, 404), 'token_file_missing']
	];

const run_rows = (rows: ReadonlyArray<Row>): void => {
	for (const row of rows) {
		test(`${row.name}: every variant gets Zod's verdict and output`, () => {
			const pool = [...BASE_POOL, ...(row.pool ?? [])];
			const inputs = [...row.samples, ...row.samples.flatMap((s) => variants_of(s, pool))];
			let accepted = 0;
			let refused = 0;
			for (const input of inputs) {
				const ok = assert_same(`${row.name} ${show(input)}`, row.fuz, row.zod, input, row.declared);
				if (ok) accepted++;
				else refused++;
				assert.strictEqual(is(row.fuz, input), ok, `${row.name} ${show(input)} (is)`);
			}
			// both verdicts reached, so a variant set that collapses to one fails
			assert.ok(accepted >= row.samples.length, `${row.name}: accepted ${accepted}`);
			assert.ok(refused > 0, `${row.name}: refused none`);
		});
	}
};

const surface_of = (schema: ValidationSchema): unknown =>
	sort_keys(schema_to_surface(schema, { io: 'output' }));

const zod_surface_of = (row: Row): unknown =>
	row.move
		? sort_keys(row.move(schema_to_surface(row.zod, { io: 'output' })))
		: surface_of(row.zod);

describe('the standard error shapes against their Zod copies', () => {
	run_rows(STANDARD_ROWS);

	test('each writes the Zod JSON Schema, as a value, but for a declared move', () => {
		for (const row of STANDARD_ROWS) {
			assert.deepStrictEqual(surface_of(row.fuz), zod_surface_of(row), row.name);
		}
	});
});

describe('the action manifest against its Zod copy', () => {
	run_rows(MANIFEST_ROWS);
});

describe('the REST error definitions', () => {
	test('the table is every definition the module exports, and only those', () => {
		assert.deepStrictEqual(
			exported_defs()
				.map(([name]) => name)
				.sort(),
			Object.keys(DEFINITIONS).sort()
		);
	});

	test('each has its pinned status and code, and its body requires them', () => {
		for (const [name, def] of exported_defs()) {
			const pinned = DEFINITIONS[name]!;
			assert.strictEqual(def.status, pinned.status, `${name} status`);
			assert.strictEqual(def.code, pinned.code, `${name} code`);
			assert.ok(is(def.schema, pinned.sample), `${name} admits its sample`);
			assert.ok(!is(def.schema, { ...pinned.sample, error: `${def.code}_` }), `${name} code`);
		}
	});

	test('each code is its ERROR_* constant', () => {
		const constants: Set<unknown> = new Set(
			(Object.entries(error_schemas) as Array<[string, unknown]>)
				.filter(([k, v]) => k.startsWith('ERROR_') && typeof v === 'string')
				.map(([, v]) => v)
		);
		for (const [name, def] of exported_defs()) assert.ok(constants.has(def.code), name);
	});

	run_rows(DEFINITION_ROWS);

	test('each writes the Zod JSON Schema, as a value, but for a declared move', () => {
		for (const row of DEFINITION_ROWS) {
			assert.deepStrictEqual(surface_of(row.fuz), zod_surface_of(row), row.name);
		}
	});

	test("the rate limit's headers are its Retry-After, rounded up", () => {
		const headers = (retry_after: number) =>
			REST_RATE_LIMIT_EXCEEDED.headers!({ error: 'rate_limit_exceeded', retry_after });
		assert.deepStrictEqual(headers(30), { 'Retry-After': '30' });
		assert.deepStrictEqual(headers(0.2), { 'Retry-After': '1' });
		assert.deepStrictEqual(headers(0), { 'Retry-After': '0' });
	});

	test('only the rate limit derives headers', () => {
		for (const [name, def] of exported_defs()) {
			assert.strictEqual(def.headers !== undefined, name === 'REST_RATE_LIMIT_EXCEEDED', name);
		}
	});

	test('the bootstrap shape of authentication_required is a second definition of its code', () => {
		assert.strictEqual(
			REST_AUTHENTICATION_REQUIRED_BOOTSTRAP.code,
			error_schemas.REST_AUTHENTICATION_REQUIRED.code
		);
		assert.notStrictEqual(
			REST_AUTHENTICATION_REQUIRED_BOOTSTRAP.schema,
			error_schemas.REST_AUTHENTICATION_REQUIRED.schema
		);
	});
});

describe('the route entries built from definitions', () => {
	for (const [name, schema, code] of ROUTE_ENTRY_ROWS) {
		test(`${name} gives the Zod-era literal's verdicts`, () => {
			assert.ok(schema, name);
			const sample = { error: code };
			for (const input of [sample, ...variants_of(sample, [...BASE_POOL, ...CODE_POOL])]) {
				assert_same(`${name} ${show(input)}`, schema, zod_error(code), input);
			}
		});
	}

	test("the fact route declares no errors of its own, its params' 400 derived", () => {
		assert.strictEqual(fact_spec.errors, undefined);
		assert.ok(
			resolve_route_errors(fact_spec).defs.includes(error_schemas.REST_INVALID_ROUTE_PARAMS)
		);
	});
});

describe('to_error_schemas', () => {
	const a = rest_error(404, 'a_missing');
	const b = rest_error(404, 'b_missing');
	const c = rest_error(409, 'c_conflict');

	test('one schema at a status is that schema', () => {
		assert.deepStrictEqual(to_error_schemas([a, c]), { 404: a.schema, 409: c.schema });
	});

	test('more at a status are a union of them in list order, each once', () => {
		const errors = to_error_schemas([a, c, b, a]);
		const union = errors[404]!;
		assert.strictEqual(union.kind, 'union');
		assert.deepStrictEqual(union.def, [a.schema, b.schema]);
		assert.strictEqual(errors[409], c.schema);
	});

	test('nothing given is no entry', () => {
		assert.deepStrictEqual(to_error_schemas([]), {});
	});

	test('a definition rebuilt the same counts once, a second shape of its code twice', () => {
		const fields = { detail: string_schema };
		const d1 = rest_error(404, 'd_missing', fields);
		const d2 = rest_error(404, 'd_missing', fields);
		const d3 = rest_error(404, 'd_missing', { detail: string_schema, more: string_schema });
		assert.deepStrictEqual(to_error_schemas([d1, d2]), { 404: d1.schema });
		assert.deepStrictEqual(to_error_schemas([d1, d3])[404]!.def, [d1.schema, d3.schema]);
	});
});

describe('same_rest_error', () => {
	test('the same status, code, headers, and field schemas', () => {
		const headers = () => ({});
		const a = rest_error(429, 'x_limited', { n: string_schema }, headers);
		assert.ok(same_rest_error(a, a));
		assert.ok(same_rest_error(a, rest_error(429, 'x_limited', { n: string_schema }, headers)));
		assert.ok(!same_rest_error(a, rest_error(429, 'x_limited', { n: string_schema })));
		assert.ok(!same_rest_error(a, rest_error(400, 'x_limited', { n: string_schema }, headers)));
		assert.ok(!same_rest_error(a, rest_error(429, 'y_limited', { n: string_schema }, headers)));
		assert.ok(!same_rest_error(a, rest_error(429, 'x_limited', { m: string_schema }, headers)));
		assert.ok(!same_rest_error(a, rest_error(429, 'x_limited', {}, headers)));
	});

	test('dedupe_rest_errors keeps two of one code and fields whose headers differ', () => {
		const fields = { n: string_schema };
		const a = rest_error(429, 'x_limited', fields, () => ({ 'Retry-After': '1' }));
		const b = rest_error(429, 'x_limited', fields, () => ({ 'Retry-After': '2' }));
		const c = rest_error(429, 'x_limited', fields);
		assert.deepStrictEqual(dedupe_rest_errors([a, b, c]), [a, b, c]);
	});

	test('dedupe_rest_errors keeps the first of each, in order', () => {
		const a = rest_error(404, 'a_missing');
		const b = rest_error(409, 'b_conflict');
		assert.deepStrictEqual(dedupe_rest_errors([a, b, rest_error(404, 'a_missing'), b]), [a, b]);
	});
});
