import './assert_dev_env.ts';

/**
 * Probes of the middleware gates a route's error map declares: a foreign
 * `Origin` (403 `forbidden_origin`), a `Host` the server doesn't answer to
 * (403 `forbidden_host`, the Rust spine's host gate), a declared
 * `Content-Length` one byte over the route's cap (413 `payload_too_large`),
 * and a `Content-Length` that isn't a length (400 `invalid_content_length`).
 *
 * The map drives which probes a route gets: a gate the route's map doesn't
 * declare — a carved-out path, a backend without the layer, a disabled limit —
 * is not probed. Every probe is a request head with no body and no
 * credential, so the gate answers it before auth, rate limiting or body
 * parsing, and it leaves no state behind.
 *
 * Over a socket (`base_url`) each probe is written raw
 * (`raw_http_send_head`): `fetch` replaces a caller's `Host` and
 * `Content-Length` with its own. In-process the head goes through the
 * fixture's transport, whose `Request` keeps both headers as given. The
 * unreadable-length probe runs in-process only: over a socket the runtime's
 * HTTP parser (Node's, hyper) refuses such a length with a bodiless 400 of its
 * own before the application sees it, and `fetch` can't send one. In-process
 * the length reaches the body limit unparsed, and the 400 is the limit's own —
 * the answer a Bun server gives when a request repeats an equal
 * `Content-Length`, which Bun hands over joined into one value.
 *
 * `describe_middleware_gate_tests` runs one per declared gate of each route
 * the standard integration suite counts (`is_standard_integration_route`). It
 * is a suite of its own, not a group of that one, because over a socket it
 * writes raw heads: the suites that send only through the fixture transports
 * stay free of a raw-socket sender.
 *
 * @module
 */

import { assert, beforeAll, describe, test } from 'vitest';

import type { RouteMethod, RouteSpec } from '../http/route_spec.ts';
import type { AppSurfaceSpec } from '../http/surface.ts';
import { get_route_error_map, type RouteErrorMap } from '../http/route_errors.ts';
import { split_route_template } from '../http/route_error_check.ts';
import {
	REST_FORBIDDEN_HOST,
	REST_FORBIDDEN_ORIGIN,
	REST_INVALID_CONTENT_LENGTH,
	REST_PAYLOAD_TOO_LARGE,
	type RestErrorDef
} from '../http/error_schemas.ts';
import { ErrorCoverageCollector } from './error_coverage.ts';
import {
	is_standard_integration_route,
	MIDDLEWARE_GATE_ERROR_CODES
} from './integration_helpers.ts';
import {
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption
} from './rpc_helpers.ts';
import type { SetupTest, TestFixture } from './cross_backend/setup.ts';
import { check_db_invariants_and_close_after_all } from './db_invariants.ts';
import { to_route_content_type } from './schema_generators.ts';
import { raw_http_send_head } from './transports/raw_http.ts';
import { SPINE_BODY_LIMIT_DEFAULT_BYTES } from './cross_backend/spine_surface_constants.ts';

/** The `Origin` the origin probe sends — no allowlist names it. */
export const GATE_PROBE_FOREIGN_ORIGIN = 'https://gate-probe.invalid';

/** The `Host` the host probe sends — neither loopback nor named by an allowed origin. */
export const GATE_PROBE_FOREIGN_HOST = 'gate-probe.invalid';

/** The `Content-Length` the unreadable-length probe sends. */
export const GATE_PROBE_UNREADABLE_LENGTH = 'not-a-length';

/** One probe: a request head a route's declared gate must refuse with `expected`. */
export interface MiddlewareGateProbe {
	readonly method: RouteMethod;
	/** The route's path, a template with no params among the routes probed. */
	readonly path: string;
	/** The refusal the route's error map declares for the gate. */
	readonly expected: RestErrorDef;
	/** Request headers beyond `Host` and `Content-Length`. */
	readonly headers: Readonly<Record<string, string>>;
	/** The `Host` to send, `null` for the backend's own. */
	readonly host: string | null;
	/** The `Content-Length` to declare; no body byte is sent. */
	readonly content_length: number | string;
}

/** Options for `plan_middleware_gate_probes`. */
export interface MiddlewareGateProbePlanOptions {
	/** The routes to probe, each a path with no params. */
	readonly route_specs: ReadonlyArray<RouteSpec>;
	/** Each route's error map, middleware included (`AppSurfaceSpec.route_error_maps`). */
	readonly route_error_maps: ReadonlyMap<string, RouteErrorMap> | null;
	/**
	 * The backend's base URL, or `null` in-process. Without a socket the
	 * unreadable-length probe is planned too.
	 */
	readonly base_url: string | null;
	/**
	 * The request-body cap on every route but `rpc_path`, in bytes.
	 *
	 * @default SPINE_BODY_LIMIT_DEFAULT_BYTES
	 */
	readonly max_body_bytes?: number;
	/** The RPC endpoint's path, whose cap is `rpc_max_body_bytes`. */
	readonly rpc_path: string;
	/**
	 * The request-body cap on `rpc_path`, in bytes.
	 *
	 * @default max_body_bytes
	 */
	readonly rpc_max_body_bytes?: number;
}

/** Whether `defs` declares `def`'s status and code. */
const declares = (defs: ReadonlyArray<RestErrorDef>, def: RestErrorDef): boolean =>
	defs.some((d) => d.status === def.status && d.code === def.code);

/**
 * Plan the gate probes of each route: one per gate its error map declares,
 * in route order.
 *
 * @param options - the routes, their maps, the socket and the caps
 * @returns the probes, none for a gate a route's map doesn't declare
 * @throws Error when a route's path has a param or a wildcard segment, which a
 *   probe would send as the literal template
 */
export const plan_middleware_gate_probes = (
	options: MiddlewareGateProbePlanOptions
): Array<MiddlewareGateProbe> => {
	const max_body_bytes = options.max_body_bytes ?? SPINE_BODY_LIMIT_DEFAULT_BYTES;
	const rpc_max_body_bytes = options.rpc_max_body_bytes ?? max_body_bytes;
	const probes: Array<MiddlewareGateProbe> = [];
	for (const spec of options.route_specs) {
		const { defs } = get_route_error_map(options.route_error_maps, spec);
		const { method, path } = spec;
		if (split_route_template(path).some((segment) => segment.startsWith(':') || segment === '*')) {
			throw new Error(
				`plan_middleware_gate_probes: ${method} ${path} has a param or wildcard segment, ` +
					'which a probe would send as the literal template'
			);
		}
		// a `POST` refuses anything but its content type with 415, so each probe
		// sends it and the gate is the only refusal left
		const headers: Record<string, string> =
			method === 'POST' ? { 'content-type': to_route_content_type(spec) } : {};
		const cap = path === options.rpc_path ? rpc_max_body_bytes : max_body_bytes;
		if (declares(defs, REST_FORBIDDEN_ORIGIN)) {
			probes.push({
				method,
				path,
				expected: REST_FORBIDDEN_ORIGIN,
				headers: { ...headers, origin: GATE_PROBE_FOREIGN_ORIGIN },
				host: null,
				content_length: 0
			});
		}
		if (declares(defs, REST_FORBIDDEN_HOST)) {
			probes.push({
				method,
				path,
				expected: REST_FORBIDDEN_HOST,
				headers,
				host: GATE_PROBE_FOREIGN_HOST,
				content_length: 0
			});
		}
		if (declares(defs, REST_PAYLOAD_TOO_LARGE)) {
			probes.push({
				method,
				path,
				expected: REST_PAYLOAD_TOO_LARGE,
				headers,
				host: null,
				content_length: cap + 1
			});
		}
		if (options.base_url === null && declares(defs, REST_INVALID_CONTENT_LENGTH)) {
			probes.push({
				method,
				path,
				expected: REST_INVALID_CONTENT_LENGTH,
				headers,
				host: null,
				content_length: GATE_PROBE_UNREADABLE_LENGTH
			});
		}
	}
	return probes;
};

/** A probe's name: the route and the refusal it expects. */
export const format_middleware_gate_probe = (probe: MiddlewareGateProbe): string =>
	`${probe.method} ${probe.path} → ${probe.expected.status} ${probe.expected.code}`;

/** The in-process transport a probe is sent through. */
export type MiddlewareGateProbeTransport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Send a probe: over the socket when there is one, else through `transport`.
 *
 * @param probe - the probe
 * @param base_url - the backend's base URL, or `null` in-process
 * @param transport - the in-process transport, read only without a `base_url`
 * @returns the response, its body JSON when the server sent JSON
 * @throws Error when an unreadable length is to go over a socket, or no
 *   transport is given in-process
 */
export const send_middleware_gate_probe = async (
	probe: MiddlewareGateProbe,
	base_url: string | null,
	transport: MiddlewareGateProbeTransport | null
): Promise<Response> => {
	if (base_url !== null) {
		if (typeof probe.content_length !== 'number') {
			throw new Error(
				`${format_middleware_gate_probe(probe)}: an unreadable length can't be sent over a socket`
			);
		}
		const raw = await raw_http_send_head(base_url, {
			method: probe.method,
			path: probe.path,
			headers: probe.headers,
			content_length: probe.content_length,
			...(probe.host !== null && { host: probe.host })
		});
		const content_type = raw.headers['content-type'];
		return new Response(raw.body === '' ? null : raw.body, {
			status: raw.status,
			headers: content_type === undefined ? {} : { 'content-type': content_type }
		});
	}
	if (!transport) {
		throw new Error(`${format_middleware_gate_probe(probe)}: no transport to send it in-process`);
	}
	return transport(probe.path, {
		method: probe.method,
		headers: {
			...probe.headers,
			...(probe.host !== null && { host: probe.host }),
			'content-length': String(probe.content_length)
		}
	});
};

/**
 * Assert a probe was refused as its route declares, then record the refusal
 * in `collector`, which checks the body against the route's map.
 *
 * @param probe - the probe sent
 * @param response - its response
 * @param collector - the error coverage to record the refusal in
 * @param route_specs - the routes the collector resolves the path against
 * @mutates collector - records the probe's route, status and code
 * @throws AssertionError when the response's status or `error` code isn't the
 *   declared refusal, or its body is off the route's map
 */
export const assert_middleware_gate_refusal = async (
	probe: MiddlewareGateProbe,
	response: Response,
	collector: ErrorCoverageCollector,
	route_specs: Array<RouteSpec>
): Promise<void> => {
	const label = format_middleware_gate_probe(probe);
	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		// not JSON — the status or code check below names it
	}
	assert.strictEqual(
		response.status,
		probe.expected.status,
		`${label}: answered ${response.status} ${JSON.stringify(body)}`
	);
	assert.strictEqual(
		(body as { error?: unknown } | undefined)?.error,
		probe.expected.code,
		`${label}: answered ${JSON.stringify(body)}`
	);
	await collector.assert_and_record(route_specs, probe.method, probe.path, response);
};

/** Configuration for `describe_middleware_gate_tests`. */
export interface MiddlewareGateTestOptions {
	/**
	 * Per-test fixture-producing function. Read in-process only, once, for the
	 * transport every probe shares; over a socket the probes need no fixture.
	 */
	setup_test: SetupTest;
	/** App surface: the counted routes and their error maps, middleware included. */
	surface_source: AppSurfaceSpec;
	/** The session cookie's name, to resolve factory-form `rpc_endpoints` at setup. */
	session_cookie_name: string;
	/** RPC endpoint specs — the endpoint's path is a counted route. */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/**
	 * Base URL the backend is reachable at, or `null` in-process. Over a socket
	 * the probes write their heads to it (`fetch` replaces a caller's `Host` and
	 * `Content-Length`); in-process they go through the fixture's transport.
	 */
	base_url: string | null;
	/**
	 * The backend's request-body cap on every counted route but the RPC
	 * endpoint, in bytes — the body-limit probe declares one byte more.
	 *
	 * @default SPINE_BODY_LIMIT_DEFAULT_BYTES
	 */
	max_body_bytes?: number;
	/**
	 * The backend's request-body cap on the RPC endpoint, in bytes, when it
	 * isn't `max_body_bytes`.
	 */
	rpc_max_body_bytes?: number;
}

/**
 * One test per middleware gate each route the standard integration suite
 * counts declares in its error map (`plan_middleware_gate_probes`): the origin
 * check, the host gate, the body limit, and in-process the unreadable length.
 * Each probe is a bodiless head with no credential that the gate refuses
 * before auth, rate limiting or body parsing, so the probes leave no state; a
 * gate a route's map doesn't declare (a carve-out, a backend without the
 * layer) gets no probe. Each refusal's body is held to the route's map.
 *
 * Every gate refusal (`MIDDLEWARE_GATE_ERROR_CODES`) a counted route declares
 * must have a planned probe — the unreadable length aside over a socket — or
 * the call throws at collection, so a planner that drops a probe can't pass by
 * registering fewer tests, whatever a run filters or excludes.
 *
 * @param options - the routes, the backend's socket and its caps
 * @throws Error at setup when `options.rpc_endpoints` names no single endpoint,
 *   or a declared gate refusal has no planned probe
 */
export const describe_middleware_gate_tests = (options: MiddlewareGateTestOptions): void => {
	const route_specs = options.surface_source.route_specs;
	const rpc_path = require_rpc_endpoint_path(
		resolve_rpc_endpoints_for_setup(options.rpc_endpoints, options.session_cookie_name)
	);
	const counted_routes = route_specs.filter((s) => is_standard_integration_route(s, rpc_path));
	const probes = plan_middleware_gate_probes({
		route_specs: counted_routes,
		route_error_maps: options.surface_source.route_error_maps,
		base_url: options.base_url,
		max_body_bytes: options.max_body_bytes,
		rpc_path,
		rpc_max_body_bytes: options.rpc_max_body_bytes
	});
	// every gate refusal a counted route declares has a probe planned — checked
	// at collection, so a planner that drops one fails whatever a run filters or
	// excludes; the unreadable length goes unprobed over a socket (the module doc)
	const planned: Set<string> = new Set(
		probes.map((p) => `${p.method} ${p.path} ${p.expected.status} ${p.expected.code}`)
	);
	const unplanned = new ErrorCoverageCollector(options.surface_source.route_error_maps)
		.uncovered(counted_routes)
		.filter(
			({ code }) =>
				MIDDLEWARE_GATE_ERROR_CODES.includes(code) &&
				!(options.base_url !== null && code === REST_INVALID_CONTENT_LENGTH.code)
		)
		.map(({ method, path, status, code }) => `${method} ${path} ${status} ${code}`)
		.filter((key) => !planned.has(key));
	if (unplanned.length > 0) {
		throw new Error(
			`describe_middleware_gate_tests: declared gate refusals no probe plans: ${unplanned.join(', ')}`
		);
	}
	describe('middleware gates', () => {
		const collector = new ErrorCoverageCollector(options.surface_source.route_error_maps);
		// in-process the probes share one fixture, built ahead of them so it
		// outlives each test (an app built in a test is closed when it
		// finishes) and checked once they are done; over a socket they need
		// none, as they read and write no state
		let fixture: TestFixture | null = null;
		let in_process_transport: MiddlewareGateProbeTransport | null = null;
		if (options.base_url === null) {
			beforeAll(async () => {
				fixture = await options.setup_test();
				in_process_transport = fixture.fresh_transport({ origin: null });
			});
			check_db_invariants_and_close_after_all(() => fixture);
		}
		for (const probe of probes) {
			test(format_middleware_gate_probe(probe), async () => {
				const res = await send_middleware_gate_probe(probe, options.base_url, in_process_transport);
				await assert_middleware_gate_refusal(probe, res, collector, route_specs);
			});
		}
	});
};
