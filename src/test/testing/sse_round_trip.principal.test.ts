/**
 * Tests for `pick_sse_route_principal`: a route admitting both the daemon
 * token and a session is opened with a session, and a stream no session
 * revoke can close throws while the revoke is asserted.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { pick_sse_route_principal } from '#lib/testing/sse_round_trip.ts';
import type { RouteAuth } from '#lib/http/auth_shape.ts';
import type { AuthPrincipal } from '#lib/testing/integration_helpers.ts';

const cases: Array<[label: string, auth: RouteAuth, expected: AuthPrincipal]> = [
	['session-only account route', { account: 'required', actor: 'none' }, 'authed'],
	['admin route', { account: 'required', actor: 'none', roles: ['admin'] }, 'admin'],
	['keeper route', { account: 'required', actor: 'none', roles: ['keeper'] }, 'keeper'],
	[
		'daemon token or session, no role',
		{ account: 'required', actor: 'none', credential_types: ['daemon_token', 'session'] },
		'authed'
	],
	[
		'daemon token or session, admin',
		{
			account: 'required',
			actor: 'none',
			roles: ['admin'],
			credential_types: ['daemon_token', 'session']
		},
		'admin'
	],
	[
		'daemon token or session, keeper',
		{
			account: 'required',
			actor: 'none',
			roles: ['keeper'],
			credential_types: ['daemon_token', 'session']
		},
		'keeper'
	]
];

describe('pick_sse_route_principal', () => {
	test.each(cases)('%s opens as a session principal', (_label, auth, expected) => {
		assert.strictEqual(pick_sse_route_principal('GET /s', auth, true), expected);
	});

	test('a daemon-token-only route throws while the revoke is asserted', () => {
		const auth: RouteAuth = {
			account: 'required',
			actor: 'none',
			roles: ['keeper'],
			credential_types: ['daemon_token']
		};
		assert.throws(
			() => pick_sse_route_principal('GET /s', auth, true),
			'GET /s: the stream opens as the daemon_token principal, which no session revoke can close — set `assert_closes_on_revoke: false`'
		);
		assert.strictEqual(pick_sse_route_principal('GET /s', auth, false), 'daemon_token');
	});

	test('a public route throws while the revoke is asserted', () => {
		const auth: RouteAuth = { account: 'none', actor: 'none' };
		assert.throws(() => pick_sse_route_principal('GET /s', auth, true), /the public principal/);
		assert.strictEqual(pick_sse_route_principal('GET /s', auth, false), 'public');
	});
});
