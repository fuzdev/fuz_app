/**
 * Two RPC endpoints at one path for the `skip_methods` tests: the declared one
 * (`widget_get`, `widget_burn`) and a live mount adding `widget_secret`.
 *
 * @module
 */

import { object } from '@fuzdev/fuz_schema/schema.ts';

import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import { create_app_surface_spec, type RpcEndpointSpec } from '#lib/http/surface.ts';

export const SKIP_RPC_PATH = '/api/rpc';

const widget_spec = (method: string, side_effects: boolean): RequestResponseActionSpec => ({
	method,
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects,
	input: object({}),
	output: object({}),
	async: true,
	description: `The ${method} method.`
});

const action = (method: string, side_effects: boolean) => ({
	spec: widget_spec(method, side_effects),
	handler: async () => ({})
});

export const skip_declared_endpoints: Array<RpcEndpointSpec> = [
	{ path: SKIP_RPC_PATH, actions: [action('widget_get', false), action('widget_burn', true)] }
];

export const skip_live_endpoints: Array<RpcEndpointSpec> = [
	{
		path: SKIP_RPC_PATH,
		actions: [...skip_declared_endpoints[0]!.actions, action('widget_secret', true)]
	}
];

export const skip_surface_source = create_app_surface_spec({
	route_specs: [],
	middleware_specs: [],
	rpc_endpoints: skip_declared_endpoints
});
