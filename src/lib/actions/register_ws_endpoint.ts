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
 * 4. Optional `require_role(required_roles)` — for endpoints gated to a
 *    non-empty any-of set of roles.
 *
 * Then delegates to `register_action_ws` for per-message JSON-RPC
 * dispatch.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	apply_authorization_phase,
	REQUEST_CONTEXT_KEY,
	require_auth,
	require_role
} from '../auth/request_context.ts';
import { verify_request_source } from '../http/origin.ts';
import type { RoleName } from '../auth/role_schema.ts';
import type { Db } from '../db/db.ts';
import { ACCOUNT_ID_KEY, TEST_CONTEXT_PRESET_KEY } from '../hono_context.ts';
import {
	register_action_ws,
	type RegisterActionWsOptions,
	type RegisterActionWsResult
} from './register_action_ws.ts';

/** Options for `register_ws_endpoint`. */
export interface RegisterWsEndpointOptions extends RegisterActionWsOptions {
	/**
	 * Origin allowlist regexes — typically parsed from the `FUZ_ALLOWED_ORIGINS`
	 * env var via `parse_allowed_origins`. Passed straight to
	 * `verify_request_source`.
	 */
	allowed_origins: ReadonlyArray<RegExp>;
	/**
	 * Roles permitted to upgrade — any-of disjunction (matches the
	 * underlying `require_role` semantics). Omit (or pass `[]`) for any
	 * authenticated account (`require_auth` + actor resolution alone);
	 * set to e.g. `[ROLE_ADMIN]` to gate the endpoint behind a single role
	 * or `[ROLE_ADMIN, ROLE_KEEPER]` to permit either. The per-action
	 * `auth` in each spec still applies at dispatch time — this is a coarse
	 * upgrade-time gate.
	 */
	required_roles?: ReadonlyArray<RoleName>;
}

/** Synthesized auth shape for WS upgrade: account + actor both required. */
const WS_UPGRADE_AUTH = {
	account: 'required' as const,
	actor: 'required' as const
};

/**
 * Upgrade-time authorization middleware. Resolves the acting actor for
 * the WS connection (single-actor default; multi-actor must supply
 * `?acting=<uuid>`) and builds the `RequestContext` that per-message
 * dispatch reads. Returns 400 on resolution failure.
 *
 * Sets `REQUEST_CONTEXT_KEY` on resolved outcomes so the inner
 * `register_action_ws` reads the upgrade-time context via
 * `require_request_context(c)`. Honors the test-preset escape hatch the
 * same way the REST and HTTP RPC binders do.
 */
const create_ws_authorization_middleware = (db: Db): MiddlewareHandler => {
	return async (c: Context, next): Promise<Response | void> => {
		// Test escape hatch — harnesses pre-populate `REQUEST_CONTEXT_KEY`
		// + flag `TEST_CONTEXT_PRESET_KEY = true`. Production middleware
		// never sets this flag.
		if (c.get(TEST_CONTEXT_PRESET_KEY)) {
			await next();
			return;
		}
		const acting_param = c.req.query('acting');
		const account_id: string | null = c.get(ACCOUNT_ID_KEY) ?? null;
		const result = await apply_authorization_phase(
			{ db },
			account_id,
			WS_UPGRADE_AUTH,
			acting_param ?? undefined
		);
		if (!result.ok) return c.json(result.body, result.status);
		if (result.request_context !== null) {
			c.set(REQUEST_CONTEXT_KEY, result.request_context);
		}
		// `request_context: null` is unreachable here — `WS_UPGRADE_AUTH` is
		// `account: 'required', actor: 'required'`, and `require_auth` ran
		// upstream, so neither the public nor the unauthenticated branch
		// resolves through this middleware.
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
export const register_ws_endpoint = (
	options: RegisterWsEndpointOptions
): RegisterActionWsResult => {
	const {
		app,
		path,
		allowed_origins,
		db,
		required_roles,
		log = new Logger('[ws]'),
		...rest
	} = options;

	app.use(path, verify_request_source(allowed_origins));
	app.use(path, require_auth);
	app.use(path, create_ws_authorization_middleware(db));
	if (required_roles?.length) {
		app.use(path, require_role(required_roles));
	}

	return register_action_ws({ app, path, db, log, ...rest });
};
