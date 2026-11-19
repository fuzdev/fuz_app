import '../assert_dev_env.ts';

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
 * the behaviour real browsers exhibit against the same surface. It does
 * honour a `Max-Age` of zero or less, dropping the cookie as a browser does:
 * a cleared session cookie kept as `name=` would be re-sent as an invalid
 * cookie, which both spines answer by clearing it again.
 *
 * @module
 */

import type { RpcTestTransport } from '../rpc_helpers.ts';

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
	 * Origin header threaded onto every request when the caller hasn't set
	 * one. Defaults to `base_url`; backends running with
	 * `ALLOWED_ORIGINS=http://localhost:*` accept `http://localhost:<port>`
	 * matching the spawned binary.
	 *
	 * Pass `null` to disable the default — useful for bearer-only probes
	 * that must not look like browser-context requests (the auth middleware
	 * silently discards bearer credentials when `Origin`/`Referer` is
	 * present). Callers can still set `Origin` per-call via `init.headers`.
	 */
	readonly origin?: string | null;
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
 * Parse a `Set-Cookie` value: its `name=value` head, and whether it deletes
 * the cookie — a `Max-Age` of zero or less, which is how both spines clear
 * the session cookie. Returns `null` for malformed inputs (missing `=`, empty
 * name). Every other attribute is dropped — the jar is name-keyed, and
 * `Expires`, `Path`, `Domain` and `SameSite` don't affect cross-process test
 * plumbing.
 */
const parse_set_cookie = (
	value: string
): { name: string; cookie: string; deleted: boolean } | null => {
	const [head_part, ...attributes] = value.split(';');
	const head = head_part!.trim();
	const eq = head.indexOf('=');
	if (eq <= 0) return null;
	const name = head.slice(0, eq).trim();
	if (!name) return null;
	const deleted = attributes.some((attribute) => {
		const [attribute_name, attribute_value] = attribute.split('=', 2);
		return (
			attribute_name!.trim().toLowerCase() === 'max-age' &&
			/^-?\d+$/.test(attribute_value?.trim() ?? '') &&
			Number(attribute_value) <= 0
		);
	});
	return { name, cookie: head, deleted };
};

/** Apply one `Set-Cookie` value to a jar, as a browser does: set, or delete on `Max-Age<=0`. */
const apply_set_cookie = (jar: Map<string, string>, raw: string): void => {
	const parsed = parse_set_cookie(raw);
	if (!parsed) return;
	if (parsed.deleted) jar.delete(parsed.name);
	else jar.set(parsed.name, parsed.cookie);
};

/**
 * Build a cookie-threading transport pinned to `options.base_url`. The
 * returned function carries a private `Map<name, cookie-head>` jar that
 * updates on every response's `Set-Cookie` (a `Max-Age<=0` one deletes its
 * cookie) and re-sends on every subsequent request.
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
	const { base_url, initial_cookies, origin } = options;
	const jar: Map<string, string> = new Map();
	if (initial_cookies) {
		for (const raw of initial_cookies) apply_set_cookie(jar, raw);
	}
	const default_origin = origin === null ? null : (origin ?? base_url);

	const cookies = (): ReadonlyArray<string> => Array.from(jar.values());

	const transport = (async (url: string, init: RequestInit): Promise<Response> => {
		const target = /^https?:\/\//i.test(url) ? url : `${base_url}${url}`;
		const headers = new Headers(init.headers);
		if (default_origin !== null && !headers.has('Origin')) {
			headers.set('Origin', default_origin);
		}
		if (!headers.has('Cookie') && jar.size > 0) {
			headers.set('Cookie', Array.from(jar.values()).join('; '));
		}
		const response = await fetch(target, { ...init, headers });
		// `Headers.getSetCookie()` returns each `Set-Cookie` value as a
		// separate string — the only way to read multiple cookies set in
		// one response (Headers.get() collapses to a single comma-joined
		// string). Node 19.7+ ships it; vitest's runtime supports it.
		const set_cookies = response.headers.getSetCookie();
		for (const raw of set_cookies) apply_set_cookie(jar, raw);
		return response;
	}) as FetchTransport;

	// Attach the cookies() accessor onto the callable. Using a property
	// definition keeps it non-enumerable-ish and avoids polluting `.bind`
	// / `.call` reflection on the function.
	Object.defineProperty(transport, 'cookies', { value: cookies, enumerable: false });

	return transport;
};
