import '../assert_dev_env.ts';

/**
 * Where a spawned backend's WebSocket endpoint is, and how the cross suites
 * open a socket on it as one account's session.
 *
 * The socket-driving cross suites take `WsEndpointTarget` as their endpoint
 * options (flat, or nested as `ws` on a suite whose socket cases are
 * optional), and open a socket on a fixture account's session through
 * `open_session_ws`, so the cookie read, the missing-cookie assertion and the
 * transport choice are written once. Sockets on another credential — a daemon
 * token, a bearer, a session a case logged in on its own transport — and the
 * raw-socket cases open their own way.
 *
 * @module
 */

import { assert } from 'vitest';

import {
	create_admitted_ws_transport,
	create_ws_transport,
	type WsTransportClient,
	type WsTransportOptions
} from '../transports/ws_transport.ts';

/** Where a backend's WebSocket endpoint is. */
export interface WsEndpointTarget {
	/** Base URL the backend is reachable at (e.g. `http://localhost:1178`). */
	readonly base_url: string;
	/** WebSocket endpoint path on the backend (e.g. `/api/ws`). */
	readonly ws_path: string;
	/** `Origin` for a browser-context upgrade. Defaults to `base_url`. */
	readonly origin?: string;
}

/** An account a session socket opens as — a fixture or a minted account. */
export interface WsSessionAccount {
	/** Build request headers carrying the account's session cookie. */
	readonly create_session_headers: (extra?: Record<string, string>) => Record<string, string>;
}

/** Options for `open_session_ws`. */
export interface OpenSessionWsOptions extends Pick<
	WsTransportOptions,
	'default_timeout_ms' | 'on_request' | 'headers'
> {
	/**
	 * Round-trip `heartbeat` before resolving, so the backend has admitted the
	 * connection (`create_admitted_ws_transport`) — needed by a case that waits
	 * for a push or relies on registration order. `false` resolves once the
	 * socket is open (`create_ws_transport`), for a case that only round-trips
	 * or counts its own requests.
	 */
	readonly admitted: boolean;
}

/**
 * The account's session cookie (`<name>=<value>`), asserted present.
 *
 * @param account - the account whose session headers carry the cookie
 * @returns the `Cookie` header value
 */
export const to_session_cookie = (account: WsSessionAccount): string => {
	const { cookie } = account.create_session_headers();
	assert.ok(cookie, 'expected a session cookie for the WS upgrade');
	return cookie;
};

/**
 * Open a real-upgrade socket on `target` as `account`'s session: its session
 * cookie on the upgrade, `target.origin` (or `base_url`) as the `Origin`.
 *
 * The cookie is the static one `account.create_session_headers` carries, not
 * whatever `fixture.transport`'s jar holds now, so a case that rotates the
 * session through `fixture.transport` first upgrades on the stale cookie.
 *
 * @param target - the backend's WebSocket endpoint
 * @param account - the account whose session the socket upgrades on
 * @param options - whether to wait for admission, plus transport extras
 * @returns the open socket
 * @throws Error if the account carries no session cookie, or the upgrade (or
 *   the admission heartbeat) fails
 */
export const open_session_ws = (
	target: WsEndpointTarget,
	account: WsSessionAccount,
	options: OpenSessionWsOptions
): Promise<WsTransportClient> => {
	const { admitted, ...transport_options } = options;
	const open = admitted ? create_admitted_ws_transport : create_ws_transport;
	return open({
		base_url: target.base_url,
		ws_path: target.ws_path,
		cookies: [to_session_cookie(account)],
		origin: target.origin ?? target.base_url,
		...transport_options
	});
};
