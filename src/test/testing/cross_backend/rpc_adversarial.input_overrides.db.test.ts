/**
 * `describe_rpc_adversarial_cross_tests`'s `input_overrides`, run in-process:
 * a method whose input the generator can't satisfy (a `check` pinning a
 * value) builds its params cases from the override. Without the wiring the
 * generated base fails the schema and collection throws, failing this file.
 * The cross-process legs run the suite over the spine, where no method needs
 * an override.
 *
 * @module
 */

import * as s from '@fuzdev/fuz_schema/schema.ts';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { RpcEndpointSpec } from '#lib/http/surface.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import { create_test_app_surface_spec } from '#lib/testing/stubs.ts';
import { default_in_process_setup } from '#lib/testing/cross_backend/in_process_setup.ts';
import { describe_rpc_adversarial_cross_tests } from '#lib/testing/cross_backend/rpc_adversarial.ts';

const session_options = create_session_config('test_rpc_adversarial_overrides_session');
const RPC_PATH = '/api/rpc';

// the envelope cases need a read beside the mutation
const gizmo_list_spec: RequestResponseActionSpec = {
	method: 'gizmo_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: s.object({ limit: s.optional(s.pipe(s.number, s.integer)) }),
	output: s.object({ items: s.array(s.string) }),
	async: true,
	description: 'List gizmos'
};

// a value the generator never produces, so only the override reaches a valid base
const gizmo_register_spec: RequestResponseActionSpec = {
	method: 'gizmo_register',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: s.pipe(
		s.object({ code: s.string, size: s.pipe(s.number, s.integer) }),
		s.check((v) => v.code === 'magic', 'code must be magic')
	),
	output: s.object({ ok: s.literal(true) }),
	async: true,
	description: 'Register a gizmo'
};

const rpc_endpoints: Array<RpcEndpointSpec> = [
	{
		path: RPC_PATH,
		actions: [
			{ spec: gizmo_list_spec, handler: () => ({ items: [] }) },
			{ spec: gizmo_register_spec, handler: () => ({ ok: true }) }
		]
	}
];

describe_rpc_adversarial_cross_tests({
	setup_test: default_in_process_setup({
		session_options,
		roles: [ROLE_KEEPER, ROLE_ADMIN],
		create_route_specs: () => [],
		rpc_endpoints
	}),
	surface_source: create_test_app_surface_spec({
		session_options,
		create_route_specs: () => [],
		rpc_endpoints
	}),
	rpc_path: RPC_PATH,
	input_overrides: new Map([['gizmo_register', { code: 'magic', size: 2 }]])
});
