/**
 * Tests for error_schemas.ts — standard error schemas and auto-derivation.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { parse, string } from '@fuzdev/fuz_schema/schema.ts';

import {
	REST_ERROR_CODE_PATTERN,
	is_rest_error_code,
	rest_error,
	derive_route_errors,
	to_error_schemas,
	REST_AUTHENTICATION_REQUIRED,
	REST_CREDENTIAL_TYPE_REQUIRED,
	REST_INSUFFICIENT_PERMISSIONS,
	REST_RATE_LIMIT_EXCEEDED,
	REST_TOKEN_SCOPE_REQUIRED,
	type DeriveRouteErrorsOptions,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_CREDENTIAL_TYPE_REQUIRED,
	ERROR_INVALID_TOKEN,
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_FORBIDDEN_ORIGIN,
	ERROR_RATE_LIMIT_EXCEEDED,
	ERROR_INVALID_CREDENTIALS,
	ERROR_KEEPER_ACCOUNT_NOT_FOUND,
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_TOKEN_FILE_MISSING,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
	ERROR_ROLE_GRANT_NOT_FOUND,
	ERROR_INVALID_EVENT_TYPE,
	ERROR_PAYLOAD_TOO_LARGE,
	ERROR_INVALID_CONTENT_LENGTH,
	ERROR_FOREIGN_KEY_VIOLATION,
	ERROR_TABLE_NOT_FOUND,
	ERROR_TABLE_NO_PRIMARY_KEY,
	ERROR_TABLE_NOT_DELETABLE,
	ERROR_ROW_NOT_FOUND,
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_INVITE_NOT_FOUND,
	ERROR_INVITE_DUPLICATE,
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_ACCOUNT_EXISTS_EMAIL,
	ERROR_ACTOR_REQUIRED,
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_NO_ACTORS_ON_ACCOUNT,
	ERROR_ACCOUNT_VANISHED,
	REST_ACCOUNT_VANISHED,
	REST_ACTOR_NOT_ON_ACCOUNT,
	REST_ACTOR_REQUIRED,
	REST_FOREIGN_KEY_VIOLATION,
	REST_INVALID_REQUEST_BODY,
	REST_NO_ACTORS_ON_ACCOUNT,
	REST_PAYLOAD_TOO_LARGE
} from '#lib/http/error_schemas.ts';

describe('rest_error codes', () => {
	test('a code is a lowercase letter, then lowercase letters, digits and _', () => {
		for (const code of ['a', 'not_found', 'error_2', 'x_y_z']) {
			assert.isTrue(is_rest_error_code(code), code);
			assert.strictEqual(rest_error(400, code as 'x').code, code);
		}
		assert.strictEqual(REST_ERROR_CODE_PATTERN.source, '^[a-z][a-z0-9_]*$');
	});

	test('a definition refuses prose, throwing at definition', () => {
		const refused = [
			'',
			'File not found',
			'not-found',
			'Not_found',
			'_leading',
			'2fa_required',
			'trailing ',
			'dotted.code',
			'with:colon',
			'emoji_🙂'
		];
		for (const code of refused) {
			assert.isFalse(is_rest_error_code(code), code);
			// the type-level check refuses most of these too; the runtime one is the whole grammar
			assert.throws(() => rest_error(400, code as 'x'), /is not an error code/, code);
		}
		assert.isFalse(is_rest_error_code(42));
	});

	test('a definition refuses fields with an error entry, which would replace its code', () => {
		assert.throws(
			() => rest_error(404, 'thing_not_found', { error: string }),
			/hold an `error` entry/
		);
	});

	test('the type refuses a literal code plainly off the grammar', () => {
		// a call whose code the type refuses still throws at runtime — a cast is no way around it
		assert.throws(() => {
			// @ts-expect-error - prose
			rest_error(404, 'File not found');
		});
		assert.throws(() => {
			// @ts-expect-error - uppercase
			rest_error(404, 'Not_found');
		});
		assert.throws(() => {
			// @ts-expect-error - a leading digit
			rest_error(404, '2fa');
		});
		assert.throws(() => {
			// @ts-expect-error - a hyphen
			rest_error(404, 'not-found');
		});
		assert.throws(() => {
			// @ts-expect-error - empty
			rest_error(404, '');
		});
	});
});

describe('standard error schemas', () => {
	test('REST_INVALID_REQUEST_BODY accepts error with issues', () => {
		const result = parse(REST_INVALID_REQUEST_BODY.schema, {
			error: 'invalid_request_body',
			issues: [
				{
					kind: 'string',
					path: ['name'],
					expected: 'string',
					received: 'number',
					message: 'Invalid input: expected string, received number'
				}
			]
		});
		assert.isTrue(result.ok);
	});

	test("REST_INVALID_REQUEST_BODY refuses an issue in a library's own shape", () => {
		const zod_shaped = parse(REST_INVALID_REQUEST_BODY.schema, {
			error: 'invalid_request_body',
			issues: [{ code: 'invalid_type', message: 'Expected string', path: ['name'] }]
		});
		assert.isFalse(zod_shaped.ok);
		const fuz_shaped = parse(REST_INVALID_REQUEST_BODY.schema, {
			error: 'invalid_request_body',
			issues: [{ kind: 'string', path: ['name'], expected: 'string', received: 'number' }]
		});
		assert.isFalse(fuz_shaped.ok);
	});

	test('REST_INSUFFICIENT_PERMISSIONS requires insufficient_permissions literal', () => {
		const valid = parse(REST_INSUFFICIENT_PERMISSIONS.schema, {
			error: ERROR_INSUFFICIENT_PERMISSIONS,
			required_roles: ['admin']
		});
		assert.isTrue(valid.ok);

		const invalid = parse(REST_INSUFFICIENT_PERMISSIONS.schema, {
			error: 'wrong_error',
			required_roles: ['admin']
		});
		assert.isFalse(invalid.ok);
	});

	test('REST_CREDENTIAL_TYPE_REQUIRED requires credential_type_required literal', () => {
		const valid = parse(REST_CREDENTIAL_TYPE_REQUIRED.schema, {
			error: ERROR_CREDENTIAL_TYPE_REQUIRED,
			required_credential_types: ['daemon_token']
		});
		assert.isTrue(valid.ok);

		const invalid = parse(REST_CREDENTIAL_TYPE_REQUIRED.schema, {
			error: 'wrong_error',
			required_credential_types: ['daemon_token']
		});
		assert.isFalse(invalid.ok);
	});

	test('REST_RATE_LIMIT_EXCEEDED requires rate_limit_exceeded and retry_after', () => {
		const valid = parse(REST_RATE_LIMIT_EXCEEDED.schema, {
			error: ERROR_RATE_LIMIT_EXCEEDED,
			retry_after: 60
		});
		assert.isTrue(valid.ok);

		const missing_retry = parse(REST_RATE_LIMIT_EXCEEDED.schema, {
			error: ERROR_RATE_LIMIT_EXCEEDED
		});
		assert.isFalse(missing_retry.ok);
	});

	test('REST_PAYLOAD_TOO_LARGE requires payload_too_large literal', () => {
		const valid = parse(REST_PAYLOAD_TOO_LARGE.schema, { error: ERROR_PAYLOAD_TOO_LARGE });
		assert.isTrue(valid.ok);

		const invalid = parse(REST_PAYLOAD_TOO_LARGE.schema, { error: 'wrong_error' });
		assert.isFalse(invalid.ok);
	});

	test('REST_FOREIGN_KEY_VIOLATION accepts error without detail or constraint', () => {
		const result = parse(REST_FOREIGN_KEY_VIOLATION.schema, {
			error: ERROR_FOREIGN_KEY_VIOLATION
		});
		assert.isTrue(result.ok);
	});
});

/** The codes `derive_route_errors` gives, `status code` in order. */
const derived = (options: DeriveRouteErrorsOptions): Array<string> =>
	derive_route_errors(options).map((def) => `${def.status} ${def.code}`);

const NONE = { account: 'none', actor: 'none' } as const;

describe('derive_route_errors', () => {
	test('auth none + no slots derives nothing, on any method but POST', () => {
		assert.deepStrictEqual(derived({ method: 'GET', auth: NONE }), []);
		assert.deepStrictEqual(derived({ method: 'DELETE', auth: NONE }), []);
		assert.deepStrictEqual(derived({ method: 'POST', auth: NONE }), [
			'415 unsupported_content_type'
		]);
	});

	test('a body derives the two body codes, off GET', () => {
		assert.deepStrictEqual(derived({ method: 'POST', auth: NONE, has_input: true }), [
			'400 invalid_request_body',
			'400 invalid_json_body',
			'415 unsupported_content_type'
		]);
		// a DELETE with a body is validated as one, and checks no content type
		assert.deepStrictEqual(derived({ method: 'DELETE', auth: NONE, has_input: true }), [
			'400 invalid_request_body',
			'400 invalid_json_body'
		]);
		assert.deepStrictEqual(derived({ method: 'PATCH', auth: NONE, has_input: true }), [
			'400 invalid_request_body',
			'400 invalid_json_body'
		]);
	});

	test('a GET with an input derives no body code: the input middleware skips GET', () => {
		assert.deepStrictEqual(derived({ method: 'GET', auth: NONE, has_input: true }), []);
	});

	test('params derive only the route-params code, a query only the query code', () => {
		assert.deepStrictEqual(derived({ method: 'GET', auth: NONE, has_params: true }), [
			'400 invalid_route_params'
		]);
		assert.deepStrictEqual(derived({ method: 'GET', auth: NONE, has_query: true }), [
			'400 invalid_query_params'
		]);
		assert.deepStrictEqual(
			derived({ method: 'PUT', auth: NONE, has_input: true, has_params: true, has_query: true }),
			[
				'400 invalid_request_body',
				'400 invalid_json_body',
				'400 invalid_route_params',
				'400 invalid_query_params'
			]
		);
	});

	test('a required account or actor derives the literal 401', () => {
		const required = derive_route_errors({
			method: 'GET',
			auth: { account: 'required', actor: 'none' }
		});
		assert.deepStrictEqual(required, [REST_AUTHENTICATION_REQUIRED]);
		assert.deepStrictEqual(
			derived({ method: 'GET', auth: { account: 'optional', actor: 'none' } }),
			[]
		);
	});

	test('each 403 gate derives its definition, in the order the gates fire', () => {
		assert.deepStrictEqual(
			derive_route_errors({
				method: 'GET',
				auth: {
					account: 'required',
					actor: 'none',
					roles: ['admin'],
					credential_types: ['session'],
					required_scope: 'surface:audit_stream'
				}
			}).filter((def) => def.status === 403),
			[REST_TOKEN_SCOPE_REQUIRED, REST_CREDENTIAL_TYPE_REQUIRED, REST_INSUFFICIENT_PERMISSIONS]
		);
		assert.deepStrictEqual(
			derived({ method: 'GET', auth: { account: 'required', actor: 'none', roles: ['admin'] } }),
			['401 authentication_required', '403 insufficient_permissions']
		);
	});

	test('an actor axis derives the authorization phase codes, with no input slot', () => {
		assert.deepStrictEqual(
			derived({ method: 'GET', auth: { account: 'required', actor: 'optional' } }),
			[
				'400 actor_required',
				'400 actor_not_on_account',
				'500 no_actors_on_account',
				'500 account_vanished',
				'401 authentication_required'
			]
		);
	});

	test('a rate limit derives 429, whichever key', () => {
		for (const rate_limit of ['ip', 'account', 'both'] as const) {
			assert.deepStrictEqual(derive_route_errors({ method: 'GET', auth: NONE, rate_limit }), [
				REST_RATE_LIMIT_EXCEEDED
			]);
		}
	});

	test('the derived 400s group into the status map as a union of their bodies', () => {
		const errors = to_error_schemas(
			derive_route_errors({
				method: 'POST',
				auth: { account: 'required', actor: 'optional' },
				has_input: true
			})
		);
		const admits = (body: unknown): boolean => parse(errors[400]!, body).ok;
		assert.isTrue(admits({ error: ERROR_INVALID_REQUEST_BODY, issues: [] }));
		assert.isTrue(admits({ error: ERROR_INVALID_JSON_BODY }));
		assert.isTrue(admits({ error: ERROR_ACTOR_REQUIRED, available: [] }));
		assert.isTrue(admits({ error: ERROR_ACTOR_NOT_ON_ACCOUNT }));
		assert.isFalse(admits({ error: ERROR_INVALID_ROUTE_PARAMS }));
		assert.isFalse(admits({ error: ERROR_INVALID_QUERY_PARAMS }));
		assert.isTrue(parse(errors[401]!, { error: ERROR_AUTHENTICATION_REQUIRED }).ok);
		assert.isFalse(parse(errors[401]!, { error: ERROR_INVALID_CREDENTIALS }).ok);
	});
});

describe('error code constants', () => {
	test('constants match expected string values', () => {
		assert.strictEqual(ERROR_INVALID_REQUEST_BODY, 'invalid_request_body');
		assert.strictEqual(ERROR_INVALID_JSON_BODY, 'invalid_json_body');
		assert.strictEqual(ERROR_INVALID_ROUTE_PARAMS, 'invalid_route_params');
		assert.strictEqual(ERROR_INVALID_QUERY_PARAMS, 'invalid_query_params');
		assert.strictEqual(ERROR_AUTHENTICATION_REQUIRED, 'authentication_required');
		assert.strictEqual(ERROR_INSUFFICIENT_PERMISSIONS, 'insufficient_permissions');
		assert.strictEqual(ERROR_CREDENTIAL_TYPE_REQUIRED, 'credential_type_required');
		assert.strictEqual(ERROR_INVALID_TOKEN, 'invalid_token');
		assert.strictEqual(ERROR_ACCOUNT_NOT_FOUND, 'account_not_found');
		assert.strictEqual(ERROR_FORBIDDEN_ORIGIN, 'forbidden_origin');
		assert.strictEqual(ERROR_RATE_LIMIT_EXCEEDED, 'rate_limit_exceeded');
		assert.strictEqual(ERROR_INVALID_CREDENTIALS, 'invalid_credentials');
		assert.strictEqual(ERROR_KEEPER_ACCOUNT_NOT_FOUND, 'keeper_account_not_found');
		assert.strictEqual(ERROR_ALREADY_BOOTSTRAPPED, 'already_bootstrapped');
		assert.strictEqual(ERROR_TOKEN_FILE_MISSING, 'token_file_missing');
		assert.strictEqual(ERROR_ROLE_NOT_WEB_GRANTABLE, 'role_not_web_grantable');
		assert.strictEqual(ERROR_ROLE_GRANT_NOT_FOUND, 'role_grant_not_found');
		assert.strictEqual(ERROR_INVALID_EVENT_TYPE, 'invalid_event_type');
		assert.strictEqual(ERROR_PAYLOAD_TOO_LARGE, 'payload_too_large');
		assert.strictEqual(ERROR_INVALID_CONTENT_LENGTH, 'invalid_content_length');
		assert.strictEqual(ERROR_FOREIGN_KEY_VIOLATION, 'foreign_key_violation');
		assert.strictEqual(ERROR_TABLE_NOT_FOUND, 'table_not_found');
		assert.strictEqual(ERROR_TABLE_NO_PRIMARY_KEY, 'table_no_primary_key');
		assert.strictEqual(ERROR_TABLE_NOT_DELETABLE, 'table_not_deletable');
		assert.strictEqual(ERROR_ROW_NOT_FOUND, 'row_not_found');
		assert.strictEqual(ERROR_NO_MATCHING_INVITE, 'no_matching_invite');
		assert.strictEqual(ERROR_SIGNUP_CONFLICT, 'signup_conflict');
		assert.strictEqual(ERROR_INVITE_NOT_FOUND, 'invite_not_found');
		assert.strictEqual(ERROR_INVITE_DUPLICATE, 'invite_duplicate');
		assert.strictEqual(ERROR_INVITE_ACCOUNT_EXISTS_USERNAME, 'invite_account_exists_username');
		assert.strictEqual(ERROR_INVITE_ACCOUNT_EXISTS_EMAIL, 'invite_account_exists_email');
	});

	test('constants are used by standard error schemas', () => {
		assert.isTrue(
			parse(REST_AUTHENTICATION_REQUIRED.schema, { error: ERROR_AUTHENTICATION_REQUIRED }).ok
		);
		assert.isTrue(
			parse(REST_INSUFFICIENT_PERMISSIONS.schema, {
				error: ERROR_INSUFFICIENT_PERMISSIONS,
				required_roles: ['admin']
			}).ok
		);
		assert.isTrue(
			parse(REST_CREDENTIAL_TYPE_REQUIRED.schema, {
				error: ERROR_CREDENTIAL_TYPE_REQUIRED,
				required_credential_types: ['daemon_token']
			}).ok
		);
		assert.isTrue(
			parse(REST_INVALID_REQUEST_BODY.schema, {
				error: ERROR_INVALID_REQUEST_BODY,
				issues: [
					{
						kind: 'string',
						path: ['name'],
						expected: 'string',
						received: 'number',
						message: 'Invalid input: expected string, received number'
					}
				]
			}).ok
		);
		assert.isTrue(
			parse(REST_RATE_LIMIT_EXCEEDED.schema, {
				error: ERROR_RATE_LIMIT_EXCEEDED,
				retry_after: 60
			}).ok
		);
		assert.isTrue(
			parse(REST_PAYLOAD_TOO_LARGE.schema, {
				error: ERROR_PAYLOAD_TOO_LARGE
			}).ok
		);
		assert.isTrue(
			parse(REST_FOREIGN_KEY_VIOLATION.schema, {
				error: ERROR_FOREIGN_KEY_VIOLATION
			}).ok
		);
	});
});

describe('authorization-phase actor error schemas', () => {
	test('REST_ACTOR_REQUIRED accepts available[] with id+name entries', () => {
		const result = parse(REST_ACTOR_REQUIRED.schema, {
			error: ERROR_ACTOR_REQUIRED,
			available: [{ id: '00000000-0000-4000-8000-000000000001', name: 'alice' }]
		});
		assert.isTrue(result.ok);
	});

	test('REST_ACTOR_REQUIRED rejects missing available', () => {
		const result = parse(REST_ACTOR_REQUIRED.schema, { error: ERROR_ACTOR_REQUIRED });
		assert.isFalse(result.ok);
	});

	test('REST_ACTOR_NOT_ON_ACCOUNT accepts the literal-only shape', () => {
		const result = parse(REST_ACTOR_NOT_ON_ACCOUNT.schema, { error: ERROR_ACTOR_NOT_ON_ACCOUNT });
		assert.isTrue(result.ok);
	});

	test('REST_NO_ACTORS_ON_ACCOUNT accepts the literal-only shape', () => {
		const result = parse(REST_NO_ACTORS_ON_ACCOUNT.schema, { error: ERROR_NO_ACTORS_ON_ACCOUNT });
		assert.isTrue(result.ok);
	});

	test('REST_ACCOUNT_VANISHED accepts the literal-only shape', () => {
		const result = parse(REST_ACCOUNT_VANISHED.schema, { error: ERROR_ACCOUNT_VANISHED });
		assert.isTrue(result.ok);
	});
});
