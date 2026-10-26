/**
 * Tests for the REST round-trip's 401 guard and its fresh account for
 * mutations — the twin of `rpc_round_trip.test.ts`.
 *
 * The behavioral half runs `describe_round_trip_validation` against a fake
 * fixture whose backend ends the caller's session on a `POST`: the round-trip
 * passes only when that request ran on an account of its own, since the
 * shared authed account's later `GET` would otherwise answer 401, which the
 * guard fails.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import type { RouteSpec } from '#lib/http/route_spec.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_test_app_surface_spec } from '#lib/testing/stubs.ts';
import type { TestAccount } from '#lib/testing/app_server.ts';
import type { TestFixture } from '#lib/testing/cross_backend/setup.ts';
import {
	assert_route_authenticated,
	describe_round_trip_validation
} from '#lib/testing/round_trip.ts';

const COOKIE_NAME = 'test_round_trip_session';

const session_options = create_session_config(COOKIE_NAME);

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

describe('assert_route_authenticated', () => {
	test('a 401 authentication_required to a credentialed request fails, naming the route', () => {
		for (const principal of ['daemon_token', 'admin', 'keeper', 'authed'] as const) {
			let message: string | undefined;
			try {
				assert_route_authenticated(
					'GET /api/widget',
					401,
					{ error: 'authentication_required' },
					principal
				);
			} catch (e) {
				message = (e as Error).message;
			}
			assert.ok(message, `${principal}: expected a failure`);
			assert.include(message, 'GET /api/widget');
			assert.include(message, principal);
			assert.include(message, 'authentication_required');
		}
	});

	test('a reason-less or non-JSON 401 to a credentialed request fails', () => {
		for (const body of [{}, undefined]) {
			let failed = false;
			try {
				assert_route_authenticated('GET /api/widget', 401, body, 'authed');
			} catch {
				failed = true;
			}
			assert.isTrue(failed, JSON.stringify(body));
		}
	});

	test("a 401 naming a handler's own reason passes (a wrong current password)", () => {
		assert_route_authenticated(
			'POST /api/account/password',
			401,
			{ error: 'invalid_credentials' },
			'authed'
		);
	});

	test('a 401 to a public request passes (a login with a wrong password)', () => {
		assert_route_authenticated(
			'POST /api/account/login',
			401,
			{ error: 'authentication_required' },
			'public'
		);
	});
});

// --- behavioral: a mutation that ends the caller's session ---

const BURN_PATH = '/api/widget/burn';
const PEEK_PATH = '/api/widget/peek';

const ok_output = z.strictObject({ ok: z.literal(true) });

// `POST` first, so on a shared account the `GET` after it would 401
const create_route_specs = (_ctx: AppServerContext): Array<RouteSpec> => [
	{
		method: 'POST',
		path: BURN_PATH,
		auth: { account: 'required', actor: 'none' },
		handler: (c) => c.json({ ok: true }),
		description: "End the caller's session",
		input: z.null(),
		output: ok_output
	},
	{
		method: 'GET',
		path: PEEK_PATH,
		auth: { account: 'required', actor: 'none' },
		handler: (c) => c.json({ ok: true }),
		description: 'Read as the caller',
		input: z.null(),
		output: ok_output
	}
];

/** Session cookies the fake backend still honors. */
const live_sessions = new Set<string>(['keeper']);
/** `[METHOD path, cookie]` per request the fake backend answered. */
const calls: Array<[string, string]> = [];
let account_counter = 0;

const read_cookie = (headers: HeadersInit | undefined): string => {
	const value = new Headers(headers).get('cookie') ?? '';
	return value.startsWith(`${COOKIE_NAME}=`) ? value.slice(COOKIE_NAME.length + 1) : '';
};

const respond = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fake_transport = async (path: string, init?: RequestInit): Promise<Response> => {
	const cookie = read_cookie(init?.headers);
	const route_key = `${init?.method ?? 'GET'} ${new URL(path, 'http://localhost').pathname}`;
	calls.push([route_key, cookie]);
	if (!live_sessions.has(cookie)) return respond(401, { error: 'authentication_required' });
	if (route_key === `POST ${BURN_PATH}`) live_sessions.delete(cookie);
	return respond(200, { ok: true });
};

// a fake fixture: the round-trip reads only these members
const fake_fixture = {
	transport: fake_transport,
	actor: { id: '00000000-0000-4000-8000-000000000003' },
	create_session_headers: () => ({ cookie: `${COOKIE_NAME}=keeper` }),
	create_bearer_headers: () => ({ authorization: 'Bearer keeper' }),
	create_daemon_token_headers: () => ({ 'x-daemon-token': 'daemon' }),
	create_account: async () => {
		const cookie = `account_${++account_counter}`;
		live_sessions.add(cookie);
		return create_account_stub(cookie);
	}
} as unknown as TestFixture;

describe_round_trip_validation({
	setup_test: async () => fake_fixture,
	surface_source: create_test_app_surface_spec({ session_options, create_route_specs })
});

test('the mutation ran on an account of its own', () => {
	const burns = calls.filter(([route_key]) => route_key === `POST ${BURN_PATH}`);
	const peeks = calls.filter(([route_key]) => route_key === `GET ${PEEK_PATH}`);
	assert.lengthOf(burns, 1);
	assert.lengthOf(peeks, 1);
	const burn_cookie = burns[0]![1];
	const peek_cookie = peeks[0]![1];
	assert.notStrictEqual(burn_cookie, peek_cookie);
	assert.isFalse(live_sessions.has(burn_cookie));
	assert.isTrue(live_sessions.has(peek_cookie));
});
