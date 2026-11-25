/**
 * Tests for the RPC round-trip's principal choice and transport, its 401 and
 * credential-type guards, and its fresh account for side-effecting calls.
 *
 * The behavioral half runs `describe_rpc_round_trip_tests` against a fake
 * fixture whose backend ends the caller's session on a side-effecting
 * method: the round-trip passes only when that call ran on an account of its
 * own, since the shared authed account's later read would otherwise answer
 * 401, which the suite fails. The fake backend also discards a daemon token
 * sent over anything but the cookie-free, `Origin`-free transport, so the
 * suite passes only when each call went through its principal's transport.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { literal, object, void as fuz_void } from '@fuzdev/fuz_schema/schema.ts';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { RpcAction } from '#lib/actions/action_types.ts';
import type { AppSurfaceRpcMethod, RpcEndpointSpec } from '#lib/http/surface.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { JSONRPC_VERSION } from '#lib/http/jsonrpc.ts';
import { create_test_app_surface_spec } from '#lib/testing/stubs.ts';
import type { TestAccount } from '#lib/testing/test_app.ts';
import type { TestFixture } from '#lib/testing/cross_backend/setup.ts';
import {
	assert_rpc_authenticated,
	describe_rpc_round_trip_tests,
	pick_rpc_auth
} from '#lib/testing/rpc_round_trip.ts';
import {
	is_credential_type_refusal,
	is_unauthenticated_refusal,
	round_trip_uses_fresh_account,
	to_principal_transport,
	type PrincipalTransports
} from '#lib/testing/integration_helpers.ts';
import type { RpcTestTransport } from '#lib/testing/rpc_helpers.ts';
import { ERROR_CREDENTIAL_TYPE_REQUIRED } from '#lib/http/error_schemas.ts';

const session_cookie_name = 'test_rpc_round_trip_session';

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

describe('to_principal_transport', () => {
	const fixture_transport: RpcTestTransport = () => Promise.resolve(new Response('fixture'));
	const fresh_calls: Array<{ readonly origin?: string | null } | undefined> = [];
	const fresh: RpcTestTransport = () => Promise.resolve(new Response('fresh'));
	const transports: PrincipalTransports = {
		transport: fixture_transport,
		fresh_transport: (options) => {
			fresh_calls.push(options);
			return fresh;
		}
	};

	test('the daemon token goes cookie-free and without an Origin', () => {
		fresh_calls.length = 0;
		assert.strictEqual(to_principal_transport('daemon_token', transports), fresh);
		assert.deepEqual(fresh_calls, [{ origin: null }]);
	});

	test('a public call goes cookie-free with the default Origin', () => {
		fresh_calls.length = 0;
		assert.strictEqual(to_principal_transport('public', transports), fresh);
		assert.deepEqual(fresh_calls, [undefined]);
	});

	test('a session principal keeps the fixture transport', () => {
		fresh_calls.length = 0;
		for (const principal of ['admin', 'keeper', 'authed'] as const) {
			assert.strictEqual(to_principal_transport(principal, transports), fixture_transport);
		}
		assert.lengthOf(fresh_calls, 0);
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

describe('assert_rpc_authenticated credential-type guard', () => {
	const credential_type_required = {
		jsonrpc: JSONRPC_VERSION,
		id: 'test',
		error: {
			code: -32002,
			message: 'forbidden',
			data: {
				reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
				required_credential_types: ['daemon_token']
			}
		}
	};

	test('a 403 credential_type_required to a credentialed call fails, naming the method', () => {
		for (const principal of ['daemon_token', 'admin', 'keeper', 'authed'] as const) {
			let message: string | undefined;
			try {
				assert_rpc_authenticated('widget_purge', 403, credential_type_required, principal);
			} catch (e) {
				message = (e as Error).message;
			}
			assert.ok(message, `${principal}: expected a failure`);
			assert.include(message, `'widget_purge'`);
			assert.include(message, principal);
			assert.include(message, ERROR_CREDENTIAL_TYPE_REQUIRED);
		}
	});

	test('a 403 naming another reason passes', () => {
		assert_rpc_authenticated(
			'widget_purge',
			403,
			{
				jsonrpc: JSONRPC_VERSION,
				id: 'test',
				error: { code: -32002, message: 'forbidden', data: { reason: 'insufficient_permissions' } }
			},
			'authed'
		);
	});

	test('a public call is not checked', () => {
		assert_rpc_authenticated('widget_login', 403, credential_type_required, 'public');
	});
});

describe('is_credential_type_refusal', () => {
	test('only a 403 reading credential_type_required', () => {
		assert.isTrue(is_credential_type_refusal(403, ERROR_CREDENTIAL_TYPE_REQUIRED));
		assert.isFalse(is_credential_type_refusal(401, ERROR_CREDENTIAL_TYPE_REQUIRED));
		assert.isFalse(is_credential_type_refusal(403, 'insufficient_permissions'));
		assert.isFalse(is_credential_type_refusal(403, undefined));
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
	input: fuz_void,
	output: object({ ok: literal(true) }),
	async: true,
	description: "End the caller's session"
};

const peek_spec: RequestResponseActionSpec = {
	method: 'widget_peek',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: fuz_void,
	output: object({ ok: literal(true) }),
	async: true,
	description: 'Read as the caller'
};

const vault_spec: RequestResponseActionSpec = {
	method: 'widget_vault',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none', credential_types: ['daemon_token'] },
	side_effects: false,
	input: fuz_void,
	output: object({ ok: literal(true) }),
	async: true,
	description: 'Read behind the daemon token'
};

// `widget_burn` enumerates first, so on a shared account `widget_peek` would 401
const actions: Array<RpcAction> = [
	{ spec: burn_spec, handler: () => ({ ok: true }) },
	{ spec: peek_spec, handler: () => ({ ok: true }) },
	{ spec: vault_spec, handler: () => ({ ok: true }) }
];

const rpc_endpoint_spec: RpcEndpointSpec = { path: '/api/rpc', actions };

const create_route_specs = (_ctx: AppServerContext): Array<RouteSpec> => [];

/** The account a success fixture calls as, through its own headers. */
const fixture_owner = create_account_stub('fixture_owner');

/** Which of the fixture's transports a call went through. */
type Via = 'fixture' | 'fresh' | 'fresh_no_origin';

/** Session cookies the fake backend still honors. */
const live_sessions = new Set<string>(['keeper', 'fixture_owner']);
/** `[method, cookie, via]` per call the fake backend answered. */
const calls: Array<[string, string, Via]> = [];
let account_counter = 0;

const read_cookie = (headers: HeadersInit | undefined): string => {
	const value = new Headers(headers).get('cookie') ?? '';
	return value.startsWith(`${COOKIE_NAME}=`) ? value.slice(COOKIE_NAME.length + 1) : '';
};

const respond = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const create_fake_transport =
	(via: Via) =>
	async (path: string, init?: RequestInit): Promise<Response> => {
		const method =
			init?.method === 'POST'
				? (JSON.parse(init.body as string) as { method: string }).method
				: new URL(path, 'http://localhost').searchParams.get('method');
		const cookie = read_cookie(init?.headers);
		calls.push([method ?? '', cookie, via]);
		// as a spawned backend: the daemon token counts only with no `Origin`,
		// and behind one the session answering in its place is the wrong channel
		if (new Headers(init?.headers).has('x-daemon-token')) {
			if (via === 'fresh_no_origin') {
				return respond(200, { jsonrpc: JSONRPC_VERSION, id: 'test', result: { ok: true } });
			}
			return respond(403, {
				jsonrpc: JSONRPC_VERSION,
				id: 'test',
				error: {
					code: -32002,
					message: 'forbidden',
					data: {
						reason: ERROR_CREDENTIAL_TYPE_REQUIRED,
						required_credential_types: ['daemon_token']
					}
				}
			});
		}
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
	transport: create_fake_transport('fixture'),
	fresh_transport: (options?: { readonly origin?: string | null }) =>
		create_fake_transport(options?.origin === null ? 'fresh_no_origin' : 'fresh'),
	...keeper,
	create_account: async () => {
		const cookie = `account_${++account_counter}`;
		live_sessions.add(cookie);
		return create_account_stub(cookie);
	},
	// no database behind the fake
	assert_db_invariants: async () => {},
	close: async () => {}
} as unknown as TestFixture;

describe_rpc_round_trip_tests({
	setup_test: async () => fake_fixture,
	surface_source: create_test_app_surface_spec({
		session_cookie_name,
		create_route_specs,
		rpc_endpoints: [rpc_endpoint_spec]
	}),
	session_cookie_name,
	rpc_endpoints: [rpc_endpoint_spec],
	success_fixtures: new Map([
		['widget_peek', async () => ({ params: {}, headers: fixture_owner.create_session_headers() })]
	])
});

test('the side-effecting call ran on an account of its own', () => {
	const burns = calls.filter(([method]) => method === 'widget_burn');
	const peeks = calls.filter(
		([method, cookie]) => method === 'widget_peek' && cookie !== 'fixture_owner'
	);
	assert.lengthOf(burns, 1);
	assert.lengthOf(peeks, 2); // POST and GET
	const burn_cookie = burns[0]![1];
	for (const [, peek_cookie] of peeks) {
		assert.notStrictEqual(burn_cookie, peek_cookie);
		assert.isTrue(live_sessions.has(peek_cookie));
	}
	assert.isFalse(live_sessions.has(burn_cookie));
});

test('each call went through the transport of its principal', () => {
	const vias = (method: string): Array<Via> =>
		calls.filter(([m]) => m === method).map(([, , via]) => via);
	// POST and GET, cookie-free and without an `Origin`
	assert.deepEqual(vias('widget_vault'), ['fresh_no_origin', 'fresh_no_origin']);
	// a success fixture's own headers go cookie-free, the default `Origin` kept
	assert.deepEqual(
		calls.filter(([, cookie]) => cookie === 'fixture_owner'),
		[['widget_peek', 'fixture_owner', 'fresh']]
	);
	// a session principal keeps the fixture's transport
	assert.deepEqual(vias('widget_burn'), ['fixture']);
});
