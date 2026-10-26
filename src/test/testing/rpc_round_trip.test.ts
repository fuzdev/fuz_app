/**
 * Tests for the RPC round-trip's principal choice, its 401 guard, and its
 * fresh account for side-effecting calls.
 *
 * The behavioral half runs `describe_rpc_round_trip_tests` against a fake
 * fixture whose backend ends the caller's session on a side-effecting
 * method: the round-trip passes only when that call ran on an account of its
 * own, since the shared authed account's later read would otherwise answer
 * 401, which the suite fails.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { RpcAction } from '#lib/actions/action_rpc.ts';
import type { AppSurfaceRpcMethod, RpcEndpointSpec } from '#lib/http/surface.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { JSONRPC_VERSION } from '#lib/http/jsonrpc.ts';
import { create_test_app_surface_spec } from '#lib/testing/stubs.ts';
import type { TestAccount } from '#lib/testing/app_server.ts';
import type { TestFixture } from '#lib/testing/cross_backend/setup.ts';
import {
	assert_rpc_authenticated,
	describe_rpc_round_trip_tests,
	pick_rpc_auth
} from '#lib/testing/rpc_round_trip.ts';
import {
	is_unauthenticated_refusal,
	round_trip_uses_fresh_account
} from '#lib/testing/integration_helpers.ts';

const session_options = create_session_config('test_rpc_round_trip_session');

const COOKIE_NAME = 'test_rpc_round_trip_session';

const to_method = (auth: AppSurfaceRpcMethod['auth']): AppSurfaceRpcMethod =>
	({ name: 'x', auth }) as AppSurfaceRpcMethod;

const create_account_stub = (cookie: string): TestAccount => ({
	account: {
		id: '00000000-0000-4000-8000-000000000001' as TestAccount['account']['id'],
		username: cookie
	},
	actor: { id: '00000000-0000-4000-8000-000000000002' as TestAccount['actor']['id'] },
	session_cookie: cookie,
	api_token: `token_${cookie}`,
	create_session_headers: (extra) => ({ cookie: `${COOKIE_NAME}=${cookie}`, ...extra }),
	create_bearer_headers: (extra) => ({ authorization: `Bearer token_${cookie}`, ...extra })
});

const keeper = {
	create_session_headers: () => ({ cookie: `${COOKIE_NAME}=keeper` }),
	create_bearer_headers: () => ({ authorization: 'Bearer keeper' }),
	create_daemon_token_headers: () => ({ 'x-daemon-token': 'daemon' })
};

describe('pick_rpc_auth', () => {
	const authed = create_account_stub('authed');
	const admin = create_account_stub('admin');

	test('a public method sends no credential', () => {
		const picked = pick_rpc_auth(
			to_method({ account: 'none', actor: 'none' }),
			keeper,
			authed,
			admin
		);
		assert.strictEqual(picked.principal, 'public');
		assert.notProperty(picked.headers, 'cookie');
	});

	test('a daemon-token method sends the keeper daemon token', () => {
		const picked = pick_rpc_auth(
			to_method({ account: 'required', actor: 'required', credential_types: ['daemon_token'] }),
			keeper,
			authed,
			admin
		);
		assert.strictEqual(picked.principal, 'daemon_token');
		assert.deepEqual(picked.headers, { 'x-daemon-token': 'daemon' });
	});

	test('an admin-gated method sends the admin session, another role the keeper session', () => {
		const as_admin = pick_rpc_auth(
			to_method({ account: 'required', actor: 'required', roles: [ROLE_ADMIN] }),
			keeper,
			authed,
			admin
		);
		assert.strictEqual(as_admin.principal, 'admin');
		assert.strictEqual(as_admin.headers.cookie, `${COOKIE_NAME}=admin`);
		const as_keeper = pick_rpc_auth(
			to_method({ account: 'required', actor: 'required', roles: ['keeper'] }),
			keeper,
			authed,
			admin
		);
		assert.strictEqual(as_keeper.principal, 'keeper');
		assert.strictEqual(as_keeper.headers.cookie, `${COOKIE_NAME}=keeper`);
	});

	test('an account method with no role sends the authed session', () => {
		const picked = pick_rpc_auth(
			to_method({ account: 'required', actor: 'none' }),
			keeper,
			authed,
			admin
		);
		assert.strictEqual(picked.principal, 'authed');
		assert.strictEqual(picked.headers.cookie, `${COOKIE_NAME}=authed`);
	});
});

describe('round_trip_uses_fresh_account', () => {
	test('only a side-effecting authed call gets a fresh account', () => {
		assert.isTrue(round_trip_uses_fresh_account('authed', true));
		assert.isFalse(round_trip_uses_fresh_account('authed', false));
		for (const principal of ['public', 'daemon_token', 'admin', 'keeper'] as const) {
			assert.isFalse(round_trip_uses_fresh_account(principal, true), principal);
		}
	});
});

describe('assert_rpc_authenticated', () => {
	const unauthenticated = {
		jsonrpc: JSONRPC_VERSION,
		id: 'test',
		error: { code: -32001, message: 'unauthenticated', data: { reason: 'authentication_required' } }
	};

	test('a 401 to a credentialed call fails, naming the method and principal', () => {
		for (const principal of ['daemon_token', 'admin', 'keeper', 'authed'] as const) {
			let message: string | undefined;
			try {
				assert_rpc_authenticated('widget_get', 401, unauthenticated, principal);
			} catch (e) {
				message = (e as Error).message;
			}
			assert.ok(message, `${principal}: expected a failure`);
			assert.include(message, `'widget_get'`);
			assert.include(message, principal);
			assert.include(message, 'authentication_required');
		}
	});

	test('a 401 to a public call passes (a login with a wrong password)', () => {
		assert_rpc_authenticated('widget_login', 401, unauthenticated, 'public');
	});

	test('other refusals pass', () => {
		for (const status of [400, 403, 404, 429]) {
			assert_rpc_authenticated('widget_get', status, unauthenticated, 'authed');
		}
	});

	test("a 401 naming a handler's own reason passes (a wrong current password)", () => {
		assert_rpc_authenticated(
			'widget_password_change',
			401,
			{
				jsonrpc: JSONRPC_VERSION,
				id: 'test',
				error: { code: -32001, message: 'unauthenticated', data: { reason: 'invalid_credentials' } }
			},
			'authed'
		);
	});
});

describe('is_unauthenticated_refusal', () => {
	test('a 401 with authentication_required or no reason', () => {
		assert.isTrue(is_unauthenticated_refusal(401, 'authentication_required'));
		assert.isTrue(is_unauthenticated_refusal(401, undefined));
	});

	test('not a 401 with another reason, nor another status', () => {
		assert.isFalse(is_unauthenticated_refusal(401, 'invalid_credentials'));
		assert.isFalse(is_unauthenticated_refusal(403, 'authentication_required'));
	});
});

// --- behavioral: a side-effecting call that ends the caller's session ---

const burn_spec: RequestResponseActionSpec = {
	method: 'widget_burn',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: z.void(),
	output: z.strictObject({ ok: z.literal(true) }),
	async: true,
	description: "End the caller's session"
};

const peek_spec: RequestResponseActionSpec = {
	method: 'widget_peek',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.void(),
	output: z.strictObject({ ok: z.literal(true) }),
	async: true,
	description: 'Read as the caller'
};

// `widget_burn` enumerates first, so on a shared account `widget_peek` would 401
const actions: Array<RpcAction> = [
	{ spec: burn_spec, handler: () => ({ ok: true }) },
	{ spec: peek_spec, handler: () => ({ ok: true }) }
];

const rpc_endpoint_spec: RpcEndpointSpec = { path: '/api/rpc', actions };

const create_route_specs = (_ctx: AppServerContext): Array<RouteSpec> => [];

/** Session cookies the fake backend still honors. */
const live_sessions = new Set<string>(['keeper']);
/** `[method, cookie]` per call the fake backend answered. */
const calls: Array<[string, string]> = [];
let account_counter = 0;

const read_cookie = (headers: HeadersInit | undefined): string => {
	const value = new Headers(headers).get('cookie') ?? '';
	return value.startsWith(`${COOKIE_NAME}=`) ? value.slice(COOKIE_NAME.length + 1) : '';
};

const respond = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fake_transport = async (path: string, init?: RequestInit): Promise<Response> => {
	const method =
		init?.method === 'POST'
			? (JSON.parse(init.body as string) as { method: string }).method
			: new URL(path, 'http://localhost').searchParams.get('method');
	const cookie = read_cookie(init?.headers);
	calls.push([method ?? '', cookie]);
	if (!live_sessions.has(cookie)) {
		return respond(401, {
			jsonrpc: JSONRPC_VERSION,
			id: 'test',
			error: {
				code: -32001,
				message: 'unauthenticated',
				data: { reason: 'authentication_required' }
			}
		});
	}
	if (method === 'widget_burn') live_sessions.delete(cookie);
	return respond(200, { jsonrpc: JSONRPC_VERSION, id: 'test', result: { ok: true } });
};

// a fake fixture: the round-trip reads only these members
const fake_fixture = {
	transport: fake_transport,
	...keeper,
	create_account: async () => {
		const cookie = `account_${++account_counter}`;
		live_sessions.add(cookie);
		return create_account_stub(cookie);
	}
} as unknown as TestFixture;

describe_rpc_round_trip_tests({
	setup_test: async () => fake_fixture,
	surface_source: create_test_app_surface_spec({
		session_options,
		create_route_specs,
		rpc_endpoints: [rpc_endpoint_spec]
	}),
	session_options,
	rpc_endpoints: [rpc_endpoint_spec]
});

test('the side-effecting call ran on an account of its own', () => {
	const burns = calls.filter(([method]) => method === 'widget_burn');
	const peeks = calls.filter(([method]) => method === 'widget_peek');
	assert.lengthOf(burns, 1);
	assert.lengthOf(peeks, 2); // POST and GET
	const burn_cookie = burns[0]![1];
	for (const [, peek_cookie] of peeks) {
		assert.notStrictEqual(burn_cookie, peek_cookie);
		assert.isTrue(live_sessions.has(peek_cookie));
	}
	assert.isFalse(live_sessions.has(burn_cookie));
});
