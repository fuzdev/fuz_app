/**
 * `describe_rpc_attack_surface_tests`'s `input_overrides`: a method whose
 * input the generator can't satisfy (a `.refine()` pinning a value) builds its
 * params cases from the override. Without the wiring the generated base fails
 * the schema and collection throws, failing this file.
 *
 * @module
 */

import { z } from 'zod';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import { create_test_app_surface_spec } from '#lib/testing/stubs.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { describe_rpc_attack_surface_tests } from '#lib/testing/rpc_attack_surface.ts';

// a value the generator never produces, so only the override reaches a valid base
const gizmo_register_spec: RequestResponseActionSpec = {
	method: 'gizmo_register',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: z
		.strictObject({ code: z.string(), size: z.number().int() })
		.refine((v) => v.code === 'magic', { message: 'code must be magic' }),
	output: z.strictObject({ ok: z.literal(true) }),
	async: true,
	description: 'Register a gizmo'
};

describe_rpc_attack_surface_tests({
	build: () =>
		create_test_app_surface_spec({
			session_options: create_session_config('test_rpc_overrides_session'),
			create_route_specs: () => [],
			rpc_endpoints: [
				{
					path: '/api/rpc',
					actions: [{ spec: gizmo_register_spec, handler: () => ({ ok: true }) }]
				}
			]
		}),
	roles: ['admin', 'keeper'],
	input_overrides: new Map([['gizmo_register', { code: 'magic', size: 2 }]])
});
