/**
 * The account domain's schemas — the self-service action inputs and outputs,
 * `ClientApiTokenJson`, `ApiTokenId`, `TokenScope`, `TokenScopeInput`,
 * `TokenLifetimeInput`, the passwords, `UsernameProvided`, and the schemas of
 * the account, signup and bootstrap routes — `@fuzdev/fuz_schema` schemas,
 * held to the Zod schemas they replaced, rebuilt here. On corpora of single
 * changes to a valid value, each pair gives the same verdict and output, but
 * for the declared differences, each recognized where it is allowed and
 * counted:
 *
 * - **the strict timestamp**: a `ClientApiTokenJson` timestamp and
 *   `TokenCreateOutput`'s `expires_at` are `Timestamp`, fuz_schema's
 *   `iso_datetime` (Zod: any string), so one that is no date and time of RFC
 *   3339 in UTC fails. Both spines write `YYYY-MM-DDTHH:MM:SSZ`.
 * - **the token id**: a `ClientApiTokenJson`'s `id` is an `ApiTokenId` (Zod:
 *   any string). Both spines mint every id as `tok_` and twelve base64url
 *   characters.
 * - **the count**: `SessionRevokeAllOutput`'s `count` and
 *   `PasswordChangeOutput`'s `sessions_revoked` and `tokens_revoked` are
 *   non-negative integers (Zod: any number).
 * - **the canonical username**: the output `username` of logout, signup and
 *   bootstrap is `UsernameCanonical` (Zod: any string on logout, the creation
 *   `Username`, which lowercased, on signup and bootstrap), so a username off
 *   the lowercase grammar or its bounds fails.
 * - **the kept `__proto__` key**: a loose object (an error body,
 *   `AccountStatusUnauthenticatedError`) given an own `__proto__` key, as
 *   `JSON.parse` defines one, returns the input with it, where Zod's copy
 *   dropped it. Both take the value; only the server writes these bodies.
 *
 * Outputs are compared as values: a fuz_schema object returns its input when
 * no entry changed it, in the input's key order, where Zod built a new object
 * in schema order.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is, parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	bounded_string as zod_bounded_string,
	Email as ZodEmail,
	Username as ZodUsername,
	USERNAME_PROVIDED_LENGTH_MAX,
	Uuid as ZodUuid
} from '#lib/primitive_schemas.ts';
import { Timestamp, UsernameCanonical, UsernameProvided } from '#lib/primitive_schemas_fuz.ts';
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
import { TOKEN_SCOPE_VERSION, TokenScope, TokenScopeInput } from '#lib/auth/token_scope.ts';
import { TOKEN_TTL_DAYS_MAX, TokenLifetimeInput } from '#lib/auth/token_lifetime.ts';
import {
	PASSWORD_LENGTH_MAX,
	PASSWORD_LENGTH_MIN,
	Password,
	PasswordProvided
} from '#lib/auth/password.ts';
import {
	AccountStatusInput,
	AccountStatusUnauthenticatedError,
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
	BootstrapInput,
	BootstrapOutput
} from '#lib/auth/bootstrap_route_schema.ts';
import {
	ERROR_ALREADY_BOOTSTRAPPED,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INVALID_CREDENTIALS,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_TOKEN,
	ERROR_NO_MATCHING_INVITE,
	ERROR_SIGNUP_CONFLICT,
	ERROR_TOKEN_FILE_MISSING
} from '#lib/http/error_schemas.ts';
import { parse_any, type ValidationSchema } from '#lib/schema_issues.ts';

// -- the Zod schemas the port replaced --------------------------------------

const ZodApiTokenId = z.string().regex(API_TOKEN_ID_REGEX);
const ZodClientApiTokenJson = z.strictObject({
	id: z.string(),
	account_id: ZodUuid,
	name: z.string(),
	expires_at: z.string().nullable(),
	last_used_at: z.string().nullable(),
	last_used_ip: z.string().nullable(),
	created_at: z.string(),
	scope: z.string()
});
const ZodTokenScope = z.discriminatedUnion('kind', [
	z.strictObject({
		version: z.literal(TOKEN_SCOPE_VERSION),
		kind: z.literal('full'),
		grandfathered: z.boolean().optional()
	}),
	z.strictObject({
		version: z.literal(TOKEN_SCOPE_VERSION),
		kind: z.literal('methods'),
		methods: z.array(z.string()),
		grandfathered: z.boolean().optional()
	})
]);
const ZodTokenScopeInput = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('full') }),
	z.strictObject({ kind: z.literal('methods'), methods: z.array(z.string()) })
]);
const ZodTokenLifetimeInput = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('eternal') }),
	z.strictObject({
		kind: z.literal('ttl'),
		days: z.number().int().min(1).max(TOKEN_TTL_DAYS_MAX)
	})
]);
const ZodTokenCreateInput = z.strictObject({
	name: zod_bounded_string({ max: API_TOKEN_NAME_LENGTH_MAX }).default('CLI token'),
	scope: ZodTokenScopeInput,
	lifetime: ZodTokenLifetimeInput
});
const ZodTokenCreateOutput = z.strictObject({
	ok: z.literal(true),
	token: z.string(),
	id: ZodApiTokenId,
	name: z.string(),
	expires_at: z.string().nullable()
});
const ZodTokenListOutput = z.strictObject({ tokens: z.array(ZodClientApiTokenJson) });
const ZodSessionRevokeOutput = z.strictObject({ ok: z.literal(true), revoked: z.boolean() });
const ZodSessionRevokeAllOutput = z.strictObject({ ok: z.literal(true), count: z.number() });
const ZodPassword = zod_bounded_string({ min: PASSWORD_LENGTH_MIN, max: PASSWORD_LENGTH_MAX });
const ZodPasswordProvided = zod_bounded_string({ min: 1, max: PASSWORD_LENGTH_MAX });
const ZodUsernameProvided = zod_bounded_string({ min: 1, max: USERNAME_PROVIDED_LENGTH_MAX })
	.transform((s) => s.trim().toLowerCase())
	.refine((s) => s.length > 0, { message: 'Username must not be empty after trimming whitespace' });
const ZodLoginInput = z.strictObject({
	username: ZodUsernameProvided,
	password: ZodPasswordProvided
});
const ZodLogoutOutput = z.strictObject({ ok: z.literal(true), username: z.string() });
const ZodPasswordChangeInput = z.strictObject({
	current_password: ZodPasswordProvided,
	new_password: ZodPassword
});
const ZodPasswordChangeOutput = z.strictObject({
	ok: z.literal(true),
	sessions_revoked: z.number(),
	tokens_revoked: z.number()
});
const ZodAccountStatusUnauthenticatedError = z.looseObject({
	error: z.literal(ERROR_AUTHENTICATION_REQUIRED),
	bootstrap_available: z.boolean().optional()
});
const ZodSignupInput = z.strictObject({
	username: ZodUsername,
	password: ZodPassword,
	email: ZodEmail.nullish()
});
const ZodCreatedOutput = z.strictObject({
	ok: z.literal(true),
	account: z.strictObject({ id: ZodUuid, username: ZodUsername }),
	actor: z.strictObject({ id: ZodUuid })
});
const ZodBootstrapInput = z.strictObject({
	token: z.string().min(1),
	username: ZodUsername,
	password: ZodPassword
});
const zod_error = (error: string) => z.looseObject({ error: z.literal(error) });
const ZodBodyError = z.looseObject({
	error: z.enum([ERROR_INVALID_JSON_BODY, ERROR_INVALID_REQUEST_BODY])
});

// -- the corpora ------------------------------------------------------------

const U = '0d6f7c1e-5a3b-4c2d-8e9f-0123456789ab';
const TS = '2026-01-02T03:04:05Z';
const WRONG: ReadonlyArray<unknown> = [null, undefined, 0, -1, 1.5, '', 'x', true, [], {}, NaN];
const TIMESTAMPS: ReadonlyArray<unknown> = [
	TS,
	'2026-01-02T03:04:05.123Z',
	'2026-01-02T03:04Z',
	'2026-01-02 03:04:05',
	'2026-01-02T03:04:05+00:00',
	'2026-02-30T03:04:05Z'
];
const TOKEN_IDS: ReadonlyArray<unknown> = [
	'tok_abcdefghijkl',
	'tok_ab-_EFGHIJKL',
	'tok_abcdefghijk',
	'TOK_abcdefghijkl',
	'tok_abcdefghijkl\n'
];
const COUNTS: ReadonlyArray<unknown> = [0, 1, 2 ** 53, -1, 1.5, -0, Infinity, '1'];
const USERNAMES_OUT: ReadonlyArray<unknown> = [
	'alice',
	'Alice',
	'al',
	'a'.repeat(39),
	'a'.repeat(40),
	'alice_',
	'1alice',
	'al ice'
];
const WHITESPACE = [' ', '\t', '\n', '\u000b', ' ', '\u0085', '᠎', ' ', '　', '﻿'];
const USERNAMES_PROVIDED: ReadonlyArray<unknown> = [
	'',
	'a',
	' Admin ',
	'user@example.com',
	'İ',
	'\ud800',
	'a'.repeat(USERNAME_PROVIDED_LENGTH_MAX),
	'a'.repeat(USERNAME_PROVIDED_LENGTH_MAX + 1),
	' '.repeat(USERNAME_PROVIDED_LENGTH_MAX + 1),
	...WHITESPACE.flatMap((w) => [w, `${w}${w}`, `${w}A${w}`])
];

/** A valid value and its single changes: each key dropped or retyped, an unknown key, `__proto__` keys. */
const around = (
	base: Record<string, unknown>,
	extra: ReadonlyArray<unknown> = []
): Array<unknown> => {
	const json = JSON.stringify(base);
	const out: Array<unknown> = [
		base,
		{ ...base, extra_key: 1 },
		null,
		undefined,
		[],
		'x',
		Object.fromEntries(Object.entries(base).reverse()),
		JSON.parse(json.replace(/^\{/, '{"__proto__":{"x":1},')),
		JSON.parse(json.replace(/^\{/, '{"__proto__":null,'))
	];
	for (const key of Object.keys(base)) {
		const { [key]: _, ...rest } = base;
		out.push(rest);
		for (const w of WRONG) out.push({ ...base, [key]: w });
	}
	return [...out, ...extra];
};
const with_each = (base: Record<string, unknown>, key: string, values: ReadonlyArray<unknown>) =>
	values.map((value) => ({ ...base, [key]: value }));

const VOIDS: ReadonlyArray<unknown> = [undefined, null, {}, [], 0, '', false];
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
const scope_inputs: ReadonlyArray<unknown> = [
	{ kind: 'full' },
	{ kind: 'methods', methods: [] },
	{ kind: 'full', methods: [] },
	{ kind: 'full', version: 1 },
	{ kind: 'full', grandfathered: true },
	{ kind: 'methods', methods: [1] },
	{ kind: 'methods', methods: ['a', 'a'] },
	{ kind: 'methods' },
	{ methods: ['x'], kind: 'methods' },
	{ kind: 'toString' },
	{ kind: '__proto__' },
	{ kind: 'hasOwnProperty' },
	{ kind: null },
	{ kind: 1 },
	{},
	JSON.parse('{"kind":"full","__proto__":{"methods":[]}}')
];
const stored_scopes: ReadonlyArray<unknown> = [
	{ version: 1, kind: 'full' },
	{ version: 1, kind: 'full', grandfathered: true },
	{ version: 1, kind: 'full', grandfathered: null },
	{ version: 1, kind: 'full', grandfathered: 'x' },
	{ version: 1, kind: 'full', methods: [] },
	{ version: 1, kind: 'methods', methods: [], grandfathered: false },
	{ version: 1, kind: 'methods', methods: [1] },
	{ version: 1, kind: 'methods' },
	{ version: 2, kind: 'full' },
	{ version: '1', kind: 'full' },
	{ kind: 'full', version: 1 },
	{ methods: ['x'], kind: 'methods', version: 1 },
	{ version: 1, kind: 'constructor' },
	{ version: 1 },
	JSON.parse('{"version":1,"kind":"full","__proto__":{"kind":"methods"}}')
];
const lifetimes: ReadonlyArray<unknown> = [
	{ kind: 'eternal' },
	{ kind: 'ttl', days: 0 },
	{ kind: 'ttl', days: 1 },
	{ kind: 'ttl', days: 30.0 },
	{ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX },
	{ kind: 'ttl', days: TOKEN_TTL_DAYS_MAX + 1 },
	{ kind: 'ttl', days: 1.5 },
	{ kind: 'ttl', days: '1' },
	{ kind: 'ttl', days: Infinity },
	{ kind: 'ttl' },
	{ kind: 'eternal', days: 1 },
	{ days: 1, kind: 'ttl' },
	{ kind: 'TTL', days: 1 }
];
const token_create = { name: 'x', scope: { kind: 'full' }, lifetime: { kind: 'eternal' } };
const passwords = (min: number): Array<unknown> => [
	'',
	'p'.repeat(min - 1 || 1),
	'p'.repeat(min),
	'p'.repeat(PASSWORD_LENGTH_MAX),
	'p'.repeat(PASSWORD_LENGTH_MAX + 1),
	'\u{1F600}'.repeat(PASSWORD_LENGTH_MAX / 2),
	'\u{1F600}'.repeat(PASSWORD_LENGTH_MAX / 2) + 'a',
	'\u{1F600}'.repeat(min / 2 || 1),
	' '.repeat(min),
	null,
	1
];
const login = { username: 'Alice', password: 'p' };
const signup = { username: 'Alice', password: 'p'.repeat(PASSWORD_LENGTH_MIN), email: 'a@b.co' };
const bootstrap = { token: 't', username: 'Alice', password: 'p'.repeat(PASSWORD_LENGTH_MIN) };
const created = { ok: true, account: { id: U, username: 'alice' }, actor: { id: U } };
const created_extra = [
	...USERNAMES_OUT.map((username) => ({ ...created, account: { id: U, username } })),
	{ ...created, account: { ...created.account, x: 1 } },
	{ ...created, actor: { id: U, x: 1 } }
];

// -- the declared differences -----------------------------------------------

type Difference =
	'strict timestamp' | 'token id' | 'count' | 'canonical username' | 'kept __proto__ key';

/** The declared difference a value refused by fuz_schema and taken by Zod falls under, if any. */
type Recognizer = (value: any) => Difference | null;

const is_record = (value: unknown): value is Record<string, any> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const strict_timestamps =
	(keys: ReadonlyArray<string>): Recognizer =>
	(value) =>
		is_record(value) && keys.some((k) => typeof value[k] === 'string' && !is(Timestamp, value[k]))
			? 'strict timestamp'
			: null;

const client_token_recognizer: Recognizer = (value) =>
	strict_timestamps(['expires_at', 'last_used_at', 'created_at'])(value) ??
	(is_record(value) && typeof value.id === 'string' && !is(ApiTokenId, value.id)
		? 'token id'
		: null);

const counts =
	(keys: ReadonlyArray<string>): Recognizer =>
	(value) =>
		is_record(value) &&
		keys.some(
			(k) =>
				typeof value[k] === 'number' &&
				Number.isFinite(value[k]) &&
				!(Number.isInteger(value[k]) && value[k] >= 0)
		)
			? 'count'
			: null;

const canonical_username =
	(at: (value: Record<string, any>) => unknown): Recognizer =>
	(value) => {
		if (!is_record(value)) return null;
		const username = at(value);
		return typeof username === 'string' && !is(UsernameCanonical, username)
			? 'canonical username'
			: null;
	};
const account_username = canonical_username((v) =>
	is_record(v.account) ? v.account.username : undefined
);

interface Pair {
	name: string;
	fuz: ValidationSchema;
	zod: ValidationSchema;
	values: ReadonlyArray<unknown>;
	recognize?: Recognizer;
	/** Whether the fuz_schema side is a `loose_object`, which keeps an own `__proto__` key. */
	loose?: boolean;
}

/** `value` without its own `__proto__` key, if it has one, and whether it had. */
const without_proto_key = (value: unknown): [unknown, boolean] => {
	if (!is_record(value) || !Object.hasOwn(value, '__proto__')) return [value, false];
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) if (key !== '__proto__') out[key] = value[key];
	return [out, true];
};

const [verify_shape, login_shape, , password_shape] = create_account_route_shapes({
	login_account_rate_limited: true
});
const signup_shape = create_signup_route_shape({ signup_account_rate_limited: true });

const pairs: ReadonlyArray<Pair> = [
	{ name: 'VerifyInput', fuz: VerifyInput, zod: z.void(), values: VOIDS },
	{ name: 'SessionListInput', fuz: SessionListInput, zod: z.void(), values: VOIDS },
	{ name: 'SessionRevokeAllInput', fuz: SessionRevokeAllInput, zod: z.void(), values: VOIDS },
	{ name: 'TokenListInput', fuz: TokenListInput, zod: z.void(), values: VOIDS },
	{
		name: 'SessionRevokeOutput',
		fuz: SessionRevokeOutput,
		zod: ZodSessionRevokeOutput,
		values: around({ ok: true, revoked: false })
	},
	{
		name: 'SessionRevokeAllOutput',
		fuz: SessionRevokeAllOutput,
		zod: ZodSessionRevokeAllOutput,
		values: around({ ok: true, count: 0 }, with_each({ ok: true, count: 0 }, 'count', COUNTS)),
		recognize: counts(['count'])
	},
	{
		name: 'ClientApiTokenJson',
		fuz: ClientApiTokenJson,
		zod: ZodClientApiTokenJson,
		values: around(client_token, [
			...with_each(client_token, 'id', TOKEN_IDS),
			...['expires_at', 'last_used_at', 'created_at'].flatMap((k) =>
				with_each(client_token, k, TIMESTAMPS)
			)
		]),
		recognize: client_token_recognizer
	},
	{
		name: 'TokenListOutput',
		fuz: TokenListOutput,
		zod: ZodTokenListOutput,
		values: around({ tokens: [client_token] }, [
			{ tokens: [] },
			{ tokens: [{ ...client_token, id: 'x' }] },
			{ tokens: [{ ...client_token, created_at: 'x' }] }
		]),
		recognize: (value) =>
			is_record(value) && Array.isArray(value.tokens)
				? (value.tokens.map(client_token_recognizer).find((d: unknown) => d !== null) ?? null)
				: null
	},
	{
		name: 'TokenCreateInput',
		fuz: TokenCreateInput,
		zod: ZodTokenCreateInput,
		values: around(token_create, [
			{ scope: { kind: 'full' }, lifetime: { kind: 'eternal' } },
			...with_each(token_create, 'name', [
				'a'.repeat(API_TOKEN_NAME_LENGTH_MAX),
				'a'.repeat(API_TOKEN_NAME_LENGTH_MAX + 1),
				'\u{1F600}'.repeat((API_TOKEN_NAME_LENGTH_MAX - 1) / 2) + 'a',
				'\u{1F600}'.repeat((API_TOKEN_NAME_LENGTH_MAX + 1) / 2)
			]),
			...with_each(token_create, 'scope', scope_inputs),
			...with_each(token_create, 'lifetime', lifetimes)
		])
	},
	{
		name: 'TokenCreateOutput',
		fuz: TokenCreateOutput,
		zod: ZodTokenCreateOutput,
		values: around({ ok: true, token: 't', id: 'tok_abcdefghijkl', name: 'n', expires_at: null }, [
			...with_each(
				{ ok: true, token: 't', id: 'tok_abcdefghijkl', name: 'n', expires_at: null },
				'expires_at',
				TIMESTAMPS
			),
			...with_each(
				{ ok: true, token: 't', id: 'tok_abcdefghijkl', name: 'n', expires_at: null },
				'id',
				TOKEN_IDS
			)
		]),
		recognize: strict_timestamps(['expires_at'])
	},
	{ name: 'ApiTokenId', fuz: ApiTokenId, zod: ZodApiTokenId, values: [...TOKEN_IDS, '', 1, null] },
	{
		name: 'TokenScope',
		fuz: TokenScope,
		zod: ZodTokenScope,
		values: around({ version: 1, kind: 'methods', methods: ['a'] }, stored_scopes)
	},
	{
		name: 'TokenScopeInput',
		fuz: TokenScopeInput,
		zod: ZodTokenScopeInput,
		values: around({ kind: 'methods', methods: ['a'] }, scope_inputs)
	},
	{
		name: 'TokenLifetimeInput',
		fuz: TokenLifetimeInput,
		zod: ZodTokenLifetimeInput,
		values: around({ kind: 'ttl', days: 30 }, lifetimes)
	},
	{
		name: 'Password',
		fuz: Password,
		zod: ZodPassword,
		values: passwords(PASSWORD_LENGTH_MIN)
	},
	{
		name: 'PasswordProvided',
		fuz: PasswordProvided,
		zod: ZodPasswordProvided,
		values: passwords(1)
	},
	{
		name: 'UsernameProvided',
		fuz: UsernameProvided,
		zod: ZodUsernameProvided,
		values: [...USERNAMES_PROVIDED, null, 1, []]
	},
	{ name: 'AccountStatusInput', fuz: AccountStatusInput, zod: z.null(), values: VOIDS },
	{ name: 'LogoutInput', fuz: LogoutInput, zod: z.null(), values: VOIDS },
	{ name: '/verify input', fuz: verify_shape.input, zod: z.null(), values: VOIDS },
	{ name: '/verify output', fuz: verify_shape.output, zod: z.null(), values: VOIDS },
	{
		name: 'AccountStatusUnauthenticatedError',
		fuz: AccountStatusUnauthenticatedError,
		zod: ZodAccountStatusUnauthenticatedError,
		loose: true,
		values: around({ error: ERROR_AUTHENTICATION_REQUIRED, bootstrap_available: true }, [
			{ error: ERROR_AUTHENTICATION_REQUIRED }
		])
	},
	{
		name: 'LoginInput',
		fuz: LoginInput,
		zod: ZodLoginInput,
		values: around(login, with_each(login, 'username', USERNAMES_PROVIDED))
	},
	{
		name: 'LoginOutput',
		fuz: LoginOutput,
		zod: z.strictObject({ ok: z.literal(true) }),
		values: around({ ok: true })
	},
	{
		name: 'LogoutOutput',
		fuz: LogoutOutput,
		zod: ZodLogoutOutput,
		values: around(
			{ ok: true, username: 'alice' },
			with_each({ ok: true, username: 'alice' }, 'username', USERNAMES_OUT)
		),
		recognize: canonical_username((v) => v.username)
	},
	{
		name: 'PasswordChangeInput',
		fuz: PasswordChangeInput,
		zod: ZodPasswordChangeInput,
		values: around({ current_password: 'p', new_password: 'p'.repeat(PASSWORD_LENGTH_MIN) })
	},
	{
		name: 'PasswordChangeOutput',
		fuz: PasswordChangeOutput,
		zod: ZodPasswordChangeOutput,
		values: around({ ok: true, sessions_revoked: 0, tokens_revoked: 0 }, [
			...with_each(
				{ ok: true, sessions_revoked: 0, tokens_revoked: 0 },
				'sessions_revoked',
				COUNTS
			),
			...with_each({ ok: true, sessions_revoked: 0, tokens_revoked: 0 }, 'tokens_revoked', COUNTS)
		]),
		recognize: counts(['sessions_revoked', 'tokens_revoked'])
	},
	{
		name: 'SignupInput',
		fuz: SignupInput,
		zod: ZodSignupInput,
		values: around(signup, [
			{ username: 'Alice', password: signup.password },
			...with_each(signup, 'email', [null, undefined, 'bad', 'a@.b.c', `${'é'.repeat(125)}@b.co`]),
			...with_each(signup, 'username', [
				'alice',
				' alice',
				'al',
				'a'.repeat(40),
				'1abc',
				'K'.repeat(39)
			])
		])
	},
	{
		name: 'SignupOutput',
		fuz: SignupOutput,
		zod: ZodCreatedOutput,
		values: around(created, created_extra),
		recognize: account_username
	},
	{
		name: 'BootstrapInput',
		fuz: BootstrapInput,
		zod: ZodBootstrapInput,
		values: around(bootstrap, with_each(bootstrap, 'token', [' ', 'x'.repeat(5000)]))
	},
	{
		name: 'BootstrapOutput',
		fuz: BootstrapOutput,
		zod: ZodCreatedOutput,
		values: around(created, created_extra),
		recognize: account_username
	},
	...(
		[
			['/login 400', login_shape.errors![400]!, ZodBodyError],
			['/login 401', login_shape.errors![401]!, zod_error(ERROR_INVALID_CREDENTIALS)],
			['/password 400', password_shape.errors![400]!, ZodBodyError],
			['/signup 400', signup_shape.errors![400]!, ZodBodyError],
			['/signup 403', signup_shape.errors![403]!, zod_error(ERROR_NO_MATCHING_INVITE)],
			['/signup 409', signup_shape.errors![409]!, zod_error(ERROR_SIGNUP_CONFLICT)],
			['/bootstrap 400', bootstrap_route_shape.errors[400], ZodBodyError],
			['/bootstrap 401', bootstrap_route_shape.errors[401], zod_error(ERROR_INVALID_TOKEN)],
			['/bootstrap 403', bootstrap_route_shape.errors[403], zod_error(ERROR_ALREADY_BOOTSTRAPPED)],
			['/bootstrap 404', bootstrap_route_shape.errors[404], zod_error(ERROR_TOKEN_FILE_MISSING)]
		] as const
	).map(([name, fuz, zod]): Pair => ({
		name,
		fuz,
		zod,
		loose: true,
		values: [
			...around({ error: ERROR_INVALID_REQUEST_BODY }),
			...[
				ERROR_INVALID_JSON_BODY,
				ERROR_INVALID_CREDENTIALS,
				ERROR_NO_MATCHING_INVITE,
				ERROR_SIGNUP_CONFLICT,
				ERROR_INVALID_TOKEN,
				ERROR_ALREADY_BOOTSTRAPPED,
				ERROR_TOKEN_FILE_MISSING
			].flatMap((error) => [{ error }, { error, x: 1 }])
		]
	}))
];

describe('the account schemas agree with the Zod ones', () => {
	const seen = new Map<Difference, number>();

	test.each(pairs.map((p) => [p.name, p] as const))('%s', (_name, pair) => {
		for (const value of pair.values) {
			const label = `${pair.name} ${JSON.stringify(value)?.slice(0, 120)}`;
			const fuz = parse_any(pair.fuz, value);
			const zod = parse_any(pair.zod, value);
			if (fuz.ok !== zod.ok) {
				const difference = zod.ok ? (pair.recognize?.(value) ?? null) : null;
				assert.ok(difference, `undeclared verdict difference: ${label}`);
				seen.set(difference, (seen.get(difference) ?? 0) + 1);
				continue;
			}
			if (!fuz.ok || !zod.ok) continue;
			const [fuz_value, had_proto_key] = pair.loose
				? without_proto_key(fuz.value)
				: [fuz.value, false];
			if (had_proto_key) seen.set('kept __proto__ key', (seen.get('kept __proto__ key') ?? 0) + 1);
			assert.deepStrictEqual(fuz_value, zod.value, label);
		}
	});

	test('every declared difference is reached', () => {
		assert.sameMembers(
			[...seen.keys()],
			['strict timestamp', 'token id', 'count', 'canonical username', 'kept __proto__ key']
		);
	});
});

describe('the declared tightenings, pinned', () => {
	test('a token row holds an ApiTokenId and Timestamps', () => {
		assert.ok(is(ClientApiTokenJson, client_token));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, id: 'tok_short' }));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, created_at: '2026-01-02 03:04:05' }));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, expires_at: '2026-01-02T03:04Z' }));
		assert.ok(!is(ClientApiTokenJson, { ...client_token, last_used_at: '' }));
		assert.ok(is(ClientApiTokenJson, { ...client_token, expires_at: null, last_used_at: TS }));
	});

	test("token_create's expires_at is a Timestamp or null", () => {
		const output = { ok: true, token: 't', id: 'tok_abcdefghijkl', name: 'n', expires_at: TS };
		assert.ok(is(TokenCreateOutput, output));
		assert.ok(is(TokenCreateOutput, { ...output, expires_at: null }));
		assert.ok(!is(TokenCreateOutput, { ...output, expires_at: 'never' }));
	});

	test('the revoke counts are non-negative integers', () => {
		assert.ok(is(SessionRevokeAllOutput, { ok: true, count: 0 }));
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
		for (const Output of [SignupOutput, BootstrapOutput]) {
			assert.ok(is(Output, created));
			assert.ok(!is(Output, { ...created, account: { id: U, username: 'Alice' } }));
		}
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
