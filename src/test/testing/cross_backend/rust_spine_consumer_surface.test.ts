/**
 * Tests for `rust_spine_consumer_surface.ts` — the declared surface of a Rust
 * spine consumer: the account router's paths and no others, the domain specs
 * filtered to request-response non-protocol actions, `exclude_methods`, and the
 * extras and standard actions on the one RPC endpoint.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { protocol_action_specs } from '#lib/actions/protocol.ts';
import { actor_lookup_action_spec } from '#lib/auth/actor_lookup_action_specs.ts';
import { create_actor_search_actions } from '#lib/auth/actor_search_actions.ts';
import { role_grant_offer_received_notification_spec } from '#lib/auth/role_grant_offer_notifications.ts';
import { create_role_schema } from '#lib/auth/role_schema.ts';
import { fuz_session_config } from '#lib/auth/session_cookie.ts';
import type { ActionSpecUnion } from '#lib/actions/action_spec.ts';
import {
	ACCOUNT_ROUTER_PATHS,
	create_rust_spine_consumer_surface_spec
} from '#lib/testing/cross_backend/rust_spine_consumer_surface.ts';

const domain_action_specs: Array<ActionSpecUnion> = [
	...protocol_action_specs,
	actor_lookup_action_spec,
	role_grant_offer_received_notification_spec
];

const route_keys = (spec: ReturnType<typeof create_rust_spine_consumer_surface_spec>) =>
	spec.surface.routes.map((r) => `${r.method} ${r.path}`);

const rpc_methods = (spec: ReturnType<typeof create_rust_spine_consumer_surface_spec>) =>
	spec.surface.rpc_endpoints.flatMap((e) => e.methods.map((m) => m.name));

describe('create_rust_spine_consumer_surface_spec', () => {
	test('declares the routes the Rust spine mounts, and no /verify', () => {
		const spec = create_rust_spine_consumer_surface_spec({
			session_options: fuz_session_config,
			domain_action_specs
		});
		const keys = route_keys(spec);
		for (const key of [
			'GET /health',
			'GET /api/account/status',
			'POST /api/account/login',
			'POST /api/account/logout',
			'POST /api/account/password',
			'POST /api/account/signup',
			'POST /api/account/bootstrap',
			'POST /api/rpc'
		]) {
			assert.include(keys, key);
		}
		assert.notInclude(keys, 'GET /api/account/verify');
		const account_routes = keys.filter((k) => k.includes('/api/account/'));
		assert.deepStrictEqual(
			account_routes.map((k) => k.split(' ')[1]!.slice('/api/account'.length)).sort(),
			[...ACCOUNT_ROUTER_PATHS, '/signup', '/bootstrap'].sort()
		);
	});

	test('lists the daemon_token layer, and host_validation only with host_gate', () => {
		const without = create_rust_spine_consumer_surface_spec({
			session_options: fuz_session_config,
			domain_action_specs
		}).surface.middleware.map((m) => m.name);
		assert.include(without, 'daemon_token');
		assert.notInclude(without, 'host_validation');
		const with_gate = create_rust_spine_consumer_surface_spec({
			session_options: fuz_session_config,
			domain_action_specs,
			host_gate: true
		}).surface.middleware.map((m) => m.name);
		assert.strictEqual(with_gate[0], 'host_validation');
		assert.deepStrictEqual(with_gate.slice(1), without);
	});

	test('mounts the standard actions and the request-response domain specs only', () => {
		const spec = create_rust_spine_consumer_surface_spec({
			session_options: fuz_session_config,
			domain_action_specs
		});
		const methods = rpc_methods(spec);
		assert.include(methods, actor_lookup_action_spec.method);
		assert.include(methods, 'account_token_create');
		assert.include(methods, 'admin_account_list');
		for (const protocol of protocol_action_specs) assert.notInclude(methods, protocol.method);
		assert.notInclude(methods, role_grant_offer_received_notification_spec.method);
	});

	test('exclude_methods leaves a domain method off, and extras join the endpoint', () => {
		const spec = create_rust_spine_consumer_surface_spec({
			session_options: fuz_session_config,
			domain_action_specs,
			exclude_methods: [actor_lookup_action_spec.method],
			extra_rpc_actions: (ctx) => create_actor_search_actions({ log: ctx.deps.log }),
			roles: create_role_schema([])
		});
		const methods = rpc_methods(spec);
		assert.notInclude(methods, actor_lookup_action_spec.method);
		assert.include(methods, 'actor_search');
	});

	test('an exclude_methods entry naming no domain spec throws', () => {
		assert.throws(
			() =>
				create_rust_spine_consumer_surface_spec({
					session_options: fuz_session_config,
					domain_action_specs,
					exclude_methods: ['no_such_method']
				}),
			/no_such_method/
		);
	});
});
