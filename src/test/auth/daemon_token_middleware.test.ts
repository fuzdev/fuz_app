/**
 * Tests for daemon token — generation, validation, Zod schema, and middleware.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach} from 'vitest';
import {Hono} from 'hono';

import {
	generate_daemon_token,
	validate_daemon_token,
	DaemonToken,
	DAEMON_TOKEN_HEADER,
	type DaemonTokenState,
} from '$lib/auth/daemon_token.js';
import {
	create_daemon_token_middleware,
	resolve_keeper_account_id,
} from '$lib/auth/daemon_token_middleware.js';
import {ACCOUNT_ID_KEY, AUTH_API_TOKEN_ID_KEY, CREDENTIAL_TYPE_KEY} from '$lib/hono_context.js';
import {
	ERROR_INVALID_DAEMON_TOKEN,
	ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED,
} from '$lib/http/error_schemas.js';
import {ROLE_KEEPER} from '$lib/auth/role_schema.js';
import type {QueryDeps} from '$lib/db/query_deps.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import {
	create_test_account,
	create_test_actor,
	create_test_role_grant,
} from '$lib/testing/entities.js';

// Mock module-level query functions used by daemon_token_middleware
const {
	mock_query_account_by_id,
	mock_query_actor_by_id,
	mock_query_actors_by_account,
	mock_query_role_grant_find_active_for_actor,
	mock_query_role_grant_find_account_id_for_role,
} = vi.hoisted(() => ({
	mock_query_account_by_id: vi.fn(),
	mock_query_actor_by_id: vi.fn(),
	mock_query_actors_by_account: vi.fn(),
	mock_query_role_grant_find_active_for_actor: vi.fn(),
	mock_query_role_grant_find_account_id_for_role: vi.fn(),
}));

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: mock_query_account_by_id,
	query_actor_by_id: mock_query_actor_by_id,
	query_actors_by_account: mock_query_actors_by_account,
}));

vi.mock('$lib/auth/role_grant_queries.js', () => ({
	query_role_grant_find_active_for_actor: mock_query_role_grant_find_active_for_actor,
	query_role_grant_find_account_id_for_role: mock_query_role_grant_find_account_id_for_role,
}));

const create_state = (overrides: Partial<DaemonTokenState> = {}): DaemonTokenState => ({
	current_token: generate_daemon_token(),
	previous_token: null,
	rotated_at: new Date(),
	keeper_account_id: 'acct-keeper',
	...overrides,
});

const mock_deps = {db: {}} as unknown as QueryDeps;

const setup_default_mocks = () => {
	const account = create_test_account({id: 'acct-keeper' as Uuid, username: 'keeper'});
	const actor = create_test_actor({
		id: 'actor-keeper' as Uuid,
		account_id: 'acct-keeper' as Uuid,
		name: 'keeper',
	});
	const role_grants = [
		create_test_role_grant({
			id: 'role_grant-keeper' as Uuid,
			actor_id: 'actor-keeper' as Uuid,
			role: 'keeper',
		}),
	];
	mock_query_account_by_id.mockImplementation(async () => account);
	mock_query_actor_by_id.mockImplementation(async () => actor);
	mock_query_actors_by_account.mockImplementation(async () => [actor]);
	mock_query_role_grant_find_active_for_actor.mockImplementation(async () => role_grants);
};

beforeEach(() => {
	mock_query_account_by_id.mockReset();
	mock_query_actor_by_id.mockReset();
	mock_query_actors_by_account.mockReset();
	mock_query_role_grant_find_active_for_actor.mockReset();
	mock_query_role_grant_find_account_id_for_role.mockReset();
	setup_default_mocks();
});

/** Create a Hono test app with daemon token middleware. */
const create_daemon_app = (state: DaemonTokenState): Hono => {
	const app = new Hono();
	app.use('/*', create_daemon_token_middleware(state, mock_deps));
	app.get('/test', (c) => {
		const account_id = c.get(ACCOUNT_ID_KEY);
		const credential_type = c.get(CREDENTIAL_TYPE_KEY);
		const api_token_id = c.get(AUTH_API_TOKEN_ID_KEY);
		return c.json({
			context: account_id ? {account_id, actor_id: null} : null,
			credential_type: credential_type ?? null,
			api_token_id: api_token_id ?? null,
		});
	});
	return app;
};

describe('generate_daemon_token', () => {
	test('produces a 43-character base64url string', () => {
		const token = generate_daemon_token();
		assert.strictEqual(token.length, 43);
		assert.match(token, /^[A-Za-z0-9_-]{43}$/);
	});

	test('produces unique tokens', () => {
		const tokens = new Set(Array.from({length: 10}, () => generate_daemon_token()));
		assert.strictEqual(tokens.size, 10);
	});
});

describe('DaemonToken Zod schema', () => {
	test('accepts valid tokens', () => {
		const token = generate_daemon_token();
		assert.ok(DaemonToken.safeParse(token).success);
	});

	test('rejects empty string', () => {
		assert.ok(!DaemonToken.safeParse('').success);
	});

	test('rejects too-short string', () => {
		assert.ok(!DaemonToken.safeParse('abc').success);
	});

	test('rejects string with invalid characters', () => {
		assert.ok(!DaemonToken.safeParse('a'.repeat(42) + '!').success);
	});

	test('rejects string with spaces', () => {
		assert.ok(!DaemonToken.safeParse('a'.repeat(42) + ' ').success);
	});
});

describe('resolve_keeper_account_id', () => {
	test('delegates to query_role_grant_find_account_id_for_role with ROLE_KEEPER', async () => {
		mock_query_role_grant_find_account_id_for_role.mockImplementation(
			async (_deps: any, role: string) => {
				return role === ROLE_KEEPER ? 'acct-keeper' : null;
			},
		);

		const result = await resolve_keeper_account_id(mock_deps);
		assert.strictEqual(result, 'acct-keeper');
		assert.strictEqual(
			mock_query_role_grant_find_account_id_for_role.mock.calls[0]![1],
			ROLE_KEEPER,
		);
	});

	test('returns null when no keeper exists', async () => {
		mock_query_role_grant_find_account_id_for_role.mockImplementation(async () => null);

		const result = await resolve_keeper_account_id(mock_deps);
		assert.strictEqual(result, null);
	});
});

describe('validate_daemon_token', () => {
	test('accepts current token', () => {
		const state = create_state();
		assert.strictEqual(validate_daemon_token(state.current_token, state), true);
	});

	test('accepts previous token', () => {
		const previous = generate_daemon_token();
		const state = create_state({previous_token: previous});
		assert.strictEqual(validate_daemon_token(previous, state), true);
	});

	test('rejects unknown token', () => {
		const state = create_state();
		const other = generate_daemon_token();
		assert.strictEqual(validate_daemon_token(other, state), false);
	});

	test('rejects when previous_token is null and token does not match current', () => {
		const state = create_state({previous_token: null});
		const other = generate_daemon_token();
		assert.strictEqual(validate_daemon_token(other, state), false);
	});

	test('rejects empty string', () => {
		const state = create_state();
		assert.strictEqual(validate_daemon_token('', state), false);
	});
});

describe('create_daemon_token_middleware', () => {
	test('no header passes through without setting context', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('empty header passes through without setting context', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: ''},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('valid current token sets account_id and credential_type', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: state.current_token},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(body.context);
		assert.strictEqual(body.context.account_id, 'acct-keeper');
		// Middleware sets only the account-grain identity. Actor resolution
		// happens in the dispatcher's authorization phase when the route's
		// auth requires role_grants or its input declares `acting`.
		assert.strictEqual(body.credential_type, 'daemon_token');
		assert.strictEqual(body.api_token_id, null);
	});

	test('valid previous token sets account_id and credential_type', async () => {
		const previous = generate_daemon_token();
		const state = create_state({previous_token: previous});
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: previous},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(body.context);
		assert.strictEqual(body.context.account_id, 'acct-keeper');
		assert.strictEqual(body.credential_type, 'daemon_token');
	});

	test('invalid token returns 401 (fail-closed)', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: generate_daemon_token()},
		});
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INVALID_DAEMON_TOKEN);
	});

	test('malformed token format returns 401', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: 'not-a-valid-format'},
		});
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INVALID_DAEMON_TOKEN);
	});

	test('no keeper_account_id returns 503', async () => {
		const state = create_state({keeper_account_id: null});
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: state.current_token},
		});
		assert.strictEqual(res.status, 503);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_KEEPER_ACCOUNT_NOT_CONFIGURED);
	});

	test('overrides existing session context when daemon token header present', async () => {
		const state = create_state();
		const app = new Hono();
		// simulate session middleware setting account-only context first
		app.use('/*', async (c, next) => {
			c.set(ACCOUNT_ID_KEY, 'acct-session-user');
			c.set(CREDENTIAL_TYPE_KEY, 'session');
			await next();
		});
		app.use('/*', create_daemon_token_middleware(state, mock_deps));
		app.get('/test', (c) => {
			const account_id = c.get(ACCOUNT_ID_KEY);
			const credential_type = c.get(CREDENTIAL_TYPE_KEY);
			return c.json({
				account_id: account_id ?? null,
				credential_type: credential_type ?? null,
			});
		});

		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: state.current_token},
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		// daemon token overrides the session-derived account id
		assert.strictEqual(body.account_id, 'acct-keeper');
		assert.strictEqual(body.credential_type, 'daemon_token');
	});
});

describe('daemon token rotation lifecycle', () => {
	test('after one rotation, previous token is still accepted', () => {
		const initial_token = generate_daemon_token();
		const state: DaemonTokenState = {
			current_token: initial_token,
			previous_token: null,
			rotated_at: new Date(),
			keeper_account_id: 'acct-keeper',
		};

		// simulate one rotation
		const new_token = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = new_token;
		state.rotated_at = new Date();

		assert.strictEqual(validate_daemon_token(initial_token, state), true);
		assert.strictEqual(validate_daemon_token(new_token, state), true);
	});

	test('after two rotations, two-ago token is rejected', () => {
		const initial_token = generate_daemon_token();
		const state: DaemonTokenState = {
			current_token: initial_token,
			previous_token: null,
			rotated_at: new Date(),
			keeper_account_id: 'acct-keeper',
		};

		// first rotation
		const second_token = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = second_token;
		state.rotated_at = new Date();

		// second rotation
		const third_token = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = third_token;
		state.rotated_at = new Date();

		assert.strictEqual(validate_daemon_token(initial_token, state), false);
		assert.strictEqual(validate_daemon_token(second_token, state), true);
		assert.strictEqual(validate_daemon_token(third_token, state), true);
	});

	test('rotation sets previous_token to old current_token', () => {
		const initial_token = generate_daemon_token();
		const state: DaemonTokenState = {
			current_token: initial_token,
			previous_token: null,
			rotated_at: new Date(),
			keeper_account_id: 'acct-keeper',
		};

		const new_token = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = new_token;

		assert.strictEqual(state.previous_token, initial_token);
		assert.strictEqual(state.current_token, new_token);
	});

	test('rejects token differing by one character from current', () => {
		const state = create_state();
		const chars = state.current_token.split('');
		// flip one character
		chars[0] = chars[0] === 'A' ? 'B' : 'A';
		const tampered = chars.join('');

		assert.strictEqual(validate_daemon_token(tampered, state), false);
	});

	test('concurrent rotation: previous token accepted via middleware during rotation', async () => {
		const initial = generate_daemon_token();
		const state: DaemonTokenState = {
			current_token: initial,
			previous_token: null,
			rotated_at: new Date(),
			keeper_account_id: 'acct-keeper',
		};

		// first rotation
		const second = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = second;
		state.rotated_at = new Date();

		const app = create_daemon_app(state);

		// both tokens should work via middleware
		const res_current = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: second},
		});
		assert.strictEqual(res_current.status, 200);
		const body_current = await res_current.json();
		assert.strictEqual(body_current.credential_type, 'daemon_token');

		const res_previous = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: initial},
		});
		assert.strictEqual(res_previous.status, 200);
		const body_previous = await res_previous.json();
		assert.strictEqual(body_previous.credential_type, 'daemon_token');
	});

	test('concurrent rotation: two-ago token rejected via middleware', async () => {
		const initial = generate_daemon_token();
		const state: DaemonTokenState = {
			current_token: initial,
			previous_token: null,
			rotated_at: new Date(),
			keeper_account_id: 'acct-keeper',
		};

		// first rotation
		const second = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = second;

		// second rotation
		const third = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = third;

		const app = create_daemon_app(state);

		// initial (two-ago) should be rejected
		const res = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: initial},
		});
		assert.strictEqual(res.status, 401);
		const body = await res.json();
		assert.strictEqual(body.error, ERROR_INVALID_DAEMON_TOKEN);

		// second (previous) and third (current) should work
		const res2 = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: second},
		});
		assert.strictEqual(res2.status, 200);

		const res3 = await app.request('/test', {
			headers: {[DAEMON_TOKEN_HEADER]: third},
		});
		assert.strictEqual(res3.status, 200);
	});
});
