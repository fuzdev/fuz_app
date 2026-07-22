/**
 * Tests for daemon token — generation, validation, Zod schema, and middleware.
 *
 * @module
 */

import { describe, test, assert, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

import {
	generate_daemon_token,
	validate_daemon_token,
	DaemonToken,
	DAEMON_TOKEN_HEADER,
	type DaemonTokenState
} from '$lib/auth/daemon_token.ts';
import {
	create_daemon_token_middleware,
	resolve_keeper_account_id
} from '$lib/auth/daemon_token_middleware.ts';
import { ACCOUNT_ID_KEY, AUTH_API_TOKEN_ID_KEY, CREDENTIAL_TYPE_KEY } from '$lib/hono_context.ts';
import { ROLE_KEEPER } from '$lib/auth/role_schema.ts';
import type { QueryDeps } from '$lib/db/query_deps.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import {
	create_test_account,
	create_test_actor,
	create_test_role_grant
} from '$lib/testing/entities.ts';

// Mock module-level query functions used by daemon_token_middleware
const {
	mock_query_account_by_id,
	mock_query_actor_by_id,
	mock_query_active_actors_by_account,
	mock_query_role_grant_find_active_for_actor,
	mock_query_role_grant_find_account_id_for_role
} = vi.hoisted(() => ({
	mock_query_account_by_id: vi.fn(),
	mock_query_actor_by_id: vi.fn(),
	mock_query_active_actors_by_account: vi.fn(),
	mock_query_role_grant_find_active_for_actor: vi.fn(),
	mock_query_role_grant_find_account_id_for_role: vi.fn()
}));

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: mock_query_account_by_id,
	query_actor_by_id: mock_query_actor_by_id,
	query_active_actors_by_account: mock_query_active_actors_by_account
}));

vi.mock('$lib/auth/role_grant_queries.js', () => ({
	query_role_grant_find_active_for_actor: mock_query_role_grant_find_active_for_actor,
	query_role_grant_find_account_id_for_role: mock_query_role_grant_find_account_id_for_role
}));

const create_state = (overrides: Partial<DaemonTokenState> = {}): DaemonTokenState => ({
	current_token: generate_daemon_token(),
	previous_token: null,
	rotated_at: new Date(),
	keeper_account_id: 'acct-keeper',
	...overrides
});

const mock_deps = { db: {} } as unknown as QueryDeps;

const test_log = new Logger('test', { level: 'off' });

const setup_default_mocks = () => {
	const account = create_test_account({ id: 'acct-keeper' as Uuid, username: 'keeper' });
	const actor = create_test_actor({
		id: 'actor-keeper' as Uuid,
		account_id: 'acct-keeper' as Uuid,
		name: 'keeper'
	});
	const role_grants = [
		create_test_role_grant({
			id: 'role_grant-keeper' as Uuid,
			actor_id: 'actor-keeper' as Uuid,
			role: 'keeper'
		})
	];
	mock_query_account_by_id.mockImplementation(async () => account);
	mock_query_actor_by_id.mockImplementation(async () => actor);
	mock_query_active_actors_by_account.mockImplementation(async () => [actor]);
	mock_query_role_grant_find_active_for_actor.mockImplementation(async () => role_grants);
	// Default the lazy-keeper-refresh lookup to a resolvable keeper so tests
	// that don't care about the refresh path get the happy default. Tests
	// that need the null-keeper case override explicitly.
	mock_query_role_grant_find_account_id_for_role.mockImplementation(async () => 'acct-keeper');
};

beforeEach(() => {
	mock_query_account_by_id.mockReset();
	mock_query_actor_by_id.mockReset();
	mock_query_active_actors_by_account.mockReset();
	mock_query_role_grant_find_active_for_actor.mockReset();
	mock_query_role_grant_find_account_id_for_role.mockReset();
	setup_default_mocks();
});

/** Create a Hono test app with daemon token middleware. */
const create_daemon_app = (state: DaemonTokenState): Hono => {
	const app = new Hono();
	app.use('/*', create_daemon_token_middleware(state, mock_deps, test_log));
	app.get('/test', (c) => {
		const account_id = c.get(ACCOUNT_ID_KEY);
		const credential_type = c.get(CREDENTIAL_TYPE_KEY);
		const api_token_id = c.get(AUTH_API_TOKEN_ID_KEY);
		return c.json({
			context: account_id ? { account_id, actor_id: null } : null,
			credential_type: credential_type ?? null,
			api_token_id: api_token_id ?? null
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
		const tokens = new Set(Array.from({ length: 10 }, () => generate_daemon_token()));
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
			}
		);

		const result = await resolve_keeper_account_id(mock_deps);
		assert.strictEqual(result, 'acct-keeper');
		assert.strictEqual(
			mock_query_role_grant_find_account_id_for_role.mock.calls[0]![1],
			ROLE_KEEPER
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
		const state = create_state({ previous_token: previous });
		assert.strictEqual(validate_daemon_token(previous, state), true);
	});

	test('rejects unknown token', () => {
		const state = create_state();
		const other = generate_daemon_token();
		assert.strictEqual(validate_daemon_token(other, state), false);
	});

	test('rejects when previous_token is null and token does not match current', () => {
		const state = create_state({ previous_token: null });
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
			headers: { [DAEMON_TOKEN_HEADER]: '' }
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
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token }
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
		const state = create_state({ previous_token: previous });
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: previous }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(body.context);
		assert.strictEqual(body.context.account_id, 'acct-keeper');
		assert.strictEqual(body.credential_type, 'daemon_token');
	});

	test('invalid token value soft-fails (pass-through, no context)', async () => {
		// A well-formed but non-matching token is a soft-fail discard, not a 401 —
		// it passes through with no identity set, mirroring the bearer guard and
		// the Rust spine's `resolve.rs` (`None`). On a daemon-gated action the
		// dispatcher returns `credential_type_required` downstream.
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: generate_daemon_token() }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('malformed token format soft-fails (pass-through, no context)', async () => {
		// A Zod-malformed token is a soft-fail discard, not a 401 — same
		// pass-through semantics as the invalid-value case.
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: 'not-a-valid-format' }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('no keeper_account_id soft-fails (pass-through) when lazy refresh also yields null', async () => {
		// A valid token with no keeper configured (still pre-bootstrap after the
		// lazy refresh) is a soft-fail discard — pass through with no identity set,
		// not a 503. Mirrors the Rust spine's `resolve.rs` (`None`): the request
		// falls through to anonymous and a daemon-gated action returns
		// `credential_type_required` downstream. Explicit null on the lazy-refresh
		// lookup so the no-keeper path is exercised under known preconditions rather
		// than via `vi.fn()`'s default undefined.
		mock_query_role_grant_find_account_id_for_role.mockImplementation(async () => null);

		const state = create_state({ keeper_account_id: null });
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
	});

	test('lazy refresh: null state + keeper now exists → 200, mutates state.keeper_account_id', async () => {
		// Covers the rotation-starts-before-bootstrap path: rotation initialized
		// with `keeper_account_id: null`, then bootstrap landed the keeper. The
		// middleware should self-heal on the first authenticated daemon-token
		// request without an explicit `on_bootstrap` hook.
		const state = create_state({ keeper_account_id: null });
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(body.context);
		assert.strictEqual(body.context.account_id, 'acct-keeper');
		assert.strictEqual(body.credential_type, 'daemon_token');
		// State is mutated so subsequent requests don't re-query.
		assert.strictEqual(state.keeper_account_id, 'acct-keeper');
		assert.strictEqual(mock_query_role_grant_find_account_id_for_role.mock.calls.length, 1);
	});

	test('lazy refresh: soft-fail (no keeper) → keeper lands → 200 (second request)', async () => {
		// First request fires before the keeper exists: refresh returns null, so
		// the token soft-fails (200 + null context, falls through to anonymous).
		// Second request fires after bootstrap: refresh now returns the keeper id,
		// 200 + keeper context. Re-queries every request until a keeper resolves.
		mock_query_role_grant_find_account_id_for_role.mockImplementation(async () => null);

		const state = create_state({ keeper_account_id: null });
		const app = create_daemon_app(state);

		const res1 = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token }
		});
		assert.strictEqual(res1.status, 200);
		const body1 = await res1.json();
		assert.strictEqual(body1.context, null);
		assert.strictEqual(body1.credential_type, null);
		assert.strictEqual(state.keeper_account_id, null);

		// Bootstrap lands; the keeper now exists.
		mock_query_role_grant_find_account_id_for_role.mockImplementation(async () => 'acct-keeper');

		const res2 = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token }
		});
		assert.strictEqual(res2.status, 200);
		const body = await res2.json();
		assert.ok(body.context);
		assert.strictEqual(body.context.account_id, 'acct-keeper');
		assert.strictEqual(state.keeper_account_id, 'acct-keeper');
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
		app.use('/*', create_daemon_token_middleware(state, mock_deps, test_log));
		app.get('/test', (c) => {
			const account_id = c.get(ACCOUNT_ID_KEY);
			const credential_type = c.get(CREDENTIAL_TYPE_KEY);
			return c.json({
				account_id: account_id ?? null,
				credential_type: credential_type ?? null
			});
		});

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		// daemon token overrides the session-derived account id
		assert.strictEqual(body.account_id, 'acct-keeper');
		assert.strictEqual(body.credential_type, 'daemon_token');
	});
});

describe('browser-context discard', () => {
	// Daemon tokens are loopback-only and never carry an Origin in production,
	// so a header-bearing request is a browser context: discard the credential
	// (pass through, no 401) so the dispatcher returns `credential_type_required`
	// downstream — exactly mirroring the bearer guard and Rust's `resolve.rs`.

	test('Origin present → 200 pass-through, no context, DEV debug header', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token, Origin: 'https://x.example' }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		// credential discarded — middleware sets no identity
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
		assert.strictEqual(
			res.headers.get('X-Fuz-Auth-Debug'),
			'daemon_token_discarded_browser_context'
		);
	});

	test('Referer present → 200 pass-through, no context, DEV debug header', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token, Referer: 'https://x.example/page' }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
		assert.strictEqual(
			res.headers.get('X-Fuz-Auth-Debug'),
			'daemon_token_discarded_browser_context'
		);
	});

	test('empty-string Origin → still discarded (browser context)', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token, Origin: '' }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);
		assert.strictEqual(
			res.headers.get('X-Fuz-Auth-Debug'),
			'daemon_token_discarded_browser_context'
		);
	});

	test('no Origin/Referer → authenticates (keeper context, no debug header)', async () => {
		const state = create_state();
		const app = create_daemon_app(state);

		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: state.current_token }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(body.context);
		assert.strictEqual(body.context.account_id, 'acct-keeper');
		assert.strictEqual(body.credential_type, 'daemon_token');
		// not a browser-context discard → no diagnostic header
		assert.strictEqual(res.headers.get('X-Fuz-Auth-Debug'), null);
	});
});

describe('daemon token rotation lifecycle', () => {
	test('after one rotation, previous token is still accepted', () => {
		const initial_token = generate_daemon_token();
		const state: DaemonTokenState = {
			current_token: initial_token,
			previous_token: null,
			rotated_at: new Date(),
			keeper_account_id: 'acct-keeper'
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
			keeper_account_id: 'acct-keeper'
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
			keeper_account_id: 'acct-keeper'
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
			keeper_account_id: 'acct-keeper'
		};

		// first rotation
		const second = generate_daemon_token();
		state.previous_token = state.current_token;
		state.current_token = second;
		state.rotated_at = new Date();

		const app = create_daemon_app(state);

		// both tokens should work via middleware
		const res_current = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: second }
		});
		assert.strictEqual(res_current.status, 200);
		const body_current = await res_current.json();
		assert.strictEqual(body_current.credential_type, 'daemon_token');

		const res_previous = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: initial }
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
			keeper_account_id: 'acct-keeper'
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

		// initial (two-ago) should be discarded — soft-fail pass-through (no
		// identity set), not a 401. The token no longer matches current/previous.
		const res = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: initial }
		});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.context, null);
		assert.strictEqual(body.credential_type, null);

		// second (previous) and third (current) should work
		const res2 = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: second }
		});
		assert.strictEqual(res2.status, 200);

		const res3 = await app.request('/test', {
			headers: { [DAEMON_TOKEN_HEADER]: third }
		});
		assert.strictEqual(res3.status, 200);
	});
});
