/**
 * App surface generation — JSON-serializable attack surface from route and middleware specs.
 *
 * Pure schema helpers (`is_null_schema`, `schema_to_surface`, `middleware_applies`,
 * `merge_error_schemas`) live in `schema_helpers.ts`.
 *
 * @module
 */

import {z} from 'zod';

import type {SseEventSpec} from '../realtime/sse.js';
import type {MiddlewareSpec} from './middleware_spec.js';
import type {RouteAuth, RouteSpec} from './route_spec.js';
import type {RateLimitKey, RouteErrorSchemas} from './error_schemas.js';
import {
	schema_to_surface,
	middleware_applies,
	merge_error_schemas,
	is_null_schema,
	is_strict_object_schema,
} from './schema_helpers.js';
import type {Sensitivity} from '../sensitivity.js';
import type {SchemaFieldMeta} from '../schema_meta.js';

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
}

/** An env var in the generated attack surface (JSON-serializable). */
export interface AppSurfaceEnv {
	name: string;
	description: string;
	/** Sensitivity level from `.meta({sensitivity})`. `null` when not sensitive. */
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
	env: Array<AppSurfaceEnv>;
	events: Array<AppSurfaceEvent>;
	diagnostics: Array<AppSurfaceDiagnostic>;
}

/**
 * The surface bundled with the source specs that produced it.
 *
 * `AppSurface` is JSON-serializable (snapshots, UI, startup logging).
 * `AppSurfaceSpec` is runtime-only (tests, introspection, attack surface assertions).
 */
export interface AppSurfaceSpec {
	surface: AppSurface;
	route_specs: Array<RouteSpec>;
	middleware_specs: Array<MiddlewareSpec>;
}

/** Options for `generate_app_surface`. */
export interface GenerateAppSurfaceOptions {
	route_specs: Array<RouteSpec>;
	middleware_specs: Array<MiddlewareSpec>;
	env_schema?: z.ZodObject;
	event_specs?: Array<SseEventSpec>;
}

// --- Surface generation ---

/**
 * Collect error schemas from all middleware that applies to a route path.
 *
 * @param middleware - the middleware specs
 * @param route_path - the route path to match against
 * @returns merged middleware error schemas, or `null` if none
 */
export const collect_middleware_errors = (
	middleware: Array<MiddlewareSpec>,
	route_path: string,
): RouteErrorSchemas | null => {
	const errors: RouteErrorSchemas = {};
	for (const mw of middleware) {
		if (mw.errors && middleware_applies(mw.path, route_path)) {
			Object.assign(errors, mw.errors);
		}
	}
	return Object.keys(errors).length > 0 ? errors : null;
};

/**
 * Convert env schema to surface entries using `.meta()` metadata.
 *
 * @param schema - Zod object schema with `.meta()` on fields
 * @returns array of env surface entries
 */
export const env_schema_to_surface = (schema: z.ZodObject): Array<AppSurfaceEnv> => {
	const entries: Array<AppSurfaceEnv> = [];
	for (const [name, field_schema] of Object.entries(schema.shape)) {
		const field = field_schema as z.ZodType;
		const meta = field.meta() as SchemaFieldMeta | undefined;
		const undef_result = field.safeParse(undefined);
		entries.push({
			name,
			description: meta?.description ?? '',
			sensitivity: meta?.sensitivity ?? null,
			has_default: undef_result.success && undef_result.data !== undefined,
			optional: undef_result.success,
		});
	}
	return entries;
};

/**
 * Convert SSE event specs to surface entries.
 *
 * @param event_specs - event specs to convert
 * @returns array of event surface entries
 */
export const events_to_surface = (event_specs: Array<SseEventSpec>): Array<AppSurfaceEvent> => {
	return event_specs.map((spec) => ({
		method: spec.method,
		description: spec.description,
		channel: spec.channel ?? null,
		params_schema: schema_to_surface(spec.params),
	}));
};

/**
 * Generate a JSON-serializable attack surface from middleware, route specs,
 * and optional env/event metadata.
 *
 * @param options - the surface generation options
 * @returns the attack surface
 */
export const generate_app_surface = (options: GenerateAppSurfaceOptions): AppSurface => {
	const {route_specs, middleware_specs, env_schema, event_specs} = options;
	const diagnostics: Array<AppSurfaceDiagnostic> = [];

	// Spec-level diagnostics: check for non-strict input schemas
	for (const r of route_specs) {
		if (!is_null_schema(r.input) && !is_strict_object_schema(r.input)) {
			diagnostics.push({
				level: 'warning',
				category: 'schema',
				message: 'Input schema is not z.strictObject() — unknown keys will be silently stripped',
				source: `${r.method} ${r.path} input`,
			});
		}
	}

	return {
		diagnostics,
		middleware: middleware_specs.map((m) => {
			let mw_error_schemas: Record<string, unknown> | null = null;
			if (m.errors) {
				const schemas: Record<string, unknown> = {};
				for (const [status, schema] of Object.entries(m.errors)) {
					const json_schema = schema_to_surface(schema as z.ZodType);
					if (json_schema !== null) {
						schemas[status] = json_schema;
					}
				}
				if (Object.keys(schemas).length > 0) {
					mw_error_schemas = schemas;
				}
			}
			return {name: m.name, path: m.path, error_schemas: mw_error_schemas};
		}),
		routes: route_specs.map((r) => {
			const applicable_middleware = middleware_specs
				.filter((m) => middleware_applies(m.path, r.path))
				.map((m) => m.name);

			// Merge auto-derived + middleware + explicit error schemas
			const mw_errors = collect_middleware_errors(middleware_specs, r.path);
			const merged_errors = merge_error_schemas(r, mw_errors);
			let error_schemas: Record<string, unknown> | null = null;
			if (merged_errors) {
				const schemas: Record<string, unknown> = {};
				for (const [status, schema] of Object.entries(merged_errors)) {
					const json_schema = schema_to_surface(schema as z.ZodType);
					if (json_schema !== null) {
						schemas[status] = json_schema;
					}
				}
				if (Object.keys(schemas).length > 0) {
					error_schemas = schemas;
				}
			}

			return {
				method: r.method,
				path: r.path,
				auth: r.auth,
				applicable_middleware,
				description: r.description,
				is_mutation: r.method !== 'GET',
				transaction: r.transaction ?? r.method !== 'GET',
				rate_limit_key: r.rate_limit ?? null,
				params_schema: r.params ? schema_to_surface(r.params) : null,
				query_schema: r.query ? schema_to_surface(r.query) : null,
				input_schema: schema_to_surface(r.input),
				output_schema: schema_to_surface(r.output),
				error_schemas,
			};
		}),
		env: env_schema ? env_schema_to_surface(env_schema) : [],
		events: event_specs?.length ? events_to_surface(event_specs) : [],
	};
};

/**
 * Create an `AppSurfaceSpec` — the surface bundled with its source specs.
 *
 * @param options - the surface generation options
 * @returns the surface spec with surface and raw specs
 */
export const create_app_surface_spec = (options: GenerateAppSurfaceOptions): AppSurfaceSpec => {
	const surface = generate_app_surface(options);
	return {
		surface,
		route_specs: options.route_specs,
		middleware_specs: options.middleware_specs,
	};
};
