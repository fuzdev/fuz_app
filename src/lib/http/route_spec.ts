/**
 * Introspectable route spec system for Hono apps.
 *
 * Routes are defined as data (method, path, auth, input/output schemas, handler),
 * then applied to Hono. The attack surface is generated from the specs —
 * always accurate, always complete.
 *
 * Input/output schemas align with SAES `ActionSpec` conventions:
 * - `input`: Zod schema for the request body (`z.null()` for no body)
 * - `output`: Zod schema for the success response body
 * - `z.strictObject()` for inputs (reject unknown keys)
 *
 * @module
 */

import type {Context, Handler, Hono, MiddlewareHandler} from 'hono';
import type {z} from 'zod';
import {DEV} from 'esm-env';
import type {Logger} from '@fuzdev/fuz_util/log.js';

import type {Db} from '../db/db.js';
import {
	type RouteErrorSchemas,
	type RateLimitKey,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_INVALID_QUERY_PARAMS,
} from './error_schemas.js';
import {is_null_schema, merge_error_schemas} from './schema_helpers.js';
import type {MiddlewareSpec} from './middleware_spec.js';

/**
 * Auth requirement for a route — `none`, `authenticated`, a specific role, or `keeper`.
 *
 * `{type: 'none'}` means the route is open to all clients — including non-browser
 * callers (CLI, API tokens, scripts). No session or auth middleware guards are applied.
 */
export type RouteAuth =
	| {type: 'none'}
	| {type: 'authenticated'}
	| {type: 'role'; role: string}
	| {type: 'keeper'};

/**
 * Resolves a `RouteAuth` to middleware guard handlers.
 *
 * Injected into `apply_route_specs` to decouple route registration
 * from auth-specific middleware. See `fuz_auth_guard_resolver` in
 * `auth/route_guards.ts` for the standard implementation.
 */
export type AuthGuardResolver = (auth: RouteAuth) => Array<MiddlewareHandler>;

/** HTTP methods supported by route specs. */
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Per-request deps provided by the framework to route handlers.
 *
 * `db` is transaction-scoped for mutation routes and pool-level for reads.
 * `background_db` is always pool-level — use it for fire-and-forget effects
 * that must outlive the transaction.
 */
export interface RouteContext {
	/** Transaction-scoped for mutations, pool-level for reads. */
	db: Db;
	/** Always pool-level — for fire-and-forget effects that outlive the transaction. */
	background_db: Db;
	/** Fire-and-forget side effects — push here for post-response flushing. */
	pending_effects: Array<Promise<void>>;
}

/**
 * Route handler function — receives the Hono context and a `RouteContext`
 * with per-request deps (db, background_db, pending_effects).
 *
 * TypeScript allows fewer params, so handlers that don't need `route`
 * can use `(c) => ...` without changes.
 */
export type RouteHandler = (c: Context, route: RouteContext) => Response | Promise<Response>;

/**
 * A single route definition — the unit of the surface map.
 *
 * `input` and `output` schemas align with SAES `ActionSpec` naming.
 * Use `z.null()` for routes with no request body (GET, DELETE without body).
 */
export interface RouteSpec {
	method: RouteMethod;
	path: string;
	/**
	 * Auth requirement for this route.
	 *
	 * `{type: 'none'}` means the route is open to all clients including non-browser
	 * callers (CLI, scripts) — no auth guards are applied.
	 */
	auth: RouteAuth;
	handler: RouteHandler;
	description: string;
	/**
	 * URL path parameter schema. Use `z.strictObject()` with string fields matching `:param` segments.
	 *
	 * TODO @action-system-review `params` is HTTP-specific — SAES encodes everything in
	 * `input`. When saes-rpc lands, this may move to `ActionRouteOptions` only.
	 */
	params?: z.ZodObject;
	/** URL query parameter schema. Use `z.strictObject()` with string fields. */
	query?: z.ZodObject;
	/** Request body schema. Use `z.null()` for routes with no body. */
	input: z.ZodType;
	/** Success response body schema. */
	output: z.ZodType;
	/**
	 * Rate limit key type — declares what this route's rate limiter is keyed on.
	 *
	 * When set, 429 (`RateLimitError`) is auto-derived in `derive_error_schemas`.
	 * The actual `RateLimiter` instance is still wired imperatively in the handler —
	 * this field is metadata for surface introspection and policy invariants.
	 */
	rate_limit?: RateLimitKey;
	/**
	 * Handler-specific error response schemas keyed by HTTP status code.
	 *
	 * Middleware errors (auth 401/403, validation 400, rate limit 429) are
	 * auto-derived from `auth`, `input`, and `rate_limit`. Declare handler-specific
	 * errors here (e.g., 404 for not-found, 409 for conflicts).
	 *
	 * Explicit entries override auto-derived ones for the same status code.
	 */
	errors?: RouteErrorSchemas;
	/**
	 * Whether to wrap the handler in a database transaction.
	 *
	 * When omitted, defaults are derived from the HTTP method:
	 * - `GET` → `false` (read-only, no transaction)
	 * - All others (`POST`, `PUT`, `DELETE`, `PATCH`) → `true`
	 *
	 * Set explicitly to override the default (e.g., `false` for a POST
	 * that manages its own transaction like signup).
	 */
	transaction?: boolean;
}

/**
 * Get validated input from the Hono context.
 *
 * Call this in route handlers after the input validation middleware has run.
 * The type parameter should match the route's `input` schema.
 *
 * @returns the validated request body
 */
export const get_route_input = <T>(c: Context): T => {
	return c.get('validated_input') as T;
};

/**
 * Get validated URL path params from the Hono context.
 *
 * Call this in route handlers after the params validation middleware has run.
 * The type parameter should match the route's `params` schema.
 *
 * TODO @action-system-review Make typesafe — derive `T` from the `params` schema on the
 * route spec so the type parameter isn't manually specified.
 *
 * @returns the validated path parameters
 */
export const get_route_params = <T>(c: Context): T => {
	return c.get('validated_params') as T;
};

/**
 * Get validated URL query params from the Hono context.
 *
 * Call this in route handlers after the query validation middleware has run.
 * The type parameter should match the route's `query` schema.
 *
 * @returns the validated query parameters
 */
export const get_route_query = <T>(c: Context): T => {
	return c.get('validated_query') as T;
};

/**
 * Create input validation middleware for a route spec.
 *
 * Returns an empty array for null-input routes (no body expected).
 * For routes with input schemas, returns a middleware that parses and validates
 * the JSON body, storing the result on the context as `validated_input`.
 */
const create_input_validation = (input_schema: z.ZodType): Array<MiddlewareHandler> => {
	if (is_null_schema(input_schema)) return [];

	const validate: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({error: ERROR_INVALID_JSON_BODY}, 400);
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return c.json({error: ERROR_INVALID_JSON_BODY}, 400);
		}
		const result = input_schema.safeParse(body);
		if (!result.success) {
			return c.json({error: ERROR_INVALID_REQUEST_BODY, issues: result.error.issues}, 400);
		}
		c.set('validated_input', result.data);
		await next();
	};
	return [validate];
};

/**
 * Create params validation middleware for a route spec.
 *
 * Returns an empty array when no params schema is defined.
 * For routes with params schemas, returns a middleware that validates
 * `c.req.param()` against the schema, storing the result on the context as `validated_params`.
 */
const create_params_validation = (params_schema?: z.ZodObject): Array<MiddlewareHandler> => {
	if (!params_schema) return [];

	const validate: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		const raw_params = c.req.param();
		const result = params_schema.safeParse(raw_params);
		if (!result.success) {
			return c.json({error: ERROR_INVALID_ROUTE_PARAMS, issues: result.error.issues}, 400);
		}
		c.set('validated_params', result.data);
		await next();
	};
	return [validate];
};

/**
 * Create query params validation middleware for a route spec.
 *
 * Returns an empty array when no query schema is defined.
 * For routes with query schemas, returns a middleware that validates
 * `c.req.query()` against the schema, storing the result on the context as `validated_query`.
 */
const create_query_validation = (query_schema?: z.ZodObject): Array<MiddlewareHandler> => {
	if (!query_schema) return [];

	const validate: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		const raw_query = c.req.query();
		const result = query_schema.safeParse(raw_query);
		if (!result.success) {
			return c.json({error: ERROR_INVALID_QUERY_PARAMS, issues: result.error.issues}, 400);
		}
		c.set('validated_query', result.data);
		await next();
	};
	return [validate];
};

/**
 * Wrap a handler with DEV-only output and error validation.
 *
 * In development, validates 2xx JSON responses against the output schema
 * and non-2xx responses against declared error schemas.
 * Logs warnings for mismatches. In production, returns the handler unchanged.
 */
const wrap_output_validation = (
	handler: Handler,
	output_schema: z.ZodType,
	error_schemas: RouteErrorSchemas | null,
	log: Logger,
): Handler => {
	if (!DEV) return handler;
	if (is_null_schema(output_schema) && !error_schemas) return handler;
	return async (c, next) => {
		const response = await handler(c, next);
		// Only validate JSON responses — streaming responses (SSE) would hang on .json().
		const content_type = response.headers.get('Content-Type');
		if (!content_type?.includes('application/json')) return response;
		if (response.ok) {
			try {
				const cloned = response.clone();
				const body = await cloned.json();
				const result = output_schema.safeParse(body);
				if (!result.success) {
					log.warn(`Output schema mismatch: ${c.req.method} ${c.req.path}`, result.error.issues);
				}
			} catch {
				// clone() or json() failed on a response claiming application/json
			}
		} else if (error_schemas) {
			const status_schema = error_schemas[response.status];
			if (status_schema) {
				try {
					const cloned = response.clone();
					const body = await cloned.json();
					const result = status_schema.safeParse(body);
					if (!result.success) {
						log.warn(
							`Error schema mismatch (${response.status}): ${c.req.method} ${c.req.path}`,
							result.error.issues,
						);
					}
				} catch {
					// clone() or json() failed on a response claiming application/json
				}
			}
		}
		return response;
	};
};

/**
 * Apply named middleware specs to a Hono app.
 *
 * @param app - the Hono app
 * @param specs - middleware specs to apply
 * @mutates `app`
 */
export const apply_middleware_specs = (app: Hono, specs: Array<MiddlewareSpec>): void => {
	for (const spec of specs) {
		app.use(spec.path, spec.handler);
	}
};

/**
 * Apply route specs to a Hono app.
 *
 * For each spec: resolves auth to guards via the provided resolver,
 * adds input validation middleware (for routes with non-null input schemas),
 * wraps handler with DEV-only output and error validation, and registers the route.
 *
 * Each handler receives a `RouteContext` with:
 * - `db`: transaction-scoped (for non-GET) or pool-level (for GET)
 * - `background_db`: always pool-level
 * - `pending_effects`: fire-and-forget effect queue
 *
 * @param app - the Hono app
 * @param specs - route specs to apply
 * @param resolve_auth_guards - maps `RouteAuth` to middleware — use `fuz_auth_guard_resolver` from `auth/route_guards.ts`
 * @param log - the logger instance
 * @param db - database instance for transaction wrapping and `RouteContext`
 * @mutates `app`
 */
export const apply_route_specs = (
	app: Hono,
	specs: Array<RouteSpec>,
	resolve_auth_guards: AuthGuardResolver,
	log: Logger,
	db: Db,
): void => {
	const registered = new Set<string>();
	for (const spec of specs) {
		const route_key = `${spec.method} ${spec.path}`;
		if (registered.has(route_key)) {
			throw new Error(
				`Duplicate route: ${route_key} — each method+path combination must be unique`,
			);
		}
		registered.add(route_key);
		const guards = resolve_auth_guards(spec.auth);
		const params_validation = create_params_validation(spec.params);
		const query_validation = create_query_validation(spec.query);
		const validation = create_input_validation(spec.input);
		const merged_errors = merge_error_schemas(spec);
		// Step 1: adapt RouteHandler → Handler (construct RouteContext, call spec.handler)
		const use_transaction = spec.transaction ?? spec.method !== 'GET';
		const inner = spec.handler;
		let handler: Handler = use_transaction
			? (c) =>
					db.transaction(async (tx) =>
						inner(c, {db: tx, background_db: db, pending_effects: c.var.pending_effects}),
					)
			: (c) => inner(c, {db, background_db: db, pending_effects: c.var.pending_effects});
		// Step 2: output validation
		handler = wrap_output_validation(handler, spec.output, merged_errors, log);
		app.on(
			spec.method,
			[spec.path],
			...guards,
			...params_validation,
			...query_validation,
			...validation,
			handler,
		);
	}
};

/**
 * Prepend a prefix to all route spec paths.
 *
 * @param prefix - the path prefix (e.g. `/api/account`)
 * @param specs - route specs to prefix
 * @returns new array of specs with prefixed paths
 */
export const prefix_route_specs = (prefix: string, specs: Array<RouteSpec>): Array<RouteSpec> => {
	return specs.map((spec) => ({
		...spec,
		path: `${prefix}${spec.path}`,
	}));
};
