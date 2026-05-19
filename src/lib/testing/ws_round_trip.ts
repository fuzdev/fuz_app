/**
 * In-process test helpers for WebSocket JSON-RPC round-trips.
 *
 * Drives `register_action_ws` without an HTTP server. Consumers supply
 * specs + handlers; the harness constructs real `WSContext` instances
 * backed by test-owned `send`/`close` pairs, fakes the authenticated
 * Hono context (`request_context`, credential type, session id, api
 * token id), and exposes a `connect()` factory returning a `WsClient`
 * per connection.
 *
 * Three layers are exported:
 *
 *   - **Primitives** (`create_fake_ws`, `create_fake_hono_context`,
 *     `create_stub_upgrade`, `MinimalActionEnvironment`,
 *     `dispatch_ws_message`) — used by fuz_app's own dispatcher tests
 *     and by consumers wiring tight one-off tests.
 *   - **Harness** (`create_ws_test_harness`, `keeper_identity`) — the
 *     high-level driver. Give it specs + handlers, get back
 *     `{transport, connect()}`. `connect()` is async and resolves after
 *     `on_socket_open` completes, so broadcasts sent immediately after
 *     `await harness.connect()` reach the client. Returns a `WsClient`
 *     (shared interface — see `transports/ws_client.ts`); the same
 *     interface is implemented by `transports/ws_transport.ts` for
 *     cross-process tests.
 *   - **Broadcast wiring** — `build_broadcast_api` for wiring a typed
 *     broadcast API against the harness's transport. Wire-frame types
 *     + predicates (`is_notification`, `is_response_for`,
 *     `JsonrpcNotificationFrame`, ...) live in `transports/ws_client.ts`
 *     so both in-process and cross-process drivers reference one source.
 *
 * Hono's wire upgrade is skipped — the Node test runtime has no
 * `@hono/node-ws` adapter — but the full dispatch path is exercised
 * (per-action auth, input validation, `ctx.notify` back to the
 * originating socket, broadcast via `BackendWebsocketTransport`, and
 * close-on-revoke).
 *
 * @module
 */

import type {Context, Hono} from 'hono';
import {
	WSContext,
	createWSMessageEvent,
	type UpgradeWebSocket,
	type WSContextInit,
	type WSEvents,
} from 'hono/ws';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.js';

import type {ActionSpecUnion} from '../actions/action_spec.js';
import type {Action} from '../actions/action_types.js';
import {ActionPeer} from '../actions/action_peer.js';
import type {ActionEventEnvironment} from '../actions/action_event_types.js';
import {create_broadcast_api} from '../actions/broadcast_api.js';
import {register_action_ws, type RegisterActionWsOptions} from '../actions/register_action_ws.js';
import {create_stub_db} from './stubs.js';
import {BackendWebsocketTransport} from '../actions/transports_ws_backend.js';
import {REQUEST_CONTEXT_KEY, type RequestContext} from '../auth/request_context.js';
import {ROLE_KEEPER} from '../auth/role_schema.js';
import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TEST_CONTEXT_PRESET_KEY,
	type CredentialType,
} from '../hono_context.js';
import {create_jsonrpc_request} from '../http/jsonrpc_helpers.js';
import {create_test_account, create_test_actor, create_test_role_grant} from './entities.js';
import {
	WS_CLIENT_DEFAULT_TIMEOUT_MS,
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcSuccessResponseFrame,
	type WsClient,
} from './transports/ws_client.js';

// ---------------------------------------------------------------------
// Primitives — used by fuz_app's own tests + consumer one-off tests.
// ---------------------------------------------------------------------

/**
 * A `WSContext` paired with capture arrays. Use `sends` to assert on
 * outgoing frames; use `closes` to assert on revocation / close.
 */
export interface FakeWs {
	ws: WSContext;
	sends: Array<string>;
	closes: Array<{code?: number; reason?: string}>;
}

/**
 * Build a real `WSContext` backed by in-memory `send`/`close` capture.
 * Parsing of outgoing frames is left to the caller — `sends` holds the
 * raw strings as the dispatcher wrote them.
 */
export const create_fake_ws = (): FakeWs => {
	const sends: Array<string> = [];
	const closes: Array<{code?: number; reason?: string}> = [];
	const init: WSContextInit = {
		send: (data) => {
			sends.push(typeof data === 'string' ? data : '<binary>');
		},
		close: (code, reason) => {
			closes.push({code, reason});
		},
		readyState: 1,
	};
	return {ws: new WSContext(init), sends, closes};
};

/** Options for `create_fake_hono_context`. */
export interface FakeHonoContextOptions {
	credential_type: CredentialType;
	/** A single role to grant via `create_test_request_context`. */
	role?: string;
	auth_session_id?: string | null;
	api_token_id?: string | null;
	/**
	 * Override the `RequestContext` outright (for multi-role or custom
	 * account/actor fixtures). Takes precedence over `role`.
	 */
	request_context?: RequestContext;
}

/**
 * Build a fake Hono `Context` exposing the auth keys the dispatcher
 * reads via `c.get(...)`. Only `.get()` is populated — no other Hono
 * context surface is simulated.
 */
export const create_fake_hono_context = (opts: FakeHonoContextOptions): Context => {
	const request_context = opts.request_context ?? build_simple_request_context(opts.role);
	const vars: Record<string, unknown> = {
		[ACCOUNT_ID_KEY]: request_context.account.id,
		[REQUEST_CONTEXT_KEY]: request_context,
		[CREDENTIAL_TYPE_KEY]: opts.credential_type,
		auth_session_id: opts.auth_session_id ?? (opts.credential_type === 'session' ? 's1' : null),
		[AUTH_API_TOKEN_ID_KEY]: opts.api_token_id ?? null,
		[TEST_CONTEXT_PRESET_KEY]: true,
	};
	return {
		get: (key: string) => vars[key],
	} as unknown as Context;
};

/** The return of `create_stub_upgrade` — fake `upgradeWebSocket` + factory capture. */
export interface StubUpgrade {
	upgradeWebSocket: UpgradeWebSocket;
	get_create_events: () => (c: Context) => WSEvents | Promise<WSEvents>;
}

/**
 * Build a fake `upgradeWebSocket` that captures the `createEvents`
 * callback. The returned middleware is inert — tests drive
 * `createEvents` directly.
 */
export const create_stub_upgrade = (): StubUpgrade => {
	let captured: ((c: Context) => WSEvents | Promise<WSEvents>) | null = null;
	const upgradeWebSocket = ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => {
		captured = createEvents;
		return async (_c: Context, next: () => Promise<void>) => next();
	}) as unknown as UpgradeWebSocket;
	return {
		upgradeWebSocket,
		get_create_events: () => {
			if (!captured) throw new Error('upgradeWebSocket was not called');
			return captured;
		},
	};
};

/**
 * Minimal `ActionEventEnvironment` for tests that instantiate an
 * `ActionPeer` without pulling in the full runtime. Pre-loads a
 * spec map from the supplied list.
 */
export class MinimalActionEnvironment implements ActionEventEnvironment {
	executor: 'frontend' | 'backend' = 'backend';
	#specs: Map<string, ActionSpecUnion> = new Map();
	constructor(specs: ReadonlyArray<ActionSpecUnion>) {
		for (const spec of specs) this.#specs.set(spec.method, spec);
	}
	lookup_action_handler(): undefined {
		return undefined;
	}
	lookup_action_spec(method: string): ActionSpecUnion | undefined {
		return this.#specs.get(method);
	}
}

/**
 * Hono types `WSEvents.onMessage` as `() => void | Promise<void>`.
 * Awaits only the Promise branch so tests observe full dispatch
 * (auth, validation, handler, send).
 */
export const dispatch_ws_message = async (
	on_message: NonNullable<WSEvents['onMessage']>,
	event: MessageEvent,
	ws: WSContext,
): Promise<void> => {
	// eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
	const result: unknown = on_message(event, ws);
	if (result instanceof Promise) await result;
};

// ---------------------------------------------------------------------
// High-level harness — specs + handlers → connect() → WsClient.
// ---------------------------------------------------------------------

/** Auth identity for a mock connection. */
export interface WsConnectIdentity {
	/** Account id for the connection. Defaults to a fresh uuid per call. */
	account_id?: Uuid;
	/** Credential type. Defaults to `'session'`. Keeper actions require `'daemon_token'`. */
	credential_type?: CredentialType;
	/** Session id (any string). Defaults to a fresh uuid. Hashed by the dispatcher. */
	session_id?: string;
	/** Api token id; set for bearer connections, null otherwise. */
	api_token_id?: string | null;
	/** Roles to grant via active role_grants. Pass `[ROLE_KEEPER]` for keeper actions. */
	roles?: Array<string>;
}

/** Options for `create_ws_test_harness`. */
export interface CreateWsTestHarnessOptions {
	/**
	 * The actions registered on this endpoint — matches the shape
	 * `register_action_ws` accepts. Each entry is a `{spec, handler?}` tuple;
	 * shared fuz_app primitives (like `heartbeat_action`) can be spread in
	 * alongside consumer-specific actions.
	 */
	actions: ReadonlyArray<Action>;
	/** Pass a pre-created transport to share with a broadcast API. */
	transport?: BackendWebsocketTransport;
	/**
	 * Threaded through to `register_action_ws`. Defaults to `false` in tests —
	 * fake timers + receive-silence detection need explicit opt-in and per-
	 * test tuning to avoid spurious closes.
	 */
	heartbeat?: RegisterActionWsOptions['heartbeat'];
	/** Optional logger. Defaults to a silent `[ws-test]` logger. */
	log?: Logger;
	/** Threaded straight through to `register_action_ws`. */
	on_socket_open?: RegisterActionWsOptions['on_socket_open'];
	/** Threaded straight through to `register_action_ws`. */
	on_socket_close?: RegisterActionWsOptions['on_socket_close'];
}

/** A harness instance — transport handle + connection factory. */
export interface WsTestHarness {
	transport: BackendWebsocketTransport;
	/**
	 * Open a mock connection. Resolves after `on_socket_open` (and the
	 * transport's `register_ws`) completes, so broadcasts issued
	 * immediately after the `await` reach the connection. Earlier
	 * revisions returned synchronously and required a `settle_open()`
	 * microtask drain — no longer necessary.
	 *
	 * Returns the shared `WsClient` interface — same surface the
	 * cross-process driver in `transports/ws_transport.ts` implements,
	 * so assertion helpers and suite bodies work against either impl.
	 */
	connect: (identity?: WsConnectIdentity) => Promise<WsClient>;
}

/**
 * Build a `RequestContext` with a fresh UUID account/actor and role_grants
 * for the supplied roles. Used by the high-level harness so callers can
 * pass `roles: [ROLE_KEEPER, 'admin']`.
 */
const build_multi_role_request_context = (
	account_id: Uuid,
	roles: ReadonlyArray<string>,
): RequestContext => {
	const actor_id = create_uuid();
	const now = new Date().toISOString();
	return {
		account: {
			id: account_id,
			username: 'ws-test',
			email: null,
			email_verified: false,
			password_hash: '',
			created_at: now,
			created_by: null,
			updated_at: now,
			updated_by: null,
		},
		actor: {
			id: actor_id,
			account_id,
			name: 'ws-test',
			created_at: now,
			updated_at: null,
			updated_by: null,
		},
		role_grants: roles.map((role) => ({
			id: create_uuid(),
			actor_id,
			role,
			scope_kind: null,
			scope_id: null,
			created_at: now,
			expires_at: null,
			revoked_at: null,
			revoked_by: null,
			revoked_reason: null,
			granted_by: null,
			source_offer_id: null,
		})),
	};
};

/**
 * Stub `RequestContext` for single-role or public fakes. Hardcoded
 * ids (`acc_1` / `act_1`) mirror `create_test_request_context` in
 * `testing/auth_apps.ts`.
 */
const build_simple_request_context = (role?: string): RequestContext => ({
	account: create_test_account({id: 'acc_1', username: 'testuser'}),
	actor: create_test_actor({id: 'act_1', account_id: 'acc_1', name: 'testuser'}),
	role_grants: role ? [create_test_role_grant({id: 'perm_1', actor_id: 'act_1', role})] : [],
});

/**
 * Create a WebSocket test harness for the given specs + handlers.
 *
 * Registers against a throwaway Hono app with a fake
 * `upgradeWebSocket`; the captured events factory is invoked per
 * `connect()` with a synthesized Hono context carrying the requested
 * auth identity. Returned clients drive the real
 * `onOpen`/`onMessage`/`onClose` path against a real `WSContext`.
 */
export const create_ws_test_harness = (options: CreateWsTestHarnessOptions): WsTestHarness => {
	const {
		actions,
		transport = new BackendWebsocketTransport(),
		heartbeat = false,
		log = new Logger('[ws-test]', {level: 'off'}),
		on_socket_open,
		on_socket_close,
	} = options;

	const stub = create_stub_upgrade();

	// Minimal Hono stub — `register_action_ws` only needs `.get(path, handler)`.
	const stub_app = {get: () => stub_app} as unknown as Hono;

	// Stub DB — the harness pre-bakes `RequestContext` via the test-preset
	// escape hatch so `perform_action` skips the live authorization phase.
	// `db.transaction(fn)` synchronously calls `fn(stub_db)` so handlers
	// declaring `side_effects: true` execute under the same shape they
	// would in production.
	const stub_db = create_stub_db();

	register_action_ws({
		path: '/test/ws',
		app: stub_app,
		upgradeWebSocket: stub.upgradeWebSocket,
		actions,
		db: stub_db,
		transport,
		heartbeat,
		log,
		on_socket_open,
		on_socket_close,
	});

	const events_factory = stub.get_create_events();

	const connect = async (identity: WsConnectIdentity = {}): Promise<WsClient> => {
		const account_id = identity.account_id ?? create_uuid();
		const credential_type = identity.credential_type ?? 'session';
		const session_id = identity.session_id ?? create_uuid();
		const api_token_id = identity.api_token_id ?? null;
		const roles = identity.roles ?? [];

		const ctx_store = new Map<string, unknown>([
			[ACCOUNT_ID_KEY, account_id],
			[REQUEST_CONTEXT_KEY, build_multi_role_request_context(account_id, roles)],
			[CREDENTIAL_TYPE_KEY, credential_type],
			['auth_session_id', session_id],
			[AUTH_API_TOKEN_ID_KEY, api_token_id],
			[TEST_CONTEXT_PRESET_KEY, true],
		]);
		const fake_c = {
			get: (key: string) => ctx_store.get(key),
		} as unknown as Context;

		const received: Array<unknown> = [];
		const waiters: Array<{
			predicate: (msg: unknown) => boolean;
			resolve: (msg: unknown) => void;
		}> = [];
		let is_closed = false;

		// Captured in `ws.close` below; `client.close(...)` returns it so
		// tests can await async `on_socket_close` cleanup.
		let close_pending: Promise<void> | null = null;

		// Real WSContext backed by test-owned send/close. Parsing is done
		// on receive so tests can assert against structured messages.
		const ws = new WSContext({
			readyState: 1,
			send: (data) => {
				if (is_closed) return;
				const parsed: unknown = typeof data === 'string' ? JSON.parse(data) : data;
				received.push(parsed);
				for (let i = waiters.length - 1; i >= 0; i--) {
					const waiter = waiters[i]!;
					if (waiter.predicate(parsed)) {
						waiter.resolve(parsed);
						waiters.splice(i, 1);
					}
				}
			},
			close: (code, reason) => {
				if (is_closed) return;
				is_closed = true;
				const close_event = new Event('close') as CloseEvent;
				Object.defineProperties(close_event, {
					code: {value: code ?? 1000, writable: false},
					reason: {value: reason ?? '', writable: false},
					wasClean: {value: true, writable: false},
				});
				close_pending = (async () => {
					// onClose is typed as `void` by Hono but `register_action_ws`
					// returns a promise when `on_socket_close` does async cleanup.
					await (events.onClose?.(close_event, ws) as Promise<void> | void);
				})();
			},
		});

		// Resolve the (possibly async) events factory and fire onOpen
		// before returning the client. Awaiting the hook chain here
		// means the transport has registered the connection and any
		// `on_socket_open` bootstrap (sending an initial snapshot,
		// populating per-connection state) has completed by the time
		// the caller's `await harness.connect(...)` resolves.
		const factory_result = events_factory(fake_c);
		const events = await Promise.resolve(factory_result);
		// onOpen is typed as `void` by Hono but `register_action_ws`
		// returns a promise when `on_socket_open` does async bootstrap.
		await (events.onOpen?.(new Event('open'), ws) as Promise<void> | void);

		const wait_for_impl = <T>(
			predicate: (msg: unknown) => boolean,
			timeout_ms = WS_CLIENT_DEFAULT_TIMEOUT_MS,
		): Promise<T> => {
			for (const msg of received) {
				if (predicate(msg)) return Promise.resolve(msg as T);
			}
			return new Promise<T>((resolve, reject) => {
				const waiter = {
					predicate,
					resolve: (msg: unknown) => {
						clearTimeout(timer);
						resolve(msg as T);
					},
				};
				const timer = setTimeout(() => {
					// Drop the waiter on timeout — without this, a later `send`
					// would still iterate it and the `waiters` array would grow
					// across timed-out waits.
					const i = waiters.indexOf(waiter);
					if (i >= 0) waiters.splice(i, 1);
					reject(new Error(`wait_for timed out after ${timeout_ms}ms`));
				}, timeout_ms);
				waiters.push(waiter);
			});
		};

		const send_impl = async (message: unknown): Promise<void> => {
			if (is_closed) throw new Error('send after close');
			const message_event = createWSMessageEvent(JSON.stringify(message));
			// `onMessage` is typed as returning void by Hono, but
			// `register_action_ws` implements it as async — cast so
			// tests await the full dispatch (auth, validation,
			// handler, send).
			await (events.onMessage?.(message_event, ws) as Promise<void> | void);
		};

		return {
			get messages() {
				return received;
			},
			send: send_impl,
			async request<R = unknown>(
				id: number | string,
				method: string,
				params: unknown,
				timeout_ms?: number,
			): Promise<R> {
				await send_impl(create_jsonrpc_request(method, params as never, id));
				const msg = await wait_for_impl<JsonrpcSuccessResponseFrame<R> | JsonrpcErrorResponseFrame>(
					is_response_for(id),
					timeout_ms,
				);
				if ('error' in msg) {
					const detail =
						msg.error.data === undefined ? '' : ` data=${JSON.stringify(msg.error.data)}`;
					throw new Error(`rpc #${id} failed: [${msg.error.code}] ${msg.error.message}${detail}`);
				}
				return msg.result;
			},
			async close(code, reason) {
				if (!is_closed) ws.close(code, reason);
				if (close_pending) await close_pending;
			},
			wait_for: wait_for_impl,
		};
	};

	return {transport, connect};
};

/** Convenience: default identity for keeper-authenticated connections. */
export const keeper_identity = (): WsConnectIdentity => ({
	credential_type: 'daemon_token',
	roles: [ROLE_KEEPER],
});

// ---------------------------------------------------------------------
// Broadcast wiring — for tests that assert on server-initiated
// notification fan-out. `build_broadcast_api` mirrors how consumer
// `backend_actions_api.ts` composes the real stack (peer + transport
// registered + `create_broadcast_api`); the helper exists so each test
// doesn't re-spell that boilerplate.
// ---------------------------------------------------------------------

const make_peer = (): ActionPeer => new ActionPeer({environment: new MinimalActionEnvironment([])});

/**
 * Wire a typed broadcast API against the harness's transport, matching
 * how a consumer's real backend composes the stack. Returns the typed
 * API so tests can call `.zap_run_created(...)` / `.workspace_changed(...)`
 * etc. directly.
 *
 * ```ts
 * const harness = create_ws_test_harness({actions});
 * const broadcast = build_broadcast_api<MyBackendActionsApi>({
 *   harness,
 *   specs: my_broadcast_action_specs,
 * });
 * const client = await harness.connect(keeper_identity());
 * await broadcast.zap_run_created({run_id: '...', ...});
 * await client.wait_for(is_notification('zap_run_created'));
 * ```
 */
export const build_broadcast_api = <TApi extends object>(options: {
	harness: WsTestHarness;
	specs: ReadonlyArray<ActionSpecUnion>;
}): TApi => {
	const peer = make_peer();
	peer.transports.register_transport(options.harness.transport);
	return create_broadcast_api<TApi>({peer, specs: options.specs});
};
