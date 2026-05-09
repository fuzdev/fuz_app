/**
 * Composed WebSocket endpoint registration — the idiomatic consumer entry
 * point for mounting a fuz_app WS endpoint.
 *
 * Wraps the standard upgrade stack every consumer writes by hand:
 *
 * 1. `verify_request_source(allowed_origins)` — reject disallowed origins
 *    before the upgrade handshake runs.
 * 2. `require_auth` — reject unauthenticated upgrades.
 * 3. **Authorization phase** — resolve the acting actor against the
 *    authenticated account plus an optional `?acting=<uuid>` query string,
 *    and build the `RequestContext` that per-message dispatch reads.
 *    Multi-actor accounts must supply `?acting` to pick a persona;
 *    single-actor accounts work without it.
 * 4. Optional `require_role(required_role)` — for endpoints gated to a
 *    specific role.
 *
 * Then delegates to `register_action_ws` for per-message JSON-RPC
 * dispatch.
 *
 * @module
 */

import type {Context, MiddlewareHandler} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {apply_authorization_phase, require_auth, require_role} from '../auth/request_context.js';
import {verify_request_source} from '../http/origin.js';
import type {RoleName} from '../auth/role_schema.js';
import type {Db} from '../db/db.js';
import {
	register_action_ws,
	type RegisterActionWsOptions,
	type RegisterActionWsResult,
} from './register_action_ws.js';
import type {BaseHandlerContext} from './action_types.js';

/** Options for `register_ws_endpoint`. */
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
	 * Pool-level database used for upgrade-time actor resolution + permit
	 * load. Ran once per connection, then the result is reused for every
	 * message on the socket.
	 */
	db: Db;
	/**
	 * Role required to upgrade. Omit for any authenticated account
	 * (`require_auth` + actor resolution alone); set to e.g. `ROLE_ADMIN`
	 * to gate the endpoint behind a role. The per-action `auth` in each
	 * spec still applies at dispatch time — this is a coarse upgrade-time
	 * gate.
	 */
	required_role?: RoleName;
}

/** Synthesized auth shape for WS upgrade: account + actor both required. */
const WS_UPGRADE_AUTH = {
	account: 'required' as const,
	actor: 'required' as const,
};

/**
 * Upgrade-time authorization middleware. Resolves the acting actor for
 * the WS connection (single-actor default; multi-actor must supply
 * `?acting=<uuid>`) and builds the `RequestContext` that per-message
 * dispatch reads. Returns 400 on resolution failure.
 */
const create_ws_authorization_middleware = (db: Db): MiddlewareHandler => {
	return async (c: Context, next): Promise<Response | void> => {
		const acting_param = c.req.query('acting');
		// `apply_authorization_phase` is a no-op when the test-harness flag
		// `TEST_CONTEXT_PRESET_KEY` is set (escape hatch for pre-baked
		// `RequestContext`). Failure shape is `{status, body}`; the WS
		// upgrade is a plain HTTP response, so bind it the same way REST does.
		const failure = await apply_authorization_phase(
			{db},
			c,
			WS_UPGRADE_AUTH,
			acting_param ?? undefined,
		);
		if (failure) return c.json(failure.body, failure.status);
		await next();
	};
};

/**
 * Mount a WebSocket endpoint with the standard upgrade stack (origin check
 * + auth + actor resolution + optional role) and JSON-RPC dispatch.
 *
 * Returns the `BackendWebsocketTransport` (supplied or freshly
 * created), same as `register_action_ws` — retain it to wire
 * `create_ws_auth_guard` on `on_audit_event` or to broadcast.
 *
 * @mutates options.app - applies origin/auth/authorization/role middleware via `app.use`,
 *   then registers the `GET path` route via the inner `register_action_ws`
 */
export const register_ws_endpoint = <TCtx extends BaseHandlerContext>(
	options: RegisterWsEndpointOptions<TCtx>,
): RegisterActionWsResult => {
	const {
		app,
		path,
		allowed_origins,
		db,
		required_role,
		log = new Logger('[ws]'),
		...rest
	} = options;

	app.use(path, verify_request_source(allowed_origins));
	app.use(path, require_auth);
	app.use(path, create_ws_authorization_middleware(db));
	if (required_role !== undefined) {
		app.use(path, require_role([required_role]));
	}

	return register_action_ws<TCtx>({app, path, log, ...rest});
};
