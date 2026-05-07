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
import {
	ThrownJsonrpcError,
	jsonrpc_error_code_to_http_status,
	jsonrpc_error_code_to_name,
} from './jsonrpc_errors.js';
import {CACHED_REQUEST_BODY_KEY, type CachedRequestBody} from '../hono_context.js';
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
 * Two-phase auth guard set returned by `AuthGuardResolver`.
 *
 * `pre_validation` runs before input validation — 401 checks live here
 * so unauthenticated callers never see route-shape information from
 * input parsing failures. `post_authorization` runs after the
 * authorization phase has populated `RequestContext` — role / keeper
 * checks live here because they read `c.var.request_context.permits`.
 */
export interface AuthGuards {
	pre_validation: Array<MiddlewareHandler>;
	post_authorization: Array<MiddlewareHandler>;
}

/**
 * Resolves a `RouteAuth` to middleware guard handlers.
 *
 * Injected into `apply_route_specs` to decouple route registration
 * from auth-specific middleware. See `fuz_auth_guard_resolver` in
 * `auth/route_guards.ts` for the standard implementation.
 */
export type AuthGuardResolver = (auth: RouteAuth) => AuthGuards;

/**
 * Per-route authorization phase. Runs after the pre-validation auth guards
 * and before input validation; resolves the acting actor (when the route's
 * input declares `acting?: ActingActor` or auth requires permits) and sets
 * the request context on the Hono context. Per-route order in
 * `apply_route_specs`: params → query → pre-validation auth (401) →
 * authorization → post-authorization auth (403) → input validation →
 * handler.
 *
 * Returns a `Response` to short-circuit (resolution failure → 400 / 500),
 * or `void` to continue. The http framework stays auth-agnostic — fuz_app
 * provides the implementation via `create_fuz_authorization_handler` in
 * `auth/request_context.ts`.
 */
export type AuthorizationHandler = (c: Context, spec: RouteSpec) => Promise<Response | void>;

/**
 * Predicate that decides whether a route is "acting-aware" — i.e. whether
 * the dispatcher's authorization phase may emit `actor_required` /
 * `actor_not_on_account` (400) or `no_actors_on_account` /
 * `account_vanished` (500) on this spec. When the predicate returns true
 * the merged error schema is widened to accept those shapes so DEV-mode
 * `wrap_output_validation` doesn't reject them.
 *
 * Computed at the call site because the canonical "input declares
 * `acting?: ActingActor`" check lives in `auth/request_context.ts` (it
 * uses reference equality with the canonical `ActingActor` schema). The
 * `http/` framework receives the predicate via this callback so it stays
 * auth-agnostic. See `http/CLAUDE.md` § Three-layer error-schema merge.
 */
export type IsActingAware = (spec: Pick<RouteSpec, 'auth' | 'input'>) => boolean;

/** HTTP methods supported by route specs. */
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Per-request deps provided by the framework to route handlers.
 */
export interface RouteContext {
	/** Transaction-scoped for mutations, pool-level for reads. */
	db: Db;
	/** Always pool-level — for fire-and-forget effects that must outlive the transaction. */
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
	auth: RouteAuth;
	handler: RouteHandler;
	description: string;
	/**
	 * URL path parameter schema. Use `z.strictObject()` with string fields matching `:param` segments.
	 *
	 * REST-only — actions dispatch through a single JSON-RPC endpoint and encode
	 * everything in `input`, so `params` doesn't appear on `ActionSpec`.
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
 * Call after the input validation middleware has run. The type parameter
 * should match the route's `input` schema.
 */
export const get_route_input = <T>(c: Context): T => {
	return c.get('validated_input') as T;
};

/**
 * Get validated URL path params from the Hono context.
 *
 * Call after the params validation middleware has run. The type parameter
 * should match the route's `params` schema.
 *
 * TODO derive `T` from the route spec so the type parameter isn't manually
 * specified — same applies to `get_route_input` / `get_route_query`.
 */
export const get_route_params = <T>(c: Context): T => {
	return c.get('validated_params') as T;
};

/**
 * Get validated URL query params from the Hono context.
 *
 * Call after the query validation middleware has run. The type parameter
 * should match the route's `query` schema.
 */
export const get_route_query = <T>(c: Context): T => {
	return c.get('validated_query') as T;
};

/**
 * Create input validation middleware for a route spec.
 *
 * Returns an empty array for GET routes (no body to parse — GET input is
 * validated elsewhere, e.g. from `?params=` query string in RPC handlers)
 * and for null-input routes (no body expected). For other routes with input
 * schemas, returns a middleware that parses and validates the JSON body,
 * storing the result on the context as `validated_input`.
 *
 * @mutates `c.var.validated_input` - set to the parsed and validated body on success
 */
const create_input_validation = (
	input_schema: z.ZodType,
	method: RouteMethod,
): Array<MiddlewareHandler> => {
	if (method === 'GET') return [];
	if (is_null_schema(input_schema)) return [];

	const validate: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		// Prefer the cached parse result written by `read_raw_acting`
		// (the dispatcher's `acting` extractor). The cache decouples
		// us from Hono's internal `bodyCache` — Hono keeps the body
		// text alive across multiple `c.req.json()` calls but still
		// re-runs `JSON.parse` each time, so caching the parsed value
		// saves work and pins behavior to fuz_app code rather than to
		// undocumented Hono internals.
		// Hono's `c.get()` types this as the variable-map entry, but at
		// runtime it returns `undefined` when no setter has run for this
		// request. Narrow defensively.
		const cached = c.get(CACHED_REQUEST_BODY_KEY) as CachedRequestBody | undefined;
		let body: unknown;
		if (cached !== undefined) {
			if (!cached.ok) return c.json({error: ERROR_INVALID_JSON_BODY}, 400);
			body = cached.body;
		} else {
			try {
				body = await c.req.json();
			} catch {
				return c.json({error: ERROR_INVALID_JSON_BODY}, 400);
			}
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
 *
 * @mutates `c.var.validated_params` - set to the parsed and validated path params on success
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
 *
 * @mutates `c.var.validated_query` - set to the parsed and validated query params on success
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
 * Logs an error for mismatches and returns the response unchanged —
 * does not throw. In production, returns the handler unchanged.
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
					log.error(`Output schema mismatch: ${c.req.method} ${c.req.path}`, result.error.issues);
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
						log.error(
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
 * @mutates `app`
 */
export const apply_middleware_specs = (app: Hono, specs: Array<MiddlewareSpec>): void => {
	for (const spec of specs) {
		app.use(spec.path, spec.handler);
	}
};

/**
 * Wrap a handler with error catch logic.
 *
 * Catches `ThrownJsonrpcError` and maps it to a flat REST `ApiError` body
 * (`{error: <reason>, message?, ...rest_data}`) at the matching HTTP status.
 * Catches generic `Error` and maps to `{error: 'internal_error', message?}`
 * at 500 (`message` populated only in DEV). Existing handlers that return
 * `c.json()` directly are unaffected — the catch layer only activates when
 * something is thrown.
 *
 * The flat shape matches what middleware and direct handler emissions
 * produce (e.g. `c.json({error: ERROR_FOO}, status)`,
 * `c.json(failure.body, status)` from the dispatcher's authorization phase),
 * so REST callers see one error envelope across every emit site. The
 * `<reason>` string comes from `err.data.reason` when set (consumer-supplied
 * canonical reason code) or from `jsonrpc_error_code_to_name(err.code)`
 * (the JSON-RPC error name — `'not_found'`, `'forbidden'`, etc.). Other
 * `data` fields flatten alongside `error` so diagnostic data is visible
 * to clients without descending an envelope.
 *
 * The JSON-RPC code is intentionally **not** carried on the REST body —
 * REST callers key on HTTP status + `error` reason, and the JSON-RPC code
 * is recoverable via `http_status_to_jsonrpc_error_code(status)` on the
 * rare consumer that wants it. Keeping the shape transport-shaped (REST
 * emits ApiError; JSON-RPC dispatcher emits the JSON-RPC envelope) avoids
 * a hybrid envelope that has to be normalized on the way out.
 */
const wrap_error_catch = (handler: Handler, log: Logger): Handler => {
	return async (c, next) => {
		try {
			return await handler(c, next);
		} catch (err) {
			if (err instanceof ThrownJsonrpcError) {
				const status = jsonrpc_error_code_to_http_status(err.code);
				return c.json(build_rest_error_body(err), status);
			}
			// generic error — internal_error
			log.error('Unhandled handler error', err);
			const body: Record<string, unknown> = {error: 'internal_error'};
			if (DEV && err instanceof Error) body.message = err.message;
			return c.json(body, 500);
		}
	};
};

/**
 * Build the REST body for a thrown `ThrownJsonrpcError`. Splits out
 * for unit-test directness and keeps the catch handler readable.
 *
 * Reason resolution order:
 * 1. `err.data.reason` (consumer-supplied canonical reason — overrides code-derived name)
 * 2. `jsonrpc_error_code_to_name(err.code)` (e.g. -32003 → `'not_found'`)
 *
 * Remaining `err.data` fields (everything except `reason`) flatten under
 * the body. Non-object `data` is dropped — we don't want a primitive
 * `data` to overwrite the structured shape.
 */
const build_rest_error_body = (err: ThrownJsonrpcError): Record<string, unknown> => {
	let reason: string;
	const rest: Record<string, unknown> = {};
	if (
		err.data !== null &&
		typeof err.data === 'object' &&
		!Array.isArray(err.data) &&
		typeof (err.data as {reason?: unknown}).reason === 'string'
	) {
		const {reason: data_reason, ...other} = err.data as Record<string, unknown> & {reason: string};
		reason = data_reason;
		Object.assign(rest, other);
	} else {
		reason = jsonrpc_error_code_to_name(err.code);
		if (err.data !== null && typeof err.data === 'object' && !Array.isArray(err.data)) {
			Object.assign(rest, err.data);
		}
	}
	const body: Record<string, unknown> = {error: reason, ...rest};
	if (err.message && err.message !== reason) body.message = err.message;
	return body;
};

/**
 * Apply route specs to a Hono app.
 *
 * For each spec: resolves auth to guards via the provided resolver,
 * adds input validation middleware (for routes with non-null input schemas),
 * runs the optional authorization phase to resolve the acting actor + build
 * the request context, wraps handler with DEV-only output and error
 * validation, wraps with error catch layer (catches `ThrownJsonrpcError`
 * and generic errors), and registers the route.
 *
 * Per-route middleware order: params → query → pre-validation auth
 * guards (401) → authorization phase → post-authorization auth guards
 * (403) → input validation → handler. The 401 check runs before any
 * body parsing so unauthenticated callers never see route-shape
 * information from parse failures. The authorization phase runs before
 * input validation (matches the RPC dispatcher's order) so role /
 * keeper denials surface 403 before 400 invalid_params; it extracts
 * `acting` from raw query (GET) or pre-parsed JSON body (POST/PUT/...)
 * — Hono caches the parsed body internally so the subsequent input-
 * validation step does not re-parse. The role / keeper guards consume
 * the `RequestContext` populated by the authorization phase.
 *
 * Each handler receives a `RouteContext` with:
 * - `db`: transaction-scoped (for non-GET) or pool-level (for GET)
 * - `background_db`: always pool-level
 * - `pending_effects`: fire-and-forget effect queue
 *
 * @param resolve_auth_guards - maps `RouteAuth` to middleware — use `fuz_auth_guard_resolver` from `auth/route_guards.ts`
 * @param authorize - optional authorization phase; runs between guards and input validation
 * @param db - used for transaction wrapping and `RouteContext`
 * @mutates `app`
 * @throws Error if two specs share the same `method` + `path` (each combination must be unique)
 */
export const apply_route_specs = (
	app: Hono,
	specs: Array<RouteSpec>,
	resolve_auth_guards: AuthGuardResolver,
	log: Logger,
	db: Db,
	authorize?: AuthorizationHandler,
	is_acting_aware?: IsActingAware,
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
		const {pre_validation: pre_validation_guards, post_authorization: post_authorization_guards} =
			resolve_auth_guards(spec.auth);
		const params_validation = create_params_validation(spec.params);
		const query_validation = create_query_validation(spec.query);
		const input_validation = create_input_validation(spec.input, spec.method);
		const merged_errors = merge_error_schemas(spec, null, is_acting_aware?.(spec) ?? false);
		const authorization: Array<MiddlewareHandler> = authorize
			? [
					async (c, next): Promise<Response | void> => {
						const response = await authorize(c, spec);
						if (response) return response;
						await next();
					},
				]
			: [];
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
		// Step 3: error catch layer
		handler = wrap_error_catch(handler, log);
		app.on(
			spec.method,
			[spec.path],
			...params_validation,
			...query_validation,
			...pre_validation_guards,
			...authorization,
			...post_authorization_guards,
			...input_validation,
			handler,
		);
	}
};

/**
 * Prepend a prefix to all route spec paths.
 *
 * @param prefix - the path prefix (e.g. `/api/account`)
 * @returns a new array — the input specs are not mutated
 */
export const prefix_route_specs = (prefix: string, specs: Array<RouteSpec>): Array<RouteSpec> => {
	return specs.map((spec) => ({
		...spec,
		path: spec.path === '/' ? prefix : `${prefix}${spec.path}`,
	}));
};
