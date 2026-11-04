/**
 * Tests for `assert_route_auth_invariants` — the cross-axis `RouteAuth`
 * invariants 1, 3, and 4, checked at registration on every route and action
 * spec: directly, through `compile_action_registry` (the loop behind
 * `create_rpc_endpoint` and `register_action_ws`), through
 * `apply_route_specs`, and through the assembled app.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { assert_route_auth_invariants, RouteAuth } from '#lib/http/auth_shape.ts';
import { compile_action_registry } from '#lib/actions/compile_action_registry.ts';
import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import { apply_route_specs, type RouteSpec } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_app_backend, create_stub_db } from '#lib/testing/stubs.ts';
import { create_loopback_app_server_options } from '#lib/testing/app_server.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_app_server } from '#lib/server/app_server.ts';

const log = new Logger('test', { level: 'off' });

const INVARIANT_1 = /auth\.roles requires auth\.actor === 'required'/;
const INVARIANT_3 = /auth\.account === 'none' && auth\.actor !== 'none' is not yet supported/;
const INVARIANT_4_ROLES = /unrestricted auth .* cannot declare roles/;
const INVARIANT_4_CREDENTIAL_TYPES = /unrestricted auth .* cannot declare credential_types/;

/** Each invariant's breaking shapes, with the message the check names. */
const VIOLATIONS: Array<{ name: string; auth: RouteAuth; message: RegExp }> = [
	{
		name: 'invariant 1: roles without an actor',
		auth: { account: 'required', actor: 'none', roles: ['admin'] },
		message: INVARIANT_1
	},
	{
		name: 'invariant 1: roles with an optional actor',
		auth: { account: 'required', actor: 'optional', roles: ['admin'] },
		message: INVARIANT_1
	},
	{
		name: 'invariant 3: an optional actor without an account',
		auth: { account: 'none', actor: 'optional' },
		message: INVARIANT_3
	},
	{
		name: 'invariant 3: a required actor without an account',
		auth: { account: 'none', actor: 'required' },
		message: INVARIANT_3
	},
	{
		name: 'invariant 4: roles on unrestricted auth',
		auth: { account: 'none', actor: 'none', roles: ['admin'] },
		message: INVARIANT_4_ROLES
	},
	{
		name: 'invariant 4: credential types on unrestricted auth',
		auth: { account: 'none', actor: 'none', credential_types: ['session'] },
		message: INVARIANT_4_CREDENTIAL_TYPES
	}
];

/** Shapes that keep every invariant, including the edges next to each one. */
const VALID: Array<RouteAuth> = [
	{ account: 'none', actor: 'none' },
	{ account: 'optional', actor: 'optional' },
	{ account: 'optional', actor: 'none' },
	{ account: 'required', actor: 'none' },
	{ account: 'required', actor: 'none', credential_types: ['session'] },
	{ account: 'required', actor: 'required', roles: ['admin'] },
	{ account: 'required', actor: 'none', roles: [] },
	{ account: 'none', actor: 'none', roles: [], credential_types: [] }
];

describe('assert_route_auth_invariants', () => {
	for (const { name, auth, message } of VIOLATIONS) {
		test(`refuses ${name}, naming the spec`, () => {
			assert.throws(() => assert_route_auth_invariants(auth, 'Spec "thing"'), message);
			assert.throws(
				() => assert_route_auth_invariants(auth, 'Spec "thing"'),
				/^Spec "thing": .*\(registry-time invariants\)$/
			);
		});
	}

	for (const auth of VALID) {
		test(`admits ${JSON.stringify(auth)}`, () => {
			assert_route_auth_invariants(auth, 'Spec "thing"');
		});
	}

	test('names every invariant a shape breaks', () => {
		// roles on unrestricted auth break invariant 1 as well as 4
		assert.throws(
			() =>
				assert_route_auth_invariants(
					{ account: 'none', actor: 'none', roles: ['admin'], credential_types: ['session'] },
					'Spec "thing"'
				),
			new RegExp(
				`${INVARIANT_1.source}.*; .*${INVARIANT_4_ROLES.source}.*; .*${INVARIANT_4_CREDENTIAL_TYPES.source}`
			)
		);
	});

	test('the RouteAuth schema reports the same violations on a parse', () => {
		for (const { auth, message } of VIOLATIONS) {
			const parsed = RouteAuth.safeParse(auth);
			assert.ok(!parsed.success);
			assert.ok(
				parsed.error.issues.some((issue) => message.test(issue.message)),
				`expected ${message} among the parse issues`
			);
		}
		for (const auth of VALID) assert.ok(RouteAuth.safeParse(auth).success);
	});
});

const create_action_spec = (auth: RouteAuth): RequestResponseActionSpec => ({
	method: 'thing_get',
	kind: 'request_response',
	initiator: 'frontend',
	auth,
	side_effects: false,
	input: z.strictObject({ id: z.string() }),
	output: z.null(),
	async: true,
	description: 'Get a thing'
});

describe('compile_action_registry refuses a spec breaking a cross-axis invariant', () => {
	for (const { name, auth, message } of VIOLATIONS) {
		test(name, () => {
			const action = { spec: create_action_spec(auth), handler: () => null };
			assert.throws(() => compile_action_registry([action], 'RPC action'), message);
			assert.throws(
				() => compile_action_registry([action], 'WS action'),
				/^WS action "thing_get": /
			);
			// a handler-less spec is checked too, as with the biconditional
			assert.throws(
				() => compile_action_registry([{ spec: create_action_spec(auth) }], 'WS action'),
				message
			);
		});
	}

	test('before the biconditional', () => {
		// breaks invariant 3 and, declaring no `acting`, the biconditional: the
		// shape's own invariant is the error
		const action = {
			spec: create_action_spec({ account: 'none', actor: 'required' }),
			handler: () => null
		};
		assert.throws(() => compile_action_registry([action], 'RPC action'), INVARIANT_3);
	});
});

const create_route_spec = (auth: RouteAuth, path = '/things'): RouteSpec => ({
	method: 'POST',
	path,
	auth,
	handler: (c) => c.json(null),
	description: 'Create a thing',
	input: z.strictObject({ name: z.string() }),
	output: z.null()
});

describe('apply_route_specs refuses a spec breaking a cross-axis invariant', () => {
	for (const { name, auth, message } of VIOLATIONS) {
		test(name, () => {
			const apply = () =>
				apply_route_specs(
					new Hono(),
					[create_route_spec(auth)],
					fuz_auth_guard_resolver,
					log,
					create_stub_db()
				);
			assert.throws(apply, message);
			assert.throws(apply, /^Route "POST \/things": /);
		});
	}

	test('before the biconditional', () => {
		assert.throws(
			() =>
				apply_route_specs(
					new Hono(),
					[create_route_spec({ account: 'none', actor: 'optional' })],
					fuz_auth_guard_resolver,
					log,
					create_stub_db()
				),
			INVARIANT_3
		);
	});
});

describe('create_app_server refuses a spec breaking a cross-axis invariant at assembly', () => {
	const base_options = () => ({
		...create_loopback_app_server_options(),
		backend: create_stub_app_backend(),
		session_options: create_session_config('test_session')
	});

	test('a route spec', async () => {
		const auth: RouteAuth = { account: 'required', actor: 'none', roles: ['admin'] };
		let thrown: unknown;
		try {
			await create_app_server({
				...base_options(),
				// under the auth middleware's path, so it's this check that refuses it
				create_route_specs: () => [create_route_spec(auth, '/api/things')]
			});
		} catch (error) {
			thrown = error;
		}
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /^Route "POST \/api\/things": /);
		assert.match(thrown.message, INVARIANT_1);
	});

	test('an action spec on an rpc endpoint', async () => {
		const auth: RouteAuth = { account: 'none', actor: 'none', credential_types: ['session'] };
		let thrown: unknown;
		try {
			await create_app_server({
				...base_options(),
				create_route_specs: () => [],
				rpc_endpoints: [
					{ path: '/api/rpc', actions: [{ spec: create_action_spec(auth), handler: () => null }] }
				]
			});
		} catch (error) {
			thrown = error;
		}
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /^RPC action "thing_get": /);
		assert.match(thrown.message, INVARIANT_4_CREDENTIAL_TYPES);
	});
});
