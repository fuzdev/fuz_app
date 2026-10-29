/**
 * WebSocket JSON-RPC endpoint — the WS transport binding.
 *
 * Consumers declare WS endpoints on `create_app_server`'s `ws_endpoints`,
 * which mounts each through `register_action_ws`; call it directly only to
 * mount an endpoint outside that assembly. Tests drive the dispatcher
 * directly via `create_ws_test_harness`.
 *
 * ## The upgrade route
 *
 * One `GET path` route, its guards in coarse-to-fine order — the route-spec
 * pipeline's, from `fuz_auth_guard_resolver`:
 *
 * 1. `verify_request_source(allowed_origins)` — a disallowed origin is
 *    refused before the upgrade handshake runs (403).
 * 2. `require_auth` — an unauthenticated upgrade is refused (401).
 * 3. `require_token_scope('surface:ws_upgrade')` — rule 3: a narrowed token
 *    cannot hold a socket (403 `token_scope_required`). Server-initiated
 *    pushes (broadcasts, role-grant-offer notifications, peer requests)
 *    reach whatever the account's connection reaches, with no per-recipient
 *    filter to narrow them by, so a scoped token that could upgrade would
 *    observe far more than it was granted.
 * 4. **Authorization phase** (`run_authorization_phase`) — the acting actor
 *    from the `?acting=<uuid>` query string (`parse_acting`; malformed reads
 *    as omitted), against the authenticated account, building the
 *    `RequestContext` per-message dispatch reads (400s on actor selection).
 *    Multi-actor accounts must supply `?acting`; single-actor accounts work
 *    without it.
 * 5. `require_role(required_roles)`, for a gated endpoint (403).
 *
 * Only `GET` is mounted (Hono serves `HEAD` through it), so any other method
 * on the path is a 404. The guards run as middleware ahead of
 * `upgradeWebSocket`, whose callback must return `WSEvents` and so cannot
 * produce a refusal.
 *
 * Symmetric to `create_rpc_endpoint` (from `actions/action_rpc.ts`):
 * both transports parse their wire envelope, then call the shared
 * `perform_action` core (`actions/perform_action.ts`) for the post-parse
 * pipeline. WS-specific concerns — connection lifecycle, heartbeat,
 * cancel-notification interception, socket-scoped notify — live in
 * `actions/ws_socket_session.ts`; everything else (auth gates, input
 * validation, authorization phase, rate limiting, transactional dispatch, DEV
 * output validation, thrown-error normalization) is shared.
 *
 * ## Per-message auth
 *
 * Per-action auth runs inside `perform_action` on every message via the same
 * gates HTTP RPC uses.
 *
 * ## Per-socket lifecycle
 *
 * Admission (the revocation race), the credential deadline, and the rule that a
 * server-closed socket dispatches nothing are the per-socket half, in
 * `actions/ws_socket_session.ts`.
 *
 * @module
 */

import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { Logger, type Logger as LoggerType } from '@fuzdev/fuz_util/log.ts';

import {
	get_request_context,
	require_request_context,
	run_authorization_phase,
	type RequestContext
} from '../auth/request_context.ts';
import { fuz_auth_guard_resolver } from '../auth/auth_guard_resolver.ts';
import type { RoleName } from '../auth/role_schema.ts';
import { get_resolved_auth } from '../auth/resolved_auth.ts';
import { verify_request_source } from '../http/origin.ts';
import { parse_acting, type RouteAuth } from '../http/auth_shape.ts';
import { get_client_ip } from '../http/client_ip.ts';
import type { EffectErrorContext } from '../http/pending_effects.ts';
import type { RateLimiter } from '../rate_limiter.ts';
import { TEST_CONTEXT_PRESET_KEY } from '../hono_context.ts';
import type { Db } from '../db/db.ts';
import { type Action } from './action_types.ts';
import { compile_action_registry } from './compile_action_registry.ts';
import type { RealtimeCloser } from './connection_closer.ts';
import { DEFAULT_WS_MAX_MESSAGE_BYTES } from './transports.ts';
import { ConnectionRegistry } from './connection_registry.ts';
import {
	create_ws_socket_events,
	PRE_ADMISSION_QUEUE_BYTES_FACTOR,
	type SocketCloseContext,
	type SocketOpenContext,
	type WsSocketEndpoint
} from './ws_socket_session.ts';

/**
 * Default receive silence (ms) past which the server closes a socket with
 * `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT` — the `receive_timeout` of
 * `register_action_ws`. Twin of the Rust spine's `DEFAULT_WS_RECEIVE_TIMEOUT`.
 */
export const DEFAULT_WS_RECEIVE_TIMEOUT = 60_000;

/**
 * The longest `receive_timeout` `register_action_ws` accepts — 2³¹ − 1 ms,
 * about 24.8 days, the longest delay a timer honors (the same bound as the
 * SSE keep-alive). It keeps the receive check's half-timeout tick well inside
 * that delay; `Infinity`, or a timeout of about 2³² ms and up, would make the
 * tick fire every millisecond on every socket. TS-only: the Rust spine's
 * `Duration` takes any length.
 */
export const WS_RECEIVE_TIMEOUT_MAX = 2_147_483_647;

/** Options for `register_action_ws`. */
export interface RegisterActionWsOptions {
	/** Mount path (e.g., `/api/ws`). */
	path: string;
	/** The Hono app to mount on. */
	app: Hono;
	/** Hono's `upgradeWebSocket` helper from the runtime adapter. */
	upgradeWebSocket: UpgradeWebSocket;
	/**
	 * Origin allowlist regexes for the upgrade — passed straight to
	 * `verify_request_source`, the route's first guard. `create_app_server`
	 * passes the server's `allowed_origins` unless the `WsEndpointSpec` narrows
	 * them.
	 */
	allowed_origins: ReadonlyArray<RegExp>;
	/**
	 * The actions registered on this endpoint — each carries a spec (drives
	 * method lookup, per-action auth, input/output validation) and an
	 * optional handler (omit for client-only specs like inbound
	 * notifications). Spread `protocol_actions` from `actions/protocol.ts`
	 * here to complete the disconnect-detection + per-request cancel
	 * pairing with the frontend client.
	 */
	actions: ReadonlyArray<Action>;
	/**
	 * Pool-level DB. The dispatcher wraps in `db.transaction` for
	 * `side_effects: true` actions, the same way HTTP RPC does. Per-message
	 * authorization phase reads through this pool.
	 *
	 * Audit writes and other rollback-resilient fire-and-forget calls run
	 * through `AppDeps.audit.emit` from the action factory's closure —
	 * the dispatcher never holds an audit-side pool reference; the bound
	 * emitter owns the pool.
	 */
	db: Db;
	/**
	 * Roles permitted to upgrade — any-of disjunction, global grants only,
	 * mounted as the route's `require_role` gate (403). Omit (or pass `[]`)
	 * for any authenticated account. The per-action `auth` in each spec still
	 * applies at dispatch time — this is a coarse upgrade-time gate on who may
	 * hold a socket, and so on who receives the endpoint's server pushes.
	 *
	 * It holds for the socket's life: recorded on every registration
	 * (`ConnectionIdentity.required_roles`), so a revoked global grant of a
	 * listed role closes the socket (a `role` close target, any listed role
	 * — see its over-close), and re-read at admission against the acting
	 * actor's grants, so a revocation that landed between the gate and the
	 * registration refuses the upgrade with `WS_CLOSE_PERMISSION_REVOKED`.
	 */
	required_roles?: ReadonlyArray<RoleName>;
	/**
	 * Existing registry to register connections with. When omitted, a fresh
	 * one is created and returned in the result. Pass your own to keep a
	 * handle for `send_to` / `broadcast` before the mount.
	 */
	registry?: ConnectionRegistry;
	/**
	 * The backend's closer — `deps.connection_closer`. This endpoint's
	 * registry is added to it, so every revocation handler's close reaches
	 * the sockets opened here. Required so it can't be forgotten: left out of
	 * the closer, no revocation closes a registry's sockets — neither the
	 * handlers' closes nor the revocation guard, which closes through the same
	 * closer. Pass `null` only when no revocation has to reach this registry
	 * (a harness driving the dispatcher directly), or when the registry was
	 * added by hand.
	 *
	 * The registry is added once the mount succeeds, so a mount that throws
	 * adds nothing. The addition is permanent — its remover is not returned.
	 * A caller that must release the membership (as `create_app_server` does
	 * on close) passes `null` and adds the registry itself, holding the
	 * remover `RealtimeCloser.add` returns.
	 */
	connection_closer: RealtimeCloser | null;
	/**
	 * Per-account connection cap for the registry this call creates — see
	 * `ConnectionRegistryOptions.max_connections_per_account`
	 * (evict-oldest, closing with `WS_CLOSE_CONNECTION_LIMIT`; `null`
	 * disables). Rejected alongside `registry`: a supplied registry carries
	 * its own cap, set where it was constructed.
	 *
	 * @default DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
	 */
	max_connections_per_account?: number | null;
	/**
	 * Byte budget of the frames waiting to be written to one connection, for
	 * the registry this call creates — see
	 * `ConnectionRegistryOptions.outbound_queue_bytes` (a frame that does
	 * not fit closes the socket with `WS_CLOSE_OUTBOUND_OVERFLOW`). Not derived
	 * from `max_message_bytes`. Rejected alongside `registry`: a supplied
	 * registry carries its own budget, set where it was constructed.
	 *
	 * @default DEFAULT_WS_OUTBOUND_QUEUE_BYTES
	 */
	outbound_queue_bytes?: number;
	/**
	 * Receive silence (ms) past which the server closes a socket with
	 * `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT`. Any incoming message resets the
	 * count — chatty clients never trip it — and the first window after
	 * admission is exempt (cold-start grace). `null` keeps silent sockets open:
	 * only do this if the upstream stack (TCP keepalive, a proxy's idle
	 * timeout) already owns disconnect detection. Must be positive and at most
	 * `WS_RECEIVE_TIMEOUT_MAX` — registration throws otherwise. Twin of the
	 * Rust spine's `ActionWsOptions.receive_timeout`.
	 *
	 * @default DEFAULT_WS_RECEIVE_TIMEOUT
	 */
	receive_timeout?: number | null;
	/**
	 * Cap on one inbound message, in bytes (UTF-8 for text frames). A larger
	 * message closes the socket with `WS_CLOSE_MESSAGE_TOO_BIG` before it's
	 * parsed — there's no per-message error reply, matching the Rust spine.
	 * The cap is checked after the runtime adapter has buffered the message,
	 * so it bounds dispatch work, not memory; bound the adapter's own frame
	 * limit too (e.g. `ws`'s `maxPayload`) where memory matters, set above this
	 * cap — twice it, as the cross-backend test adapters do. A message past the
	 * frame limit is refused by the adapter without
	 * `WS_CLOSE_MESSAGE_TOO_BIG_REASON` (`ws` closes with the code and an empty
	 * reason, Bun drops the socket), so a frame limit equal to this cap loses
	 * the reason a message just over it gets. A consumer that raises it passes
	 * the same value to the client's
	 * `FrontendWebsocketTransportOptions.max_message_bytes`.
	 *
	 * @default DEFAULT_WS_MAX_MESSAGE_BYTES
	 */
	max_message_bytes?: number;
	/** Optional logger; defaults to `[ws]` namespace. */
	log?: LoggerType;
	/**
	 * Called once per socket, after the connection is admitted
	 * (`actions/ws_socket_session.ts`, "Admission: the revocation race").
	 * Awaited before any inbound frame is dispatched — every
	 * frame the client sends meanwhile waits in arrival order, replies to
	 * server-initiated requests included: a hook that awaits
	 * `registry.request_connection` on its own connection gets no reply until
	 * it returns, so start such a request without awaiting it. Throwing logs an
	 * error and closes the socket with an `internal_error` frame and
	 * `WS_CLOSE_INTERNAL_ERROR` — a failing bootstrap should not leave a
	 * partially-initialized socket alive.
	 */
	on_socket_open?: (ctx: SocketOpenContext) => void | Promise<void>;
	/**
	 * Called once per admitted socket on close, *after* the registry has
	 * removed the connection — a slow hook never holds a dead entry that
	 * broadcasts still target and the per-account cap still counts. Receives
	 * `connection_id` and `identity` captured at open time, the same whether the
	 * close came from the client, a revocation, or a connection-cap eviction.
	 * Errors are logged and swallowed.
	 */
	on_socket_close?: (ctx: SocketCloseContext) => void | Promise<void>;
	/**
	 * Per-IP rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'ip'` or `'both'`, keyed on the client IP read at upgrade
	 * time. Required, with no default: pass `null` to turn the IP check off,
	 * so an unthrottled socket is a choice the call site states rather than
	 * an option it forgot. Share one instance with the HTTP RPC dispatcher so
	 * one budget covers both transports per action — `create_app_server`
	 * does, for the endpoints it mounts from `ws_endpoints`.
	 */
	action_ip_rate_limiter: RateLimiter | null;
	/**
	 * Per-account rate limiter consulted for actions whose spec declares
	 * `rate_limit: 'account'` or `'both'`. Keyed on
	 * `request_context.account.id`. Required, with no default: pass `null`
	 * to turn the account check off. Share one instance with the HTTP RPC
	 * dispatcher.
	 */
	action_account_rate_limiter: RateLimiter | null;
	/**
	 * Called when an eager pending effect of a frame's action rejects, after
	 * the rejection is logged — the WS half of `create_app_server`'s
	 * `on_effect_error`, which threads it here for the endpoints it mounts.
	 * The context carries `transport: 'ws'`, the action method, and `path`.
	 */
	on_effect_error?: (error: unknown, context: EffectErrorContext) => void;
}

/** Result of `register_action_ws`. */
export interface RegisterActionWsResult {
	/** The registry bound to the endpoint — supplied or freshly created. */
	registry: ConnectionRegistry;
}

/**
 * Mount a JSON-RPC WebSocket endpoint — the upgrade route with its origin,
 * auth, token-scope, acting-actor, and role guards (module doc, "The upgrade
 * route") — that dispatches via the shared `perform_action` core.
 *
 * Wire behavior:
 * - Batch JSON-RPC is rejected (single-message only).
 * - Notifications (method + no id) are silently dropped per JSON-RPC spec.
 *   Exception: `cancel` notifications abort the matching pending request's
 *   `ctx.signal` before bubbling out.
 * - A request whose id names a request still running on the socket is
 *   answered `invalid_request` with `data.reason` `ERROR_DUPLICATE_REQUEST_ID`
 *   and not dispatched.
 * - At most `MAX_INBOUND_DISPATCHES_PER_CONNECTION` requests run at once per
 *   socket; one more is answered `queue_overflow` and not dispatched, and the
 *   socket stays open.
 * - Per-message dispatch goes through `perform_action`: pre-authorization
 *   auth (401) → authorization phase → post-authorization auth (403) →
 *   rate limit (429) → input validation (400) → handler (with transaction
 *   wrap iff `spec.side_effects: true`) → DEV output validation.
 * - Authorization phase runs **per message** — role_grant changes during a
 *   connection lifetime are picked up on the next message without any
 *   in-place refresh. Authentication invalidation closes the socket: the
 *   revocation handlers through `connection_closer`, and the revocation guard
 *   (`create_revocation_guard`) on the audit row.
 * - Admission re-reads the credential once, after the handshake: a socket
 *   whose session or token was revoked while it was upgrading closes with
 *   `WS_CLOSE_SESSION_REVOKED`, one that lost a role `required_roles` lists
 *   with `WS_CLOSE_PERMISSION_REVOKED`, and one whose re-check failed with
 *   `WS_CLOSE_INTERNAL_ERROR`. Frames sent before admission wait for it.
 * - A revoked global grant of a role `required_roles` lists closes the
 *   account's sockets on this endpoint with `WS_CLOSE_PERMISSION_REVOKED` —
 *   the revoking handler through `connection_closer`, the revocation guard
 *   again on the audit row; nothing more is sent on them.
 * - A socket the server has closed dispatches nothing more, whether or not
 *   its client answers the close.
 * - Every frame sent — responses, error frames, notifications — goes through
 *   the registry's outbound queue. A connection with more waiting than its
 *   `outbound_queue_bytes` budget closes with `WS_CLOSE_OUTBOUND_OVERFLOW`, and
 *   the response of the request whose handler overflowed it is not sent.
 *
 * @returns the registry (supplied or freshly created) — retain it to broadcast
 * @mutates options.app - registers the `GET path` upgrade route, its guards
 *   ahead of `upgradeWebSocket`
 * @mutates options.registry - per socket, registers, admits, and removes a
 *   connection via `register_pending` / `admit` / `remove_connection`
 * @mutates options.connection_closer - adds the endpoint's registry, once the
 *   mount has succeeded
 * @throws Error when `max_connections_per_account` or `outbound_queue_bytes`
 *   is passed alongside `registry`, when the cap is neither `null` nor a
 *   positive integer, when the budget is not a positive integer, or when
 *   `actions` fails to compile (`compile_action_registry`)
 */
export const register_action_ws = (options: RegisterActionWsOptions): RegisterActionWsResult => {
	if (options.registry && options.max_connections_per_account !== undefined) {
		// a cap that silently did nothing would read as enforced
		throw new Error(
			`register_action_ws: max_connections_per_account configures the registry created for ${options.path}, ` +
				'but a registry was supplied — set the cap on that ConnectionRegistry instead'
		);
	}
	if (options.registry && options.outbound_queue_bytes !== undefined) {
		// a budget that silently did nothing would read as enforced
		throw new Error(
			`register_action_ws: outbound_queue_bytes configures the registry created for ${options.path}, ` +
				'but a registry was supplied — set the budget on that ConnectionRegistry instead'
		);
	}
	const {
		path,
		app,
		upgradeWebSocket,
		actions,
		db,
		receive_timeout = DEFAULT_WS_RECEIVE_TIMEOUT,
		allowed_origins,
		max_message_bytes = DEFAULT_WS_MAX_MESSAGE_BYTES,
		log = new Logger('[ws]'),
		on_socket_open,
		on_socket_close,
		action_ip_rate_limiter,
		action_account_rate_limiter,
		on_effect_error,
		required_roles = []
	} = options;

	const registry =
		options.registry ??
		new ConnectionRegistry({
			max_connections_per_account: options.max_connections_per_account,
			outbound_queue_bytes: options.outbound_queue_bytes,
			log
		});

	// Build the dispatcher's per-method lookup. Only request_response
	// specs with a handler reach `action_map` — perform_action is the
	// only site that calls handlers, and it requires an `RpcAction`.
	// Other kinds (`remote_notification` like `cancel`, `local_call`)
	// are registry-only on WS; the cancel handler reads
	// `cancel_action_spec.method` directly.
	const { action_map } = compile_action_registry(actions, 'WS action');

	const pre_admission_queue_max_bytes = PRE_ADMISSION_QUEUE_BYTES_FACTOR * max_message_bytes;

	if (
		receive_timeout !== null &&
		!(receive_timeout > 0 && receive_timeout <= WS_RECEIVE_TIMEOUT_MAX)
	) {
		// a zero (or NaN) timeout would close every socket at its first tick, and
		// `Infinity` would make the half-timeout tick fire every millisecond
		throw new Error(
			`register_action_ws: receive_timeout must be a positive number of ms up to ${WS_RECEIVE_TIMEOUT_MAX} for ${options.path}, got ${receive_timeout} — pass null to keep silent sockets open`
		);
	}
	// Run the checker on timeout/2 so event-loop blockage pauses the timer
	// itself — a dead-because-blocked socket is close enough to
	// dead-because-unresponsive that closing is arguably correct.
	const receive_tick_interval =
		receive_timeout === null ? null : Math.max(100, Math.floor(receive_timeout / 2));

	// The upgrade's auth shape: account and actor required, the endpoint's roles,
	// and rule 3's surface — the guards the route-spec pipeline would mount for it
	// (module doc, "The upgrade route").
	const upgrade_auth: RouteAuth = {
		account: 'required',
		actor: 'required',
		...(required_roles.length > 0 ? { roles: required_roles } : {}),
		required_scope: 'surface:ws_upgrade'
	};
	const { pre_authorization, post_authorization } = fuz_auth_guard_resolver(upgrade_auth);

	const endpoint: WsSocketEndpoint = {
		path,
		db,
		log,
		registry,
		action_map,
		receive_timeout,
		receive_tick_interval,
		max_message_bytes,
		pre_admission_queue_max_bytes,
		on_socket_open,
		on_socket_close,
		action_ip_rate_limiter,
		action_account_rate_limiter,
		on_effect_error,
		required_roles
	};

	app.get(
		path,
		verify_request_source(allowed_origins),
		...pre_authorization,
		async (c, next) => {
			const refused = await run_authorization_phase(
				c,
				{ db },
				upgrade_auth,
				parse_acting(c.req.query('acting'))
			);
			if (refused) return refused;
			return next();
		},
		...post_authorization,
		upgradeWebSocket((c) => {
			// Upgrade-time identity capture. The route's `require_auth` has
			// already rejected unauthenticated upgrades, and its authorization
			// phase set the request context, so it is non-null here. Per-message
			// dispatch reads the captured resolved credential; the live
			// request_context is only used by the test-preset escape hatch
			// (perform_action runs the authorization phase fresh on every message
			// in production).
			//
			// Session / token validity is read here, by the auth middleware,
			// and re-read once at admission (`onOpen` in
			// `actions/ws_socket_session.ts`) — never per
			// message: per-message dispatch reloads role_grants via the
			// authorization phase and nothing else. From admission on,
			// revocation enforcement lives outside this dispatcher: the
			// revocation handlers close through `deps.connection_closer`
			// (which holds this endpoint's registry — see the
			// `connection_closer` option), and the revocation guard on that
			// closer repeats the close on the audit row. With the registry out
			// of the closer, `session_revoke` / `token_revoke` are no-ops for
			// connections that are already open.
			const upgrade_context = require_request_context(c);
			const client_ip = get_client_ip(c);
			// The credential the auth middleware resolved — the one derivation
			// both long-lived transports share (`get_resolved_auth`), the value
			// the middleware set rather than re-derived here, so a custom
			// session context key or a daemon token riding beside a session
			// cookie can't make this path disagree with the middleware.
			// Fail closed: no credential, or one on another account than the
			// request context's, never reaches the upgrade.
			const resolved = get_resolved_auth(c);
			if (resolved === null) {
				throw new Error(
					`register_action_ws: no resolved credential for the upgrade on ${path} — is the auth middleware wired?`
				);
			}
			if (resolved.account_id !== upgrade_context.account.id) {
				throw new Error(
					`register_action_ws: the credential and the request context name different accounts for the upgrade on ${path}`
				);
			}
			// Test escape hatch — captured once at upgrade. perform_action
			// honors it per-message so harnesses with pre-baked
			// `RequestContext` skip the live authorization phase. It skips the
			// admission re-read for the same reason: a pre-baked credential has
			// no session, token, or account row to re-read.
			const upgrade_preset: { request_context: RequestContext | null } | undefined = c.get(
				TEST_CONTEXT_PRESET_KEY
			)
				? { request_context: get_request_context(c) }
				: undefined;

			// Captured at upgrade and passed per message, its scope consulted
			// there. Rule 3 rejects a narrowed token at the upgrade's guards
			// above, so in practice the scope is always `full` on a live socket —
			// but the per-message gate runs regardless, so the invariant is
			// enforced rather than assumed.
			return create_ws_socket_events(endpoint, {
				client_ip,
				upgrade_preset,
				resolved,
				upgrade_context
			});
		})
	);

	// last, after everything that can throw, so a failed mount leaves no member
	options.connection_closer?.add(registry);
	return { registry };
};
