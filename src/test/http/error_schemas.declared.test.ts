/**
 * The REST error schemas — every `REST_*` definition's status, code, body and
 * JSON Schema, the route entries built from definitions, the auth and
 * rate-limit enums, and the action manifest — plus `to_error_schemas` and
 * `same_rest_error`. One declared choice: the rate limit's `retry_after` is a
 * non-negative integer, as both spines send whole seconds.
 *
 * What `derive_route_errors` derives — it narrows to the slots a route has —
 * is held by `error_schemas.test.ts`.
 *
 * Every definition's status and code are pinned here, and the table is the
 * module's whole set: a definition added or dropped fails it.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import {
	format_issue,
	is,
	parse,
	string as string_schema,
	type AnySchema
} from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import * as error_schemas from '#lib/http/error_schemas.ts';
import {
	ERROR_RATE_LIMIT_EXCEEDED,
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP,
	REST_RATE_LIMIT_EXCEEDED,
	dedupe_rest_errors,
	rest_error,
	same_rest_error,
	to_error_schemas,
	type RestErrorDef
} from '#lib/http/error_schemas.ts';
import { schema_to_surface } from '#lib/http/schema_helpers.ts';
import { resolve_route_error_map } from '#lib/http/route_errors.ts';
import { AuthAxisState } from '#lib/http/auth_shape.ts';
import { RateLimitKey } from '#lib/rate_limiter.ts';
import { ActionManifest, ActionManifestEntry } from '#lib/testing/cross_backend/action_manifest.ts';
import { create_account_route_shapes } from '#lib/auth/account_route_schema.ts';
import { create_signup_route_shape } from '#lib/auth/signup_route_schema.ts';
import { bootstrap_route_shape } from '#lib/auth/bootstrap_route_schema.ts';
import { create_serve_fact_route_spec } from '#lib/server/serve_fact_route.ts';

const WIRE_ISSUE = {
	kind: 'string',
	path: ['a', 0],
	expected: 'string',
	received: 'number',
	message: 'a.0: expected string'
};
const ACTOR = { id: '0d6f7c1e-5a3b-4c2d-8e9f-0123456789ab', name: 'alice' };

// the JSON Schema of an error body: its code, its fields, and any other key
const body_surface = (
	code: string,
	properties: Record<string, unknown> = {},
	required: Array<string> = []
): unknown => ({
	type: 'object',
	properties: { error: { type: 'string', const: code }, ...properties },
	required: ['error', ...required],
	additionalProperties: {}
});
const ISSUES_SURFACE = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			kind: { type: 'string' },
			path: { type: 'array', items: { type: ['string', 'number'] } },
			expected: { type: 'string' },
			received: { type: 'string' },
			message: { type: 'string' }
		},
		required: ['kind', 'path', 'expected', 'received', 'message'],
		additionalProperties: {}
	}
};
const READONLY_STRINGS = { type: 'array', items: { type: 'string' }, readOnly: true };

/**
 * Each definition by its export name: its status, its code, a body it admits,
 * and the JSON Schema the surface writes for it when it has fields.
 */
const DEFINITIONS: Record<
	string,
	{ status: number; code: string; sample: object; surface?: unknown }
> = {
	REST_INVALID_REQUEST_BODY: {
		status: 400,
		code: 'invalid_request_body',
		sample: { error: 'invalid_request_body', issues: [WIRE_ISSUE] },
		surface: body_surface('invalid_request_body', { issues: ISSUES_SURFACE })
	},
	REST_INVALID_JSON_BODY: {
		status: 400,
		code: 'invalid_json_body',
		sample: { error: 'invalid_json_body' }
	},
	REST_INVALID_ROUTE_PARAMS: {
		status: 400,
		code: 'invalid_route_params',
		sample: { error: 'invalid_route_params', issues: [WIRE_ISSUE] },
		surface: body_surface('invalid_route_params', { issues: ISSUES_SURFACE })
	},
	REST_INVALID_QUERY_PARAMS: {
		status: 400,
		code: 'invalid_query_params',
		sample: { error: 'invalid_query_params', issues: [] },
		surface: body_surface('invalid_query_params', { issues: ISSUES_SURFACE })
	},
	REST_INVALID_CONTENT_LENGTH: {
		status: 400,
		code: 'invalid_content_length',
		sample: { error: 'invalid_content_length' }
	},
	REST_ACTOR_REQUIRED: {
		status: 400,
		code: 'actor_required',
		sample: { error: 'actor_required', available: [ACTOR] },
		surface: body_surface(
			'actor_required',
			{
				available: {
					type: 'array',
					items: {
						type: 'object',
						properties: { id: { type: 'string' }, name: { type: 'string' } },
						required: ['id', 'name'],
						additionalProperties: {}
					}
				}
			},
			['available']
		)
	},
	REST_ACTOR_NOT_ON_ACCOUNT: {
		status: 400,
		code: 'actor_not_on_account',
		sample: { error: 'actor_not_on_account' }
	},
	REST_TABLE_NOT_DELETABLE: {
		status: 400,
		code: 'table_not_deletable',
		sample: { error: 'table_not_deletable' }
	},
	REST_TABLE_NO_PRIMARY_KEY: {
		status: 400,
		code: 'table_no_primary_key',
		sample: { error: 'table_no_primary_key' }
	},
	REST_AUTHENTICATION_REQUIRED: {
		status: 401,
		code: 'authentication_required',
		sample: { error: 'authentication_required' }
	},
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP: {
		status: 401,
		code: 'authentication_required',
		sample: { error: 'authentication_required', bootstrap_available: false },
		surface: body_surface('authentication_required', {
			bootstrap_available: { type: 'boolean' }
		})
	},
	REST_INVALID_CREDENTIALS: {
		status: 401,
		code: 'invalid_credentials',
		sample: { error: 'invalid_credentials' }
	},
	REST_INVALID_TOKEN: { status: 401, code: 'invalid_token', sample: { error: 'invalid_token' } },
	REST_INSUFFICIENT_PERMISSIONS: {
		status: 403,
		code: 'insufficient_permissions',
		sample: { error: 'insufficient_permissions', required_roles: ['admin'] },
		surface: body_surface('insufficient_permissions', { required_roles: READONLY_STRINGS }, [
			'required_roles'
		])
	},
	REST_CREDENTIAL_TYPE_REQUIRED: {
		status: 403,
		code: 'credential_type_required',
		sample: { error: 'credential_type_required', required_credential_types: ['daemon_token'] },
		surface: body_surface(
			'credential_type_required',
			{ required_credential_types: READONLY_STRINGS },
			['required_credential_types']
		)
	},
	REST_TOKEN_SCOPE_REQUIRED: {
		status: 403,
		code: 'token_scope_required',
		sample: { error: 'token_scope_required', required_scope: 'surface:fact_bare' },
		surface: body_surface('token_scope_required', { required_scope: { type: 'string' } }, [
			'required_scope'
		])
	},
	REST_FORBIDDEN_ORIGIN: {
		status: 403,
		code: 'forbidden_origin',
		sample: { error: 'forbidden_origin' }
	},
	REST_FORBIDDEN_HOST: { status: 403, code: 'forbidden_host', sample: { error: 'forbidden_host' } },
	REST_ALREADY_BOOTSTRAPPED: {
		status: 403,
		code: 'already_bootstrapped',
		sample: { error: 'already_bootstrapped' }
	},
	REST_NO_MATCHING_INVITE: {
		status: 403,
		code: 'no_matching_invite',
		sample: { error: 'no_matching_invite' }
	},
	REST_TOKEN_FILE_MISSING: {
		status: 404,
		code: 'token_file_missing',
		sample: { error: 'token_file_missing' }
	},
	REST_TABLE_NOT_FOUND: {
		status: 404,
		code: 'table_not_found',
		sample: { error: 'table_not_found' }
	},
	REST_ROW_NOT_FOUND: { status: 404, code: 'row_not_found', sample: { error: 'row_not_found' } },
	REST_FOREIGN_KEY_VIOLATION: {
		status: 409,
		code: 'foreign_key_violation',
		sample: { error: 'foreign_key_violation' }
	},
	REST_SIGNUP_CONFLICT: {
		status: 409,
		code: 'signup_conflict',
		sample: { error: 'signup_conflict' }
	},
	REST_PAYLOAD_TOO_LARGE: {
		status: 413,
		code: 'payload_too_large',
		sample: { error: 'payload_too_large' }
	},
	REST_UNSUPPORTED_CONTENT_TYPE: {
		status: 415,
		code: 'unsupported_content_type',
		sample: { error: 'unsupported_content_type' }
	},
	REST_RATE_LIMIT_EXCEEDED: {
		status: 429,
		code: 'rate_limit_exceeded',
		sample: { error: 'rate_limit_exceeded', retry_after: 30 },
		surface: body_surface('rate_limit_exceeded', { retry_after: { type: 'integer', minimum: 0 } }, [
			'retry_after'
		])
	},
	REST_NO_ACTORS_ON_ACCOUNT: {
		status: 500,
		code: 'no_actors_on_account',
		sample: { error: 'no_actors_on_account' }
	},
	REST_ACCOUNT_VANISHED: {
		status: 500,
		code: 'account_vanished',
		sample: { error: 'account_vanished' }
	},
	REST_INTERNAL_ERROR: {
		status: 500,
		code: 'internal_error',
		sample: { error: 'internal_error', message: 'boom' }
	},
	REST_SERVICE_UNAVAILABLE: {
		status: 503,
		code: 'service_unavailable',
		sample: { error: 'service_unavailable' }
	},
	REST_DATABASE_CONNECTION_FAILED: {
		status: 503,
		code: 'database_connection_failed',
		// the body `GET /health` and the Rust spine send on a failed check
		sample: { error: 'database_connection_failed', connected: false, type: 'pglet' },
		surface: body_surface(
			'database_connection_failed',
			{ connected: { type: 'boolean', const: false }, type: { type: 'string' } },
			['connected', 'type']
		)
	},
	REST_SCHEMA_DRIFT: { status: 503, code: 'schema_drift', sample: { error: 'schema_drift' } },
	REST_DB_UNREACHABLE: { status: 503, code: 'db_unreachable', sample: { error: 'db_unreachable' } }
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

const surface_of = (schema: AnySchema): unknown =>
	sort_keys(schema_to_surface(schema, { io: 'output' }));

/** The first issue of a failed parse, with its message. */
const first_issue = (schema: AnySchema, input: unknown) => {
	const result = parse(schema, input);
	assert.ok(!result.ok);
	const { kind, path, expected, received } = result.issues[0]!;
	return { kind, path, expected, received, message: format_issue(result.issues[0]!) };
};

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

/** More valid samples: the definitions' other shapes, the enums, and the action manifest. */
const SAMPLES: Array<[name: string, schema: AnySchema, samples: ReadonlyArray<unknown>]> = [
	[
		'REST_INSUFFICIENT_PERMISSIONS',
		error_schemas.REST_INSUFFICIENT_PERMISSIONS.schema,
		[{ error: 'insufficient_permissions', required_roles: ['admin', 'keeper'] }]
	],
	[
		'REST_RATE_LIMIT_EXCEEDED',
		REST_RATE_LIMIT_EXCEEDED.schema,
		[
			{ error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 60 },
			{ error: ERROR_RATE_LIMIT_EXCEEDED, retry_after: 0 }
		]
	],
	[
		'REST_ACTOR_REQUIRED',
		error_schemas.REST_ACTOR_REQUIRED.schema,
		[{ error: 'actor_required', available: [] }]
	],
	[
		'REST_AUTHENTICATION_REQUIRED_BOOTSTRAP',
		REST_AUTHENTICATION_REQUIRED_BOOTSTRAP.schema,
		[
			{ error: 'authentication_required' },
			{ error: 'authentication_required', bootstrap_available: true }
		]
	],
	['AuthAxisState', AuthAxisState, ['none', 'optional', 'required']],
	['RateLimitKey', RateLimitKey, ['ip', 'account', 'both']],
	[
		'ActionManifestEntry',
		ActionManifestEntry,
		[MANIFEST_ENTRY, { ...MANIFEST_ENTRY, input: 'object', rate_limit: 'both' }]
	],
	['ActionManifest', ActionManifest, [{ methods: [MANIFEST_ENTRY] }, { methods: [] }]]
];

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

/** The route entries built from definitions, each the single code it answers with. */
const ROUTE_ENTRY_ROWS: Array<[name: string, schema: AnySchema | undefined, code: string]> = [
	['POST /login 401', own_errors_at(login_shape, 401), 'invalid_credentials'],
	['POST /signup 403', own_errors_at(signup_shape, 403), 'no_matching_invite'],
	['POST /signup 409', own_errors_at(signup_shape, 409), 'signup_conflict'],
	['POST /bootstrap 401', own_errors_at(bootstrap_route_shape, 401), 'invalid_token'],
	['POST /bootstrap 403', own_errors_at(bootstrap_route_shape, 403), 'already_bootstrapped'],
	['POST /bootstrap 404', own_errors_at(bootstrap_route_shape, 404), 'token_file_missing']
];

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
			const { error: _, ...no_code } = pinned.sample as Record<string, unknown>;
			assert.ok(!is(def.schema, no_code), `${name} requires its code`);
		}
	});

	test('each body is a loose object, keeping an unknown key', () => {
		for (const [name, def] of exported_defs()) {
			// `unknown`: a sample is typed `object`, so the spread lacks the `error` the body type requires; the test compares identity
			const input: unknown = { ...DEFINITIONS[name]!.sample, extra: 1 };
			const result = parse(def.schema, input);
			assert.ok(result.ok, name);
			assert.strictEqual(result.value, input, name);
		}
	});

	test('each writes its pinned JSON Schema', () => {
		for (const [name, def] of exported_defs()) {
			const pinned = DEFINITIONS[name]!;
			assert.deepStrictEqual(
				surface_of(def.schema),
				sort_keys(pinned.surface ?? body_surface(pinned.code)),
				name
			);
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

	test('every valid sample parses', () => {
		for (const [name, schema, samples] of SAMPLES) {
			for (const sample of samples) {
				assert.ok(parse(schema, sample).ok, `${name} ${JSON.stringify(sample)}`);
			}
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

describe('the declared differences', () => {
	test("the rate limit's retry_after is a non-negative integer", () => {
		const cases: Array<[retry_after: number, ok: boolean]> = [
			[0, true],
			[60, true],
			[2 ** 53, true],
			[0.5, false],
			[-1, false],
			[Infinity, false]
		];
		for (const [retry_after, ok] of cases) {
			assert.strictEqual(
				is(REST_RATE_LIMIT_EXCEEDED.schema, { error: ERROR_RATE_LIMIT_EXCEEDED, retry_after }),
				ok,
				String(retry_after)
			);
		}
		assert.deepStrictEqual(
			first_issue(REST_RATE_LIMIT_EXCEEDED.schema, {
				error: ERROR_RATE_LIMIT_EXCEEDED,
				retry_after: 0.5
			}),
			{
				kind: 'integer',
				path: ['retry_after'],
				expected: 'integer',
				received: 'number',
				message: 'retry_after: expected integer, received number'
			}
		);
		assert.deepStrictEqual(
			first_issue(REST_RATE_LIMIT_EXCEEDED.schema, {
				error: ERROR_RATE_LIMIT_EXCEEDED,
				retry_after: -1
			}),
			{
				kind: 'min_value',
				path: ['retry_after'],
				expected: '>= 0',
				received: 'number',
				message: 'retry_after: expected >= 0, received number'
			}
		);
	});
});

describe('the route entries built from definitions', () => {
	for (const [name, schema, code] of ROUTE_ENTRY_ROWS) {
		test(`${name} is the body of its one code`, () => {
			assert.ok(schema, name);
			const cases: Array<[input: unknown, ok: boolean]> = [
				[{ error: code }, true],
				[{ error: code, message: 'm' }, true],
				[{ error: `${code}_` }, false],
				[{ error: 'internal_error' }, false],
				[{}, false],
				[null, false],
				[code, false]
			];
			for (const [input, ok] of cases) {
				assert.strictEqual(is(schema, input), ok, `${name} ${JSON.stringify(input)}`);
			}
		});
	}

	test("the fact route declares no errors of its own, its params' 400 derived", () => {
		assert.strictEqual(fact_spec.errors, undefined);
		assert.ok(
			resolve_route_error_map(fact_spec).defs.includes(error_schemas.REST_INVALID_ROUTE_PARAMS)
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
