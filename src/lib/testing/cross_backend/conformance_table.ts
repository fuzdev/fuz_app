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

import type { AppSurfaceSpec, RpcEndpointSpec } from '../../http/surface.ts';
import type { RouteMethod, RouteSpec } from '../../http/route_spec.ts';
import type { RpcAction } from '../../actions/action_types.ts';
import type { SessionOptions } from '../../auth/session_cookie.ts';
import { DAEMON_TOKEN_HEADER } from '../../auth/daemon_token.ts';
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
import { account_token_create_action_spec } from '../../auth/account_action_specs.ts';
import { jsonrpc_error_code_to_http_status } from '../../http/jsonrpc_errors.ts';
import type { JsonrpcErrorCode } from '../../http/jsonrpc.ts';
import type { FetchTransport } from '../transports/fetch_transport.ts';
import { create_admitted_ws_transport } from '../transports/ws_transport.ts';
import { is_response_for } from '../transports/ws_client.ts';
import {
	SCOPED_TOKEN_ADMITTED_METHOD,
	type ConformanceActingBinding,
	type ConformanceCase,
	type ConformancePrincipal
} from './conformance_case.ts';
import type { BackendCapabilities } from './capabilities.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { mint_narrowed_api_token } from './narrowed_api_token.ts';
import { xfail_until } from './xfail.ts';
import type { WsEndpointTarget } from './ws_endpoint.ts';

/**
 * Names a seeded `extra_accounts` username for the `role_holder` /
 * `wrong_role` principals — the only two that aren't backed by an
 * always-available fixture accessor. Suites exercising those principals
 * declare the matching `extra_accounts` at setup and name them here.
 */
export interface ConformancePrincipalConfig {
	/** `extra_accounts` username for the `role_holder` principal. */
	readonly role_holder?: string;
	/** `extra_accounts` username for the `wrong_role` principal. */
	readonly wrong_role?: string;
}

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
 * (`anonymous`, the browser-discarded and malformed bearers, the expired
 * session) or one the upgrade refuses (`scoped_token` — a narrowed token is
 * refused `surface:ws_upgrade`), so the upgrade answers before any frame.
 * The front-door table (`describe_transport_composition_cross_tests`) pins
 * those upgrade refusals.
 */
const WS_UNAVAILABLE_PRINCIPALS: ReadonlySet<ConformancePrincipal> = new Set([
	'anonymous',
	'bearer_browser',
	'malformed_bearer',
	'expired_session',
	'scoped_token'
] satisfies Array<ConformancePrincipal>);

/**
 * Whether a case can run over a WebSocket: an RPC method (not a REST auth
 * route), sent as `POST` (a `GET` row pins the HTTP query path), pinning no
 * header value (a frame has no headers; an absence pin holds vacuously), as
 * a principal that can hold a socket.
 *
 * @param c - the case
 * @returns whether the WS leg runs it
 */
export const is_ws_conformance_case = (c: ConformanceCase): boolean =>
	!c.request.method.startsWith('/') &&
	(c.request.verb ?? 'POST') === 'POST' &&
	!Object.values(c.expect.headers ?? {}).some((value) => value !== null) &&
	!WS_UNAVAILABLE_PRINCIPALS.has(c.request.as);

/** A resolved principal: the transport + headers a case fires through. */
export interface ResolvedConformancePrincipal {
	readonly transport: FetchTransport;
	readonly headers: Record<string, string>;
	/**
	 * Suppress the default `Origin` header on the request. Required for
	 * non-browser credential probes (bearer / daemon) — `bearer_auth`
	 * discards the token when `Origin` / `Referer` is present.
	 */
	readonly suppress_default_origin?: boolean;
	/**
	 * The actor of the account the credential names — what the `principal`
	 * acting binding writes. Absent for principals that present no account.
	 */
	readonly actor_id?: string;
}

/**
 * A deliberately malformed `X-Daemon-Token` value for the `invalid_daemon`
 * principal. Fails the `DaemonToken` Zod schema (not 43 base64url chars), so
 * the daemon-token middleware soft-fail-discards it rather than authenticating
 * — the request falls through with no identity, surfacing
 * `credential_type_required` on a daemon-gated action (matching the Rust
 * spine's `None`). Sent over a no-Origin transport so it lands on the
 * invalid-token path, not the browser-context discard.
 */
const INVALID_DAEMON_TOKEN_VALUE = 'not-a-valid-daemon-token';

/**
 * Mint the `scoped_token` principal's narrowed bearer token over the
 * production `account_token_create` path.
 *
 * Minted rather than seeded, and minted *here* rather than in a case. The
 * seed stays `full` because `_testing_reset`'s api token backs every other
 * bearer principal, and a case that minted its own credential would be the
 * setup-DSL trap the case schema exists to avoid.
 *
 * `account_token_create` is session-only, so this runs over the keeper's
 * session — which also makes the mint itself a live assertion that a narrowed
 * scope is *accepted* at the mint boundary, not merely stored.
 */
const mint_scoped_token = async (
	fixture: TestFixture,
	resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup>
): Promise<string> => {
	const found = find_rpc_action(resolved_rpc_endpoints, account_token_create_action_spec.method);
	if (!found) {
		throw new Error(
			`conformance: principal 'scoped_token' needs '${account_token_create_action_spec.method}' ` +
				`on the surface to mint its narrowed token, but the method is not registered on ` +
				`rpc_endpoints.`
		);
	}
	return mint_narrowed_api_token({
		app: fixture.transport,
		rpc_path: found.path,
		session_headers: fixture.create_session_headers(),
		methods: [SCOPED_TOKEN_ADMITTED_METHOD],
		name: 'conformance scoped token'
	});
};

/**
 * Map a `ConformancePrincipal` onto the transport + headers it
 * authenticates with, reading exclusively from the per-test `TestFixture`.
 *
 * The five always-available principals resolve from fixture accessors;
 * `role_holder` / `wrong_role` read a seeded `extra_accounts` entry named
 * via `options.principals` (throws a clear setup error when unconfigured);
 * `scoped_token` mints its narrowed credential over the production path.
 * Also used outside the table by suites that send a principal's requests
 * themselves (`describe_rpc_adversarial_cross_tests`).
 *
 * @param fixture - the per-test fixture
 * @param as - the principal
 * @param principals - usernames for `role_holder` / `wrong_role`
 * @param resolved_rpc_endpoints - the endpoints `scoped_token` mints through
 * @returns the transport and headers the principal sends with
 */
export const resolve_conformance_principal = async (
	fixture: TestFixture,
	as: ConformancePrincipal,
	principals?: ConformancePrincipalConfig,
	resolved_rpc_endpoints: ReturnType<typeof resolve_rpc_endpoints_for_setup> = []
): Promise<ResolvedConformancePrincipal> => {
	switch (as) {
		case 'keeper':
			// Keeper carries its session cookie via `create_session_headers`
			// (in-process the transport is stateless; cross-process the jar
			// also holds it — the explicit header is the same value).
			return {
				transport: fixture.transport,
				headers: fixture.create_session_headers(),
				actor_id: fixture.actor.id
			};
		case 'daemon':
			// Daemon-token is a non-browser credential — empty jar + no Origin.
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: fixture.create_daemon_token_headers(),
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		case 'invalid_daemon':
			// A malformed `X-Daemon-Token` carried ALONGSIDE the keeper's session
			// cookie, over a non-browser (no-Origin) transport. The invalid daemon
			// token is soft-fail-discarded (matching the Rust spine's `None`), so
			// auth falls through to the session leg: the request authenticates as
			// the keeper-via-session (clearing `require_auth`), then the daemon-gated
			// action's credential-type gate refuses the session credential →
			// `403 credential_type_required`. No-Origin keeps the daemon token on
			// the invalid-token path, NOT the browser-context discard. Without the
			// base credential this would 401 (anonymous) — the session is what makes
			// the *credential-type* gate, not the auth gate, the refusing layer.
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: fixture.create_session_headers({
					[DAEMON_TOKEN_HEADER]: INVALID_DAEMON_TOKEN_VALUE
				}),
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		case 'daemon_browser':
			// A VALID `X-Daemon-Token` carried in a browser context (default Origin
			// present) ALONGSIDE the keeper's session cookie. The daemon-token
			// middleware discards a header-bearing daemon token as browser context
			// (mirroring the bearer guard + the Rust spine's `is_browser_context`),
			// so the valid token is dropped and auth falls through to the session
			// leg → keeper-via-session → a daemon-gated action refuses the session
			// credential with `credential_type_required`. Origin is NOT suppressed —
			// its presence is the browser-context signal under test. Unlike the
			// `daemon` principal (no Origin → token honored → reaches the 400 confirm
			// guard), the 403 here proves the valid token was discarded, not honored.
			return {
				transport: fixture.transport,
				headers: fixture.create_session_headers(fixture.create_daemon_token_headers()),
				actor_id: fixture.actor.id
			};
		case 'token':
			// Bearer is discarded in a browser context — empty jar + no Origin.
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: fixture.create_bearer_headers(),
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		case 'bearer_browser':
			// A VALID bearer api-token in a browser context (default Origin
			// present), fresh jar so no session rides alongside. The bearer
			// middleware discards a header-bearing token as browser context
			// (mirroring the daemon guard + the Rust spine's `is_browser_context`),
			// so the request arrives anonymous → an authed action 401s. Origin is
			// NOT suppressed (its presence is the browser-context signal) — the
			// inverse of the `token` principal, which suppresses it so the same
			// token is honored. The 401 proves the valid token was discarded, not
			// honored (a non-discarding leg would authenticate → 200).
			return {
				transport: fixture.fresh_transport(),
				headers: fixture.create_bearer_headers()
			};
		case 'malformed_bearer': {
			// The keeper's valid token minus its last character — prefixed, one char
			// short — over the same no-Origin, empty-jar transport as `token`, so the
			// shape precheck (not the browser-context discard) is what refuses it.
			const valid = fixture.create_bearer_headers().authorization;
			if (!valid)
				throw new Error(`conformance: principal 'malformed_bearer' found no bearer header`);
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: { authorization: valid.slice(0, -1) },
				suppress_default_origin: true
			};
		}
		case 'scoped_token': {
			// A narrowed bearer, otherwise identical to `token` — empty jar + no
			// Origin, so the credential is honored rather than browser-discarded
			// and the scope gate is what any denial comes from.
			const token = await mint_scoped_token(fixture, resolved_rpc_endpoints);
			return {
				transport: fixture.fresh_transport({ origin: null }),
				headers: { authorization: `Bearer ${token}` },
				suppress_default_origin: true,
				actor_id: fixture.actor.id
			};
		}
		case 'anonymous':
			// Fresh jar so the keeper cookie (cross-process) can't leak in.
			return { transport: fixture.fresh_transport(), headers: {} };
		case 'fresh_non_admin': {
			const account = await fixture.create_account();
			return {
				transport: fixture.fresh_transport(),
				headers: account.create_session_headers(),
				actor_id: account.actor.id
			};
		}
		case 'expired_session': {
			// The keeper presented via an expired server-side session — fresh
			// jar so only the (expired) cookie this seam returns is sent. The
			// minted cookie payload is valid; the backdated `auth_session` row
			// is what the DB-row expiry gate refuses.
			const cookie = await fixture.mint_expired_session();
			return {
				transport: fixture.fresh_transport(),
				headers: { cookie },
				actor_id: fixture.actor.id
			};
		}
		case 'role_holder':
		case 'wrong_role': {
			const username = principals?.[as];
			if (!username) {
				throw new Error(
					`conformance: principal '${as}' requires options.principals.${as} naming a seeded ` +
						`extra_accounts username (declare the account at setup via extra_accounts).`
				);
			}
			const extra = fixture.extra_accounts[username];
			if (!extra) {
				throw new Error(
					`conformance: extra_accounts['${username}'] not seeded for principal '${as}' — ` +
						`declare it in the suite's extra_accounts option.`
				);
			}
			return {
				transport: fixture.fresh_transport(),
				headers: extra.create_session_headers(),
				actor_id: extra.actor.id
			};
		}
	}
};

/** Assert each expected field deep-equals the corresponding response field. */
const assert_fields = (actual: unknown, fields: Record<string, unknown>, label: string): void => {
	assert.ok(
		actual !== null && typeof actual === 'object',
		`${label}: expected an object to read fields from, got ${JSON.stringify(actual)}`
	);
	const record = actual as Record<string, unknown>;
	for (const [key, expected] of Object.entries(fields)) {
		assert.deepEqual(record[key], expected, `${label}: field '${key}'`);
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
 * response-headers snapshot (lowercased keys), and the JSON body exactly as
 * the server sent it — the whole JSON-RPC envelope for an RPC method,
 * `undefined` for a REST body that is not JSON.
 *
 * Over a WebSocket the body is the response frame, the headers are empty (a
 * frame carries none), and the status is the one the HTTP binding answers
 * for the frame's outcome: `200` for a result, else
 * `jsonrpc_error_code_to_http_status` of its error code — so a row's
 * `expect.status` reads as the error code on both transports.
 */
export interface ConformanceCaseResponse {
	readonly target: ConformanceCaseTarget;
	readonly status: number;
	readonly headers: Record<string, string>;
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
		return { status, headers: {}, body };
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
		const parsed = action.spec.output.safeParse(res.result);
		assert.ok(
			parsed.success,
			`${c.name}: result does not match spec.output: ${JSON.stringify(
				parsed.success ? undefined : parsed.error.issues
			)}`
		);
		if (c.expect.fields) assert_fields(res.result, c.expect.fields, c.name);
		return { status: res.status, body: res.result };
	}

	assert.ok(!res.ok, `${c.name}: expected error status ${c.expect.status} but got success`);
	assert.strictEqual(res.status, c.expect.status, `${c.name}: error status`);
	if (c.expect.error_reason !== undefined) {
		// A row that *declares* a reason must carry it — present AND equal —
		// mirroring the REST branch's unconditional `body.error` assertion. The
		// earlier skip-if-absent form let a backend that dropped the reason pass
		// a row declaring one, blessing a reason/forensic-parity divergence (the
		// IDOR-mask / privilege reason is exactly the distinguishing bit). Rows
		// whose denial genuinely has no reason (the bare `unauthenticated()` 401)
		// simply omit `error_reason` and are pinned by `status` above.
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
	assert.strictEqual(status, c.expect.status, `${c.name}: status`);
	if (is_success_status(c.expect.status)) {
		const parsed = route.output.safeParse(body);
		assert.ok(
			parsed.success,
			`${c.name}: body does not match route output: ${JSON.stringify(
				parsed.success ? undefined : parsed.error.issues
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
				xfail_until(c.xfail.tracking_id, c.xfail.reason, label, body);
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
