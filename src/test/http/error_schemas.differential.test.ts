/**
 * The REST error schemas — the standard shapes, every `REST_*` definition's
 * body, the error schemas `derive_error_schemas` builds, the route entries
 * built from definitions, and the action manifest — `@fuzdev/fuz_schema`
 * schemas, held to the Zod schemas they replaced, rebuilt here. Over each
 * schema's valid bodies and every variant of them one edit away (a node
 * replaced by a value of the pool, a key dropped, a key added), the verdict
 * and the output are Zod's, and the surface writes the same JSON Schema, as a
 * value: `to_json_schema` writes a `readOnly` annotation after the node's
 * keywords, where Zod wrote it first. An input holding a `Date`, which a loose
 * object keeps where Zod copies it into a plain object, is held to Zod's
 * verdict alone: no JSON body holds one.
 *
 * Every definition's status and code are pinned here, and the table is the
 * module's whole set: a definition added or dropped fails it.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import * as error_schemas from '#lib/http/error_schemas.ts';
import {
	AccountVanishedError,
	ActorNotOnAccountError,
	ActorRequiredError,
	ApiError,
	CredentialTypeRequiredError,
	derive_error_schemas,
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
	rest_error,
	to_error_schemas,
	TokenScopeRequiredError,
	UnsupportedContentTypeError,
	type DeriveErrorSchemasOptions,
	type RestErrorDef
} from '#lib/http/error_schemas.ts';
import { parse_any, type ValidationSchema } from '#lib/schema_issues.ts';
import { schema_to_surface } from '#lib/http/schema_helpers.ts';
import { AuthAxisState, type RouteAuth } from '#lib/http/auth_shape.ts';
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

/** `derive_error_schemas` as it was, building Zod schemas. */
const zod_derive_error_schemas = ({
	auth,
	has_input = false,
	has_params = false,
	has_query = false,
	rate_limit,
	checks_content_type = false
}: DeriveErrorSchemasOptions): Record<number, z.ZodType> => {
	const errors: Record<number, z.ZodType> = {};
	const has_validation = has_input || has_params || has_query;
	if (auth.actor !== 'none') {
		errors[400] = has_validation
			? z.union([ZodValidationError, ZodActorRequiredError, ZodActorNotOnAccountError])
			: z.union([ZodActorRequiredError, ZodActorNotOnAccountError]);
		errors[500] = z.union([ZodNoActorsOnAccountError, ZodAccountVanishedError]);
	} else if (has_validation) {
		errors[400] = ZodValidationError;
	}
	if (auth.account === 'required' || auth.actor === 'required') errors[401] = ZodApiError;
	const forbidden: Array<z.ZodType> = [];
	if (auth.required_scope !== undefined) forbidden.push(ZodTokenScopeRequiredError);
	if (auth.credential_types?.length) forbidden.push(ZodCredentialTypeRequiredError);
	if (auth.roles?.length) forbidden.push(ZodPermissionError);
	if (forbidden.length === 1) errors[403] = forbidden[0]!;
	else if (forbidden.length > 1) errors[403] = z.union(forbidden);
	if (rate_limit) errors[429] = ZodRateLimitError;
	if (checks_content_type) errors[415] = ZodUnsupportedContentTypeError;
	return errors;
};

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

/** Asserts `fuz` gives Zod's verdict and output on `input`; returns the verdict. */
const assert_same = (
	label: string,
	fuz: ValidationSchema,
	zod: z.ZodType,
	input: unknown
): boolean => {
	const zod_result = zod.safeParse(input);
	const fuz_result = parse_any(fuz, input);
	assert.strictEqual(fuz_result.ok, zod_result.success, label);
	if (fuz_result.ok && !holds_date(input)) {
		assert.deepStrictEqual(fuz_result.value, zod_result.data, label);
	}
	return fuz_result.ok;
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
			{ error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 0.5 }
		]
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
	pool: CODE_POOL
}));

const log = new Logger('test', { level: 'off' });
const login_shape = create_account_route_shapes({ login_account_rate_limited: true }).find(
	(shape) => shape.path === '/login'
);
const signup_shape = create_signup_route_shape({ signup_account_rate_limited: true });
const fact_spec = create_serve_fact_route_spec({ facts_dir: '/facts', log });

/** The route entries built from definitions, against the Zod-era literals they were. */
const ROUTE_ENTRY_ROWS: Array<[name: string, schema: ValidationSchema | undefined, code: string]> =
	[
		['POST /login 401', login_shape?.errors?.[401], 'invalid_credentials'],
		['POST /signup 403', signup_shape.errors?.[403], 'no_matching_invite'],
		['POST /signup 409', signup_shape.errors?.[409], 'signup_conflict'],
		['POST /bootstrap 401', bootstrap_route_shape.errors[401], 'invalid_token'],
		['POST /bootstrap 403', bootstrap_route_shape.errors[403], 'already_bootstrapped'],
		['POST /bootstrap 404', bootstrap_route_shape.errors[404], 'token_file_missing']
	];

const run_rows = (rows: ReadonlyArray<Row>): void => {
	for (const row of rows) {
		test(`${row.name}: every variant gets Zod's verdict and output`, () => {
			const pool = [...BASE_POOL, ...(row.pool ?? [])];
			const inputs = [...row.samples, ...row.samples.flatMap((s) => variants_of(s, pool))];
			let accepted = 0;
			let refused = 0;
			for (const input of inputs) {
				const ok = assert_same(`${row.name} ${show(input)}`, row.fuz, row.zod, input);
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

describe('the standard error shapes against their Zod copies', () => {
	run_rows(STANDARD_ROWS);

	test('each writes the Zod JSON Schema, as a value', () => {
		for (const row of STANDARD_ROWS) {
			assert.deepStrictEqual(surface_of(row.fuz), surface_of(row.zod), row.name);
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

	test('each writes the Zod JSON Schema, as a value', () => {
		for (const row of DEFINITION_ROWS) {
			assert.deepStrictEqual(surface_of(row.fuz), surface_of(row.zod), row.name);
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

	test("the fact route's 400 is the route-params definition", () => {
		assert.strictEqual(fact_spec.errors?.[400], error_schemas.REST_INVALID_ROUTE_PARAMS.schema);
	});
});

// --- derive_error_schemas against its Zod copy ---

const AXES: ReadonlyArray<Pick<RouteAuth, 'account' | 'actor'>> = [
	{ account: 'none', actor: 'none' },
	{ account: 'optional', actor: 'none' },
	{ account: 'optional', actor: 'optional' },
	{ account: 'required', actor: 'none' },
	{ account: 'required', actor: 'optional' },
	{ account: 'required', actor: 'required' }
];
const AUTHS: Array<RouteAuth> = AXES.flatMap((axes) =>
	[false, true].flatMap((roles) =>
		[false, true].flatMap((credential_types) =>
			[false, true].map((scope): RouteAuth => ({
				...axes,
				...(roles && { roles: ['admin'] }),
				...(credential_types && { credential_types: ['session'] }),
				...(scope && { required_scope: 'surface:x' })
			}))
		)
	)
);
const SLOTS: ReadonlyArray<Partial<DeriveErrorSchemasOptions>> = [
	{},
	{ has_input: true },
	{ has_params: true },
	{ has_query: true }
];
const DERIVE_OPTIONS: Array<DeriveErrorSchemasOptions> = AUTHS.flatMap((auth) =>
	SLOTS.flatMap((slots) =>
		[undefined, 'ip' as const].flatMap((rate_limit) =>
			[false, true].map((checks_content_type) => ({
				auth,
				...slots,
				rate_limit,
				checks_content_type
			}))
		)
	)
);

/** Every body any derived schema may see: each sample and its top-level variants. */
const DERIVED_BODIES: Array<unknown> = (() => {
	const samples: Array<object> = [
		...STANDARD_ROWS.filter((r) => r.name.endsWith('Error')).flatMap(
			(r) => r.samples as Array<object>
		),
		...Object.values(DEFINITIONS).map((d) => d.sample)
	];
	const out: Array<unknown> = [...samples];
	for (const sample of samples) {
		out.push({ ...sample, extra: 1 });
		for (const key of Object.keys(sample)) {
			const { [key]: _, ...dropped } = sample as Record<string, unknown>;
			out.push(dropped);
			for (const v of [null, 1, 'x', [], ['a'], {}]) out.push({ ...sample, [key]: v });
		}
	}
	return out;
})();

// an id per schema, so a status's pair is checked once however many option sets derive it
const schema_ids: WeakMap<object, number> = new WeakMap();
const schema_id = (schema: object): number => {
	let id = schema_ids.get(schema);
	if (id === undefined) schema_ids.set(schema, (id = schema_ids_next++));
	return id;
};
let schema_ids_next = 0;
// a union by its members, which a call builds anew around the same ones
const pair_key = (fuz: AnySchema, zod: z.ZodType): string => {
	const fuz_members: ReadonlyArray<object> =
		fuz.kind === 'union' ? (fuz.def as Array<object>) : [fuz];
	const zod_members: ReadonlyArray<object> = zod instanceof z.ZodUnion ? zod.options : [zod];
	return `${fuz_members.map(schema_id).join(',')}|${zod_members.map(schema_id).join(',')}`;
};

describe('derive_error_schemas against its Zod copy', () => {
	const checked: Set<string> = new Set();
	for (const auth of AUTHS) {
		test(`${JSON.stringify(auth)} derives the same statuses, verdicts, outputs, and surface`, () => {
			for (const options of DERIVE_OPTIONS.filter((o) => o.auth === auth)) {
				const label = JSON.stringify(options);
				const fuz = derive_error_schemas(options);
				const zod = zod_derive_error_schemas(options);
				assert.deepStrictEqual(Object.keys(fuz), Object.keys(zod), label);
				for (const status of Object.keys(zod).map(Number)) {
					const fuz_schema = fuz[status]!;
					const zod_schema = zod[status]!;
					const key = `${status}:${pair_key(fuz_schema, zod_schema)}`;
					if (checked.has(key)) continue;
					checked.add(key);
					for (const body of DERIVED_BODIES) {
						assert_same(`${label} ${status} ${show(body)}`, fuz_schema, zod_schema, body);
					}
					assert.deepStrictEqual(surface_of(fuz_schema), surface_of(zod_schema), label);
				}
			}
		});
	}

	test('the option sets reach every derived status', () => {
		const statuses = new Set(
			DERIVE_OPTIONS.flatMap((o) => Object.keys(derive_error_schemas(o)).map(Number))
		);
		assert.deepStrictEqual(
			[...statuses].sort((a, b) => a - b),
			[400, 401, 403, 415, 429, 500]
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
});
