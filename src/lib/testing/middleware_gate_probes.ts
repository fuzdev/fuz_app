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
 * the answer a Deno or Bun server gives when a request repeats an equal
 * `Content-Length`, which those runtimes hand over joined into one value.
 *
 * `describe_standard_integration_tests` runs one per declared gate of each
 * route it counts and records each answer in its error coverage.
 *
 * @module
 */

import { assert } from 'vitest';

import type { RouteMethod, RouteSpec } from '../http/route_spec.ts';
import { get_route_error_map, type RouteErrorMap } from '../http/route_errors.ts';
import { split_route_template } from '../http/route_error_check.ts';
import {
	REST_FORBIDDEN_HOST,
	REST_FORBIDDEN_ORIGIN,
	REST_INVALID_CONTENT_LENGTH,
	REST_PAYLOAD_TOO_LARGE,
	type RestErrorDef
} from '../http/error_schemas.ts';
import type { ErrorCoverageCollector } from './error_coverage.ts';
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
