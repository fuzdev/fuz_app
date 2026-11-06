/**
 * App surface generation — JSON-serializable attack surface from route and middleware specs.
 *
 * Pure schema helpers (`is_null_schema`, `schema_to_surface`, `middleware_applies`,
 * `middleware_spec_applies`) live in `http/schema_helpers.ts`, and each route's
 * error map (`resolve_route_error_map`) in `http/route_errors.ts`.
 *
 * @module
 */

import { get_schema_entries, get_schema_fields } from '@fuzdev/fuz_schema/introspect.ts';
import { is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import type { EventSpec } from '../realtime/sse.ts';
import type { MiddlewareSpec } from './middleware_spec.ts';
import type { RouteSpec } from './route_spec.ts';
import type { RouteAuth } from './auth_shape.ts';
import { to_error_schemas } from './error_schemas.ts';
import type { RateLimitKey } from '../rate_limiter.ts';
import type { RpcAction } from '../actions/action_types.ts';
import type { ActionKind } from '../actions/action_spec.ts';
import type { ResolvedWsEndpointSpec } from '../actions/ws_endpoint_spec.ts';
import {
	schema_to_surface,
	middleware_spec_applies,
	is_null_schema,
	is_strict_object_schema
} from './schema_helpers.ts';
import {
	get_route_error_map,
	resolve_app_route_error_maps,
	type RouteErrorMap
} from './route_errors.ts';
import { format_route_key } from './surface_query.ts';
import { find_schema_sensitivity, type Sensitivity } from '../sensitivity.ts';
import type { ValidationSchema } from '../schema_issues.ts';

// --- Surface types ---

/** A route in the generated attack surface (JSON-serializable). */
export interface AppSurfaceRoute {
	method: string;
	path: string;
	auth: RouteAuth;
	applicable_middleware: Array<string>;
	description: string;
	/** Whether this route mutates state (POST, PUT, DELETE, PATCH). */
	is_mutation: boolean;
	/** Whether this route's handler runs inside a database transaction. */
	transaction: boolean;
	/**
	 * Whether this route carries raw bytes / a streaming protocol rather than
	 * JSON (see `RouteSpec.raw_body`). When `true`, `input_schema` /
	 * `output_schema` being `null` means "raw bytes", not "no body".
	 */
	raw_body: boolean;
	/** Rate limit key type declared on the route spec. `null` when not rate-limited. */
	rate_limit_key: RateLimitKey | null;
	/** JSON Schema representation of the URL path params schema. `null` when no params. */
	params_schema: unknown;
	/** JSON Schema representation of the URL query params schema. `null` when no query schema. */
	query_schema: unknown;
	/** JSON Schema representation of the request body schema. `null` for no-body routes. */
	input_schema: unknown;
	/** JSON Schema representation of the success response schema. */
	output_schema: unknown;
	/** JSON Schema representations of error responses, keyed by HTTP status code. `null` when none. */
	error_schemas: Record<string, unknown> | null;
}

/** A middleware in the generated attack surface (JSON-serializable). */
export interface AppSurfaceMiddleware {
	name: string;
	path: string;
	/** JSON Schema representations of error responses, keyed by HTTP status code. `null` when none. */
	error_schemas: Record<string, unknown> | null;
	/** Paths under `path` the layer does not run on, each with its reason. Absent when none. */
	carve_outs?: Array<{ path: string; reason: string }>;
}

/** An env var in the generated attack surface (JSON-serializable). */
export interface AppSurfaceEnv {
	name: string;
	description: string;
	/** Sensitivity level from `meta(schema, {sensitivity})`. `null` when not sensitive. */
	sensitivity: Sensitivity | null;
	has_default: boolean;
	optional: boolean;
}

/** An SSE event in the generated attack surface (JSON-serializable). */
export interface AppSurfaceEvent {
	method: string;
	description: string;
	channel: string | null;
	params_schema: unknown;
}

/** A method within an RPC endpoint in the generated attack surface (JSON-serializable). */
export interface AppSurfaceRpcMethod {
	name: string;
	auth: RouteAuth;
	/** JSON Schema representation of the input schema. `null` for null-input methods. */
	input_schema: unknown;
	/** JSON Schema representation of the output schema. */
	output_schema: unknown;
	side_effects: boolean;
	description: string;
	/** Rate limit key declared on the action spec. `null` when not rate-limited. */
	rate_limit_key: RateLimitKey | null;
}

/** An RPC endpoint in the generated attack surface (JSON-serializable). */
export interface AppSurfaceRpcEndpoint {
	path: string;
	methods: Array<AppSurfaceRpcMethod>;
}

/** A method within a WebSocket endpoint in the generated attack surface (JSON-serializable). */
export interface AppSurfaceWsMethod {
	name: string;
	/** `request_response` (inbound dispatch) or `remote_notification` (server → client). */
	kind: ActionKind;
	/**
	 * Per-action auth shape. `null` for `remote_notification` (server →
	 * client) — notifications have no inbound dispatch and therefore no
	 * auth axis. `request_response` always carries a `RouteAuth`.
	 */
	auth: RouteAuth | null;
	/** JSON Schema of the input schema. `null` for nullary inputs. */
	input_schema: unknown;
	/** JSON Schema of the output schema. */
	output_schema: unknown;
	description: string;
	side_effects: boolean;
	/** Rate limit key declared on the action spec. `null` when not rate-limited. */
	rate_limit_key: RateLimitKey | null;
}

/** A WebSocket endpoint in the generated attack surface (JSON-serializable). */
export interface AppSurfaceWsEndpoint {
	path: string;
	/**
	 * Upgrade-time origin allowlist — the spec's own `allowed_origins`, or the
	 * server's when it declares none — one entry per regex, stringified via
	 * `RegExp.prototype.toString()` (`'/<source>/<flags>'`). An empty array
	 * refuses every request that carries an `Origin`. Reviewers read this as the
	 * exact pattern matched at the upgrade gate, not a wildcard approximation.
	 * Reconstruct via `new RegExp(source, flags)` if needed.
	 */
	allowed_origins: ReadonlyArray<string>;
	/**
	 * Upgrade-time role gate — empty array when no `required_roles` was
	 * declared (any-authenticated). Documents the coarse gate; per-action
	 * `auth` on each method covers per-message authorization.
	 */
	required_roles: ReadonlyArray<string>;
	methods: Array<AppSurfaceWsMethod>;
}

/** Assembly-time diagnostic collected during surface generation or server assembly. */
export interface AppSurfaceDiagnostic {
	level: 'warning' | 'info';
	category: string;
	message: string;
	source?: string;
}

/** Generated attack surface — JSON-serializable. */
export interface AppSurface {
	middleware: Array<AppSurfaceMiddleware>;
	routes: Array<AppSurfaceRoute>;
	rpc_endpoints: Array<AppSurfaceRpcEndpoint>;
	ws_endpoints: Array<AppSurfaceWsEndpoint>;
	env: Array<AppSurfaceEnv>;
	events: Array<AppSurfaceEvent>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

/**
 * The surface bundled with the source specs that produced it.
 *
 * `AppSurface` is JSON-serializable (snapshots, UI, startup logging) —
 * it's the observability layer, written to disk by `gro gen` for human
 * inspection + drift detection.
 *
 * `AppSurfaceSpec` is runtime-only — tests, introspection, attack
 * surface assertions. Both in-process and cross-process tests construct
 * an `AppSurfaceSpec` in TS via `create_test_app_surface_spec` (or a
 * consumer equivalent); the cross-process-ness lives in the transport
 * + per-test fixture, not the schema source.
 */
export interface AppSurfaceSpec {
	surface: AppSurface;
	route_specs: Array<RouteSpec>;
	middleware_specs: Array<MiddlewareSpec>;
	/**
	 * Each route's error map (`resolve_route_error_map` against `middleware_specs`),
	 * keyed `METHOD path` (`format_route_key`) — the one the surface writes, and
	 * the one the DEV error check and the test helpers read.
	 */
	route_error_maps: ReadonlyMap<string, RouteErrorMap>;
	rpc_endpoints: Array<RpcEndpointSpec>;
	ws_endpoints: Array<ResolvedWsEndpointSpec>;
}

/** An RPC endpoint definition for surface generation. */
export interface RpcEndpointSpec {
	path: string;
	actions: Array<RpcAction>;
}

/** Options for `generate_app_surface`. */
export interface GenerateAppSurfaceOptions {
	route_specs: Array<RouteSpec>;
	middleware_specs: Array<MiddlewareSpec>;
	/** A `@fuzdev/fuz_schema` object schema of the app's env vars, such as `BaseServerEnv`. */
	env_schema?: AnySchema;
	event_specs?: Array<EventSpec>;
	rpc_endpoints?: Array<RpcEndpointSpec>;
	/**
	 * Mounted WS endpoints (the same array `create_app_server.ws_endpoints`
	 * auto-mounts). Each entry's actions surface into
	 * `AppSurface.ws_endpoints[i].methods` for attack-surface tests +
	 * startup logging. Each carries its effective `allowed_origins` —
	 * `resolve_ws_endpoints` fills in the server's list where a spec omits
	 * it — so the surface records the exact patterns the upgrade gate matches.
	 */
	ws_endpoints?: ReadonlyArray<ResolvedWsEndpointSpec>;
	/**
	 * Each route's error map, keyed `METHOD path`, when the caller has built
	 * it (`resolve_app_route_error_maps` over the same routes and middleware);
	 * resolved here otherwise.
	 */
	route_error_maps?: ReadonlyMap<string, RouteErrorMap>;
}

// --- Surface generation ---

/**
 * Convert a `@fuzdev/fuz_schema` env schema to surface entries, one per
 * entry in order, reading each field's `meta`: the description from its
 * layers (`get_schema_fields`), and the fail-safe `find_schema_sensitivity`
 * for secrets. `optional` and `has_default` are what a parse of `undefined`
 * does: accepted, and accepted with a value other than `undefined`.
 *
 * @param schema - an object schema (under any wrappers) with `meta` on its fields
 * @throws TypeError if `schema` is not an object schema
 */
export const env_schema_to_surface = (schema: AnySchema): Array<AppSurfaceEnv> => {
	if (!get_schema_entries(schema)) {
		throw new TypeError(`env_schema must be an object schema, got '${schema.kind}'`);
	}
	return get_schema_fields(schema).map((field) => {
		const undef_result = parse(field.schema, undefined);
		return {
			name: field.name,
			description: field.description ?? '',
			sensitivity: find_schema_sensitivity(field.schema) ?? null,
			has_default: undef_result.ok && undef_result.value !== undefined,
			optional: undef_result.ok
		};
	});
};

/**
 * Convert SSE event specs to surface entries, each event's `params` written
 * as the output side (`schema_to_surface`) — the server sends them.
 *
 * @param event_specs - the events to describe
 * @param diagnostics - receives an `info` diagnostic per part of a schema with no JSON Schema form
 * @throws Error naming the event when its params schema can't be written
 */
export const events_to_surface = (
	event_specs: Array<EventSpec>,
	diagnostics?: Array<AppSurfaceDiagnostic>
): Array<AppSurfaceEvent> => {
	const to_surface = create_to_surface(diagnostics);
	return event_specs.map((spec) => ({
		method: spec.method,
		description: spec.description,
		channel: spec.channel ?? null,
		params_schema: to_surface(spec.params, 'output', `event ${spec.method} params`)
	}));
};

// `schema_to_surface` with its source named, recording each part of a schema
// with no JSON Schema form as an `info` diagnostic: a transform's output or a
// `z.custom()` is ordinary, so it's recorded on the surface, not warned at startup
const create_to_surface =
	(diagnostics: Array<AppSurfaceDiagnostic> | undefined) =>
	(schema: ValidationSchema, io: 'input' | 'output', source: string): unknown =>
		schema_to_surface(schema, {
			io,
			source,
			on_unrepresentable: diagnostics
				? (message) =>
						diagnostics.push({
							level: 'info',
							category: 'schema',
							message: `Part of the schema has no JSON Schema form and is left out or written as {} there: ${message}`,
							source
						})
				: undefined
		});

// a fuz_schema input that is not a strict `object`: a `strip_object` drops
// unknown keys and a `loose_object` keeps them, so the text names neither
const FUZ_SCHEMA_NOT_STRICT_INPUT_MESSAGE =
	'Input schema is not a strict object (@fuzdev/fuz_schema `object`) — unknown keys may not be refused';

/**
 * Generate a JSON-serializable attack surface from middleware, route specs,
 * and optional env/event metadata.
 */
export const generate_app_surface = (options: GenerateAppSurfaceOptions): AppSurface => {
	const { route_specs, middleware_specs, env_schema, event_specs, rpc_endpoints, ws_endpoints } =
		options;
	const route_error_maps =
		options.route_error_maps ?? resolve_app_route_error_maps(route_specs, middleware_specs);
	const diagnostics: Array<AppSurfaceDiagnostic> = [];
	const to_surface = create_to_surface(diagnostics);

	// Spec-level diagnostics: check for non-strict input schemas
	for (const r of route_specs) {
		if (!is_null_schema(r.input) && !is_strict_object_schema(r.input)) {
			diagnostics.push({
				level: 'warning',
				category: 'schema',
				message: is_schema(r.input)
					? FUZ_SCHEMA_NOT_STRICT_INPUT_MESSAGE
					: 'Input schema is not z.strictObject() — unknown keys will be silently stripped',
				source: `${r.method} ${r.path} input`
			});
		}
	}

	return {
		diagnostics,
		middleware: middleware_specs.map((m) => {
			let mw_error_schemas: Record<string, unknown> | null = null;
			if (m.errors) {
				const schemas: Record<string, unknown> = {};
				for (const [status, schema] of Object.entries(to_error_schemas(m.errors))) {
					const json_schema = to_surface(schema, 'output', `middleware ${m.name} errors.${status}`);
					if (json_schema !== null) {
						schemas[status] = json_schema;
					}
				}
				if (Object.keys(schemas).length > 0) {
					mw_error_schemas = schemas;
				}
			}
			return {
				name: m.name,
				path: m.path,
				error_schemas: mw_error_schemas,
				...(m.carve_outs?.length && {
					carve_outs: m.carve_outs.map(({ path, reason }) => ({ path, reason }))
				})
			};
		}),
		routes: route_specs.map((r) => {
			const applicable_middleware = middleware_specs
				.filter((m) => middleware_spec_applies(m, r.path))
				.map((m) => m.name);

			const route = format_route_key(r);

			// the route's error map: derived, middleware, and explicit, unioned
			let error_schemas: Record<string, unknown> | null = null;
			const schemas: Record<string, unknown> = {};
			for (const [status, schema] of Object.entries(
				get_route_error_map(route_error_maps, r).schemas
			)) {
				const json_schema = to_surface(schema, 'output', `${route} errors.${status}`);
				if (json_schema !== null) {
					schemas[status] = json_schema;
				}
			}
			if (Object.keys(schemas).length > 0) {
				error_schemas = schemas;
			}

			return {
				method: r.method,
				path: r.path,
				auth: r.auth,
				applicable_middleware,
				description: r.description,
				is_mutation: r.method !== 'GET',
				transaction: r.transaction ?? r.method !== 'GET',
				raw_body: r.raw_body ?? false,
				rate_limit_key: r.rate_limit ?? null,
				params_schema: r.params ? to_surface(r.params, 'input', `${route} params`) : null,
				query_schema: r.query ? to_surface(r.query, 'input', `${route} query`) : null,
				input_schema: to_surface(r.input, 'input', `${route} input`),
				output_schema: to_surface(r.output, 'output', `${route} output`),
				error_schemas
			};
		}),
		rpc_endpoints: rpc_endpoints?.length
			? rpc_endpoints.map((ep) => ({
					path: ep.path,
					methods: ep.actions.map((a) => ({
						name: a.spec.method,
						auth: a.spec.auth,
						input_schema: to_surface(a.spec.input, 'input', `${ep.path} ${a.spec.method} input`),
						output_schema: to_surface(
							a.spec.output,
							'output',
							`${ep.path} ${a.spec.method} output`
						),
						side_effects: a.spec.side_effects,
						description: a.spec.description,
						rate_limit_key: a.spec.rate_limit ?? null
					}))
				}))
			: [],
		ws_endpoints: ws_endpoints?.length
			? ws_endpoints.map((ep) => ({
					path: ep.path,
					allowed_origins: ep.allowed_origins.map((re) => re.toString()),
					required_roles: ep.required_roles ?? [],
					// `local_call` specs are frontend-side helpers — registry-only
					// on the backend, never dispatched over WS. Drop them from the
					// surface so attack-surface tests reflect dispatchable methods
					// only. Notifications are kept (server → client emit).
					methods: ep.actions
						.filter((a) => a.spec.kind !== 'local_call')
						.map((a) => ({
							name: a.spec.method,
							kind: a.spec.kind,
							// `request_response` carries a `RouteAuth`; notifications
							// have `auth: null` (server-pushed, no inbound dispatch).
							auth: a.spec.auth,
							input_schema: to_surface(a.spec.input, 'input', `${ep.path} ${a.spec.method} input`),
							output_schema: to_surface(
								a.spec.output,
								'output',
								`${ep.path} ${a.spec.method} output`
							),
							description: a.spec.description,
							side_effects: a.spec.side_effects,
							rate_limit_key:
								a.spec.kind === 'request_response' ? (a.spec.rate_limit ?? null) : null
						}))
				}))
			: [],
		env: env_schema ? env_schema_to_surface(env_schema) : [],
		events: event_specs?.length ? events_to_surface(event_specs, diagnostics) : []
	};
};

/**
 * Create an `AppSurfaceSpec` — the surface bundled with its source specs and
 * each route's error map, built once and read by both.
 */
export const create_app_surface_spec = (options: GenerateAppSurfaceOptions): AppSurfaceSpec => {
	const route_error_maps =
		options.route_error_maps ??
		resolve_app_route_error_maps(options.route_specs, options.middleware_specs);
	const surface = generate_app_surface({ ...options, route_error_maps });
	return {
		surface,
		route_specs: options.route_specs,
		middleware_specs: options.middleware_specs,
		route_error_maps,
		rpc_endpoints: options.rpc_endpoints ?? [],
		ws_endpoints: options.ws_endpoints ? [...options.ws_endpoints] : []
	};
};
