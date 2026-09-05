/**
 * `select_auth_app` — picking the test app whose credential and role a route
 * actually admits.
 *
 * The channel decision has to come first, because the credential gate is
 * pre-authorization. A role-correct app on a channel the route refuses never
 * reaches the role gate, so the adversarial runner's "correct auth passes
 * guard" case would read `credential_type_required` as the role gate
 * rejecting a caller it never saw — a failure that points at the wrong gate.
 *
 * That was reachable before the channel check moved ahead of the role check:
 * the selector special-cased `daemon_token` and fell through to the
 * session-credentialed role apps for everything else, so a route gated to
 * `['api_token']` got a session app and a guaranteed 403.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import { create_auth_test_apps, select_auth_app } from '$lib/testing/auth_apps.ts';
import { ActingActor } from '$lib/http/auth_shape.ts';
import type { RouteSpec } from '$lib/http/route_spec.ts';

const specs: Array<RouteSpec> = [
	{
		method: 'GET',
		path: '/public',
		auth: { account: 'none', actor: 'none' },
		handler: (c) => c.json({ ok: true }),
		description: 'Public',
		input: z.null(),
		output: z.null()
	},
	{
		method: 'GET',
		path: '/authed',
		auth: { account: 'required', actor: 'none' },
		handler: (c) => c.json({ ok: true }),
		description: 'Authenticated',
		input: z.null(),
		output: z.null()
	},
	{
		method: 'GET',
		path: '/session-only-role',
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['admin'],
			credential_types: ['session']
		},
		handler: (c) => c.json({ ok: true }),
		description: 'Session-gated admin route',
		query: z.strictObject({ acting: ActingActor }),
		input: z.null(),
		output: z.null()
	},
	{
		method: 'POST',
		path: '/keeper-auth',
		auth: {
			account: 'required',
			actor: 'required',
			roles: ['keeper'],
			credential_types: ['daemon_token']
		},
		handler: (c) => c.json({ ok: true }),
		description: 'Keeper route',
		query: z.strictObject({ acting: ActingActor }),
		input: z.null(),
		output: z.null()
	}
];

const build_apps = () => create_auth_test_apps(specs, ['admin', 'keeper']);

/** `ActingActor` is uuid-shaped, and query validation runs ahead of the gates. */
const ACTING = 'acting=00000000-0000-0000-0000-000000000000';

describe('select_auth_app', () => {
	test('public routes get the anonymous app', () => {
		const apps = build_apps();
		assert.strictEqual(select_auth_app(apps, { account: 'none', actor: 'none' }), apps.public);
	});

	test('a plain authenticated route gets the session app', () => {
		const apps = build_apps();
		assert.strictEqual(select_auth_app(apps, { account: 'required', actor: 'none' }), apps.authed);
	});

	test('a daemon-token gate gets the keeper app, whatever role it declares', () => {
		const apps = build_apps();
		assert.strictEqual(
			select_auth_app(apps, {
				account: 'required',
				actor: 'required',
				roles: ['keeper'],
				credential_types: ['daemon_token']
			}),
			apps.keeper
		);
	});

	test('a session gate falls through to the role app, which carries that channel', () => {
		const apps = build_apps();
		assert.strictEqual(
			select_auth_app(apps, {
				account: 'required',
				actor: 'required',
				roles: ['admin'],
				credential_types: ['session']
			}),
			apps.by_role.get('admin')
		);
	});

	test('a role-less gate on another channel gets that channel app', () => {
		const apps = build_apps();
		assert.strictEqual(
			select_auth_app(apps, {
				account: 'required',
				actor: 'none',
				credential_types: ['api_token']
			}),
			apps.by_credential_type.get('api_token')
		);
	});

	/**
	 * The one shape the harness cannot serve: the channel apps hold the keeper
	 * role, and only the session channel has per-role apps. Throwing names it;
	 * returning a session app would 403 at the channel gate and read as the
	 * role gate refusing a caller it never saw.
	 */
	test('a non-session channel paired with another role throws, naming both', () => {
		const apps = build_apps();
		assert.throws(
			() =>
				select_auth_app(apps, {
					account: 'required',
					actor: 'required',
					roles: ['admin'],
					credential_types: ['api_token']
				}),
			/No test app for credential types 'api_token' with roles 'admin'/
		);
	});

	test('a missing role app still throws, naming the role', () => {
		const apps = build_apps();
		assert.throws(
			() =>
				select_auth_app(apps, {
					account: 'required',
					actor: 'required',
					roles: ['steward']
				}),
			/No test app for role 'steward'/
		);
	});
});

describe('create_auth_test_apps', () => {
	test('the keeper app carries the daemon-token credential, the role apps a session', async () => {
		const apps = create_auth_test_apps(specs, ['admin', 'keeper']);
		// The keeper route admits only `daemon_token`; the admin route only
		// `session`. Each app passing its own route and being refused by the
		// other's channel gate is what makes the selector's choice meaningful.
		const keeper_res = await apps.keeper.request(`/keeper-auth?${ACTING}`, { method: 'POST' });
		assert.notStrictEqual(keeper_res.status, 403);
		const session_on_keeper = await apps.by_role
			.get('keeper')!
			.request(`/keeper-auth?${ACTING}`, { method: 'POST' });
		assert.strictEqual(session_on_keeper.status, 403);
		const daemon_on_admin = await apps.keeper.request(`/session-only-role?${ACTING}`);
		assert.strictEqual(daemon_on_admin.status, 403);
	});
});
