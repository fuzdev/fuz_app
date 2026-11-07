/**
 * Host verification — refusing requests addressed to a name the server
 * doesn't answer to, which is how DNS rebinding reaches a loopback server.
 *
 * In a rebinding attack, a page on an attacker's domain re-resolves that
 * domain to `127.0.0.1` and talks to the local server **same-origin**: its
 * GETs carry no `Origin` header, so the origin allowlist (`http/origin.ts`)
 * doesn't apply. The `Host` header gives it away — the browser sets it from
 * the URL, so it names the attacker's domain, never `localhost`.
 *
 * A host is allowed when its name is loopback (`localhost`, `127.0.0.0/8`,
 * `[::1]`), at any port — a rebinding page can't put one of those in `Host`
 * — or when an allowed origin names it (the allowlist is where the server's
 * UI is served from, so its hosts are the server's own names). Matching
 * reuses the origin matchers, so `http://localhost:*` or `https://*.fuz.dev`
 * admit the hosts they'd admit as origins.
 *
 * A request without a `Host` header passes: browsers always send one, so its
 * absence means a non-browser client, which the auth stack governs. A request
 * with more than one `Host` is refused (RFC 9112 §3.2) — the runtimes join a
 * repeated header into one value (`a, b`), which names no host.
 *
 * The gate is on by default (`AppServerOptions.host_gate`). A refusal is said
 * in the log as well as answered: the first in each
 * `HOST_REFUSAL_WARN_INTERVAL_MS` is a warning naming the refused `Host`
 * (quoted ASCII-only and truncated, since the client wrote it) and the env var
 * that lists the server's names, with a count of the refusals the interval
 * held back. The response says neither, so a client learns nothing about the
 * allowlist.
 *
 * Twin of the Rust spine's `fuz_http::host`.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { MiddlewareHandler } from 'hono';

import { ERROR_FORBIDDEN_HOST, REST_FORBIDDEN_HOST } from './error_schemas.ts';
import { parse_ipv4_bits, parse_ipv6_bits } from './ip_canonical.ts';
import type { MiddlewareSpec } from './middleware_spec.ts';
import { quote_ascii, should_allow_origin } from './origin.ts';
import { ALLOWED_ORIGINS_VAR } from './origin_wildcard.ts';

/** Where the host gate mounts — every path, as the Rust stack mounts it in every group. */
export const HOST_MIDDLEWARE_PATH = '*';

/**
 * The shortest gap between two refusal warnings, in milliseconds; the
 * refusals between are counted and reported with the next one.
 */
export const HOST_REFUSAL_WARN_INTERVAL_MS = 60_000;

/** The longest excerpt of a refused `Host` a warning quotes. */
const HOST_EXCERPT_MAX = 200;

/** A port: decimal digits, at most 65535. */
const PORT_DIGITS = /^[0-9]+$/;

/**
 * True when `host` (a `Host` header value, `name[:port]`) names a loopback
 * address: `localhost`, an IPv4 address in `127.0.0.0/8`, or `[::1]`.
 *
 * Anything after the name but a `:` and a port (decimal digits, at most 65535)
 * makes it not loopback: `[::1]junk`, `localhost:abc`, and `localhost: 1` are
 * refused. Twin of the Rust `is_loopback_host`.
 *
 * @param host - one `Host` header value
 * @returns whether it names a loopback address
 */
export const is_loopback_host = (host: string): boolean => {
	let name: string;
	let rest: string;
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		if (end === -1) return false;
		name = host.slice(0, end + 1);
		rest = host.slice(end + 1);
	} else {
		const colon = host.lastIndexOf(':');
		name = colon === -1 ? host : host.slice(0, colon);
		rest = colon === -1 ? '' : host.slice(colon);
	}
	if (rest !== '') {
		const port = rest.slice(1);
		if (!rest.startsWith(':') || !PORT_DIGITS.test(port) || Number(port) > 65535) return false;
	}
	if (name.toLowerCase() === 'localhost') return true;
	const ip = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
	const v4 = parse_ipv4_bits(ip);
	if (v4 !== null) return v4 >>> 24 === 127;
	return parse_ipv6_bits(ip) === 1n;
};

/**
 * Check one `Host` value: loopback, or named by an allowed origin on either
 * scheme. Twin of the Rust `AllowedOrigins::allows_host`.
 *
 * @param host - one `Host` header value
 * @param allowed_patterns - the matchers `parse_allowed_origins` built
 * @returns whether the server answers to it
 */
export const allows_host = (host: string, allowed_patterns: ReadonlyArray<RegExp>): boolean => {
	if (is_loopback_host(host)) return true;
	// a `Host` can't hold these, and they'd change how the origin parses
	if (host === '' || /[/?#@]/.test(host)) return false;
	return (
		should_allow_origin(`http://${host}`, allowed_patterns) ||
		should_allow_origin(`https://${host}`, allowed_patterns)
	);
};

/** Visible ASCII, the space, and a tab — what a header value holds. */
const HEADER_TEXT = /^[\t\x20-\x7e]*$/;

/**
 * Host check for a request's `Host` header values — true when there are none
 * or one that passes `allows_host`. A value that isn't visible ASCII (a tab
 * and the space allowed, as in a header value) is refused, and so is more than
 * one `Host` (RFC 9112 §3.2). Twin of the Rust
 * `AllowedOrigins::allows_request_hosts`.
 *
 * @param hosts - the request's `Host` values, `[]` for none
 * @param allowed_patterns - the matchers `parse_allowed_origins` built
 * @returns whether the request passes the host gate
 */
export const allows_request_hosts = (
	hosts: ReadonlyArray<string>,
	allowed_patterns: ReadonlyArray<RegExp>
): boolean => {
	if (hosts.length === 0) return true;
	if (hosts.length > 1) return false;
	const host = hosts[0]!;
	return HEADER_TEXT.test(host) && allows_host(host, allowed_patterns);
};

/**
 * The refusal warning's text. Twin of the Rust `format_host_refusal_warning`.
 *
 * @param host - the refused `Host` as the request carried it
 * @param allowed_origins_var - the env var the allowlist was read from
 * @param held_back - the refusals held back since the last warning
 * @returns one log line
 */
export const format_host_refusal_warning = (
	host: string,
	allowed_origins_var: string,
	held_back: number
): string => {
	const excerpt = host.length > HOST_EXCERPT_MAX ? host.slice(0, HOST_EXCERPT_MAX) + '...' : host;
	const held = held_back === 0 ? '' : ` (${held_back} more refused since the last warning)`;
	return (
		`host gate refused a request for Host ${quote_ascii(excerpt)}${held}: the server answers ` +
		`only to loopback names and the hosts ${allowed_origins_var} names. If it should answer to ` +
		`this name, add the origin it is served from to ${allowed_origins_var}`
	);
};

/**
 * Counts refusals between warnings, so a flood of foreign `Host`s writes one
 * line per `HOST_REFUSAL_WARN_INTERVAL_MS` and holds no per-host state.
 */
export interface HostRefusalWarnings {
	/**
	 * Record a refusal at `now_ms`: the refusals held back since the last
	 * warning when this one is warned, `null` when it is held back itself.
	 */
	note: (now_ms: number) => number | null;
}

/** Create the refusal warning's rate limit. */
export const create_host_refusal_warnings = (): HostRefusalWarnings => {
	let last_warned: number | null = null;
	let held_back = 0;
	return {
		note: (now_ms) => {
			if (last_warned === null || now_ms - last_warned >= HOST_REFUSAL_WARN_INTERVAL_MS) {
				last_warned = now_ms;
				const count = held_back;
				held_back = 0;
				return count;
			}
			held_back++;
			return null;
		}
	};
};

/** Options for `create_host_gate_middleware`. */
export interface HostGateOptions {
	/** The matchers `parse_allowed_origins` built — the server's allowlist. */
	allowed_origins: ReadonlyArray<RegExp>;
	/** Where the refusal warning goes. */
	log: Logger;
	/** The env var the allowlist was read from, named in the warning. Defaults to `ALLOWED_ORIGINS_VAR`. */
	allowed_origins_var?: string;
	/** The clock the warning's rate limit reads, in milliseconds. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Middleware enforcing `allows_request_hosts`, refusing with `403`
 * `{"error": "forbidden_host"}` and warning (rate-limited, module doc).
 *
 * @param options - the allowlist, the log, and the warning's clock
 * @returns the Hono middleware
 */
export const create_host_gate_middleware = (options: HostGateOptions): MiddlewareHandler => {
	const { allowed_origins, log, allowed_origins_var = ALLOWED_ORIGINS_VAR } = options;
	const now = options.now ?? Date.now;
	const warnings = create_host_refusal_warnings();
	return async (c, next) => {
		const host = c.req.header('host');
		const hosts = host === undefined ? [] : [host];
		if (!allows_request_hosts(hosts, allowed_origins)) {
			const held_back = warnings.note(now());
			if (held_back !== null) {
				log.warn(format_host_refusal_warning(host ?? '', allowed_origins_var, held_back));
			}
			return c.json({ error: ERROR_FORBIDDEN_HOST }, 403);
		}
		return next();
	};
};

/**
 * The host gate's spec without its handler — what the surface and each
 * route's error map read, so a stub surface (`create_test_app_surface_spec`)
 * lists the same layer.
 */
export const host_gate_middleware_shape = {
	name: 'host',
	path: HOST_MIDDLEWARE_PATH,
	errors: [REST_FORBIDDEN_HOST]
} as const satisfies Omit<MiddlewareSpec, 'handler'>;

/**
 * The host gate as a middleware spec on every path (`HOST_MIDDLEWARE_PATH`),
 * declaring its `403`, so the surface and each route's error map carry it.
 *
 * @param options - the allowlist, the log, and the warning's clock
 * @returns the spec
 */
export const create_host_gate_middleware_spec = (options: HostGateOptions): MiddlewareSpec => ({
	...host_gate_middleware_shape,
	handler: create_host_gate_middleware(options)
});
