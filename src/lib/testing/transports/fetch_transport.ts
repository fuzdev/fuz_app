import '../assert_dev_env.js';

/**
 * Cookie-threading HTTP transport for cross-process tests.
 *
 * Wraps the global `fetch` against a base URL, carries cookies across
 * requests in a `Map`-backed jar so the session cookie set on bootstrap
 * is re-sent on every subsequent call. Satisfies the `RpcTestTransport`
 * shape `Hono.request` already does — so every suite body that takes
 * `transport: RpcTestTransport` works against a cross-process binary
 * unchanged.
 *
 * The `Origin` header is threaded onto every request because the
 * backend's allowlist (`{ZZZ,ZAP,FUZ}_ALLOWED_ORIGINS`) rejects mutations
 * without an `Origin`. Cross-process tests run with
 * `ALLOWED_ORIGINS=http://localhost:*`, so defaulting `origin` to the
 * configured `base_url` is safe.
 *
 * The cookie jar is intentionally simple — it does not honour `Domain`,
 * `Path`, `Expires`, or `SameSite` attributes. Cross-process tests
 * always hit a single host:port, so name-keyed last-write-wins matches
 * the behaviour real browsers exhibit against the same surface.
 *
 * @module
 */

import type {RpcTestTransport} from '../rpc_helpers.js';

/** Construction options for `create_fetch_transport`. */
export interface FetchTransportOptions {
	/** Base URL the binary is reachable at — e.g. `http://localhost:8788`. */
	readonly base_url: string;
	/**
	 * Initial cookie values to seed the jar. Pass the `Set-Cookie` values
	 * captured from a prior `bootstrap()` call to keep the keeper session
	 * across a transport-recreation boundary. Each entry is a full
	 * `Set-Cookie` value (the same string `Headers.getSetCookie()` returns).
	 */
	readonly initial_cookies?: ReadonlyArray<string>;
	/**
	 * Origin header threaded onto every request. Defaults to `base_url`.
	 * Backends running with `ALLOWED_ORIGINS=http://localhost:*` accept
	 * `http://localhost:<port>` matching the spawned binary.
	 */
	readonly origin?: string;
}

/**
 * The transport shape: callable as `RpcTestTransport` plus a `cookies()`
 * accessor that returns the current jar state. The accessor exists so
 * `ws_transport` can thread the session cookie onto the WS upgrade
 * without an HTTP round trip.
 */
export interface FetchTransport extends RpcTestTransport {
	/**
	 * Snapshot of every cookie currently in the jar, formatted as full
	 * `Set-Cookie` values (`name=value`). Used by `ws_transport` to
	 * compose the `Cookie` header on the upgrade request.
	 */
	readonly cookies: () => ReadonlyArray<string>;
}

/**
 * Parse the `name=value` head of a `Set-Cookie` value. Returns `null`
 * for malformed inputs (missing `=`, empty name). Drops every attribute
 * after the first `;` — the jar is name-keyed and the lifetime
 * attributes (`Expires`, `Max-Age`, `Path`, `Domain`, `SameSite`)
 * don't affect cross-process test plumbing.
 */
const parse_set_cookie = (value: string): {name: string; cookie: string} | null => {
	const head = value.split(';', 1)[0]!.trim();
	const eq = head.indexOf('=');
	if (eq <= 0) return null;
	const name = head.slice(0, eq).trim();
	if (!name) return null;
	return {name, cookie: head};
};

/**
 * Build a cookie-threading transport pinned to `options.base_url`. The
 * returned function carries a private `Map<name, cookie-head>` jar that
 * updates on every response's `Set-Cookie` and re-sends on every
 * subsequent request.
 *
 * Request rewriting:
 *
 * - Absolute URLs (`http://other.example/...`) pass through verbatim —
 *   handy for cross-origin negative tests that target a deliberately
 *   different host.
 * - Relative URLs are resolved against `base_url`.
 * - `Origin` is set to `options.origin ?? base_url` unless the caller
 *   already provided one.
 * - `Cookie` is set from the jar unless the caller already provided one.
 */
export const create_fetch_transport = (options: FetchTransportOptions): FetchTransport => {
	const {base_url, initial_cookies, origin} = options;
	const jar: Map<string, string> = new Map();
	if (initial_cookies) {
		for (const raw of initial_cookies) {
			const parsed = parse_set_cookie(raw);
			if (parsed) jar.set(parsed.name, parsed.cookie);
		}
	}
	const default_origin = origin ?? base_url;

	const cookies = (): ReadonlyArray<string> => Array.from(jar.values());

	const transport = (async (url: string, init: RequestInit): Promise<Response> => {
		const target = /^https?:\/\//i.test(url) ? url : `${base_url}${url}`;
		const headers = new Headers(init.headers);
		if (!headers.has('Origin')) headers.set('Origin', default_origin);
		if (!headers.has('Cookie') && jar.size > 0) {
			headers.set('Cookie', Array.from(jar.values()).join('; '));
		}
		const response = await fetch(target, {...init, headers});
		// `Headers.getSetCookie()` returns each `Set-Cookie` value as a
		// separate string — the only way to read multiple cookies set in
		// one response (Headers.get() collapses to a single comma-joined
		// string). Node 19.7+ ships it; vitest's runtime supports it.
		const set_cookies = response.headers.getSetCookie();
		for (const raw of set_cookies) {
			const parsed = parse_set_cookie(raw);
			if (parsed) jar.set(parsed.name, parsed.cookie);
		}
		return response;
	}) as FetchTransport;

	// Attach the cookies() accessor onto the callable. Using a property
	// definition keeps it non-enumerable-ish and avoids polluting `.bind`
	// / `.call` reflection on the function.
	Object.defineProperty(transport, 'cookies', {value: cookies, enumerable: false});

	return transport;
};
