/**
 * Composed WebSocket endpoint registration — the idiomatic consumer entry
 * point for mounting a fuz_app WS endpoint.
 *
 * Wraps the standard upgrade stack every consumer writes by hand:
 *
 * 1. `verify_request_source(allowed_origins)` — reject disallowed origins
 *    before the upgrade handshake runs.
 * 2. `require_auth` — reject unauthenticated upgrades.
 * 3. Optional `require_role(required_role)` — for endpoints gated to a
 *    specific role.
 *
 * Then delegates to {@link register_action_ws} for per-message JSON-RPC
 * dispatch.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.js';

import {require_auth, require_role} from '../auth/request_context.js';
import {verify_request_source} from '../http/origin.js';
import type {RoleName} from '../auth/role_schema.js';
import {
	register_action_ws,
	type RegisterActionWsOptions,
	type RegisterActionWsResult,
} from './register_action_ws.js';
import type {BaseHandlerContext} from './action_types.js';

/** Options for {@link register_ws_endpoint}. */
export interface RegisterWsEndpointOptions<
	TCtx extends BaseHandlerContext,
> extends RegisterActionWsOptions<TCtx> {
	/**
	 * Origin allowlist regexes — typically parsed from the `ALLOWED_ORIGINS`
	 * env var via `parse_allowed_origins`. Passed straight to
	 * `verify_request_source`.
	 */
	allowed_origins: Array<RegExp>;
	/**
	 * Role required to upgrade. Omit for any authenticated account (`require_auth`
	 * alone); set to e.g. `ROLE_ADMIN` to gate the endpoint behind a role. The
	 * per-action `auth` in each spec still applies at dispatch time — this is
	 * a coarse upgrade-time gate.
	 */
	required_role?: RoleName;
}

/**
 * Mount a WebSocket endpoint with the standard upgrade stack (origin check
 * + auth + optional role) and JSON-RPC dispatch.
 *
 * Returns the {@link BackendWebsocketTransport} (supplied or freshly
 * created), same as {@link register_action_ws} — retain it to wire
 * `create_ws_auth_guard` on `on_audit_event` or to broadcast.
 */
export const register_ws_endpoint = <TCtx extends BaseHandlerContext>(
	options: RegisterWsEndpointOptions<TCtx>,
): RegisterActionWsResult => {
	const {app, path, allowed_origins, required_role, log = new Logger('[ws]'), ...rest} = options;

	app.use(path, verify_request_source(allowed_origins));
	app.use(path, require_auth);
	if (required_role !== undefined) {
		app.use(path, require_role(required_role));
	}

	return register_action_ws<TCtx>({app, path, log, ...rest});
};
