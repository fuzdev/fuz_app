import '../assert_dev_env.ts';

/**
 * Table runner for the declarative cross-backend conformance suite.
 *
 * `describe_conformance_table_tests` takes a list of `ConformanceCase`
 * rows plus the standard `{setup_test, surface_source, capabilities}`
 * fixture protocol every Tier 1 suite uses — so **one runner drives both
 * transports**: in-process via `default_in_process_setup` (fast, every
 * `gro test`) and cross-process via `default_cross_process_setup` (the
 * conformance gate, exercising each impl's real auth resolution over real
 * HTTP). Same case definition, transport-parameterized.
 *
 * Each row references a `method`; the runner resolves its `input` /
 * `output` schema from the live spec registry (RPC) or `RouteSpec` (the 6
 * REST auth routes) — the row never carries a schema. The principal the
 * row runs `as` resolves to a `TestFixture` accessor via
 * `resolve_conformance_principal` — no inline credential minting.
 *
 * Every response also passes an always-on **no-fingerprint** invariant
 * (`assert_no_fingerprint_headers` over `FINGERPRINT_HEADERS` — `Server` /
 * `X-Powered-By` / `WWW-Authenticate` must stay absent on both spines), and
 * a row may pin further header expectations via `expect.headers`. Headers are
 * deliberately kept out of the equivalence-group `{status, body}` comparison.
 *
 * On HTTP every response is also held to what it does to the session cookie:
 * the row's `expect.set_cookie` — omitted meaning none — is matched against
 * `classify_session_cookie_effect` of its `Set-Cookie` lines, which reads the
 * clear and the mint through the spine's own formatters, with a floor behind
 * it that no response outside 2xx mints one (`assert_session_cookie`). An RPC
 * error row is held to its JSON-RPC `error.code` too, not just the status it
 * answers. Rows that can't honestly run are refused at collection
 * (`check_conformance_cases`).
 *
 * Given `ws`, the runner sends each case as a frame on a WebSocket instead:
 * the principal opens an admitted socket and the frame meets the per-message
 * gates. The frame carries the same JSON-RPC envelope the HTTP body does, so
 * the same rows hold, read through the status the HTTP binding maps the
 * frame's error code to; the cases a socket can't carry are left out
 * (`is_ws_conformance_case`).
 *
 * A case binding `request.acting` gets `params.acting` filled with a real
 * actor id at run time (`ConformanceActingBinding`), so rows can act as a
 * named actor of a multi-actor keeper without knowing its id.
 *
 * A case's RPC method resolves from the declared `rpc_endpoints` first, then
 * from `live_rpc_endpoints` when given — the methods a backend live-mounts
 * off the declared surface (cell verbs, opt-in resolvers, `_testing_*`
 * backdoors), so rows can reach them too.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import type { AppSurfaceSpec, RpcEndpointSpec } from '../../http/surface.ts';
import type { RouteMethod, RouteSpec } from '../../http/route_spec.ts';
import type { RpcAction } from '../../actions/action_types.ts';
import type { SessionOptions } from '../../auth/session_cookie.ts';
import {
	find_auth_route,
	rest_auth_route_suffixes,
	type RestAuthRouteSuffix
} from '../integration_helpers.ts';
import {
	find_rpc_action,
	headers_to_record,
	parse_rpc_call_result,
	rpc_call_raw,
	create_rpc_request_text,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption
} from '../rpc_helpers.ts';
import {
	http_status_to_jsonrpc_error_code,
	jsonrpc_error_code_to_http_status
} from '../../http/jsonrpc_errors.ts';
import type { JsonrpcErrorCode } from '../../http/jsonrpc.ts';
import { create_admitted_ws_transport } from '../transports/ws_transport.ts';
import { is_response_for } from '../transports/ws_client.ts';
import {
	type ConformanceActingBinding,
	type ConformanceCase,
	type ConformancePrincipal
} from './conformance_case.ts';
import type { BackendCapabilities } from './capabilities.ts';
import {
	classify_session_cookie_effect,
	filter_session_set_cookies,
	find_session_cookie_mints
} from './session_cookie_effect.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { xfail_until } from './xfail.ts';
import type { WsEndpointTarget } from './ws_endpoint.ts';
import {
	resolve_conformance_principal,
	type ConformancePrincipalConfig,
	type ResolvedConformancePrincipal
} from './conformance_principal.ts';

/** Options for `describe_conformance_table_tests`. */
export interface ConformanceTableOptions {
	/** The conformance cases to run, in order. */
	readonly cases: ReadonlyArray<ConformanceCase>;
	/** Per-test fixture producer (in-process or cross-process). */
	readonly setup_test: SetupTest;
	/** Surface spec — supplies the `RouteSpec`s for the REST branch. */
	readonly surface_source: AppSurfaceSpec;
	/** Declared backend capabilities (reserved for capability-gated rows). */
	readonly capabilities: BackendCapabilities;
	/** RPC endpoints — resolved to find each method's action spec. */
	readonly rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * The RPC endpoints the backend live-mounts, for methods kept off the
	 * declared `rpc_endpoints` (cell verbs, opt-in resolvers, `_testing_*`
	 * backdoors). A method resolves from `rpc_endpoints` first and from here
	 * only when the declared surface lacks it, so passing a backend's whole
	 * live mount is fine. Omitted, only declared methods resolve.
	 */
	readonly live_rpc_endpoints?: RpcEndpointsSuiteOption;
	/** Session options — needed to resolve the `rpc_endpoints` factory form. */
	readonly session_options: SessionOptions<string>;
	/** Maps the `role_holder` / `wrong_role` principals to seeded usernames. */
	readonly principals?: ConformancePrincipalConfig;
	/**
	 * Run the cases over a WebSocket at this endpoint instead of HTTP: each RPC
	 * case's principal opens an admitted socket and sends its request as a
	 * frame. Only the cases `is_ws_conformance_case` admits run; the rest are
	 * left out, and so is an equivalence group left with fewer than two members.
	 */
	readonly ws?: WsEndpointTarget;
	/** `describe` block label. Defaults to `'conformance table'`. */
	readonly suite_name?: string;
}

/** What `resolve_conformance_rpc_endpoints` reads. */
export interface ConformanceRpcEndpointsOptions {
	/** The declared RPC endpoints. */
	readonly rpc_endpoints: RpcEndpointsSuiteOption;
	/** The live-mounted RPC endpoints, for methods off the declared surface. */
	readonly live_rpc_endpoints?: RpcEndpointsSuiteOption;
	/** Session options — needed to resolve the factory forms. */
	readonly session_options: SessionOptions<string>;
}

/**
 * Resolve the endpoints a conformance case's RPC method is looked up in: the
 * declared `rpc_endpoints`, then `live_rpc_endpoints`. `find_rpc_action`
 * takes the first match, so a declared method resolves from the declared
 * surface even when the live mount repeats it.
 *
 * @param options - the declared and live endpoints, and the session options
 * @returns the endpoints in lookup order
 */
export const resolve_conformance_rpc_endpoints = (
	options: ConformanceRpcEndpointsOptions
): Array<RpcEndpointSpec> => [
	...resolve_rpc_endpoints_for_setup(options.rpc_endpoints, options.session_options),
	...(options.live_rpc_endpoints
		? resolve_rpc_endpoints_for_setup(options.live_rpc_endpoints, options.session_options)
		: [])
];

/**
 * Principals that cannot hold a socket: each presents no usable credential
 * (`anonymous`, the browser-discarded and malformed bearers, the dead
 * credentials) or one the upgrade refuses (`scoped_token` — a narrowed token
 * is refused `surface:ws_upgrade`), so the upgrade answers before any frame.
 * The front-door table (`describe_transport_composition_cross_tests`) pins
 * those upgrade refusals.
 */
const WS_UNAVAILABLE_PRINCIPALS: ReadonlySet<ConformancePrincipal> = new Set([
	'anonymous',
	'bearer_browser',
	'malformed_bearer',
	'expired_session',
	'tampered_cookie',
	'wrong_daemon',
	'unknown_bearer',
	'revoked_session',
	'revoked_token',
	'expired_token',
	'scoped_token'
] satisfies Array<ConformancePrincipal>);

/**
 * Whether a case can run over a WebSocket: an RPC method (not a REST auth
 * route), sent as `POST` (a `GET` row pins the HTTP query path), pinning no
 * header value and no session cookie effect (a frame has no headers; an
 * absence pin, `'none'` included, holds vacuously), as a principal that can
 * hold a socket.
 *
 * @param c - the case
 * @returns whether the WS leg runs it
 */
export const is_ws_conformance_case = (c: ConformanceCase): boolean =>
	!c.request.method.startsWith('/') &&
	(c.request.verb ?? 'POST') === 'POST' &&
	!Object.values(c.expect.headers ?? {}).some((value) => value !== null) &&
	(c.expect.set_cookie ?? 'none') === 'none' &&
	!WS_UNAVAILABLE_PRINCIPALS.has(c.request.as);

/** Assert each expected field deep-equals the corresponding response field. */
const assert_fields = (actual: unknown, fields: Record<string, unknown>, label: string): void => {
	assert.ok(
		actual !== null && typeof actual === 'object',
		`${label}: expected an object to read fields from, got ${JSON.stringify(actual)}`
	);
	const record = actual as Record<string, unknown>;
	for (const [key, expected] of Object.entries(fields)) {
		// the actual value in the message: chai truncates the values it prints,
		// and an `xfail` row's `fails_with` reads the message
		assert.deepEqual(
			record[key],
			expected,
			`${label}: field '${key}' is ${JSON.stringify(record[key])}`
		);
	}
};

/**
 * Whether `key` is present as an own property of `value` or any object nested
 * within it (arrays and objects walked recursively). The shape-agnostic test
 * behind `expect.absent_fields` — a secret column leaking at any depth (inside
 * a list element, a nested record) is caught, not just a top-level field.
 */
const has_key_anywhere = (value: unknown, key: string): boolean => {
	if (Array.isArray(value)) return value.some((v) => has_key_anywhere(v, key));
	if (value !== null && typeof value === 'object') {
		if (Object.hasOwn(value, key)) return true;
		return Object.values(value as Record<string, unknown>).some((v) => has_key_anywhere(v, key));
	}
	return false;
};

/** Assert none of the sensitive field names appear anywhere in the response body. */
const assert_absent_fields = (
	body: unknown,
	absent: ReadonlyArray<string>,
	label: string
): void => {
	for (const key of absent) {
		assert.ok(
			!has_key_anywhere(body, key),
			`${label}: response must not serialize the sensitive field '${key}' anywhere in its ` +
				`body — a secret column leaked into the wire shape.`
		);
	}
};

/**
 * Response headers that fingerprint the backend implementation or framework.
 * Neither spine emits these; the runner asserts they stay absent on EVERY
 * conformance response so a framework upgrade or consumer middleware that adds
 * (say) `Server:` to one spine can't silently become a backend-identifying
 * oracle. Lowercased — matched against the lowercased-key snapshot
 * `headers_to_record` produces.
 */
export const FINGERPRINT_HEADERS: ReadonlyArray<string> = [
	'server',
	'x-powered-by',
	'www-authenticate'
];

/**
 * Assert a response carries none of the `FINGERPRINT_HEADERS`. Run on every
 * case unconditionally — the always-on no-fingerprint floor.
 */
export const assert_no_fingerprint_headers = (
	headers: Record<string, string>,
	label: string
): void => {
	for (const name of FINGERPRINT_HEADERS) {
		assert.ok(
			!(name in headers),
			`${label}: response leaked backend-fingerprinting header '${name}: ${headers[name]}' — ` +
				`Server / X-Powered-By / WWW-Authenticate must stay absent on both spines.`
		);
	}
};

/**
 * Assert each declared header expectation: a string value must be present and
 * equal (header name matched case-insensitively), `null` must be absent. The
 * negative-space twin for headers — `expect.headers` pins a header beyond the
 * always-on no-fingerprint floor.
 */
export const assert_expected_headers = (
	headers: Record<string, string>,
	expected: Record<string, string | null>,
	label: string
): void => {
	for (const [name, value] of Object.entries(expected)) {
		const key = name.toLowerCase();
		if (value === null) {
			assert.ok(
				!(key in headers),
				`${label}: header '${name}' expected absent but present as '${headers[key]}'`
			);
		} else {
			assert.strictEqual(headers[key], value, `${label}: header '${name}'`);
		}
	}
};

/**
 * Run a case's header invariants: the always-on no-fingerprint floor on every
 * response plus any declared `expect.headers`. Header assertions are kept off
 * the equivalence-group `{status, body}` normalized response — `Set-Cookie` /
 * `Date` legitimately vary, so headers are never compared for byte-identity.
 */
const assert_response_headers = (headers: Record<string, string>, c: ConformanceCase): void => {
	assert_no_fingerprint_headers(headers, c.name);
	if (c.expect.headers) assert_expected_headers(headers, c.expect.headers, c.name);
};

const is_success_status = (status: number): boolean => status >= 200 && status < 300;

/**
 * Assert a response's session cookie lines against the row's
 * `expect.set_cookie` (omitted, `'none'`), by the classification both the
 * runner and the differential read (`classify_session_cookie_effect`) — the
 * assertion that decides a row.
 *
 * Ahead of it runs the floor: a response that is not 2xx mints no session
 * cookie (`find_session_cookie_mints`, which reads a mint in any shape). It is
 * a backstop, not a second guarantee: `check_conformance_cases` refuses a
 * non-2xx row expecting a mint, so on a row the table collected, a refusal
 * that mints already fails the effect assertion. The floor names the cause
 * plainly when it does, and holds for a caller asserting a row the collection
 * never saw.
 *
 * @param sent - the response, with every `Set-Cookie` line
 * @param c - the case
 * @param cookie_name - the session cookie's name
 */
export const assert_session_cookie = (
	sent: Pick<ConformanceCaseResponse, 'status' | 'set_cookies'>,
	c: ConformanceCase,
	cookie_name: string
): void => {
	if (!is_success_status(sent.status)) {
		const mints = find_session_cookie_mints(sent.set_cookies, cookie_name);
		assert.ok(
			mints.length === 0,
			`${c.name}: a ${sent.status} refusal minted a session cookie — ${JSON.stringify(mints)}`
		);
	}
	const expected = c.expect.set_cookie ?? 'none';
	const actual = classify_session_cookie_effect(sent.set_cookies, cookie_name);
	assert.strictEqual(
		actual,
		expected,
		`${c.name}: session cookie effect (its Set-Cookie lines: ${JSON.stringify(
			filter_session_set_cookies(sent.set_cookies, cookie_name)
		)})`
	);
};

/**
 * The wire-distinguishing content a case observed — `{status, body}` where
 * `body` is the success `result` or the error envelope (`{code, message,
 * data?}` for RPC, the flat `{error, ...}` for REST). Equivalence groups
 * compare this for byte-identity, so it is exactly what a prober sees.
 */
interface NormalizedResponse {
	readonly status: number;
	readonly body: unknown;
}

/** What `send_conformance_case` needs besides the case. */
export interface SendConformanceCaseOptions {
	/** The per-test fixture the principal resolves from. */
	readonly fixture: TestFixture;
	/** Surface spec — supplies the `RouteSpec`s for the REST branch. */
	readonly surface_source: AppSurfaceSpec;
	/** Usernames for the `role_holder` / `wrong_role` principals. */
	readonly principals?: ConformancePrincipalConfig;
	/**
	 * The endpoints RPC methods (and the `scoped_token` mint) resolve against —
	 * `resolve_conformance_rpc_endpoints` of the declared and live endpoints.
	 */
	readonly resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup>;
	/** Send the request as a frame on a socket at this endpoint instead of over HTTP. */
	readonly ws?: WsEndpointTarget;
	/**
	 * Headers added to the HTTP request beneath the principal's, which win on
	 * a name clash. Not sent on the WS leg (a frame carries no headers).
	 */
	readonly request_headers?: Readonly<Record<string, string>>;
}

/** The spec a sent case resolved to — the RPC action, or the REST route. */
export type ConformanceCaseTarget =
	| { readonly kind: 'rpc'; readonly path: string; readonly action: RpcAction }
	| { readonly kind: 'rest'; readonly route: RouteSpec };

/**
 * One case's request as sent and its response unparsed: the HTTP status, the
 * response-headers snapshot (lowercased keys), every `Set-Cookie` line in
 * order (the snapshot keeps only one), and the JSON body exactly as the server
 * sent it — the whole JSON-RPC envelope for an RPC method, `undefined` for a
 * REST body that is not JSON.
 *
 * Over a WebSocket the body is the response frame, the headers and
 * `Set-Cookie` lines are empty (a frame carries none), and the status is the
 * one the HTTP binding answers for the frame's outcome: `200` for a result,
 * else `jsonrpc_error_code_to_http_status` of its error code — so a row's
 * `expect.status` reads as the error code on both transports.
 */
export interface ConformanceCaseResponse {
	readonly target: ConformanceCaseTarget;
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly set_cookies: ReadonlyArray<string>;
	readonly body: unknown;
}

/**
 * Resolve a case's principal on `fixture` and send its request, asserting
 * nothing about the response.
 *
 * The send half of the table runner, shared with the cross-backend
 * differential (`describe_differential_conformance_tests`), which sends one
 * case to two backends and compares what came back.
 *
 * @param c - the case
 * @param options - the fixture, surface and endpoints to send through
 * @returns the resolved target and the raw response
 * @throws Error when the method is on neither the RPC surface nor the REST
 *   auth routes
 */
export const send_conformance_case = async (
	c: ConformanceCase,
	options: SendConformanceCaseOptions
): Promise<ConformanceCaseResponse> => {
	const { fixture, surface_source, principals, resolved_rpc_endpoints, ws, request_headers } =
		options;
	if (ws && !is_ws_conformance_case(c)) {
		throw new Error(
			`conformance: case '${c.name}' cannot run over a WebSocket (is_ws_conformance_case) — ` +
				`filter the cases before sending them on the WS leg.`
		);
	}
	const principal = await resolve_conformance_principal(
		fixture,
		c.request.as,
		principals,
		resolved_rpc_endpoints
	);
	const { transport, suppress_default_origin } = principal;
	const headers = request_headers
		? { ...request_headers, ...principal.headers }
		: principal.headers;
	const { params_json } = c.request;
	if (params_json !== undefined && (c.request.params !== undefined || c.request.acting)) {
		throw new Error(
			`conformance: case '${c.name}' sets params_json, so it can't also set params or acting.`
		);
	}
	const params = c.request.acting
		? bind_acting(c, resolve_acting_binding(c, c.request.acting, fixture, principal))
		: c.request.params;

	if (c.request.method.startsWith('/')) {
		if (params_json !== undefined) {
			throw new Error(
				`conformance: case '${c.name}' sets params_json, which only RPC methods take.`
			);
		}
		const suffix = c.request.method as RestAuthRouteSuffix;
		if (!rest_auth_route_suffixes.includes(suffix)) {
			throw new Error(
				`conformance: REST method '${c.request.method}' is not a known auth-route suffix ` +
					`(${rest_auth_route_suffixes.join(', ')}). Use an RPC method name for RPC actions.`
			);
		}
		const verb: RouteMethod = c.request.verb ?? 'POST';
		const route = find_auth_route(surface_source.route_specs, suffix, verb);
		if (!route) {
			throw new Error(`conformance: no REST route spec for ${verb} ${suffix} on the surface.`);
		}
		const init: RequestInit = {
			method: verb,
			headers: { 'Content-Type': 'application/json', ...headers },
			...(verb !== 'GET' && params !== undefined && { body: JSON.stringify(params) })
		};
		const response = await transport(route.path, init);
		const body: unknown = await response.json().catch(() => undefined);
		return {
			target: { kind: 'rest', route },
			status: response.status,
			headers: headers_to_record(response.headers),
			set_cookies: response.headers.getSetCookie(),
			body
		};
	}

	const found = find_rpc_action(resolved_rpc_endpoints, c.request.method);
	if (!found) {
		throw new Error(
			`conformance: RPC method '${c.request.method}' not found on the surface — ` +
				`check the method name or that the action is registered on rpc_endpoints ` +
				`(or, for a method off the declared surface, on live_rpc_endpoints).`
		);
	}
	if (ws) {
		return {
			target: { kind: 'rpc', ...found },
			...(await send_ws_frame(c.request.method, params, params_json, principal, ws))
		};
	}
	const raw = await rpc_call_raw({
		app: transport,
		path: found.path,
		method: c.request.method,
		params,
		...(params_json !== undefined && { params_json }),
		headers,
		...(c.request.verb && { verb: c.request.verb }),
		...(suppress_default_origin && { suppress_default_origin: true })
	});
	return { target: { kind: 'rpc', ...found }, ...raw };
};

/**
 * The request id the WS leg sends under — the id the HTTP leg's
 * `rpc_call_raw` sends by default, so the two envelopes read alike.
 */
const CONFORMANCE_REQUEST_ID = 'test';

/**
 * Open an admitted socket as the principal, send one request frame, and read
 * its response frame — the WS leg of `send_conformance_case`.
 *
 * The upgrade carries the principal's headers (its cookie, bearer or daemon
 * token) and the `Origin` the HTTP leg would send: none for a principal that
 * suppresses it, the target's otherwise. It also names the principal's own
 * actor as `?acting=`, which both spines resolve at the upgrade (a
 * multi-actor account's upgrade without one is refused 400
 * `actor_required`). Per-frame dispatch resolves the actor from each frame's
 * own `acting` on both. Because the leg always sends `?acting=`, it does not
 * cover the upgrade's own refusal — the front-door table's multi-actor row
 * does. The socket closes afterwards; a close error is not the case's subject
 * (a request that revokes its own credential closes the socket after its
 * reply).
 */
const send_ws_frame = async (
	method: string,
	params: unknown,
	params_json: string | undefined,
	principal: ResolvedConformancePrincipal,
	ws: WsEndpointTarget
): Promise<Omit<ConformanceCaseResponse, 'target'>> => {
	const client = await create_admitted_ws_transport({
		base_url: ws.base_url,
		ws_path:
			principal.actor_id === undefined
				? ws.ws_path
				: `${ws.ws_path}?acting=${encodeURIComponent(principal.actor_id)}`,
		cookies: [],
		headers: principal.headers,
		origin: principal.suppress_default_origin ? null : (ws.origin ?? ws.base_url)
	});
	try {
		if (params_json === undefined) {
			const frame: Record<string, unknown> = {
				jsonrpc: '2.0',
				id: CONFORMANCE_REQUEST_ID,
				method
			};
			if (params !== undefined && params !== null) frame.params = params;
			await client.send(frame);
		} else {
			await client.send_text(create_rpc_request_text(method, params_json, CONFORMANCE_REQUEST_ID));
		}
		const body = await client.wait_for<{ error?: { code?: unknown } }>(
			is_response_for(CONFORMANCE_REQUEST_ID)
		);
		const code = body.error?.code;
		const status =
			body.error === undefined
				? 200
				: typeof code === 'number'
					? jsonrpc_error_code_to_http_status(code as JsonrpcErrorCode)
					: 500;
		return { status, headers: {}, set_cookies: [], body };
	} finally {
		await client.close().catch(() => {});
	}
};

/**
 * The actor id a case's `acting` binding names on this fixture.
 *
 * @throws Error when the binding names an actor the fixture or principal lacks
 */
const resolve_acting_binding = (
	c: ConformanceCase,
	binding: ConformanceActingBinding,
	fixture: TestFixture,
	principal: ResolvedConformancePrincipal
): string => {
	switch (binding) {
		case 'principal':
			if (principal.actor_id === undefined) {
				throw new Error(
					`conformance: case '${c.name}' binds acting to its principal, but '${c.request.as}' ` +
						`presents no account to take an actor from.`
				);
			}
			return principal.actor_id;
		case 'extra_actor': {
			const extra = fixture.extra_actors[0];
			if (!extra) {
				throw new Error(
					`conformance: case '${c.name}' binds acting to the keeper's extra actor, but the ` +
						`fixture seeds none — declare extra_actors at setup.`
				);
			}
			return extra.id;
		}
		case 'keeper_actor':
			return fixture.actor.id;
	}
};

/** A case's params with `acting` set to `actor_id`. */
const bind_acting = (c: ConformanceCase, actor_id: string): Record<string, unknown> => {
	const { params } = c.request;
	if (params === undefined) return { acting: actor_id };
	if (params === null || typeof params !== 'object' || Array.isArray(params)) {
		throw new Error(
			`conformance: case '${c.name}' binds acting, so its params must be an object or omitted.`
		);
	}
	if ('acting' in params) {
		throw new Error(
			`conformance: case '${c.name}' binds acting and also sets params.acting — pick one.`
		);
	}
	return { ...params, acting: actor_id };
};

/**
 * Run one conformance case end-to-end: resolve the principal, dispatch the
 * request, and assert the expected status / reason / fields. Returns the
 * normalized response so the caller can feed an equivalence group.
 */
const run_case = async (
	c: ConformanceCase,
	options: ConformanceTableOptions,
	resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup>
): Promise<NormalizedResponse> => {
	const sent = await send_conformance_case(c, {
		fixture: await options.setup_test(),
		surface_source: options.surface_source,
		...(options.principals && { principals: options.principals }),
		resolved_rpc_endpoints,
		...(options.ws && { ws: options.ws })
	});
	assert_response_headers(sent.headers, c);
	// a frame carries no headers, so the cookie assertions are the HTTP legs'
	if (!options.ws) assert_session_cookie(sent, c, options.session_options.cookie_name);

	const normalized =
		sent.target.kind === 'rest'
			? assert_rest_case(c, sent.target.route, sent)
			: assert_rpc_case(c, sent.target.action, sent);

	// Negative-space field check, uniform across REST + RPC and success + error
	// bodies: a sensitive column (`password_hash`, `token_hash`) must not appear
	// anywhere in what the prober sees.
	if (c.expect.absent_fields) {
		assert_absent_fields(normalized.body, c.expect.absent_fields, c.name);
	}
	return normalized;
};

/** Assert a case targeting an RPC method. */
const assert_rpc_case = (
	c: ConformanceCase,
	action: RpcAction,
	sent: ConformanceCaseResponse
): NormalizedResponse => {
	const res = parse_rpc_call_result(sent, c.request.method);

	if (is_success_status(c.expect.status)) {
		assert.ok(
			res.ok,
			`${c.name}: expected success (${c.expect.status}) but got error ${JSON.stringify(
				res.ok ? undefined : res.error
			)}`
		);
		assert.strictEqual(res.status, c.expect.status, `${c.name}: status`);
		const parsed = parse(action.spec.output, res.result);
		assert.ok(
			parsed.ok,
			`${c.name}: result does not match spec.output: ${JSON.stringify(
				parsed.ok ? undefined : parsed.issues
			)}`
		);
		if (c.expect.fields) assert_fields(res.result, c.expect.fields, c.name);
		return { status: res.status, body: res.result };
	}

	assert.ok(!res.ok, `${c.name}: expected error status ${c.expect.status} but got success`);
	assert.strictEqual(
		res.status,
		c.expect.status,
		`${c.name}: error status (error ${JSON.stringify(res.error)})`
	);
	// the code, not just the status it answers: several codes share a status
	assert.strictEqual(
		res.error.code,
		c.expect.error_code ?? http_status_to_jsonrpc_error_code(c.expect.status),
		`${c.name}: error.code (error ${JSON.stringify(res.error)})`
	);
	if (c.expect.error_reason === null) {
		const { data } = res.error;
		assert.ok(
			!(data !== null && typeof data === 'object' && Object.hasOwn(data, 'reason')),
			`${c.name}: error.data.reason expected absent, got ${JSON.stringify(data)}`
		);
	} else if (c.expect.error_reason !== undefined) {
		// present AND equal: a backend that dropped the reason must not pass a row
		// declaring one — the reason is the distinguishing bit of a mask
		const reason = (res.error.data as { reason?: unknown } | undefined)?.reason;
		assert.strictEqual(reason, c.expect.error_reason, `${c.name}: error.data.reason`);
	}
	if (c.expect.fields) assert_fields(res.error.data, c.expect.fields, c.name);
	return { status: res.status, body: res.error };
};

/** Assert a case targeting one of the 6 REST auth routes. */
const assert_rest_case = (
	c: ConformanceCase,
	route: RouteSpec,
	sent: ConformanceCaseResponse
): NormalizedResponse => {
	const { status, body } = sent;
	assert.strictEqual(status, c.expect.status, `${c.name}: status (body ${JSON.stringify(body)})`);
	if (is_success_status(c.expect.status)) {
		const parsed = parse(route.output, body);
		assert.ok(
			parsed.ok,
			`${c.name}: body does not match route output: ${JSON.stringify(
				parsed.ok ? undefined : parsed.issues
			)}`
		);
	} else if (c.expect.error_reason !== undefined) {
		const error = (body as { error?: unknown } | undefined)?.error;
		assert.strictEqual(error, c.expect.error_reason, `${c.name}: body.error`);
	}
	if (c.expect.fields) assert_fields(body, c.expect.fields, c.name);
	return { status, body };
};

/**
 * Refuse the rows a table can't honestly run, before any is sent, each throw
 * naming the case:
 *
 * - a REST row pinning `error_reason: null` — a REST error body always names
 *   its code in `error`, so the row pins that code instead;
 * - a REST row setting `error_code`, which only a JSON-RPC envelope carries;
 * - a row whose status is not 2xx expecting the session cookie minted
 *   (`set_cookie` `'set'` or `'clear_then_set'`) — no refusal may mint one,
 *   so the row contradicts the floor `assert_session_cookie` holds every
 *   response to.
 *
 * `describe_conformance_table_tests` runs it at collection.
 *
 * @param cases - the cases a table would run
 * @throws Error naming the first case that can't be written
 */
export const check_conformance_cases = (cases: ReadonlyArray<ConformanceCase>): void => {
	for (const c of cases) {
		const rest = c.request.method.startsWith('/');
		if (rest && c.expect.error_reason === null) {
			throw new Error(
				`conformance: case '${c.name}' pins error_reason null on a REST route, whose error ` +
					`body always names its code in \`error\` — pin the code instead.`
			);
		}
		if (rest && c.expect.error_code !== undefined) {
			throw new Error(
				`conformance: case '${c.name}' sets error_code on a REST route, whose error body ` +
					`carries no JSON-RPC code — pin error_reason instead.`
			);
		}
		const set_cookie = c.expect.set_cookie ?? 'none';
		if (
			!is_success_status(c.expect.status) &&
			(set_cookie === 'set' || set_cookie === 'clear_then_set')
		) {
			throw new Error(
				`conformance: case '${c.name}' expects a ${c.expect.status} that mints the session ` +
					`cookie (set_cookie '${set_cookie}') — no refusal may mint one.`
			);
		}
	}
};

/**
 * Register a `describe` block running every `ConformanceCase` as a
 * vitest `test` (or `xfail_until` for deferred-by-design rows). Drives
 * either transport via the shared `{setup_test, surface_source,
 * capabilities}` protocol.
 */
export const describe_conformance_table_tests = (options: ConformanceTableOptions): void => {
	const resolved_rpc_endpoints = resolve_conformance_rpc_endpoints(options);
	// Per-group normalized responses, populated as the member case tests run
	// and consulted by the per-group byte-identity assertions registered after
	// the case loop — vitest runs a describe's tests in registration order, so
	// the group assertions execute last, after every member has recorded.
	const equivalence_groups = new Map<
		string,
		Array<{ name: string; normalized: NormalizedResponse }>
	>();
	const cases = options.ws ? options.cases.filter(is_ws_conformance_case) : options.cases;
	check_conformance_cases(options.cases);
	const group_sizes = new Map<string, number>();
	for (const c of cases) {
		const group = c.expect.equivalence_group;
		if (group) group_sizes.set(group, (group_sizes.get(group) ?? 0) + 1);
	}
	// a group the WS filter left a single member of has nothing to compare;
	// on HTTP every group runs, so an undersized one still fails loud
	const group_names = new Set(
		[...group_sizes].filter(([, size]) => !options.ws || size >= 2).map(([group]) => group)
	);
	describe(options.suite_name ?? 'conformance table', () => {
		for (const c of cases) {
			const label = c.note ? `${c.name} — ${c.note}` : c.name;
			const group = c.expect.equivalence_group;
			const recorded = group !== undefined && group_names.has(group);
			const body = async (): Promise<void> => {
				const normalized = await run_case(c, options, resolved_rpc_endpoints);
				if (recorded && group) {
					const members = equivalence_groups.get(group) ?? [];
					members.push({ name: c.name, normalized });
					equivalence_groups.set(group, members);
				}
			};
			if (c.xfail) {
				xfail_until(c.xfail, label, body);
			} else {
				test(label, body);
			}
		}
		// Negative-space gate: every member of an equivalence group must have
		// produced a byte-identical `{status, body}`. This holds the impl under
		// test to "a prober cannot distinguish these masked paths" — the
		// promotion of a masked pair (wrong-password ≡ account-not-found,
		// found-but-unauthorized ≡ not-found) from "same status + reason" to
		// "wire-indistinguishable". Runs per impl, so each spine is held to it.
		for (const group of group_names) {
			test(`equivalence group '${group}' — members are wire-indistinguishable`, () => {
				const members = equivalence_groups.get(group) ?? [];
				assert.ok(
					members.length >= 2,
					`equivalence group '${group}': expected >= 2 members to have recorded, got ` +
						`${members.length} — a group pins indistinguishability between paths, so it ` +
						`needs at least a pair (check the member cases ran and weren't all xfail).`
				);
				const [first, ...rest] = members;
				// `members.length >= 2` guarantees `first` is defined; the explicit
				// assert narrows it for the typechecker (noUncheckedIndexedAccess).
				assert.ok(first);
				for (const member of rest) {
					assert.deepStrictEqual(
						member.normalized,
						first.normalized,
						`equivalence group '${group}': '${member.name}' is distinguishable from ` +
							`'${first.name}' — a prober could tell these masked paths apart. The ` +
							`normalized {status, body} must be byte-identical across all members.`
					);
				}
			});
		}
	});
};
