/**
 * The route, middleware and surface assembly `create_app_server` shares with
 * `create_test_app_surface_spec` (`testing/stubs.ts`).
 *
 * One function decides the route order (consumer routes, then bootstrap, RPC
 * endpoints, and the surface route), the middleware list (the transformed
 * stack between the body limit and the post-route middleware), and the event
 * specs (the audit stream's when the context carries one), so the stub
 * surface the standard suites read can't drift from what the live server
 * mounts. The callers build what differs — real or stub middleware handlers,
 * live or stub bootstrap handlers, the server's own WS mount checks — and
 * pass it in. Hono-free, so cross-process test consumers can import it.
 *
 * @module
 */

import type { AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import type { AppServerContext } from './app_server_context.ts';
import { BaseServerEnv } from './env.ts';
import { create_surface_route_spec, type SurfaceRouteOptions } from './surface_route.ts';
import { audit_log_event_specs } from '../realtime/audit_log_sse.ts';
import type { EventSpec } from '../realtime/sse.ts';
import {
	create_app_surface_spec,
	type AppSurfaceSpec,
	type RpcEndpointSpec
} from '../http/surface.ts';
import { prefix_route_specs, type RouteSpec } from '../http/route_spec.ts';
import type { MiddlewareSpec } from '../http/middleware_spec.ts';
import {
	assert_credential_routes_in_auth_scope,
	assert_endpoint_in_auth_scope,
	assert_middleware_stack_mounted
} from '../auth/middleware.ts';
import { create_rpc_endpoint } from '../actions/action_rpc.ts';
import {
	resolve_ws_endpoints,
	type ResolvedWsEndpointSpec,
	type WsEndpointSpec
} from '../actions/ws_endpoint_spec.ts';

/** Input for `assemble_app_surface`. */
export interface AssembleAppSurfaceOptions {
	/** The context the consumer's factories run against. Its `audit_sse` adds the audit event specs. */
	context: AppServerContext;
	/** `AppServerOptions.create_route_specs`. */
	create_route_specs: (context: AppServerContext) => Array<RouteSpec>;
	/** The bootstrap routes, unprefixed, and their prefix — `null` when bootstrap is not mounted. */
	bootstrap: { route_prefix: string; routes: Array<RouteSpec> } | null;
	/** `AppServerOptions.rpc_endpoints`. */
	rpc_endpoints:
		Array<RpcEndpointSpec> | ((context: AppServerContext) => Array<RpcEndpointSpec>) | undefined;
	/** `AppServerOptions.ws_endpoints`. */
	ws_endpoints:
		| ReadonlyArray<WsEndpointSpec>
		| ((context: AppServerContext) => ReadonlyArray<WsEndpointSpec>)
		| undefined;
	/**
	 * The server's origin allowlist, the default for a WS endpoint that names
	 * none. `null` when there is no server list (a stub surface): every WS
	 * endpoint must then carry its own.
	 */
	allowed_origins: ReadonlyArray<RegExp> | null;
	/** `AppServerOptions.surface_route`. */
	surface_route: boolean;
	/** The host gate (when on), the trusted proxy, then the auth stack. */
	stack_specs: Array<MiddlewareSpec>;
	/** `AppServerOptions.transform_middleware`. */
	transform_middleware: ((specs: Array<MiddlewareSpec>) => Array<MiddlewareSpec>) | undefined;
	/** The body limit's spec, `null` when the limit is disabled. */
	body_limit_spec: MiddlewareSpec | null;
	/** `AppServerOptions.post_route_middleware`. */
	post_route_middleware: Array<MiddlewareSpec> | undefined;
	/** `AppServerOptions.env_schema`; defaults to `BaseServerEnv`. */
	env_schema: AnySchema | undefined;
	/** `AppServerOptions.event_specs`. */
	event_specs: Array<EventSpec> | undefined;
}

/** What `assemble_app_surface` assembled. */
export interface AppSurfaceAssembly {
	/** Every route spec in mount order: consumer, bootstrap, RPC, then the surface route. */
	route_specs: Array<RouteSpec>;
	/** The stack after `transform_middleware`, mounted after the body limit. */
	middleware_specs: Array<MiddlewareSpec>;
	/** The resolved RPC endpoints. */
	rpc_endpoints: Array<RpcEndpointSpec> | undefined;
	/** The resolved WS endpoints, each with its `allowed_origins` and `actions`. */
	ws_endpoints: Array<ResolvedWsEndpointSpec> | undefined;
	/** The generated surface. `GET /api/surface`, when mounted, serves its `surface`. */
	surface_spec: AppSurfaceSpec;
}

/**
 * Assemble the routes, middleware list and surface of an app server.
 *
 * Refuses an endpoint or bootstrap path outside the auth middleware's scope
 * (`assert_endpoint_in_auth_scope`), a route that reads or mints a credential
 * outside it (`assert_credential_routes_in_auth_scope`), and a
 * `transform_middleware` that doesn't keep the stack mounted
 * (`assert_middleware_stack_mounted`).
 *
 * @param options - the context, the consumer's factories, and the built stack
 * @returns the route specs, transformed middleware, resolved endpoints, and surface
 * @throws Error on any of the refusals above, or when `allowed_origins` is
 *   `null` and a WS endpoint declares no `allowed_origins`
 */
export const assemble_app_surface = (options: AssembleAppSurfaceOptions): AppSurfaceAssembly => {
	const { context, stack_specs } = options;

	let middleware_specs = stack_specs;
	if (options.transform_middleware) {
		// the transform gets copies in a fresh array, so mutating what it was
		// handed can't rewrite the originals the check matches against
		middleware_specs = options.transform_middleware(stack_specs.map((spec) => ({ ...spec })));
		assert_middleware_stack_mounted(stack_specs, middleware_specs);
	}

	const consumer_routes = options.create_route_specs(context);

	// factory-managed routes, appended after the consumer's
	const factory_routes: Array<RouteSpec> = [];

	if (options.bootstrap) {
		const prefixed = prefix_route_specs(options.bootstrap.route_prefix, options.bootstrap.routes);
		for (const route of prefixed) {
			assert_endpoint_in_auth_scope('bootstrap.route_prefix', route.path);
		}
		factory_routes.push(...prefixed);
	}

	// RPC endpoints — resolved once, so the surface and live dispatch share them
	const rpc_endpoints =
		typeof options.rpc_endpoints === 'function'
			? options.rpc_endpoints(context)
			: options.rpc_endpoints;
	if (rpc_endpoints) {
		for (const endpoint of rpc_endpoints) {
			assert_endpoint_in_auth_scope('rpc_endpoints', endpoint.path);
			factory_routes.push(
				...create_rpc_endpoint({
					path: endpoint.path,
					actions: endpoint.actions,
					log: context.deps.log,
					action_ip_rate_limiter: context.action_ip_rate_limiter,
					action_account_rate_limiter: context.action_account_rate_limiter,
					notification_sender: context.deps.notification_sender
				})
			);
		}
	}

	// WS endpoints — a spec without `allowed_origins` takes the server's list,
	// and one without `actions` the sole RPC endpoint's
	const declared_ws_endpoints =
		typeof options.ws_endpoints === 'function'
			? options.ws_endpoints(context)
			: options.ws_endpoints;
	const { allowed_origins } = options;
	const ws_endpoints = resolve_ws_endpoints(
		allowed_origins ? declared_ws_endpoints : declared_ws_endpoints?.map(assert_own_ws_origins),
		// with no server list every spec carries its own, so the empty default never applies
		{ allowed_origins: allowed_origins ?? [], rpc_endpoints }
	);
	for (const endpoint of ws_endpoints ?? []) {
		assert_endpoint_in_auth_scope('ws_endpoints', endpoint.path);
	}

	// the surface route serves the surface generated below, backfilled into the same ref
	const surface_ref: SurfaceRouteOptions = {
		surface: {
			middleware: [],
			routes: [],
			rpc_endpoints: [],
			ws_endpoints: [],
			env: [],
			events: [],
			diagnostics: []
		}
	};
	if (options.surface_route) {
		factory_routes.push(create_surface_route_spec(surface_ref));
	}

	const route_specs = [...consumer_routes, ...factory_routes];
	// a route that reads or mints a credential outside the auth scope would
	// skip session parsing or fall under an origin carve-out — consumer
	// prefixes included (account and signup specs are relative)
	assert_credential_routes_in_auth_scope(route_specs);

	// the body limit first, where it runs, then the stack, then the post-route layers
	const surface_middleware = [
		...(options.body_limit_spec ? [options.body_limit_spec] : []),
		...middleware_specs,
		...(options.post_route_middleware ?? [])
	];
	const surface_spec = create_app_surface_spec({
		middleware_specs: surface_middleware,
		route_specs,
		env_schema: options.env_schema ?? BaseServerEnv,
		event_specs: [
			...(options.event_specs ?? []),
			...(context.audit_sse ? audit_log_event_specs : [])
		],
		rpc_endpoints,
		ws_endpoints
	});
	surface_ref.surface = surface_spec.surface;

	return { route_specs, middleware_specs, rpc_endpoints, ws_endpoints, surface_spec };
};

/**
 * Check that a WS endpoint spec carries its own `allowed_origins` — the only
 * way it resolves when no server list is given to default from.
 *
 * @throws Error when the spec declares no `allowed_origins`
 */
const assert_own_ws_origins = (endpoint: WsEndpointSpec): WsEndpointSpec => {
	if (!endpoint.allowed_origins) {
		throw new Error(
			`assemble_app_surface: ws endpoint ${endpoint.path} has no allowed_origins — ` +
				"pass the server's list (create_test_app_surface_spec's allowed_origins option), " +
				'or set allowed_origins on the spec'
		);
	}
	return endpoint;
};
