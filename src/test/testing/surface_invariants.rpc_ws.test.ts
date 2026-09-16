/**
 * Tests for the RPC / WS surface invariants in `surface_invariants.ts`.
 *
 * Parallel of `surface_invariants.test.ts` (which covers route-level
 * invariants) for the `surface.rpc_endpoints` + `surface.ws_endpoints`
 * slots produced by `generate_app_surface`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';

import {
	assert_rpc_method_descriptions_present,
	assert_ws_method_descriptions_present,
	assert_ws_endpoints_include_protocol_actions,
	assert_ws_notifications_have_null_auth,
	assert_no_testing_methods,
	assert_rpc_ws_surface_invariants
} from '$lib/testing/surface_invariants.ts';
import { create_spine_surface_spec } from '$lib/testing/cross_backend/default_spine_surface.ts';
import { generate_app_surface, type AppSurface } from '$lib/http/surface.ts';
import type {
	RequestResponseActionSpec,
	RemoteNotificationActionSpec
} from '$lib/actions/action_spec.ts';
import type { RpcAction } from '$lib/actions/action_rpc.ts';
import { protocol_actions } from '$lib/actions/protocol.ts';

const rpc_account_verify_spec: RequestResponseActionSpec = {
	method: 'account_verify',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.strictObject({}),
	output: z.strictObject({}),
	async: true,
	description: 'Verify the session.'
};

const rpc_admin_list_spec: RequestResponseActionSpec = {
	method: 'admin_account_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'required', roles: ['admin'] },
	side_effects: false,
	input: z.strictObject({ acting: z.strictObject({ actor_id: z.string() }) }),
	output: z.strictObject({}),
	async: true,
	description: 'List accounts.'
};

const ws_account_verify_spec: RequestResponseActionSpec = {
	method: 'ws_account_verify',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.strictObject({}),
	output: z.strictObject({}),
	async: true,
	description: 'Verify session over WS.'
};

const ws_role_grant_offer_received_spec: RemoteNotificationActionSpec = {
	method: 'role_grant_offer_received',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({ offer: z.strictObject({ id: z.string() }) }),
	output: z.void(),
	async: true,
	description: 'Notify recipient of a new role-grant offer.'
};

/** A `_testing_*` backdoor spec — must never reach a declared surface. */
const rpc_testing_reset_spec: RequestResponseActionSpec = {
	method: '_testing_reset',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none', credential_types: ['daemon_token'] },
	side_effects: true,
	input: z.strictObject({}),
	output: z.strictObject({}),
	async: true,
	description: 'Test-binary only — wipe + re-seed.'
};

const rpc_action = (spec: RequestResponseActionSpec): RpcAction => ({
	spec,
	handler: async () => ({})
});

const noop_handler = async () => ({});

/** Surface with one populated RPC endpoint and one WS endpoint that obeys every invariant. */
const build_valid_surface = (): AppSurface =>
	generate_app_surface({
		route_specs: [],
		middleware_specs: [],
		rpc_endpoints: [
			{
				path: '/api/rpc',
				actions: [rpc_action(rpc_account_verify_spec), rpc_action(rpc_admin_list_spec)]
			}
		],
		ws_endpoints: [
			{
				path: '/api/ws',
				allowed_origins: [],
				required_roles: [],
				actions: [
					...protocol_actions,
					{ spec: ws_account_verify_spec, handler: noop_handler },
					{ spec: ws_role_grant_offer_received_spec }
				]
			}
		]
	});

describe('assert_rpc_method_descriptions_present', () => {
	test('passes for well-formed surface', () => {
		assert_rpc_method_descriptions_present(build_valid_surface());
	});

	test('passes when there are no rpc endpoints', () => {
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [] });
		assert_rpc_method_descriptions_present(surface);
	});

	test('fails when an rpc method has empty description', () => {
		const surface = build_valid_surface();
		surface.rpc_endpoints[0]!.methods[0]!.description = '';
		assert.throws(
			() => assert_rpc_method_descriptions_present(surface),
			/'account_verify'.*'\/api\/rpc'.*empty description/
		);
	});
});

describe('assert_ws_method_descriptions_present', () => {
	test('passes for well-formed surface', () => {
		assert_ws_method_descriptions_present(build_valid_surface());
	});

	test('passes when there are no ws endpoints', () => {
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [] });
		assert_ws_method_descriptions_present(surface);
	});

	test('fails when a ws method has empty description', () => {
		const surface = build_valid_surface();
		const target = surface.ws_endpoints[0]!.methods.find((m) => m.name === 'ws_account_verify')!;
		target.description = '';
		assert.throws(
			() => assert_ws_method_descriptions_present(surface),
			/'ws_account_verify'.*'\/api\/ws'.*empty description/
		);
	});
});

describe('assert_ws_endpoints_include_protocol_actions', () => {
	test('passes when heartbeat + cancel are spread in', () => {
		assert_ws_endpoints_include_protocol_actions(build_valid_surface());
	});

	test('passes when there are no ws endpoints', () => {
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [] });
		assert_ws_endpoints_include_protocol_actions(surface);
	});

	test('fails when an endpoint omits heartbeat', () => {
		const surface = build_valid_surface();
		surface.ws_endpoints[0]!.methods = surface.ws_endpoints[0]!.methods.filter(
			(m) => m.name !== 'heartbeat'
		);
		assert.throws(
			() => assert_ws_endpoints_include_protocol_actions(surface),
			/missing protocol action method 'heartbeat'/
		);
	});

	test('fails when an endpoint omits cancel', () => {
		const surface = build_valid_surface();
		surface.ws_endpoints[0]!.methods = surface.ws_endpoints[0]!.methods.filter(
			(m) => m.name !== 'cancel'
		);
		assert.throws(
			() => assert_ws_endpoints_include_protocol_actions(surface),
			/missing protocol action method 'cancel'/
		);
	});
});

describe('assert_ws_notifications_have_null_auth', () => {
	test('passes for well-formed surface', () => {
		assert_ws_notifications_have_null_auth(build_valid_surface());
	});

	test('passes when there are no ws endpoints', () => {
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [] });
		assert_ws_notifications_have_null_auth(surface);
	});

	test('fails when a notification has non-null auth', () => {
		const surface = build_valid_surface();
		const notification = surface.ws_endpoints[0]!.methods.find(
			(m) => m.kind === 'remote_notification'
		)!;
		notification.auth = { account: 'required', actor: 'none' };
		assert.throws(() => assert_ws_notifications_have_null_auth(surface), /violates kind ⇔ auth/);
	});

	test('fails when a request_response method has null auth', () => {
		const surface = build_valid_surface();
		const rr = surface.ws_endpoints[0]!.methods.find((m) => m.name === 'ws_account_verify')!;
		rr.auth = null;
		assert.throws(() => assert_ws_notifications_have_null_auth(surface), /violates kind ⇔ auth/);
	});
});

describe('assert_no_testing_methods', () => {
	test('passes for a surface with no testing methods', () => {
		assert_no_testing_methods(build_valid_surface());
	});

	test('passes for an empty surface', () => {
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [] });
		assert_no_testing_methods(surface);
	});

	test('passes for the real declared spine surface', () => {
		// The canonical artifact: fuz_app's own no-domain spine surface must
		// never carry a `_testing_*` backdoor (they're live-mounted on the
		// binary's RPC endpoint, off `spine_rpc_endpoints`).
		assert_no_testing_methods(create_spine_surface_spec().surface);
	});

	test('fails when an rpc endpoint exposes a `_testing_*` method', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			rpc_endpoints: [
				{
					path: '/api/rpc',
					actions: [rpc_action(rpc_account_verify_spec), rpc_action(rpc_testing_reset_spec)]
				}
			]
		});
		assert.throws(
			() => assert_no_testing_methods(surface),
			/exposes test-backdoor method '_testing_reset'/
		);
	});

	test('fails when a ws endpoint exposes a `_testing_*` method', () => {
		const surface = build_valid_surface();
		// No real `_testing_*` WS spec exists (they're RPC-only), so inject one
		// to prove the WS arm of the invariant fires too.
		const cloned = surface.ws_endpoints[0]!.methods[0]!;
		surface.ws_endpoints[0]!.methods.push({ ...cloned, name: '_testing_ws_backdoor' });
		assert.throws(
			() => assert_no_testing_methods(surface),
			/exposes test-backdoor method '_testing_ws_backdoor'/
		);
	});
});

describe('assert_rpc_ws_surface_invariants', () => {
	test('passes for well-formed surface', () => {
		assert_rpc_ws_surface_invariants(build_valid_surface());
	});

	test('passes for an empty surface', () => {
		const surface = generate_app_surface({ route_specs: [], middleware_specs: [] });
		assert_rpc_ws_surface_invariants(surface);
	});

	test('fails on the first violation it encounters', () => {
		const surface = build_valid_surface();
		surface.rpc_endpoints[0]!.methods[0]!.description = '';
		assert.throws(() => assert_rpc_ws_surface_invariants(surface), /empty description/);
	});

	test('runs the ws invariants when rpc invariants pass', () => {
		const surface = build_valid_surface();
		const notification = surface.ws_endpoints[0]!.methods.find(
			(m) => m.kind === 'remote_notification'
		)!;
		notification.auth = { account: 'required', actor: 'none' };
		assert.throws(() => assert_rpc_ws_surface_invariants(surface), /violates kind ⇔ auth/);
	});

	test('runs the no-testing-methods invariant', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			rpc_endpoints: [{ path: '/api/rpc', actions: [rpc_action(rpc_testing_reset_spec)] }]
		});
		assert.throws(() => assert_rpc_ws_surface_invariants(surface), /test-backdoor method/);
	});
});
