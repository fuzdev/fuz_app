import '../assert_dev_env.ts';

/**
 * The declared surface of a consumer served by the Rust spine, for its cross
 * suites — `create_rust_spine_consumer_surface_spec`.
 *
 * The usual Rust spine consumer server mounts the same spine routes whatever
 * its domain: `/health`, `fuz_auth::account_router` under `/api/account`
 * (`ACCOUNT_ROUTER_PATHS`), the bootstrap and signup routers beside it, and
 * one RPC endpoint carrying the standard admin / role-grant-offer / account
 * actions plus the consumer's own. This module builds that surface from the
 * hono-free route shapes and the consumer's action specs, so a consumer
 * supplies only what is its own. A server that mounts no signup router (a
 * single-keeper daemon such as mageguild's) is not this shape.
 *
 * The route shapes come from `create_account_route_shapes` and friends, never
 * the live route factories, which statically pull `hono/cookie` and
 * `hono/streaming`. Handlers are never invoked — the suites read `method`,
 * `path`, `auth` and the schemas, and live dispatch happens in the spawned
 * binary — so routes and actions carry no-op handlers.
 *
 * @module
 */

import type { ActionHandler, RpcAction } from '../../actions/action_rpc.ts';
import type { ActionSpecUnion, RequestResponseActionSpec } from '../../actions/action_spec.ts';
import { is_protocol_action_method } from '../../actions/action_codegen.ts';
import {
	account_status_route_shape,
	create_account_route_shapes
} from '../../auth/account_route_schema.ts';
import type { RoleSchemaResult } from '../../auth/role_schema.ts';
import type { SessionOptions } from '../../auth/session_cookie.ts';
import { create_signup_route_shape } from '../../auth/signup_route_schema.ts';
import { create_standard_rpc_actions } from '../../auth/standard_rpc_actions.ts';
import { create_health_route_spec } from '../../http/common_routes.ts';
import type { MiddlewareSpec } from '../../http/middleware_spec.ts';
import { prefix_route_specs, type RouteSpec } from '../../http/route_spec.ts';
import type { AppSurfaceSpec, RpcEndpointSpec } from '../../http/surface.ts';
import type { AppServerContext } from '../../server/app_server_context.ts';
import { create_test_app_surface_spec, stub_handler, stub_mw } from '../stubs.ts';
import { SPINE_ACCOUNT_PATH_PREFIX, SPINE_RPC_PATH } from './spine_surface_constants.ts';

/**
 * The routes `fuz_auth::account_router` mounts, relative to `/api/account`. An
 * allowlist rather than every account route shape: `/verify` is a TS-only
 * route the Rust router doesn't serve, so declaring it would have the suites
 * probe a 404. A shape fuz_app renames or drops fails the surface build; one
 * it adds stays off the surface until the Rust router mounts it and this list
 * names it.
 */
export const ACCOUNT_ROUTER_PATHS = ['/status', '/login', '/logout', '/password'] as const;

/** Surface generation never invokes handlers — see the module doc. */
const noop_action_handler = (async () => undefined) as unknown as ActionHandler;

const to_route_spec = (shape: Omit<RouteSpec, 'handler'>): RouteSpec => ({
	...shape,
	handler: stub_handler
});

/** Options for `create_rust_spine_consumer_rpc_endpoints`. */
export interface RustSpineConsumerRpcEndpointsOptions {
	/**
	 * The consumer's own action specs. The request-response specs that aren't
	 * protocol actions (`heartbeat`, `peer/ping`, …) go on the RPC endpoint, so a
	 * full registry like `all_action_specs` can be passed as it is.
	 */
	readonly domain_action_specs: ReadonlyArray<ActionSpecUnion>;
	/**
	 * Actions besides the standard set and the domain specs — opt-in families
	 * the consumer mounts (`create_actor_lookup_actions`,
	 * `create_self_service_role_actions`), built against the stub context.
	 */
	readonly extra_rpc_actions?: (ctx: AppServerContext) => Array<RpcAction>;
	/** The consumer's role schema, for the standard admin and role-grant-offer actions. */
	readonly roles?: RoleSchemaResult;
	/**
	 * Domain methods kept off the declared surface — ones the spec-derived
	 * suites can't drive (an input whose `.refine()` the generic body generator
	 * can't satisfy). They stay mounted on the backend; this only leaves them
	 * out of what the suites enumerate.
	 */
	readonly exclude_methods?: ReadonlyArray<string>;
	/** The RPC endpoint's path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/** Options for `create_rust_spine_consumer_surface_spec`. */
export interface RustSpineConsumerSurfaceSpecOptions extends RustSpineConsumerRpcEndpointsOptions {
	/** The backend's session config — its cookie name above all. */
	readonly session_options: SessionOptions<string>;
	/**
	 * Whether the server turns on the spine's opt-in host gate
	 * (`fuz_http::StackOptions::host_gate`), declared as a `host_validation`
	 * layer at the head of the middleware list.
	 *
	 * @default false
	 */
	readonly host_gate?: boolean;
}

/**
 * The RPC endpoints a Rust spine consumer mounts: the standard admin /
 * role-grant-offer / account actions, the extra families, then the domain
 * specs — what `describe_spine_cross_suites` takes as `rpc_endpoints`.
 *
 * @param options - the consumer's action specs, extras and roles
 * @returns the endpoints, as a factory of the stub context
 * @throws Error when an `exclude_methods` entry names no domain spec
 */
export const create_rust_spine_consumer_rpc_endpoints = (
	options: RustSpineConsumerRpcEndpointsOptions
): ((ctx: AppServerContext) => Array<RpcEndpointSpec>) => {
	const {
		domain_action_specs,
		extra_rpc_actions,
		roles,
		exclude_methods = [],
		rpc_path = SPINE_RPC_PATH
	} = options;
	const excluded = new Set(exclude_methods);
	for (const method of excluded) {
		if (!domain_action_specs.some((spec) => spec.method === method)) {
			throw new Error(
				`create_rust_spine_consumer_rpc_endpoints: exclude_methods names '${method}', ` +
					'which is not among the domain action specs'
			);
		}
	}
	const domain_actions: Array<RpcAction> = domain_action_specs
		.filter((spec): spec is RequestResponseActionSpec => spec.kind === 'request_response')
		.filter((spec) => !is_protocol_action_method(spec.method) && !excluded.has(spec.method))
		.map((spec) => ({ spec, handler: noop_action_handler }));
	return (ctx) => [
		{
			path: rpc_path,
			actions: [
				...create_standard_rpc_actions(ctx.deps, roles ? { roles } : {}),
				...(extra_rpc_actions?.(ctx) ?? []),
				...domain_actions
			]
		}
	];
};

/**
 * The spine routes a Rust spine consumer serves, outside the RPC endpoint:
 * `/health`, the `ACCOUNT_ROUTER_PATHS` under `/api/account`, and signup
 * beside them (bootstrap is added by `create_test_app_surface_spec`).
 */
const create_spine_consumer_route_specs = (ctx: AppServerContext): Array<RouteSpec> => {
	const shapes = [
		account_status_route_shape,
		...create_account_route_shapes({
			login_account_rate_limited: ctx.login_account_rate_limiter !== null
		})
	];
	const account_router_shapes = ACCOUNT_ROUTER_PATHS.map((path) => {
		const shape = shapes.find((candidate) => candidate.path === path);
		if (!shape) throw new Error(`fuz_app's account route shapes have no '${path}'`);
		return shape;
	});
	return [
		create_health_route_spec(),
		...prefix_route_specs(
			SPINE_ACCOUNT_PATH_PREFIX,
			[
				...account_router_shapes,
				create_signup_route_shape({
					signup_account_rate_limited: ctx.signup_account_rate_limiter !== null
				})
			].map(to_route_spec)
		)
	];
};

/**
 * Build the declared surface of a Rust spine consumer for its cross suites,
 * on `create_test_app_surface_spec`: the spine routes (health, the account
 * router's paths, signup, and bootstrap as a `surface_only` shape), the RPC
 * endpoint from `create_rust_spine_consumer_rpc_endpoints`, the daemon-token
 * layer every consumer test binary wires, and — with `host_gate` — the
 * `host_validation` layer at the head of the middleware list.
 *
 * @param options - the consumer's session config, action specs, extras and roles
 * @returns the surface spec, for `describe_spine_cross_suites`'s `surface_source`
 * @throws Error when an account route shape the Rust router mounts is missing,
 *   or an `exclude_methods` entry names no domain spec
 */
export const create_rust_spine_consumer_surface_spec = (
	options: RustSpineConsumerSurfaceSpecOptions
): AppSurfaceSpec =>
	create_test_app_surface_spec({
		session_options: options.session_options,
		create_route_specs: create_spine_consumer_route_specs,
		rpc_endpoints: create_rust_spine_consumer_rpc_endpoints(options),
		// the binaries mount `bootstrap_router`; `surface_only` declares its shape
		bootstrap: { mode: 'surface_only' },
		// consumer test binaries wire a daemon-token state (production ones don't)
		daemon_token: true,
		transform_middleware: options.host_gate
			? (specs: Array<MiddlewareSpec>): Array<MiddlewareSpec> => [
					{ name: 'host_validation', path: '*', handler: stub_mw },
					...specs
				]
			: undefined
	});
