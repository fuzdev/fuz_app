/**
 * Introspectable route spec system for Hono apps.
 *
 * Routes are defined as data (method, path, auth, input/output schemas, handler),
 * then applied to Hono. The attack surface is generated from the specs —
 * always accurate, always complete. A handler returns a result
 * (`http/route_result.ts`) and `apply_route_specs` builds the response; a spec
 * is made by `define_route` (or `define_route_shape` + `attach_route_handler`),
 * which checks the handler's results against the route.
 *
 * Input/output schemas align with SAES `ActionSpec` conventions, and each is
 * a `@fuzdev/fuz_schema` schema (`AnySchema`):
 * - `input`: the request body schema (`literal(null)` for no body)
 * - `output`: the success response body schema
 * - a strict object for inputs (reject unknown keys): `object`
 *
 * @module
 */

import type { Context, Handler, Hono, MiddlewareHandler } from 'hono';
import { DEV } from 'esm-env';
import {
	is_schema,
	type AnySchema,
	parse,
	type InferInput,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import type { Db } from '../db/db.ts';
import { format_route_key } from './surface_query.ts';
import { is_db_checkout_error } from '../db/db_checkout_error.ts';
import {
	type RestErrorDef,
	type REST_AUTHENTICATION_REQUIRED,
	type REST_CREDENTIAL_TYPE_REQUIRED,
	type REST_INSUFFICIENT_PERMISSIONS,
	type REST_INTERNAL_ERROR,
	type REST_RATE_LIMIT_EXCEEDED,
	type REST_SERVICE_UNAVAILABLE,
	type REST_TOKEN_SCOPE_REQUIRED,
	ERROR_INVALID_JSON_BODY,
	ERROR_INVALID_REQUEST_BODY,
	ERROR_INVALID_ROUTE_PARAMS,
	ERROR_INVALID_QUERY_PARAMS,
	ERROR_INTERNAL_ERROR,
	ERROR_SERVICE_UNAVAILABLE,
	ERROR_UNSUPPORTED_CONTENT_TYPE
} from './error_schemas.ts';
import type { RateLimitKey } from '../rate_limiter.ts';
import { is_post_content_type_refused } from './simple_request.ts';
import {
	jsonrpc_error_code_to_http_status,
	jsonrpc_error_code_to_name,
	dev_only,
	to_thrown_jsonrpc_error
} from './jsonrpc_errors.ts';
import type { JsonrpcErrorObject } from './jsonrpc.ts';
import { is_null_schema, scan_json_value } from './schema_helpers.ts';
import { is_json_response } from './route_error_check.ts';
import { dispatch_with_post_commit_rollback } from './pending_effects.ts';
import type { MiddlewareSpec } from './middleware_spec.ts';
import {
	ROUTE_RAW_REFUSED_HEADERS,
	type ReadonlyJson,
	type RouteFailOf,
	type RouteOk,
	type RouteRaw,
	type RouteRawBody,
	type RouteResult,
	type RouteSse
} from './route_result.ts';
import type { OpenedSseStream, SseResponseOptions, SseStream } from '../realtime/sse.ts';
import { SSE_RESPONSE_HEADERS } from '../realtime/sse_constants.ts';
import {
	assert_route_auth_acting_biconditional,
	assert_route_auth_invariants,
	type RouteAuth
} from './auth_shape.ts';
import { assert_validation_schema, to_wire_issues } from '../schema_issues.ts';
import { read_json_body, type JsonBodyResult } from './json_text.ts';
import { get_client_ip } from './client_ip.ts';
import { get_header_lines } from './header_lines.ts';
import { CONNECTION_IP_KEY, has_test_context_preset, RESOLVED_AUTH_KEY } from '../hono_context.ts';
import type { RequestContext, RequestContextForAuth } from '../auth/request_context.ts';
import type { ResolvedAuth } from '../auth/resolved_auth.ts';

/**
 * Two-phase auth guard set returned by `AuthGuardResolver`.
 *
 * `pre_authorization` runs before the authorization phase — the 401 check
 * and the rule-3 token-scope refusal live here, so a caller either one turns
 * away never reaches the actor resolution or the route's body.
 * `post_authorization` runs after the authorization phase has populated
 * `RequestContext` — credential / role checks live here because they read
 * `c.var.request_context.role_grants`.
 *
 * Both phases run ahead of body validation, which is why neither is named
 * for it: route-shape information stays behind every authority gate. The
 * names say which side of the authorization phase a guard sits on, the only
 * axis that still distinguishes them.
 */
export interface AuthGuards {
	pre_authorization: Array<MiddlewareHandler>;
	post_authorization: Array<MiddlewareHandler>;
}

/**
 * Resolves a `RouteAuth` to middleware guard handlers.
 *
 * Injected into `apply_route_specs` to decouple route registration
 * from auth-specific middleware. See `fuz_auth_guard_resolver` in
 * `auth/auth_guard_resolver.ts` for the standard implementation.
 */
export type AuthGuardResolver = (auth: RouteAuth) => AuthGuards;

/**
 * Per-route authorization phase. Runs after the pre-authorization auth guards
 * and before input validation; resolves the acting actor (when `auth.actor !==
 * 'none'`) from the `acting` selector — `c.var.validated_query.acting` on GETs,
 * read off the raw body on mutations — and sets the request context on the Hono
 * context. Per-route order in `apply_route_specs`: content type (415) →
 * params → query → pre-authorization auth (401 + rule-3 scope) →
 * authorization phase →
 * post-authorization auth (403) → input validation (400) → handler.
 *
 * Returns a `Response` to short-circuit (resolution failure → 400 / 500),
 * or `void` to continue. The http framework stays auth-agnostic — fuz_app
 * provides the implementation via `create_fuz_authorization_handler` in
 * `auth/request_context.ts`.
 */
export type AuthorizationHandler = (c: Context, spec: RouteSpec) => Promise<Response | void>;

/** HTTP methods supported by route specs. */
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Everything a route handler receives: the request as the pipeline resolved
 * and validated it, the per-request deps, and the few effects a handler may
 * ask of the response. A handler takes nothing else — never the Hono
 * context — and returns a result (`http/route_result.ts`), so nothing it does
 * can write on the response the spine builds after the commit.
 *
 * The fields it shares with `ActionContext` (`auth`, `client_ip`, `signal`,
 * `db`, `pending_effects`, `post_commit_effects`) carry the same names and
 * types there, so a helper typed against one of the narrow slices
 * (`QueryDeps`, `EmitAfterCommitContext`, `AuditEmitterContext`) takes
 * either.
 *
 * Audit writes run through `AppDeps.audit.emit(route, input)` (see
 * `auth/audit_emitter.ts`). It writes a success row in the route's
 * transaction when one is open and a failure row on the pool it closes over,
 * so a refused attempt's row survives the rollback.
 *
 * Routes whose body manages its own transaction (signup, bootstrap)
 * declare `transaction: false` on the spec, which makes `route.db` the
 * pool — they reach for it directly.
 *
 * @typeParam TAuth - `auth`, narrowed per route by `RequestContextForAuth`
 * @typeParam TInput - the validated body
 * @typeParam TParams - the validated path params, `undefined` without a `params` schema
 * @typeParam TQuery - the validated query, `undefined` without a `query` schema
 */
export interface RouteContext<
	TAuth extends RequestContext | null = RequestContext | null,
	TInput = unknown,
	TParams = unknown,
	TQuery = unknown
> {
	/**
	 * The request context the authorization phase built: the account, the
	 * acting actor, and its role grants; `null` on a route whose auth reads
	 * none. A handler of a route that requires an account or an actor gets
	 * it non-null by type (`RequestContextForAuth`), and the spec's handler
	 * throws rather than run without it (`define_route`).
	 */
	auth: TAuth;
	/**
	 * The credential the auth middleware resolved, `null` for an anonymous
	 * caller. A `reads_credential` route — one that answers anonymous callers
	 * itself — reads the account it may act on through
	 * `get_public_account_id(route)` (`auth/request_context.ts`), never from
	 * here: a scope-narrowed API token is the anonymous caller there, and only
	 * that function applies the rule.
	 */
	credential: ResolvedAuth | null;
	/** The client IP the trusted-proxy middleware resolved, `'unknown'` without one. */
	client_ip: string;
	/**
	 * The connection's peer address as the trusted-proxy middleware read it
	 * (`ProxyOptions.get_connection_ip`) — the socket's, never a forwarded
	 * one — `null` when the middleware is not mounted or the runtime gave
	 * none. For a route that admits loopback callers only. As the runtime
	 * spells it, not normalized — an IPv4-mapped `::ffff:127.0.0.1` stays
	 * that — unlike `client_ip`.
	 */
	connection_ip: string | null;
	/** Aborts when the client disconnects. */
	signal: AbortSignal;
	/** The validated body — `null` for a route with a `null` input (every `GET`). */
	input: TInput;
	/** The validated path params, `undefined` for a route without a `params` schema. */
	params: TParams;
	/** The validated query, `undefined` for a route without a `query` schema. */
	query: TQuery;
	/**
	 * Whether a test harness pre-built the request context — what
	 * `has_test_context_preset` reads of the Hono context: `auth` then has no
	 * rows behind it, so a handler that re-reads them skips the re-read.
	 * Never set in production.
	 */
	has_test_context_preset: boolean;
	/**
	 * The raw request, for what the pipeline neither validates nor reads: a
	 * `raw_body` route's body stream, the undecoded URL. Its body can be read
	 * once: the pipeline already read it on a route with a JSON input, and
	 * `read_json_body` reads it, so a handler that reads it there finds it
	 * used. Its `headers.get(name)` answers `null` for an absent header, where
	 * `header_lines(name)` answers an empty list.
	 */
	request: Request;
	/**
	 * A query parameter's first value as Hono decodes it (`c.req.query(name)`):
	 * `''` for a key with no value, `undefined` when absent — for a parameter
	 * the route's `query` schema does not declare. A repeated key's later
	 * values are ignored, as on the Rust spine's `query_first`.
	 */
	query_first: (name: string) => string | undefined;
	/**
	 * The body read as JSON text (`read_json_body`, `http/json_text.ts`), the
	 * one read the authorization phase and input validation share — for a
	 * route that parses its own body.
	 */
	read_json_body: () => Promise<JsonBodyResult>;
	/** A request header as the lines the client sent (`get_header_lines`). */
	header_lines: (name: string) => Array<string>;
	/**
	 * Answer with `Connection: close`, whatever the result — the error catch's
	 * answer included — so the runtime drops the connection rather than read
	 * a request body nothing will read (an upload refused before its end).
	 * A raw result may not carry the header itself.
	 */
	close_connection: () => void;
	/**
	 * Open the SSE stream this request answers with (`route_sse(stream)`).
	 * The stream exists — `send`, `close`, and `on_close` work — from the
	 * moment this returns, so the handler can register it before it answers.
	 * Nothing is written on the context: the response is built only when the
	 * route answers with the stream, after any commit, through the context
	 * (so it carries what the middleware put there) and with
	 * `SSE_RESPONSE_HEADERS`. A stream the handler opens and does not answer
	 * with — it answers something else, or throws — is closed and its body
	 * cancelled, and the answer carries none of the stream's headers.
	 *
	 * @throws Error when `apply_route_specs` was given no `open_sse`
	 */
	open_sse: <T = unknown>(options?: RouteOpenSseOptions) => SseStream<T>;
	/**
	 * Transaction-scoped when `RouteSpec.transaction` is true (the default
	 * for non-GET); pool-level otherwise.
	 */
	db: Db;
	/**
	 * Eager fire-and-forget queue — push the in-flight `Promise<void>` for
	 * pool writes already running (audit emits, api-token usage
	 * tracking). The flush middleware drains via
	 * `flush_pending_effects` after the handler returns.
	 */
	pending_effects: Array<Promise<void>>;
	/**
	 * Deferred post-commit thunks — do not push directly; reach for
	 * `emit_after_commit(ctx, fn)` from `http/pending_effects.ts`. The flush
	 * middleware invokes each thunk after the handler (and any wrapping
	 * `db.transaction`) returns, closing the microtask-ordering window
	 * that an eager `Promise.resolve().then(fn)` leaves open inside the
	 * transaction.
	 */
	post_commit_effects: Array<() => void | Promise<void>>;
}

/** Options for `RouteContext.open_sse`. */
export interface RouteOpenSseOptions extends SseResponseOptions {
	/**
	 * Logger for the stream's serialization and `on_close` listener errors and
	 * its outbound-overflow warning. Default: the `log` given `apply_route_specs`.
	 */
	log?: Logger;
}

/**
 * What opens an SSE stream on a request without building its response: the
 * stream and its body, the shape of `create_sse_stream` (`realtime/sse.ts`),
 * which `create_app_server` passes. Injected, so this module stays free of
 * `hono/streaming`.
 */
export type RouteSseOpener = <T>(
	c: Context,
	log: Logger,
	options?: SseResponseOptions
) => OpenedSseStream<T>;

/**
 * Route handler function — receives the `RouteContext` and returns a result
 * (`route_ok`, `route_fail`, `route_raw`, `route_sse` in
 * `http/route_result.ts`) that `apply_route_specs` turns into the response.
 *
 * The type a `RouteSpec` stores, any result: `define_route` and
 * `attach_route_handler` check a handler against its route
 * (`TypedRouteHandler`) before it is stored.
 */
export type RouteHandler = (route: RouteContext) => RouteResult | Promise<RouteResult>;

/** Marks a `RouteSpec` made by `define_route` or `attach_route_handler`; no runtime property. */
declare const ROUTE_SPEC_BRAND: unique symbol;

/**
 * A single route definition — the unit of the surface map.
 *
 * `input` and `output` schemas align with SAES `ActionSpec` naming. Every
 * schema field takes a `@fuzdev/fuz_schema` schema, validated through
 * `parse`. Use `literal(null)` for routes with no request body (a DELETE
 * without one). A `GET` carries none, so its `input` must be `literal(null)`
 * — `apply_route_specs` refuses any other — and its fields go on `query`.
 */
export interface RouteSpec {
	method: RouteMethod;
	path: string;
	auth: RouteAuth;
	/** Returns a result the framework answers with; see `RouteHandler`. */
	handler: RouteHandler;
	description: string;
	/**
	 * URL path parameter schema. Use an `object` with string fields matching
	 * `:param` segments. It must be an object schema under any wrappers
	 * (`get_schema_entries`);
	 * `apply_route_specs` throws on one that isn't.
	 *
	 * REST-only — actions dispatch through a single JSON-RPC endpoint and encode
	 * everything in `input`, so `params` doesn't appear on `ActionSpec`.
	 */
	params?: AnySchema;
	/**
	 * URL query parameter schema. Use an `object` with string fields; it must
	 * be an object schema, as for `params`.
	 */
	query?: AnySchema;
	/** Request body schema. Use `literal(null)` for routes with no body. */
	input: AnySchema;
	/** Success response body schema. */
	output: AnySchema;
	/**
	 * Marks a route whose request and/or response carries **raw bytes or a
	 * streaming protocol** rather than JSON — git smart-HTTP, file-store
	 * binary uploads/downloads, raw internal callbacks. Disambiguates the
	 * overloaded `input: literal(null)`, which otherwise can't distinguish "no
	 * body" (`GET /health`) from "raw bytes" (a binary upload).
	 *
	 * A `raw_body` `POST` takes any `Content-Type` a browser can't send
	 * cross-origin without a preflight; every other `POST` route requires
	 * `application/json`, bodyless or not (415 `unsupported_content_type`
	 * otherwise — see `http/simple_request.ts`). The schema-driven round-trip
	 * test suite auto-skips `raw_body` routes (it can neither synthesize a
	 * meaningful body nor assert a JSON output shape), so consumers don't
	 * hand-maintain a `skip_routes` entry per binary route. Also surfaces in
	 * `AppSurfaceRoute` so generated docs render "raw" instead of a
	 * misleading `null` body.
	 */
	raw_body?: boolean;
	/**
	 * The route answers JSON-RPC 2.0 envelopes, its refusals included, not REST
	 * bodies — the pair `create_rpc_endpoint` builds. A JSON-RPC error envelope
	 * it answers is left out of the DEV error check and
	 * `assert_response_matches_spec`: no REST error definition describes one,
	 * and the dispatch core checks its own outputs. On any other route an
	 * envelope-shaped body is checked like any error body.
	 */
	jsonrpc?: boolean;
	/**
	 * Marks a route that issues a credential — a session cookie — while
	 * declaring no auth itself: login, signup, bootstrap. A forged cross-site
	 * request to one is login CSRF, so it must take the origin check, and
	 * assembly refuses it outside the auth middleware's scope, where no origin
	 * carve-out can reach (`assert_credential_routes_in_auth_scope`). A route
	 * that reads a credential (`auth.account` not `'none'`) is held there
	 * without the mark.
	 */
	mints_credential?: boolean;
	/**
	 * Marks a route that reads the resolved credential in its handler while
	 * declaring no auth gate — it answers an anonymous caller itself instead
	 * of taking the dispatcher's `401` (account status, the cell-scoped fact
	 * read, the JSON-RPC endpoint whose dispatcher gates each action).
	 * Outside the auth middleware's scope no session or bearer parsing runs
	 * and it would see every caller as anonymous, so assembly refuses it
	 * there (`assert_credential_routes_in_auth_scope`), as it does a route
	 * whose `auth.account` is not `'none'`.
	 *
	 * The handler owns the token-scope rule a gate would otherwise apply: a
	 * scope-narrowed API token reaches no non-RPC surface that reads account
	 * data, and `auth.required_scope` is refused on a route that admits
	 * anonymous callers. Read the credential through `get_public_account_id`
	 * (`auth/request_context.ts`), not `get_resolved_auth`, so a narrowed token is
	 * answered as the anonymous caller. The RPC endpoint is the exception — its
	 * dispatcher gates each method against the scope.
	 */
	reads_credential?: boolean;
	/**
	 * Rate limit key type — declares what this route's rate limiter is keyed on.
	 *
	 * When set, 429 `rate_limit_exceeded` is derived (`derive_route_errors`).
	 * The actual `RateLimiter` instance is still wired imperatively in the handler —
	 * this field is metadata for surface introspection and policy invariants.
	 */
	rate_limit?: RateLimitKey;
	/**
	 * The handler's error definitions (`rest_error`), one per code it answers
	 * with (a 404 for not-found, a 409 for a conflict).
	 *
	 * What the framework's own middleware answers (the input 400s, auth
	 * 401/403, rate limit 429) is derived from `method`, `auth`, the input
	 * slots, and `rate_limit` (`derive_route_errors`), and the middleware
	 * layers declare their own. The route's error map
	 * (`resolve_route_error_map`) is the union of all three: a definition here at
	 * a status another layer declares adds a branch there and replaces nothing.
	 */
	errors?: ReadonlyArray<RestErrorDef>;
	/**
	 * Headers every answer of the route carries, once a request reaches it:
	 * its own validation and gate refusals, the handler's result of any kind,
	 * and the error catch's 500 or 503 (a refusal by middleware ahead of the
	 * route, such as the origin check, carries none). For a header true of
	 * every answer — `Cache-Control: no-store` on a per-caller read — not one
	 * of a success alone, which the result carries.
	 *
	 * One value per name, a name once in any case, a value a `Headers`
	 * accepts and not empty; none of `ROUTE_RAW_REFUSED_HEADERS`, and neither
	 * `Content-Type` nor `Content-Length`, which belong to a body. A result
	 * whose own headers name one of these is refused when it is prepared —
	 * the declared value is the route's for every answer, so a second one is
	 * a conflict, not an override. `apply_route_specs` throws naming the
	 * route on a record off these rules.
	 */
	response_headers?: Readonly<Record<string, string>>;
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
	/**
	 * Present only in the types: a spec whose handler was checked against its
	 * route, which only `define_route` and `attach_route_handler` make. A spread
	 * of a spec keeps it, and is not checked again.
	 */
	readonly [ROUTE_SPEC_BRAND]: true;
}

/** The catch layers' answers, which a handler may also give on any route (`ALWAYS_ACCEPTED_ERRORS`). */
export type RouteAlwaysErrors = typeof REST_INTERNAL_ERROR | typeof REST_SERVICE_UNAVAILABLE;

/**
 * The derived definitions a handler may itself answer with, read off its
 * route's `auth` and `rate_limit` types: the 401 and the auth 403s (a handler
 * that re-checks admission) and the 429 of a rate-limited route. The input
 * 400s, the actor codes, and the 415 are the pipeline's alone, and left out.
 */
export type RouteHandlerDerivedErrors<TAuth extends RouteAuth, TRateLimit> =
	| (TAuth['account'] extends 'required'
			? typeof REST_AUTHENTICATION_REQUIRED
			: TAuth['actor'] extends 'required'
				? typeof REST_AUTHENTICATION_REQUIRED
				: never)
	| (TAuth['required_scope'] extends string ? typeof REST_TOKEN_SCOPE_REQUIRED : never)
	| (TAuth['credential_types'] extends ReadonlyArray<string>
			? typeof REST_CREDENTIAL_TYPE_REQUIRED
			: never)
	| (TAuth['roles'] extends ReadonlyArray<string> ? typeof REST_INSUFFICIENT_PERMISSIONS : never)
	| (TRateLimit extends RateLimitKey ? typeof REST_RATE_LIMIT_EXCEEDED : never);

/**
 * What a handler of a route may return: a success typed by the input side of
 * its `output`, a raw answer, an SSE stream, or a failure of a definition the
 * route allows — its `errors`, the derived ones a handler may give
 * (`RouteHandlerDerivedErrors`), and the catch layers' (`RouteAlwaysErrors`).
 */
export type RouteHandlerResult<
	TErrors extends ReadonlyArray<RestErrorDef>,
	TOutput extends AnySchema,
	TAuth extends RouteAuth,
	TRateLimit
> =
	| RouteOk<ReadonlyJson<InferInput<TOutput>>>
	| RouteRaw
	| RouteSse
	| RouteFailOf<TErrors[number] | RouteAlwaysErrors | RouteHandlerDerivedErrors<TAuth, TRateLimit>>;

/** A `params` or `query` slot's validated value: `undefined` when the route declares no schema. */
export type RouteSlotValue<TSchema extends AnySchema | undefined> = TSchema extends AnySchema
	? Infer<TSchema>
	: undefined;

/**
 * The `RouteContext` a route's handler receives, typed from its spec: `auth`
 * narrowed by `RequestContextForAuth`, and the validated `input`, `params`,
 * and `query` by their schemas.
 */
export type TypedRouteContext<
	TAuth extends RouteAuth,
	TInput extends AnySchema,
	TParams extends AnySchema | undefined,
	TQuery extends AnySchema | undefined
> = RouteContext<
	RequestContextForAuth<TAuth>,
	Infer<TInput>,
	RouteSlotValue<TParams>,
	RouteSlotValue<TQuery>
>;

/** A route handler checked against its route; see `RouteHandlerResult` and `TypedRouteContext`. */
export type TypedRouteHandler<
	TErrors extends ReadonlyArray<RestErrorDef>,
	TOutput extends AnySchema,
	TAuth extends RouteAuth,
	TRateLimit,
	TInput extends AnySchema = AnySchema,
	TParams extends AnySchema | undefined = undefined,
	TQuery extends AnySchema | undefined = undefined
> = (
	route: TypedRouteContext<TAuth, TInput, TParams, TQuery>
) =>
	| RouteHandlerResult<TErrors, TOutput, TAuth, TRateLimit>
	| Promise<RouteHandlerResult<TErrors, TOutput, TAuth, TRateLimit>>;

/** The fields of a route that carry no type parameter. */
type RouteShapePlain = Omit<
	RouteSpec,
	| 'handler'
	| 'errors'
	| 'output'
	| 'auth'
	| 'rate_limit'
	| 'input'
	| 'params'
	| 'query'
	| typeof ROUTE_SPEC_BRAND
>;

/**
 * A route minus its handler, with the types its handler is checked against
 * kept: what `define_route_shape` returns and `attach_route_handler` takes,
 * the hono-free half of a route a cross-process suite builds its surface from.
 */
export type RouteShape<
	TErrors extends ReadonlyArray<RestErrorDef> = ReadonlyArray<RestErrorDef>,
	TOutput extends AnySchema = AnySchema,
	TAuth extends RouteAuth = RouteAuth,
	TRateLimit extends RateLimitKey | undefined = RateLimitKey | undefined,
	TInput extends AnySchema = AnySchema,
	TParams extends AnySchema | undefined = AnySchema | undefined,
	TQuery extends AnySchema | undefined = AnySchema | undefined
> = RouteShapePlain & {
	auth: TAuth;
	output: TOutput;
	input: TInput;
	params?: TParams;
	query?: TQuery;
	errors?: TErrors;
	rate_limit?: TRateLimit;
};

/**
 * Refuses an `errors` list whose definitions were erased to `RestErrorDef`
 * (a code typed `string`), which would allow a handler any failure.
 */
export type KnownRouteErrors<TErrors extends ReadonlyArray<RestErrorDef>> =
	string extends TErrors[number]['code'] ? ReadonlyArray<never> : TErrors;

/**
 * Define a route: its handler is checked against the route's `output`,
 * `errors`, `auth`, and `rate_limit` (`TypedRouteHandler`), and the spec is
 * returned as it is, typed as a `RouteSpec`.
 *
 * A literal `errors` list is read as given; a list typed
 * `Array<RestErrorDef>` is refused (`KnownRouteErrors`).
 *
 * The handler's `route` is typed from the spec (`TypedRouteContext`). Where
 * that types `route.auth` non-null — the route requires an account or an
 * actor — the stored handler checks it before it runs and throws when it is
 * missing anyway (a spread of the spec whose `auth` was rewritten, a harness
 * that skipped the gate), which the error catch answers 500: a handler never
 * runs on a request context its type promised and the request lacks.
 *
 * @param spec - the route, its handler returning `route_ok`, `route_fail`, `route_raw`, or `route_sse`
 * @returns `spec`, its handler behind that check where the route requires one
 */
// @__NO_SIDE_EFFECTS__
export const define_route = <
	const TErrors extends ReadonlyArray<RestErrorDef> = [],
	TOutput extends AnySchema = AnySchema,
	const TAuth extends RouteAuth = RouteAuth,
	TRateLimit extends RateLimitKey | undefined = undefined,
	TInput extends AnySchema = AnySchema,
	TParams extends AnySchema | undefined = undefined,
	TQuery extends AnySchema | undefined = undefined
>(
	spec: RouteShape<TErrors, TOutput, TAuth, TRateLimit, TInput, TParams, TQuery> & {
		errors?: KnownRouteErrors<TErrors>;
		handler: TypedRouteHandler<TErrors, TOutput, TAuth, TRateLimit, TInput, TParams, TQuery>;
	}
): RouteSpec => {
	const handler = guard_route_auth(spec.auth, spec.handler as unknown as RouteHandler);
	return (
		handler === (spec.handler as unknown) ? spec : { ...spec, handler }
	) as unknown as RouteSpec;
};

/**
 * Define a route minus its handler, keeping the types `attach_route_handler`
 * checks its handler against.
 *
 * @param shape - the route without `handler`
 * @returns `shape`
 */
// @__NO_SIDE_EFFECTS__
export const define_route_shape = <
	const TErrors extends ReadonlyArray<RestErrorDef> = [],
	TOutput extends AnySchema = AnySchema,
	const TAuth extends RouteAuth = RouteAuth,
	TRateLimit extends RateLimitKey | undefined = undefined,
	TInput extends AnySchema = AnySchema,
	TParams extends AnySchema | undefined = undefined,
	TQuery extends AnySchema | undefined = undefined
>(
	shape: RouteShape<TErrors, TOutput, TAuth, TRateLimit, TInput, TParams, TQuery> & {
		errors?: KnownRouteErrors<TErrors>;
	}
): RouteShape<TErrors, TOutput, TAuth, TRateLimit, TInput, TParams, TQuery> => shape;

/**
 * Attach a handler to a route shape (`define_route_shape`), checked and
 * guarded as `define_route` checks and guards one.
 *
 * @param shape - the route without `handler`
 * @param handler - the handler, returning `route_ok`, `route_fail`, `route_raw`, or `route_sse`
 * @returns a new spec, `shape` with `handler`
 */
// @__NO_SIDE_EFFECTS__
export const attach_route_handler = <
	TErrors extends ReadonlyArray<RestErrorDef>,
	TOutput extends AnySchema,
	TAuth extends RouteAuth,
	TRateLimit extends RateLimitKey | undefined,
	TInput extends AnySchema,
	TParams extends AnySchema | undefined,
	TQuery extends AnySchema | undefined
>(
	shape: RouteShape<TErrors, TOutput, TAuth, TRateLimit, TInput, TParams, TQuery> & {
		errors?: KnownRouteErrors<TErrors>;
	},
	handler: TypedRouteHandler<TErrors, TOutput, TAuth, TRateLimit, TInput, TParams, TQuery>
): RouteSpec =>
	({
		...shape,
		handler: guard_route_auth(shape.auth, handler as unknown as RouteHandler)
	}) as unknown as RouteSpec;

/**
 * The handler behind the check its `route.auth` type promises: a route that
 * requires an actor gets a request context with one, a route that requires
 * an account a request context — else the call throws, naming what was
 * missing. Any other route's handler is returned as it is.
 */
const guard_route_auth = (auth: RouteAuth, handler: RouteHandler): RouteHandler => {
	const requires_actor = auth.actor === 'required';
	if (!requires_actor && auth.account !== 'required') return handler;
	return (route) => {
		if (route.auth === null || (requires_actor && route.auth.actor === null)) {
			throw new Error(
				`a route handler typed for ${requires_actor ? 'an acting actor' : 'an account'} ran with ${
					route.auth === null ? 'no request context' : 'no acting actor'
				} — the route's auth gate did not run`
			);
		}
		return handler(route);
	};
};

/**
 * A handler's result made ready to answer, by `prepare_route_response`: what
 * `emit_route_response` builds the response from.
 */
export type PreparedRouteResponse =
	| {
			readonly kind: 'body';
			/** `undefined` for a success, which answers the context's status (200), as `c.json` does. */
			readonly status: number | undefined;
			readonly body: RouteRawBody;
			/** Absent for a raw answer with no headers. */
			readonly headers: Record<string, string | Array<string>> | undefined;
			/** A success's `Set-Cookie` lines, `[]` for any other result. */
			readonly set_cookie: ReadonlyArray<string>;
	  }
	| {
			readonly kind: 'sse';
			readonly stream: SseStream<never>;
			readonly body: ReadableStream<Uint8Array>;
	  };

/** `SSE_RESPONSE_HEADERS` less the `Connection` that keeps a stream open, for a `HEAD`. */
const SSE_HEAD_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		Object.entries(SSE_RESPONSE_HEADERS).filter(([name]) => name.toLowerCase() !== 'connection')
	)
);

/** A `Content-Length` value: a decimal integer with no leading zero. */
const CONTENT_LENGTH_PATTERN = /^(0|[1-9]\d*)$/;

/** The statuses a response may not carry a body on. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * The statuses a response may not declare a `Content-Length` on: 204 (RFC
 * 9110 §8.6) and 205, whose response has no content (§15.3.6). A 304 may,
 * naming the size the selected representation would have (§8.6, §15.4.5), so
 * it keeps the rules of a null body.
 */
const NO_CONTENT_LENGTH_STATUSES: ReadonlySet<number> = new Set([204, 205]);

const ROUTE_RAW_REFUSED: ReadonlySet<string> = new Set(ROUTE_RAW_REFUSED_HEADERS);

/** A status a `Response` can be built with, 200 to 599. */
const is_route_status = (status: unknown): status is number =>
	typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599;

const is_route_raw_body = (body: unknown): body is RouteRawBody =>
	body === null ||
	typeof body === 'string' ||
	body instanceof Uint8Array ||
	body instanceof ReadableStream;

/**
 * Whether a view's resizable buffer shrank below it: such a view reads as
 * empty (`byteLength` 0) and every runtime would answer it as zero bytes, so
 * nothing but this tells it from bytes that are empty. Every method that
 * validates a view (`at` among them) throws on one out of bounds.
 */
const is_view_out_of_bounds = (view: Uint8Array): boolean => {
	if (view.byteLength !== 0) return false;
	try {
		view.at(0);
		return false;
	} catch {
		return true;
	}
};

/**
 * Prepare the response for a handler's result, checking everything it can see
 * that would keep it from being built or framed as declared, so
 * `emit_route_response` fails only on a stream disturbed past what a check
 * can see (`route_raw`). Runs inside
 * the route's transaction: a result it refuses throws, the transaction rolls
 * back, and the post-commit effects are discarded. Serializes a success's or
 * a failure's JSON body here for the same reason. Writes nothing.
 *
 * - a success — `value` as JSON, its `set_cookie` lines kept for the emit
 * - a failure — its body as JSON at its status, with the headers its
 *   definition derives (`Retry-After`); a failure carrying `set_cookie` is
 *   refused, since a refusal never sets a cookie
 * - a raw answer — checked by the rules `route_raw` lists
 * - an SSE answer — its stream must be one `RouteContext.open_sse` opened for
 *   this request (`opened_sse`), and the route may not have asked to close the
 *   connection (`SSE_RESPONSE_HEADERS` keep it alive)
 *
 * A raw or failure result whose headers name one of the route's
 * `response_headers`, or an SSE answer on a route declaring one of
 * `SSE_RESPONSE_HEADERS`, is refused: the declared header is the route's on
 * every answer.
 *
 * @param result - the handler's result
 * @param options - the request's label for refusals, the streams it opened, and what the route declared or asked of the response
 * @returns the prepared response
 * @throws TypeError when `result` is not a result the factories made — a `Response`, a success without a JSON value, a failure without its status or definition, a raw answer its rules refuse, a stream this request did not open, `undefined` or `null` — or conflicts with the route's `response_headers` or its `close_connection`
 */
export const prepare_route_response = (
	result: RouteResult,
	options: {
		/** Names the request in a refusal, `METHOD path`. */
		label: string;
		/** The streams `open_sse` opened for this request, each with its response. */
		opened_sse: ReadonlyMap<SseStream<never>, ReadableStream<Uint8Array>>;
		/** The route's `response_headers` names, lowercase. Default none. */
		response_header_names?: ReadonlySet<string>;
		/** Whether the handler called `close_connection`. Default `false`. */
		close_requested?: boolean;
	}
): PreparedRouteResponse => {
	const { label, opened_sse, response_header_names, close_requested = false } = options;
	const refuse = (reason: string): never => {
		throw new TypeError(
			`${label}: a route handler returned ${reason} — return \`route_ok\`, \`route_fail\`, \`route_raw\`, or \`route_sse\``
		);
	};
	const prepared = prepare_result(result, label, opened_sse, refuse);
	if (prepared.kind === 'sse') {
		if (close_requested) {
			return refuse('an SSE stream after asking to close the connection');
		}
		if (response_header_names) {
			for (const name of Object.keys(SSE_RESPONSE_HEADERS)) {
				if (response_header_names.has(name.toLowerCase())) {
					return refuse(`an SSE stream on a route declaring \`${name.toLowerCase()}\``);
				}
			}
		}
	} else if (response_header_names && prepared.headers && result.ok !== true) {
		// a success's only headers are `JSON_HEADERS`, which no declaration may name
		for (const name of Object.keys(prepared.headers)) {
			if (response_header_names.has(name.toLowerCase())) {
				return refuse(
					`a header \`${name.toLowerCase()}\` the route declares in \`response_headers\``
				);
			}
		}
	}
	return prepared;
};

const prepare_result = (
	result: RouteResult,
	label: string,
	opened_sse: ReadonlyMap<SseStream<never>, ReadableStream<Uint8Array>>,
	refuse: (reason: string) => never
): PreparedRouteResponse => {
	// each branch checks the fields it reads, so a malformed or nullish result
	// falls through to the refusal — a `Response` has its own `ok` and
	// `status`, but no `value`, `def`, `headers` record, or `stream`
	if (result instanceof Response) return refuse('a Response');
	if (result?.ok === true) {
		// a function, symbol, or `undefined` is no JSON value: `JSON.stringify`
		// writes nothing for it, which would answer an empty 200
		const text: unknown = JSON.stringify(result.value);
		if (typeof text !== 'string') return refuse('a success without a JSON value');
		const set_cookie = check_header_lines(result.set_cookie, label);
		return { kind: 'body', status: undefined, body: text, headers: JSON_HEADERS, set_cookie };
	}
	if (result?.ok === 'raw') return prepare_raw(result, refuse);
	if (result?.ok === 'sse') {
		const body = opened_sse.get(result.stream);
		if (!body) return refuse('an SSE stream this request did not open');
		return { kind: 'sse', stream: result.stream, body };
	}
	if (result && !result.ok && result.def !== undefined && is_route_status(result.status)) {
		if ('set_cookie' in result) return refuse('a failure carrying a cookie');
		const derived = result.def.headers?.(result.body as never);
		const headers = check_header_record({ ...JSON_HEADERS, ...derived }, refuse);
		return {
			kind: 'body',
			status: result.status,
			body: JSON.stringify(result.body),
			headers,
			set_cookie: []
		};
	}
	return refuse('a malformed result');
};

/** The headers `c.json` writes, a success's and a failure's. */
const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'Content-Type': 'application/json'
});

const prepare_raw = (raw: RouteRaw, refuse: (reason: string) => never): PreparedRouteResponse => {
	const { status, body } = raw;
	if (!is_route_status(status)) return refuse(`a raw answer at status ${String(status)}`);
	if (!is_route_raw_body(body)) return refuse('a raw answer whose body is no `RouteRawBody`');
	// what a `Response` can't be built from, or a runtime can't write
	if (body instanceof ReadableStream && body.locked) {
		return refuse('a raw answer whose stream body is locked');
	}
	if (body instanceof Uint8Array && body.buffer instanceof ArrayBuffer && body.buffer.detached) {
		return refuse('a raw answer whose bytes are detached');
	}
	if (body instanceof Uint8Array && is_view_out_of_bounds(body)) {
		return refuse('a raw answer whose bytes are out of their shrunk buffer');
	}
	if (body !== null && NULL_BODY_STATUSES.has(status)) {
		return refuse(`a raw answer with a body at null-body status ${status}`);
	}
	if (typeof raw.headers !== 'object' || raw.headers === null) {
		return refuse('a raw answer without a headers record');
	}
	const headers = check_header_record(raw.headers, refuse);
	const names = Object.keys(headers).map((name) => name.toLowerCase());
	for (const name of names) {
		if (ROUTE_RAW_REFUSED.has(name)) return refuse(`a raw answer carrying \`${name}\``);
	}
	if (body !== null && !names.includes('content-type')) {
		return refuse('a raw answer with a body and no `Content-Type`');
	}
	const length_name = Object.keys(headers).find((name) => name.toLowerCase() === 'content-length');
	if (length_name !== undefined) {
		if (NO_CONTENT_LENGTH_STATUSES.has(status)) {
			return refuse(`a raw answer with a \`Content-Length\` at status ${status}`);
		}
		const length = headers[length_name];
		if (typeof length !== 'string' || !CONTENT_LENGTH_PATTERN.test(length)) {
			return refuse(
				'a raw answer whose `Content-Length` is not a decimal integer without a leading zero'
			);
		}
		if (!Number.isSafeInteger(Number(length))) {
			return refuse(
				`a raw answer whose \`Content-Length\` ${length} is past the safe integer range`
			);
		}
		// a null or stream body declares a size it does not carry (`HEAD`,
		// `X-Accel-Redirect`); a body in hand must be exactly that size
		const byte_length =
			typeof body === 'string'
				? new TextEncoder().encode(body).byteLength
				: body instanceof Uint8Array
					? body.byteLength
					: null;
		if (byte_length !== null && Number(length) !== byte_length) {
			return refuse(
				`a raw answer whose \`Content-Length\` ${length} is not its body's ${byte_length} bytes`
			);
		}
	}
	return {
		kind: 'body',
		status,
		body,
		headers: names.length === 0 ? undefined : headers,
		set_cookie: []
	};
};

/**
 * A header record copied, each name once in any case, each value one a
 * `Headers` accepts — so building the response from it cannot throw.
 */
const check_header_record = (
	record: Readonly<Record<string, unknown>>,
	refuse: (reason: string) => never
): Record<string, string | Array<string>> => {
	const copy: Record<string, string | Array<string>> = {};
	const seen: Set<string> = new Set();
	const trial = new Headers();
	for (const [name, value] of Object.entries(record)) {
		const lower = name.toLowerCase();
		if (seen.has(lower)) return refuse(`headers naming \`${lower}\` twice`);
		seen.add(lower);
		const values = typeof value === 'string' ? [value] : value;
		if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
			return refuse(`a header \`${name}\` that is no string or list of strings`);
		}
		// an empty value a runtime writes its own way (Bun adds a line of its own)
		if (values.length === 0 || values.includes('')) {
			return refuse(`a header \`${name}\` with an empty value`);
		}
		try {
			for (const v of values) trial.append(name, v);
		} catch {
			return refuse(`a header \`${name}\` a \`Headers\` refuses`);
		}
		copy[name] = typeof value === 'string' ? value : [...values];
	}
	return copy;
};

// a success's `Set-Cookie` lines, each a string a `Headers` accepts
const check_header_lines = (lines: unknown, label: string): ReadonlyArray<string> => {
	if (!Array.isArray(lines)) {
		throw new TypeError(`${label}: a route success whose \`set_cookie\` is no list`);
	}
	const trial = new Headers();
	for (const line of lines) {
		if (typeof line !== 'string') {
			throw new TypeError(`${label}: a route success whose \`set_cookie\` holds a non-string`);
		}
		try {
			trial.append('set-cookie', line);
		} catch {
			throw new TypeError(
				`${label}: a route success whose \`set_cookie\` holds a line a \`Headers\` refuses`
			);
		}
	}
	return lines as ReadonlyArray<string>;
};

/**
 * Build the response `prepare_route_response` prepared — the one place a route
 * result becomes a `Response`, and only once the route's transaction has
 * committed, so nothing a handler returned reaches the wire for writes that
 * rolled back. Built through the Hono context (`c.body`), so the headers the
 * middleware put on the context — the session middleware's clear of a stale
 * cookie — lead, and a success's `Set-Cookie` lines follow them in order.
 * A success is written as `c.json` writes it, a failure as
 * `c.json(body, status, headers)` does, and an SSE stream with
 * `SSE_RESPONSE_HEADERS`.
 *
 * The prepare checked everything it can see. What it can't — a stream body
 * read and released, unlocked yet disturbed — makes the `Response` constructor
 * throw here, after the commit; `apply_route_specs` rethrows that as an error
 * naming the route and the commit, which the error catch logs and answers 500.
 *
 * A `HEAD` request — which Hono answers by running the `GET` route and
 * dropping the body unread, never cancelling it — gets a stream's status and
 * headers alone, and the stream released here: an SSE stream is closed, so
 * its `on_close` listeners run and a registry drops it, and a raw stream body
 * is cancelled, which releases its source (`route_raw`). An SSE answer to a
 * `HEAD` leaves out `SSE_RESPONSE_HEADERS`' `Connection: keep-alive`, which
 * keeps a stream's connection open and would hold one with no stream on it
 * past a client's `Connection: close` (`@hono/node-server` honors it). Text and bytes are
 * built as for a `GET` — Hono drops them, and an outer layer that reads the
 * answer (the DEV error check) still sees its body.
 *
 * @param c - the Hono context
 * @param prepared - what `prepare_route_response` returned
 * @returns the response
 * @throws TypeError when the runtime refuses to build a response from a prepared body
 */
export const emit_route_response = (c: Context, prepared: PreparedRouteResponse): Response => {
	const head = c.req.method === 'HEAD';
	if (prepared.kind === 'sse') {
		if (head) {
			prepared.stream.close();
			cancel_unread(prepared.body);
			return c.body(null, undefined, SSE_HEAD_RESPONSE_HEADERS);
		}
		return c.body(prepared.body as never, undefined, SSE_RESPONSE_HEADERS);
	}
	const { status, headers, set_cookie } = prepared;
	let { body } = prepared;
	if (head && body instanceof ReadableStream) {
		cancel_unread(body);
		body = null;
	}
	const data = body as never;
	if (set_cookie.length === 0) return c.body(data, status as never, headers);
	// the `ResponseInit` form appends its `set-cookie` lines to the context's
	// headers, after the middleware's, where a header record would replace them
	const init: ResponseInit = {
		status,
		headers: set_cookie.map((line): [string, string] => ['set-cookie', line])
	};
	return c.body(data, init as never, headers);
};

/**
 * The header names `RouteSpec.response_headers` may not declare, lowercase:
 * `ROUTE_RAW_REFUSED_HEADERS`, which are the server's or a success's, and the
 * two a body determines.
 */
const RESPONSE_HEADERS_REFUSED: ReadonlySet<string> = new Set([
	...ROUTE_RAW_REFUSED_HEADERS,
	'content-type',
	'content-length'
]);

// throws unless `response_headers` holds a header a response can carry on
// every answer: by the raw rules (`check_header_record`), one string per name,
// and no name `RESPONSE_HEADERS_REFUSED` lists
const assert_response_headers = (
	record: Readonly<Record<string, string>> | undefined,
	route_key: string
): void => {
	if (record === undefined) return;
	const refuse = (reason: string): never => {
		throw new Error(`Route "${route_key}": response_headers holds ${reason}`);
	};
	if (typeof record !== 'object' || record === null || Array.isArray(record)) {
		refuse('no headers record');
	}
	check_header_record(record, refuse);
	for (const [name, value] of Object.entries(record)) {
		if (typeof value !== 'string') refuse(`a header \`${name}\` that is no string`);
		if (RESPONSE_HEADERS_REFUSED.has(name.toLowerCase())) {
			refuse(`\`${name.toLowerCase()}\`, which a route may not declare for every answer`);
		}
	}
};

/**
 * The route's first stage: write its `response_headers` on the context, ahead
 * of everything else on the route, so every answer built through the context
 * from here — a refusal, the handler's result, the error catch's — carries
 * them. Empty when the route declares none.
 */
const create_response_headers_entry = (
	record: Readonly<Record<string, string>> | undefined
): Array<MiddlewareHandler> => {
	if (record === undefined) return [];
	const entries = Object.entries(record);
	if (entries.length === 0) return [];
	const write: MiddlewareHandler = async (c, next): Promise<void> => {
		for (const [name, value] of entries) c.header(name, value);
		await next();
	};
	return [write];
};

/**
 * Create the content-type check for a route spec: a `POST` whose
 * `Content-Type` the route refuses (`is_post_content_type_refused` — anything
 * but JSON, or for a `raw_body` route anything a browser sends cross-origin
 * without a preflight) gets 415 before anything else on the route runs. The
 * Rust spine's JSON handlers check the same, first thing after the origin.
 *
 * Returns an empty array for other methods, which are never CORS-simple and
 * so always preflighted.
 */
const create_content_type_check = (spec: RouteSpec): Array<MiddlewareHandler> => {
	if (spec.method !== 'POST') return [];
	const raw_body = spec.raw_body ?? false;
	const check: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		if (is_post_content_type_refused(c.req.header('content-type'), raw_body)) {
			return c.json({ error: ERROR_UNSUPPORTED_CONTENT_TYPE }, 415);
		}
		await next();
	};
	return [check];
};

/**
 * Create input validation middleware for a route spec.
 *
 * Returns an empty array for null-input routes (no body expected; every
 * `GET`, as `apply_route_specs` refuses a `GET` with an input). For other
 * routes with input
 * schemas, returns a middleware that parses and validates the JSON body,
 * storing the result on the context as `validated_input`. A body that parses
 * but holds U+0000 in a string or key is `invalid_request_body` ahead of the
 * schema (`scan_json_value`), since Postgres refuses it. Input validation
 * runs after the authorization phase and the post-authorization guards, so a
 * caller they refuse never sees a parse failure; the authorization phase reads
 * `acting` off the raw body itself (`read_route_acting` in
 * `auth/request_context.ts`), treating a malformed body as no selector.
 *
 * @mutates `c.var.validated_input` - set to the parsed and validated body on success
 */
const create_input_validation = (input_schema: AnySchema): Array<MiddlewareHandler> => {
	if (is_null_schema(input_schema)) return [];

	const validate: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		const read = await read_json_body(c.req);
		if (!read.ok) return c.json({ error: ERROR_INVALID_JSON_BODY }, 400);
		const body = read.value;
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return c.json({ error: ERROR_INVALID_JSON_BODY }, 400);
		}
		// U+0000 in any string or key, which Postgres refuses to store, ahead of
		// the schema, flat as the Rust spine's `parse_json_body` answers it
		if (scan_json_value(body).nul) return c.json({ error: ERROR_INVALID_REQUEST_BODY }, 400);
		const result = parse(input_schema, body);
		if (!result.ok) {
			return c.json(
				{
					error: ERROR_INVALID_REQUEST_BODY,
					issues: dev_only(() => to_wire_issues(result.issues))
				},
				400
			);
		}
		c.set('validated_input', result.value);
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
const create_params_validation = (params_schema?: AnySchema): Array<MiddlewareHandler> => {
	if (!params_schema) return [];

	const validate: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		const raw_params = c.req.param();
		const result = parse(params_schema, raw_params);
		if (!result.ok) {
			return c.json(
				{
					error: ERROR_INVALID_ROUTE_PARAMS,
					issues: dev_only(() => to_wire_issues(result.issues))
				},
				400
			);
		}
		c.set('validated_params', result.value);
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
const create_query_validation = (query_schema?: AnySchema): Array<MiddlewareHandler> => {
	if (!query_schema) return [];

	const validate: MiddlewareHandler = async (c, next): Promise<Response | void> => {
		const raw_query = c.req.query();
		const result = parse(query_schema, raw_query);
		if (!result.ok) {
			return c.json(
				{
					error: ERROR_INVALID_QUERY_PARAMS,
					issues: dev_only(() => to_wire_issues(result.issues))
				},
				400
			);
		}
		c.set('validated_query', result.value);
		await next();
	};
	return [validate];
};

/**
 * Wrap a handler with DEV-only output validation.
 *
 * In development, validates 2xx JSON responses against the output schema,
 * logging an error on a mismatch and returning the response unchanged — it
 * never throws. Non-2xx responses are the DEV error check's
 * (`create_dev_route_error_check`), which `create_app_server` mounts
 * outermost so it sees what every layer answers. Non-JSON responses (SSE,
 * binary) are skipped. The schema is parsed with `parse`; the log carries
 * its issues. In production,
 * returns the handler unchanged.
 */
const wrap_output_validation = (
	handler: Handler,
	output_schema: AnySchema,
	log: Logger
): Handler => {
	if (!DEV) return handler;
	if (is_null_schema(output_schema)) return handler;
	return async (c, next) => {
		const response = await handler(c, next);
		if (!response.ok) return response;
		// Only validate JSON responses — streaming responses (SSE) would hang on .json().
		if (!is_json_response(response)) return response;
		let body: unknown;
		try {
			body = await response.clone().json();
		} catch {
			// clone() or json() failed on a response claiming application/json
			return response;
		}
		const result = parse(output_schema, body);
		if (!result.ok) {
			log.error(`Output schema mismatch: ${c.req.method} ${c.req.path}`, result.issues);
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
 * Catches a thrown JSON-RPC error — a `ThrownJsonrpcError` from any copy of
 * fuz_app, recognized by its brand (`to_thrown_jsonrpc_error`) — and maps it
 * to a flat REST error body (`{error: <reason>, message?, ...rest_data}`)
 * at the matching HTTP status.
 * A failed pool checkout (`DbCheckoutError`) answers the flat 503
 * `{error: 'service_unavailable'}` with no `message`, byte for byte the Rust
 * spine's `db_unavailable_response`.
 * Catches anything else, a foreign error class carrying a JSON-RPC `code`
 * included, and maps to `{error: 'internal_error', message?}`
 * at 500 (`message` populated only in DEV). A handler's returned result is
 * unaffected — the catch layer only activates when something is thrown.
 *
 * The flat shape matches what middleware and handler failures produce
 * (`c.json({error: ERROR_FOO}, status)` in a middleware, `route_fail(def)` in a
 * handler, `c.json(failure.body, status)` from the dispatcher's authorization
 * phase),
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
 * emits the flat body; JSON-RPC dispatcher emits the JSON-RPC envelope) avoids
 * a hybrid envelope that has to be normalized on the way out.
 */
const wrap_error_catch = (handler: Handler, log: Logger): Handler => {
	return async (c, next) => {
		try {
			return await handler(c, next);
		} catch (err) {
			// a failed pool checkout is the database unavailable: the flat 503 the
			// Rust spine's `db_unavailable_response` answers, no message
			if (is_db_checkout_error(err)) {
				log.error('pool checkout failed:', err);
				return c.json({ error: ERROR_SERVICE_UNAVAILABLE }, 503);
			}
			// recognized by brand, so a second fuz_app copy's error maps too
			const thrown = to_thrown_jsonrpc_error(err);
			if (thrown) {
				const status = jsonrpc_error_code_to_http_status(thrown.code);
				return c.json(build_rest_error_body(thrown), status);
			}
			// generic error — internal_error. Raw exception messages can leak
			// internals; surface them only in development (same gate as the
			// validation-issue redaction), production gets the bare error code.
			log.error('Unhandled handler error', err);
			const body: Record<string, unknown> = {
				error: ERROR_INTERNAL_ERROR,
				message: dev_only(() => (err instanceof Error ? err.message : undefined))
			};
			return c.json(body, 500);
		}
	};
};

/**
 * Build the REST body for a thrown JSON-RPC error. Splits out
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
const build_rest_error_body = (err: JsonrpcErrorObject): Record<string, unknown> => {
	let reason: string;
	const rest: Record<string, unknown> = {};
	if (
		err.data !== null &&
		typeof err.data === 'object' &&
		!Array.isArray(err.data) &&
		typeof (err.data as { reason?: unknown }).reason === 'string'
	) {
		const { reason: data_reason, ...other } = err.data as Record<string, unknown> & {
			reason: string;
		};
		reason = data_reason;
		Object.assign(rest, other);
	} else {
		reason = jsonrpc_error_code_to_name(err.code);
		if (err.data !== null && typeof err.data === 'object' && !Array.isArray(err.data)) {
			Object.assign(rest, err.data);
		}
	}
	const body: Record<string, unknown> = { error: reason, ...rest };
	if (err.message && err.message !== reason) body.message = err.message;
	return body;
};

/**
 * Apply route specs to a Hono app.
 *
 * For each spec: resolves auth to guards via the provided resolver,
 * adds input validation middleware (for routes with non-null input schemas),
 * runs the optional authorization phase to resolve the acting actor + build
 * the request context, wraps handler with DEV-only output
 * validation, builds each response from its handler's result
 * (`prepare_route_response` inside the transaction, `emit_route_response`
 * after it), wraps with error catch layer (a thrown JSON-RPC error,
 * recognized via `to_thrown_jsonrpc_error`, maps to its status; any other
 * throw to a 500), and registers the route.
 *
 * Per-route middleware order: content type (415, `POST` only) → params →
 * query → pre-authorization auth guards (401 + rule-3 scope) →
 * authorization phase → post-authorization auth guards (403) → input
 * validation (400) → handler. The content type goes first because it says
 * almost nothing about the route, and a forged request should be refused
 * before any credential is read. Body
 * validation runs behind every authority gate, so a caller
 * any of them refuse never sees route-shape information from a parse
 * failure — a 400 there would confirm the route exists and describe how
 * to call it. Params and query still validate first (they address the
 * route rather than carry its payload, and the authorization phase reads
 * `acting` off the query on GETs).
 *
 * Each handler receives a `RouteContext` and nothing else: built from the
 * Hono context once every stage before the handler has run, with `db`
 * transaction-scoped when `RouteSpec.transaction` is true and the pool
 * otherwise, and `open_sse` opening through `options.open_sse`.
 *
 * A route's `response_headers` are written on the context by its first
 * stage, ahead of the content-type check, so every answer the route gives
 * carries them; a record off their rules throws at registration.
 *
 * Also enforces the auth shape's registry-time invariants: the cross-axis
 * invariants 1, 3, and 4 (`assert_route_auth_invariants`), and invariant 2:
 * `auth.actor !== 'none' ⟺ input or query declares acting?: ActingActor`.
 * REST is bi-located (GETs declare `acting` on `query`, mutations on
 * `input`), so the check passes both slots; the action-dispatcher
 * registries (`compile_action_registry`) share the same helper with
 * `input` only — `ActionSpec` has no `query` shape.
 *
 * Every schema slot (`params`, `query`, `input`, `output`) must hold a
 * `@fuzdev/fuz_schema` schema (`assert_validation_schema`), and every
 * `errors` entry an error definition (`rest_error`): anything else throws
 * naming the route and the slot. A `params` or `query`
 * must be an object schema (`get_schema_entries`), as the path params and
 * query string are an object: one that isn't throws naming the route. A
 * `GET` carries no body, so its `input` must be a null schema
 * (`is_null_schema`): any other throws naming the route.
 *
 * In DEV each handler's 2xx JSON responses are checked against its `output`.
 * Error responses are checked by the DEV error check
 * (`create_dev_route_error_check`), which `create_app_server` mounts outermost.
 *
 * @param resolve_auth_guards - maps `RouteAuth` to middleware — use `fuz_auth_guard_resolver` from `auth/auth_guard_resolver.ts`
 * @param db - used for transaction wrapping and `RouteContext`
 * @param options - the authorization phase and the SSE opener
 * @mutates `app`
 * @throws Error if two specs share the same `method` + `path` (each combination must be unique), if a schema slot holds a value that is no schema or an `errors` entry is not a definition, if a `GET` declares an `input` other than `literal(null)`, if any spec violates a cross-axis auth invariant or the actor-acting biconditional, if a `params` or `query` is not an object schema, or if `response_headers` is off its rules
 */
export const apply_route_specs = (
	app: Hono,
	specs: Array<RouteSpec>,
	resolve_auth_guards: AuthGuardResolver,
	log: Logger,
	db: Db,
	options?: ApplyRouteSpecsOptions
): void => {
	const { authorize, open_sse } = options ?? {};
	const registered = new Set<string>();
	for (const spec of specs) {
		const route_key = format_route_key(spec);
		if (registered.has(route_key)) {
			throw new Error(
				`Duplicate route: ${route_key} — each method+path combination must be unique`
			);
		}
		registered.add(route_key);
		assert_schema_slots(spec, route_key);
		assert_get_has_no_input(spec, route_key);
		assert_object_slot(spec.params, 'params', route_key);
		assert_object_slot(spec.query, 'query', route_key);
		assert_response_headers(spec.response_headers, route_key);
		assert_route_auth_invariants(spec.auth, `Route "${route_key}"`);
		assert_route_auth_acting_biconditional(
			spec.auth,
			{ input: spec.input, query: spec.query },
			`Route "${route_key}"`
		);
		const {
			pre_authorization: pre_authorization_guards,
			post_authorization: post_authorization_guards
		} = resolve_auth_guards(spec.auth);
		const response_headers_entry = create_response_headers_entry(spec.response_headers);
		const content_type_check = create_content_type_check(spec);
		const params_validation = create_params_validation(spec.params);
		const query_validation = create_query_validation(spec.query);
		const input_validation = create_input_validation(spec.input);
		const authorization: Array<MiddlewareHandler> = authorize
			? [
					async (c, next): Promise<Response | void> => {
						const response = await authorize(c, spec);
						if (response) return response;
						await next();
					}
				]
			: [];
		// Step 1: adapt RouteHandler → Handler (construct RouteContext, call
		// spec.handler, build the response from its result)
		const use_transaction = spec.transaction ?? spec.method !== 'GET';
		const inner = spec.handler;
		// Discard post-commit effects a handler queued (`emit_after_commit`) if it
		// throws — a thrown handler rolls back its wrapping transaction, so firing
		// those effects would announce state that never committed. The eager
		// `pending_effects` queue (attempt audits, run outside the transaction) is
		// untouched. Shared with the action dispatcher (actions/perform_action.ts)
		// via `dispatch_with_post_commit_rollback`. The response is prepared
		// inside the dispatch, so a result that can't become one throws before
		// the commit and rolls back; it is built after the dispatch returns, so a
		// commit that fails answers the error catch's 500 and nothing the handler
		// returned — no cookie for a session that rolled back.
		const response_header_names: ReadonlySet<string> = new Set(
			Object.keys(spec.response_headers ?? {}).map((name) => name.toLowerCase())
		);
		const has_input = !is_null_schema(spec.input);
		let handler: Handler = async (c) => {
			const label = `${c.req.method} ${c.req.path}`;
			const opened_sse: Map<SseStream<never>, ReadableStream<Uint8Array>> = new Map();
			// what the handler returned, and the stream body the response took
			let returned: RouteResult | undefined;
			let answered_body: ReadableStream<Uint8Array> | null = null;
			// `close_connection` asks; the header is written once, on whichever
			// answer the route gives — the emitted result or the error catch's
			let close_requested = false;
			const route_context: Omit<RouteContext, 'db'> = {
				auth: c.var.request_context ?? null,
				credential: c.get(RESOLVED_AUTH_KEY) ?? null,
				client_ip: get_client_ip(c),
				connection_ip: c.get(CONNECTION_IP_KEY) ?? null,
				signal: c.req.raw.signal,
				input: has_input ? c.var.validated_input : null,
				params: spec.params ? c.var.validated_params : undefined,
				query: spec.query ? c.var.validated_query : undefined,
				has_test_context_preset: has_test_context_preset(c),
				request: c.req.raw,
				query_first: (name) => c.req.query(name),
				read_json_body: () => read_json_body(c.req),
				header_lines: (name) => get_header_lines(c, name),
				close_connection: () => {
					close_requested = true;
				},
				pending_effects: c.var.pending_effects,
				post_commit_effects: c.var.post_commit_effects,
				open_sse: <T>(sse_options?: RouteOpenSseOptions): SseStream<T> => {
					if (!open_sse) {
						throw new Error(
							`${label}: the route opened an SSE stream, and \`apply_route_specs\` was given no \`open_sse\``
						);
					}
					const { log: stream_log = log, ...rest } = sse_options ?? {};
					const { stream, body } = open_sse<T>(c, stream_log, rest);
					opened_sse.set(stream, body);
					return stream;
				}
			};
			// the handler, then the prepare, on the route's `db` — the transaction's
			// when it runs in one
			const run = async (route_db: Db): Promise<PreparedRouteResponse> => {
				returned = await inner({ ...route_context, db: route_db });
				return prepare_route_response(returned, {
					label,
					opened_sse,
					response_header_names,
					close_requested
				});
			};
			try {
				const prepared = await dispatch_with_post_commit_rollback(
					c.var.post_commit_effects,
					async () => (use_transaction ? db.transaction(run) : run(db))
				);
				if (close_requested) c.header('Connection', 'close');
				// after the commit: a failure here answers the error catch's 500 for
				// work that committed, so the error names that
				let response: Response;
				try {
					response = emit_route_response(c, prepared);
				} catch (error) {
					throw new Error(
						`${label}: the response could not be built after the route committed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error }
					);
				}
				if (prepared.kind === 'sse' || prepared.body instanceof ReadableStream) {
					answered_body = prepared.body as ReadableStream<Uint8Array>;
				}
				return response;
			} catch (error) {
				// the error catch answers through the context, so it carries the close
				if (close_requested) c.header('Connection', 'close');
				throw error;
			} finally {
				// a body no response took has no reader: an SSE stream opened and not
				// answered with is closed, and a raw stream body refused or rolled
				// back is cancelled, so its source (a file handle, a child process)
				// is released
				for (const [stream, body] of opened_sse) {
					if (body !== answered_body) {
						stream.close();
						cancel_unread(body);
					}
				}
				const raw_body = raw_stream_body(returned);
				if (raw_body && raw_body !== answered_body) cancel_unread(raw_body);
			}
		};
		// Step 2: error catch layer — a thrown error becomes its REST body here
		handler = wrap_error_catch(handler, log);
		// Step 3: output validation of a 2xx body
		handler = wrap_output_validation(handler, spec.output, log);
		app.on(
			spec.method,
			[spec.path],
			...response_headers_entry,
			...content_type_check,
			...params_validation,
			...query_validation,
			...pre_authorization_guards,
			...authorization,
			...post_authorization_guards,
			...input_validation,
			handler
		);
	}
};

// a handler result's raw stream body, if it is one
const raw_stream_body = (result: unknown): ReadableStream | null => {
	if (typeof result !== 'object' || result === null) return null;
	const { ok, body } = result as { ok?: unknown; body?: unknown };
	return ok === 'raw' && body instanceof ReadableStream ? body : null;
};

// cancel a body nothing reads; a locked one is its reader's to end
const cancel_unread = (body: ReadableStream): void => {
	if (body.locked) return;
	body.cancel().catch(() => {});
};

/** Options for `apply_route_specs`. */
export interface ApplyRouteSpecsOptions {
	/** The authorization phase; runs after the pre-authorization guards and before the post-authorization guards. */
	authorize?: AuthorizationHandler;
	/**
	 * What `RouteContext.open_sse` opens a stream with — `create_sse_stream`
	 * (`realtime/sse.ts`). Without it a route opening a stream throws.
	 */
	open_sse?: RouteSseOpener;
}

// throws unless every schema slot holds a fuz_schema schema and every
// `errors` entry is a definition; `params` and `query` may be absent
const assert_schema_slots = (spec: RouteSpec, route_key: string): void => {
	const label = `Route "${route_key}"`;
	if (spec.params !== undefined) assert_validation_schema(spec.params, `${label}: params`);
	if (spec.query !== undefined) assert_validation_schema(spec.query, `${label}: query`);
	assert_validation_schema(spec.input, `${label}: input`);
	assert_validation_schema(spec.output, `${label}: output`);
	if (spec.errors !== undefined) {
		if (!Array.isArray(spec.errors)) {
			throw new Error(`${label}: errors is not a list of error definitions (\`rest_error\`)`);
		}
		for (const [i, def] of spec.errors.entries()) {
			if (!is_schema((def as Partial<RestErrorDef> | null)?.schema)) {
				throw new Error(`${label}: errors[${i}] is not an error definition (\`rest_error\`)`);
			}
		}
	}
};

// throws when a `GET` declares an input: a `GET` carries no body, so nothing
// would validate it, and the handler's `input` and the surface's
// `input_schema` would both describe a value that never arrives
const assert_get_has_no_input = (spec: RouteSpec, route_key: string): void => {
	if (spec.method !== 'GET' || is_null_schema(spec.input)) return;
	throw new Error(
		`Route "${route_key}": input is not \`literal(null)\` — a GET carries no body; declare its fields on \`query\``
	);
};

// throws unless a `params` / `query` is an object schema under any wrappers
const assert_object_slot = (
	schema: AnySchema | undefined,
	slot: 'params' | 'query',
	route_key: string
): void => {
	if (schema === undefined || get_schema_entries(schema)) return;
	throw new Error(
		`Route "${route_key}": ${slot} is a @fuzdev/fuz_schema '${schema.kind}' schema, not an object schema`
	);
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
		path: spec.path === '/' ? prefix : `${prefix}${spec.path}`
	}));
};
