/**
 * The account domain's schemas — the self-service action inputs and outputs,
 * `ClientApiTokenJson`, `ApiTokenId`, `TokenScope`, `TokenScopeInput`,
 * `TokenLifetimeInput`, the passwords, `UsernameProvided`, and the schemas of
 * the account, signup and bootstrap routes: their valid samples, and the
 * verdicts that tightened when they were ported, pinned case by case.
 *
 * - **the strict timestamp**: a `ClientApiTokenJson` timestamp and
 *   `TokenCreateOutput`'s `expires_at` are `Timestamp`, an RFC 3339 date and
 *   time in UTC. Both spines write `YYYY-MM-DDTHH:MM:SSZ`.
 * - **the token id**: a `ClientApiTokenJson`'s `id` is an `ApiTokenId`. Both
 *   spines mint every id as `tok_` and twelve base64url characters.
 * - **the count**: `SessionRevokeAllOutput`'s `count` and
 *   `PasswordChangeOutput`'s `sessions_revoked` and `tokens_revoked` are
 *   non-negative integers.
 * - **the canonical username**: the output `username` of logout, signup and
 *   bootstrap is `UsernameCanonical`.
 * - **the bootstrap token's maximum**: `BootstrapInput`'s `token` is at most
 *   `BOOTSTRAP_TOKEN_LENGTH_MAX` UTF-16 code units, the token file's cap.
 * - **the kept `__proto__` key**: a loose object (an error body) given an own
 *   `__proto__` key, as `JSON.parse` defines one, returns the input with it.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { is, is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import { ClientApiTokenJson } from '#lib/auth/account_schema.ts';
import {
	API_TOKEN_NAME_LENGTH_MAX,
	SessionListInput,
	SessionRevokeAllInput,
	SessionRevokeAllOutput,
	SessionRevokeOutput,
	TokenCreateInput,
	TokenCreateOutput,
	TokenListInput,
	TokenListOutput,
	VerifyInput
} from '#lib/auth/account_action_specs.ts';
import { API_TOKEN_ID_REGEX, ApiTokenId } from '#lib/auth/api_token.ts';
import { TokenScope, TokenScopeInput } from '#lib/auth/token_scope.ts';
import { TOKEN_TTL_DAYS_MAX, TokenLifetimeInput } from '#lib/auth/token_lifetime.ts';
import { PASSWORD_LENGTH_MIN, Password, PasswordProvided } from '#lib/auth/password.ts';
import { UsernameProvided } from '#lib/primitive_schemas.ts';
import {
	AccountStatusInput,
	create_account_route_shapes,
	LoginInput,
	LoginOutput,
	LogoutInput,
	LogoutOutput,
	PasswordChangeInput,
	PasswordChangeOutput
} from '#lib/auth/account_route_schema.ts';
import {
	create_signup_route_shape,
	SignupInput,
	SignupOutput
} from '#lib/auth/signup_route_schema.ts';
import {
	bootstrap_route_shape,
	BOOTSTRAP_TOKEN_LENGTH_MAX,
	BootstrapInput,
	BootstrapOutput
} from '#lib/auth/bootstrap_route_schema.ts';
import {
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INVALID_CREDENTIALS,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_TOKEN,
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_TOKEN_FILE_MISSING,
	REST_AUTHENTICATION_REQUIRED_BOOTSTRAP,
	to_error_schemas,
	type RestErrorDef
} from '#lib/http/error_schemas.ts';
import { to_wire_issues } from '#lib/schema_issues.ts';

const U = '0d6f7c1e-5a3b-4c2d-8e9f-0123456789ab';
const TS = '2026-01-02T03:04:05Z';

const client_token = {
	id: 'tok_abcdefghijkl',
	account_id: U,
	name: 'n',
	expires_at: TS,
	last_used_at: null,
	last_used_ip: null,
	created_at: TS,
	scope: 'full'
};
const created = { ok: true, account: { id: U, username: 'alice' }, actor: { id: U } };
const bootstrap = { token: 't', username: 'Alice', password: 'p'.repeat(PASSWORD_LENGTH_MIN) };

/** The wire issues of a refusal as `[kind, path, expected]`, or `null` for an acceptance. */
const issues_of = (schema: AnySchema, input: unknown): Array<unknown> | null => {
	const result = parse(schema, input);
	return result.ok ? null : to_wire_issues(result.issues).map((i) => [i.kind, i.path, i.expected]);
};

const [verify_shape, login_shape, , password_shape] = create_account_route_shapes({
	login_account_rate_limited: true
});
const signup_shape = create_signup_route_shape({ signup_account_rate_limited: true });

/** A route shape's own errors at a status, the one schema its definitions there group into. */
const declared = (
	shape: { readonly errors?: ReadonlyArray<RestErrorDef> },
	status: number
): AnySchema => {
	const schema = to_error_schemas(shape.errors ?? [])[status];
	if (!schema) throw new Error(`no error declared at ${status}`);
	return schema;
};

const samples: ReadonlyArray<[string, AnySchema, ReadonlyArray<unknown>]> = [
	['VerifyInput', VerifyInput, [undefined]],
	['SessionListInput', SessionListInput, [undefined]],
	['SessionRevokeAllInput', SessionRevokeAllInput, [undefined]],
	['TokenListInput', TokenListInput, [undefined]],
	['SessionRevokeOutput', SessionRevokeOutput, [{ ok: true, revoked: false }]],
	['SessionRevokeAllOutput', SessionRevokeAllOutput, [{ ok: true, count: 0 }]],
	['ClientApiTokenJson', ClientApiTokenJson, [client_token]],
	['TokenListOutput', TokenListOutput, [{ tokens: [] }, { tokens: [client_token] }]],
	[
		'TokenCreateInput',
		TokenCreateInput,
		[
			{ name: 'x', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
			{ scope: { kind: 'methods', methods: ['a'] }, lifetime: { kind: 'ttl', days: 30 } }
		]
	],
	[
		'TokenCreateOutput',
		TokenCreateOutput,
		[{ ok: true, token: 't', id: 'tok_abcdefghijkl', name: 'n', expires_at: null }]
	],
	['ApiTokenId', ApiTokenId, ['tok_abcdefghijkl', 'tok_ab-_EFGHIJKL']],
	[
		'TokenScope',
		TokenScope,
		[
			{ version: 1, kind: 'methods', methods: ['a'] },
			{ version: 1, kind: 'full', grandfathered: true }
		]
	],
	['TokenScopeInput', TokenScopeInput, [{ kind: 'full' }, { kind: 'methods', methods: ['a'] }]],
	[
		'TokenLifetimeInput',
		TokenLifetimeInput,
		[{ kind: 'eternal' }, { kind: 'ttl', days: 1 }, { kind: 'ttl', days: TOKEN_TTL_DAYS_MAX }]
	],
	['Password', Password, ['p'.repeat(PASSWORD_LENGTH_MIN)]],
	['PasswordProvided', PasswordProvided, ['p']],
	['UsernameProvided', UsernameProvided, ['a', ' Admin ', 'user@example.com']],
	['AccountStatusInput', AccountStatusInput, [null]],
	['LogoutInput', LogoutInput, [null]],
	['/verify input', verify_shape.input, [null]],
	['/verify output', verify_shape.output, [null]],
	[
		'REST_AUTHENTICATION_REQUIRED_BOOTSTRAP',
		REST_AUTHENTICATION_REQUIRED_BOOTSTRAP.schema,
		[
			{ error: ERROR_AUTHENTICATION_REQUIRED },
			{ error: ERROR_AUTHENTICATION_REQUIRED, bootstrap_available: true }
		]
	],
	['LoginInput', LoginInput, [{ username: 'Alice', password: 'p' }]],
	['LoginOutput', LoginOutput, [{ ok: true }]],
	['LogoutOutput', LogoutOutput, [{ ok: true, username: 'alice' }]],
	[
		'PasswordChangeInput',
		PasswordChangeInput,
		[{ current_password: 'p', new_password: 'p'.repeat(PASSWORD_LENGTH_MIN) }]
	],
	[
		'PasswordChangeOutput',
		PasswordChangeOutput,
		[{ ok: true, sessions_revoked: 0, tokens_revoked: 0 }]
	],
	[
		'SignupInput',
		SignupInput,
		[
			{ username: 'Alice', password: 'p'.repeat(PASSWORD_LENGTH_MIN), email: 'a@b.co' },
			{ username: 'alice', password: 'p'.repeat(PASSWORD_LENGTH_MIN) }
		]
	],
	['SignupOutput', SignupOutput, [created]],
	['BootstrapInput', BootstrapInput, [bootstrap]],
	['BootstrapOutput', BootstrapOutput, [created]]
];

describe('the account schemas', () => {
	test.each(samples)('%s takes every valid sample', (_name, schema, values) => {
		assert.ok(is_schema(schema));
		for (const value of values) {
			assert.ok(parse(schema, value).ok, JSON.stringify(value));
		}
	});

	test("each route's error schemas take their own errors alone", () => {
		const cases: ReadonlyArray<[AnySchema, string]> = [
			[declared(login_shape, 401), ERROR_INVALID_CREDENTIALS],
			[declared(password_shape, 401), ERROR_INVALID_CREDENTIALS],
			[declared(signup_shape, 403), ERROR_NO_MATCHING_INVITE],
			[declared(signup_shape, 409), ERROR_SIGNUP_CONFLICT],
			[declared(bootstrap_route_shape, 401), ERROR_INVALID_TOKEN],
			[declared(bootstrap_route_shape, 403), ERROR_ALREADY_BOOTSTRAPPED],
			[declared(bootstrap_route_shape, 404), ERROR_TOKEN_FILE_MISSING]
		];
		for (const [schema, error] of cases) {
			assert.ok(parse(schema, { error }).ok, error);
			// a loose object: an unknown key passes through
			const extra = { error, x: 1 };
			const result = parse(schema, extra);
			assert.ok(result.ok, error);
			assert.deepStrictEqual(result.value, extra);
			assert.ok(!parse(schema, { error: ERROR_INVALID_REQUEST_BODY }).ok, error);
			assert.ok(!parse(schema, null).ok, error);
		}
	});
});

describe('the declared tightenings, pinned', () => {
	test('a token row holds an ApiTokenId and Timestamps', () => {
		assert.ok(is(ClientApiTokenJson, client_token));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, id: 'tok_short' }));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, id: 'TOK_abcdefghijkl' }));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, created_at: '2026-01-02 03:04:05' }));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, expires_at: '2026-01-02T03:04Z' }));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, last_used_at: '' }));
		assert.ok(is(ClientApiTokenJson, { ...client_token, expires_at: null, last_used_at: TS }));
		assert.ok(is(ClientApiTokenJson, { ...client_token, created_at: '2026-01-02T03:04:05.123Z' }));
		assert.deepStrictEqual(issues_of(ClientApiTokenJson, { ...client_token, id: 'x' }), [
			['regex', ['id'], String(API_TOKEN_ID_REGEX)]
		]);
		assert.deepStrictEqual(
			issues_of(TokenListOutput, { tokens: [{ ...client_token, created_at: 'x' }] }),
			[['iso_datetime', ['tokens', 0, 'created_at'], 'iso_datetime']]
		);
	});

	test("token_create's expires_at is a Timestamp or null", () => {
		const output = { ok: true, token: 't', id: 'tok_abcdefghijkl', name: 'n', expires_at: TS };
		assert.ok(is(TokenCreateOutput, output));
		assert.ok(is(TokenCreateOutput, { ...output, expires_at: null }));
		assert.ok(!is(TokenCreateOutput, { ...output, expires_at: 'never' }));
		assert.ok(!is(TokenCreateOutput, { ...output, expires_at: '2026-01-02T03:04:05+00:00' }));
		assert.ok(!is(TokenCreateOutput, { ...output, expires_at: '2026-02-30T03:04:05Z' }));
	});

	test('the revoke counts are non-negative integers', () => {
		assert.ok(is(SessionRevokeAllOutput, { ok: true, count: 0 }));
		assert.ok(is(SessionRevokeAllOutput, { ok: true, count: 2 ** 53 - 1 }));
		assert.ok(!is(SessionRevokeAllOutput, { ok: true, count: -1 }));
		assert.ok(!is(SessionRevokeAllOutput, { ok: true, count: 0.5 }));
		const change = { ok: true, sessions_revoked: 2, tokens_revoked: 0 };
		assert.ok(is(PasswordChangeOutput, change));
		assert.ok(!is(PasswordChangeOutput, { ...change, sessions_revoked: -1 }));
		assert.ok(!is(PasswordChangeOutput, { ...change, tokens_revoked: 1.5 }));
	});

	test('the output usernames are canonical', () => {
		assert.ok(is(LogoutOutput, { ok: true, username: 'alice' }));
		assert.ok(!is(LogoutOutput, { ok: true, username: 'Alice' }));
		assert.ok(!is(LogoutOutput, { ok: true, username: 'al' }));
		assert.ok(!is(LogoutOutput, { ok: true, username: 'alice_' }));
		for (const Output of [SignupOutput, BootstrapOutput]) {
			assert.ok(is(Output, created));
			assert.ok(is(Output, { ...created, account: { id: U, username: 'a'.repeat(39) } }));
			assert.ok(!is(Output, { ...created, account: { id: U, username: 'Alice' } }));
			assert.ok(!is(Output, { ...created, account: { id: U, username: 'a'.repeat(40) } }));
		}
	});

	test('the bootstrap token is at most BOOTSTRAP_TOKEN_LENGTH_MAX code units', () => {
		const at_max = 'x'.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX);
		const astral_at_max = '\u{1F600}'.repeat(BOOTSTRAP_TOKEN_LENGTH_MAX / 2);
		assert.ok(is(BootstrapInput, { ...bootstrap, token: at_max }));
		assert.ok(is(BootstrapInput, { ...bootstrap, token: astral_at_max }));
		for (const token of [`${at_max}x`, `${astral_at_max}a`]) {
			assert.deepStrictEqual(issues_of(BootstrapInput, { ...bootstrap, token }), [
				['max_length', ['token'], `length <= ${BOOTSTRAP_TOKEN_LENGTH_MAX}`]
			]);
		}
	});

	test('a loose error body keeps an own __proto__ key', () => {
		for (const json of [
			`{"__proto__":{"x":1},"error":"${ERROR_AUTHENTICATION_REQUIRED}"}`,
			`{"__proto__":null,"error":"${ERROR_AUTHENTICATION_REQUIRED}","bootstrap_available":true}`
		]) {
			const input: unknown = JSON.parse(json);
			const result = parse(REST_AUTHENTICATION_REQUIRED_BOOTSTRAP.schema, input);
			assert.ok(result.ok, json);
			assert.strictEqual(result.value, input);
			assert.ok(Object.hasOwn(result.value, '__proto__'), json);
		}
		const body: unknown = JSON.parse(`{"__proto__":{"x":1},"error":"${ERROR_INVALID_TOKEN}"}`);
		const result = parse(declared(bootstrap_route_shape, 401), body);
		assert.ok(result.ok);
		assert.strictEqual(result.value, body);
	});

	test('the API token name is bounded in code units', () => {
		const at_max = 'a'.repeat(API_TOKEN_NAME_LENGTH_MAX);
		const base = { scope: { kind: 'full' }, lifetime: { kind: 'eternal' } };
		assert.ok(is(TokenCreateInput, { ...base, name: at_max }));
		assert.ok(!is(TokenCreateInput, { ...base, name: `${at_max}a` }));
	});

	test('a stored scope parses to the document itself, in its stored order', () => {
		// fuz_schema returns the input it changed nothing of: the parsed
		// document is what `JSON.parse` read, not a copy in schema order
		const stored: unknown = { methods: ['a'], kind: 'methods', version: 1 };
		const result = parse(TokenScope, stored);
		assert.ok(result.ok);
		assert.strictEqual<unknown>(result.value, stored);
		assert.deepStrictEqual(Object.keys(result.value), ['methods', 'kind', 'version']);
	});
});
