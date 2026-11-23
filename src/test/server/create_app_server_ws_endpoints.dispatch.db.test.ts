/**
 * `create_app_server.ws_endpoints` dispatch through the assembled app.
 *
 * Every upgrade here is an `app.request('/api/ws', …)` carrying a real
 * credential, so it runs the app's whole middleware chain — proxy (client
 * IP from `X-Forwarded-For`), origin, session or bearer, the endpoint's
 * upgrade stack — before `create_stub_upgrade` records the real `Context`
 * and the socket's events are built from it. Covers:
 *
 * - the per-action rate limit on WS: an account-keyed action, the IP-keyed
 *   `peer/ping` (malformed params charge the bucket), per-IP buckets, and
 *   the account bucket across a session and a bearer socket
 * - one budget across transports: RPC and WS calls charge the same bucket
 * - omitted limiter options still throttle WS — the defaults are threaded
 * - the upgrade route answers ahead of `post_route_middleware` and
 *   `static_serving`
 * - `AppServer.close` ends a socket opened through the upgrade path; an
 *   upgrade request after it is refused 503, one opened after it is born
 *   closed (going-away, no re-read), and one whose re-read the shutdown lands
 *   in is closed going-away, never as revoked — its re-read held on the
 *   tracker, so the database closes after it, or given up on at the drain
 *   bound
 * - a WS reply arrives before its audit write lands, and
 *   `_testing_drain_effects` over a tracked emitter waits for it
 * - `AppServer.close` waits for a WS message's effects still flushing after
 *   its reply — an eager promise and a post-commit thunk, neither an audit write
 * - `_testing_drain_effects` waits for a WS message's post-commit effect still
 *   running after its reply
 * - `AppServer.close` waits for a handler still running when it starts — a WS
 *   message's and an HTTP RPC call's — and then for its flush; a request
 *   arriving after the close started is refused 503
 * - `_testing_drain_effects` over HTTP, with the response awaiting its
 *   effects, never waits on itself, two at once included
 * - an action's notification, sent over HTTP RPC or WS through the handler
 *   context's sender, reaches the account's sockets on every mounted
 *   registry — once per socket, a registry two endpoints share included
 *
 * Every server is closed after its test — that disposes the limiters it
 * built. The database is the shared instance the default factory hands out,
 * which outlives the file, so the backend's `close` leaves it open.
 *
 * Mount-time behavior (guards, surface, audit wiring) is in
 * `create_app_server_ws_endpoints.db.test.ts`.
 *
 * @module
 */

import { afterEach, describe, test, assert, vi } from 'vitest';
import { literal, object, void as fuz_void } from '@fuzdev/fuz_schema/schema.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_health_route_spec } from '#lib/http/common_routes.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions
} from '#lib/server/app_server.ts';
import type { AppServerContext } from '#lib/server/app_server_context.ts';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';
import type { Db } from '#lib/db/db.ts';
import { create_gated_db, is_session_read, type GatedDb } from '../gated_db.ts';
import { create_audit_emitter, type AuditEmitter } from '#lib/auth/audit_emitter.ts';
import {
	default_audit_factory,
	type AppBackend,
	type AuditFactory
} from '#lib/server/app_backend.ts';
import { create_testing_drain_effects_action } from '#lib/testing/cross_backend/testing_reset_actions.ts';
import {
	create_test_account_with_credentials,
	create_loopback_app_server_options,
	stub_password_deps
} from '#lib/testing/app_server.ts';
import { TEST_ORIGIN } from '#lib/testing/test_origin.ts';
import { create_default_db_factory } from '#lib/testing/db.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import {
	create_fake_ws,
	create_stub_upgrade,
	dispatch_ws_message,
	type StubUpgrade
} from '#lib/testing/ws_round_trip.ts';
import { protocol_actions } from '#lib/actions/protocol.ts';
import { PEER_PING_METHOD } from '#lib/actions/peer_ping.ts';
import type { RpcAction } from '#lib/actions/action_types.ts';
import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import type { MiddlewareSpec } from '#lib/http/middleware_spec.ts';
import {
	emit_after_commit,
	type EffectErrorContext,
	create_request_tracker
} from '#lib/http/pending_effects.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { create_rate_limiter, type RateLimiter } from '#lib/rate_limiter.ts';
import { create_realtime_closer } from '#lib/actions/connection_closer.ts';
import { create_realtime_notification_sender } from '#lib/actions/notification_sender.ts';
import { ConnectionRegistry } from '#lib/actions/connection_registry.ts';
import { create_jsonrpc_notification } from '#lib/http/jsonrpc_helpers.ts';
import { Uuid as UuidSchema, type Uuid } from '#lib/primitive_schemas.ts';
import { WS_CLOSE_GOING_AWAY, WS_CLOSE_GOING_AWAY_REASON } from '#lib/actions/transports.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';

const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_test_keyring(TEST_KEY);
const session_cookie_name = 'test_session';
const log = new Logger('test', { level: 'off' });

const WS_PATH = '/api/ws';
const GOING_AWAY_CLOSE = { code: WS_CLOSE_GOING_AWAY, reason: WS_CLOSE_GOING_AWAY_REASON };
const RPC_PATH = '/api/rpc';
const ORIGIN = TEST_ORIGIN;

const factory = create_default_db_factory(async () => {});

/** An account-keyed action — the shape `rate_limit: 'account'` requires. */
const counted_action_spec = {
	method: 'counted',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: fuz_void,
	output: object({ ok: literal(true) }),
	async: true,
	rate_limit: 'account',
	description: 'account-throttled no-op'
} satisfies RequestResponseActionSpec;

const counted_action: RpcAction = {
	spec: counted_action_spec,
	handler: () => ({ ok: true })
};

/** A tiny budget — the call past it is refused. */
const create_tiny_limiter = (): RateLimiter =>
	create_rate_limiter({ max_attempts: 2, window_ms: 60_000, cleanup_interval_ms: 0 });

interface TestServer {
	server: AppServer;
	stub: StubUpgrade;
	/** The backend's pool. */
	db: Db;
	/** The backend's emitter (`deps.audit`). */
	audit: AuditEmitter;
	/** The backend's capabilities. */
	deps: AppBackend['deps'];
	/** The backend the server was assembled on — its `close` is replaceable. */
	backend: AppBackend;
	/** Session cookie header for a fresh account. */
	create_account: (username: string) => Promise<{
		account_id: string;
		session_headers: Record<string, string>;
		bearer_headers: Record<string, string>;
	}>;
}

/**
 * Assemble a server over a fresh database, with the WS endpoint at `/api/ws`.
 * `wrap_db` replaces the backend's pool — a `create_gated_db` wrapper, say —
 * and `server_log` the backend's logger.
 */
const create_test_server = async (
	options: Partial<Omit<AppServerOptions, 'backend' | 'upgrade_websocket'>> = {},
	audit_factory: AuditFactory = default_audit_factory,
	wrap_db: (db: Db) => Db = (db) => db,
	server_log: Logger = log
): Promise<TestServer> => {
	const db = wrap_db(await factory.create());
	const migration_results = await run_migrations(db, [AUTH_MIGRATION_NS]);
	const audit = audit_factory({ db, log });
	const backend: AppBackend = {
		db_type: 'pglet-memory',
		db_name: '(memory)',
		migration_results,
		close: async () => {},
		deps: {
			log: server_log,
			keyring,
			password: stub_password_deps,
			db,
			audit,
			connection_closer: create_realtime_closer(),
			notification_sender: create_realtime_notification_sender(),
			request_tracker: create_request_tracker()
		}
	};
	const stub = create_stub_upgrade();
	const server = await create_app_server({
		// the loopback proxy is trusted, so `X-Forwarded-For` sets the client IP
		...create_loopback_app_server_options(),
		backend,
		session_cookie_name,
		auth_cleanup: 'off',
		create_route_specs: () => [create_health_route_spec()],
		upgrade_websocket: stub.upgradeWebSocket,
		ws_endpoints: [
			{ path: WS_PATH, actions: [...protocol_actions, counted_action], receive_timeout: null }
		],
		...options
	});
	servers.push(server);
	const create_account: TestServer['create_account'] = async (username) => {
		const { account, session_cookie, api_token } = await create_test_account_with_credentials({
			db,
			keyring,
			password: stub_password_deps,
			username
		});
		return {
			account_id: account.id,
			session_headers: {
				origin: ORIGIN,
				cookie: `${session_cookie_name}=${session_cookie}`
			},
			// bearer is refused beside an Origin header
			bearer_headers: { authorization: `Bearer ${api_token}` }
		};
	};
	return { server, stub, db, audit, deps: backend.deps, backend, create_account };
};

const servers: Array<AppServer> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface TestSocket {
	/** Send one JSON-RPC request and return its response frame. */
	request: (method: string, params?: unknown) => Promise<any>;
	/**
	 * Send one JSON-RPC request and return its response frame as soon as it is
	 * sent — before the message's effects flush. `dispatched` settles when the
	 * dispatch, flush included, is done.
	 */
	request_reply: (
		method: string,
		params?: unknown
	) => Promise<{ frame: any; dispatched: Promise<void> }>;
	/**
	 * Send one JSON-RPC request without waiting for its reply. Settles when
	 * the dispatch, flush included, is done.
	 */
	send: (method: string, params?: unknown) => Promise<void>;
	/** The close frames the server sent the socket. */
	closes: Array<{ code?: number; reason?: string }>;
	/** The methods of the notifications the server sent the socket, in order. */
	notifications: () => Array<string>;
}

let next_request_id = 0;

/**
 * Upgrade through the assembled app and open the socket on the `Context`
 * the middleware chain built — admission included.
 */
const open_socket = async (
	{ server, stub }: TestServer,
	headers: Record<string, string>,
	path = WS_PATH
): Promise<TestSocket> => {
	const upgrades_before = stub.upgrades.length;
	const res = await server.app.request(path, {
		headers: { host: 'localhost', upgrade: 'websocket', ...headers }
	});
	assert.strictEqual(res.status, 200, `upgrade refused: ${await res.text()}`);
	assert.strictEqual(stub.upgrades.length, upgrades_before + 1);
	const { c, create_events } = stub.upgrades.at(-1)!;
	const events = await create_events(c);
	const fake = create_fake_ws();
	// typed `void` by Hono; `register_action_ws` returns the admission promise
	await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);
	assert.deepStrictEqual(fake.closes, [], 'socket closed at admission');
	return {
		closes: fake.closes,
		notifications: () =>
			fake.sends
				.map((s) => JSON.parse(s))
				.filter((f) => typeof f.method === 'string')
				.map((f) => f.method),
		request: async (method, params) => {
			const id = ++next_request_id;
			await dispatch_ws_message(
				events.onMessage!,
				new MessageEvent('message', {
					data: JSON.stringify({ jsonrpc: '2.0', id, method, params })
				}),
				fake.ws
			);
			const frame = fake.sends.map((s) => JSON.parse(s)).find((f) => f.id === id);
			assert.ok(frame, `no response to request ${id}`);
			return frame;
		},
		send: (method, params) =>
			dispatch_ws_message(
				events.onMessage!,
				new MessageEvent('message', {
					data: JSON.stringify({ jsonrpc: '2.0', id: ++next_request_id, method, params })
				}),
				fake.ws
			),
		request_reply: async (method, params) => {
			const id = ++next_request_id;
			const dispatched = dispatch_ws_message(
				events.onMessage!,
				new MessageEvent('message', {
					data: JSON.stringify({ jsonrpc: '2.0', id, method, params })
				}),
				fake.ws
			);
			const find_frame = () => fake.sends.map((s) => JSON.parse(s)).find((f) => f.id === id);
			// the reply is sent ahead of the flush, so it lands while `dispatched` is pending
			const deadline = Date.now() + 2000;
			while (!find_frame()) {
				assert.ok(Date.now() < deadline, `no response to request ${id}`);
				await wait();
			}
			return { frame: find_frame(), dispatched };
		}
	};
};

const rpc_call = async (server: AppServer, headers: Record<string, string>): Promise<Response> =>
	server.app.request(RPC_PATH, {
		method: 'POST',
		headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: counted_action_spec.method })
	});

const assert_ok = (frame: any): void => {
	assert.deepStrictEqual(frame.result, { ok: true }, JSON.stringify(frame));
};

const assert_error_code = (frame: any, code: number): void => {
	assert.strictEqual(frame.error?.code, code, JSON.stringify(frame));
};

describe('create_app_server.ws_endpoints dispatch through the assembled app', () => {
	test('rate_limit account: the call past the budget is refused, on every socket of the account', async () => {
		const action_account_rate_limiter = create_tiny_limiter();
		const t = await create_test_server({ action_account_rate_limiter });
		const alice = await t.create_account('alice');
		const bob = await t.create_account('bob_ws');

		const socket = await open_socket(t, alice.session_headers);
		assert_ok(await socket.request(counted_action_spec.method));
		assert_ok(await socket.request(counted_action_spec.method));
		assert_error_code(
			await socket.request(counted_action_spec.method),
			JSONRPC_ERROR_CODES.rate_limited
		);
		// keyed on the account, not the socket or credential
		const bearer_socket = await open_socket(t, alice.bearer_headers);
		assert_error_code(
			await bearer_socket.request(counted_action_spec.method),
			JSONRPC_ERROR_CODES.rate_limited
		);
		// another account has its own budget
		const bob_socket = await open_socket(t, bob.session_headers);
		assert_ok(await bob_socket.request(counted_action_spec.method));
		action_account_rate_limiter.dispose();
	});

	test('peer/ping with malformed params charges the IP bucket, keyed per X-Forwarded-For', async () => {
		const action_ip_rate_limiter = create_tiny_limiter();
		const t = await create_test_server({ action_ip_rate_limiter });
		const alice = await t.create_account('alice');

		const bad_params = { nonce: 'not a number' };
		const socket = await open_socket(t, {
			...alice.session_headers,
			'x-forwarded-for': '203.0.113.1'
		});
		// the throttle runs ahead of validation, so a 400 still costs budget
		assert_error_code(
			await socket.request(PEER_PING_METHOD, bad_params),
			JSONRPC_ERROR_CODES.invalid_params
		);
		assert_error_code(
			await socket.request(PEER_PING_METHOD, bad_params),
			JSONRPC_ERROR_CODES.invalid_params
		);
		assert_error_code(
			await socket.request(PEER_PING_METHOD, bad_params),
			JSONRPC_ERROR_CODES.rate_limited
		);
		// the same account from another client IP has its own bucket
		const other_ip = await open_socket(t, {
			...alice.session_headers,
			'x-forwarded-for': '203.0.113.2'
		});
		assert_error_code(
			await other_ip.request(PEER_PING_METHOD, bad_params),
			JSONRPC_ERROR_CODES.invalid_params
		);
		action_ip_rate_limiter.dispose();
	});

	test('an RPC call and WS calls charge one bucket', async () => {
		const action_account_rate_limiter = create_tiny_limiter();
		const t = await create_test_server({
			action_account_rate_limiter,
			rpc_endpoints: [{ path: RPC_PATH, actions: [counted_action] }]
		});
		const alice = await t.create_account('alice');

		const first = await rpc_call(t.server, alice.session_headers);
		assert.strictEqual(first.status, 200);
		assert_ok(await first.json());
		const socket = await open_socket(t, alice.session_headers);
		assert_ok(await socket.request(counted_action_spec.method));
		assert_error_code(
			await socket.request(counted_action_spec.method),
			JSONRPC_ERROR_CODES.rate_limited
		);
		const refused = await rpc_call(t.server, alice.session_headers);
		assert.strictEqual(refused.status, 429);
		assert_error_code(await refused.json(), JSONRPC_ERROR_CODES.rate_limited);
		action_account_rate_limiter.dispose();
	});

	test('omitted limiter options still throttle WS: the default limiters are threaded', async () => {
		// the default budgets are too large to spend through the socket, so the
		// test fills the default the server built — reached through the
		// `ws_endpoints` factory's context — and the next WS call is refused
		let ctx: AppServerContext | null = null;
		const t = await create_test_server({
			ws_endpoints: (context) => {
				ctx = context;
				return [
					{ path: WS_PATH, actions: [...protocol_actions, counted_action], receive_timeout: null }
				];
			}
		});
		const alice = await t.create_account('alice');
		const { action_account_rate_limiter, action_ip_rate_limiter } = ctx!;
		assert.ok(action_account_rate_limiter);
		assert.ok(action_ip_rate_limiter);

		const socket = await open_socket(t, {
			...alice.session_headers,
			'x-forwarded-for': '203.0.113.9'
		});
		assert_ok(await socket.request(counted_action_spec.method));
		for (let i = 1; i < action_account_rate_limiter.options.max_attempts; i++) {
			action_account_rate_limiter.record(alice.account_id);
		}
		assert_error_code(
			await socket.request(counted_action_spec.method),
			JSONRPC_ERROR_CODES.rate_limited
		);

		// and the IP default, through `peer/ping`
		for (let i = 0; i < action_ip_rate_limiter.options.max_attempts; i++) {
			action_ip_rate_limiter.record('203.0.113.9');
		}
		assert_error_code(
			await socket.request(PEER_PING_METHOD, { nonce: 'x' }),
			JSONRPC_ERROR_CODES.rate_limited
		);
		// the defaults are the server's, disposed by its `close` after the test
	});

	test('the upgrade answers ahead of post_route_middleware and static_serving', async () => {
		const hits: Array<string> = [];
		const post_route_middleware: Array<MiddlewareSpec> = [
			{
				name: 'post_probe',
				path: '*',
				handler: async (_c, next) => {
					hits.push('post_route');
					await next();
				}
			}
		];
		const t = await create_test_server({
			post_route_middleware,
			// answers every path it sees
			static_serving: {
				serve_static: () => async (c) => {
					hits.push('static');
					return c.text('static', 200);
				}
			}
		});
		const alice = await t.create_account('alice');

		const socket = await open_socket(t, alice.session_headers);
		assert_ok(await socket.request(counted_action_spec.method));
		assert.deepStrictEqual(hits, []);

		// control: a plain GET passes the stub and reaches both
		const plain = await t.server.app.request(WS_PATH, {
			headers: { host: 'localhost', ...alice.session_headers }
		});
		assert.strictEqual(await plain.text(), 'static');
		assert.deepStrictEqual(hits, ['post_route', 'static']);
	});

	test('the upgrade runs the auth middleware: no credential is 401, a foreign origin 403', async () => {
		const t = await create_test_server();
		const alice = await t.create_account('alice');
		const upgrade = async (headers: Record<string, string>): Promise<Response> =>
			t.server.app.request(WS_PATH, {
				headers: { host: 'localhost', upgrade: 'websocket', ...headers }
			});
		assert.strictEqual((await upgrade({ origin: ORIGIN })).status, 401);
		assert.strictEqual(
			(await upgrade({ ...alice.session_headers, origin: 'http://evil.example' })).status,
			403
		);
		assert.strictEqual(t.stub.upgrades.length, 0);
	});

	test('an invalid session cookie is cleared on a refused upgrade, never on an accepted one', async () => {
		const t = await create_test_server();
		const alice = await t.create_account('alice');
		const clear = 'test_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
		const stale = { cookie: `${session_cookie_name}=stale.invalidsignature` };
		const upgrade = async (headers: Record<string, string>): Promise<Response> =>
			t.server.app.request(WS_PATH, {
				headers: { host: 'localhost', upgrade: 'websocket', ...headers }
			});

		const refused = await upgrade(stale);
		assert.strictEqual(refused.status, 401);
		assert.deepStrictEqual(refused.headers.getSetCookie(), [clear]);

		// the bearer authenticates beside the dead cookie; the adapter's
		// placeholder response carries no clear for it to copy onto its `101`
		const accepted = await upgrade({ ...alice.bearer_headers, ...stale });
		assert.strictEqual(accepted.status, 200);
		assert.strictEqual(t.stub.upgrades.length, 1);
		assert.deepStrictEqual(accepted.headers.getSetCookie(), []);

		// the same request without the upgrade falls through to a response like any other
		const plain = await t.server.app.request(WS_PATH, {
			headers: { host: 'localhost', ...alice.bearer_headers, ...stale }
		});
		assert.strictEqual(plain.status, 404);
		assert.deepStrictEqual(plain.headers.getSetCookie(), [clear]);
	});

	test('close ends a socket opened through the upgrade path, and only once', async () => {
		const t = await create_test_server();
		const alice = await t.create_account('alice');
		const socket = await open_socket(t, alice.session_headers);
		assert_ok(await socket.request(counted_action_spec.method));

		await t.server.close();
		assert.deepStrictEqual(
			socket.closes.map((c) => c.code),
			[WS_CLOSE_GOING_AWAY]
		);
		assert.strictEqual(t.server.ws_endpoints[WS_PATH]!.connection_count(), 0);
		// the afterEach close is a no-op on a closed server
		await t.server.close();
		assert.strictEqual(socket.closes.length, 1);
	});

	test('an upgrade opened after close is born closed: going-away, never admitted, no re-read', async () => {
		const t = await create_test_server();
		const alice = await t.create_account('alice');
		// upgraded before the close — a request after it starts is refused 503 —
		// and opened after
		const res = await t.server.app.request(WS_PATH, {
			headers: { host: 'localhost', upgrade: 'websocket', ...alice.session_headers }
		});
		assert.strictEqual(res.status, 200);
		await t.server.close();
		const late = await t.server.app.request(WS_PATH, {
			headers: { host: 'localhost', upgrade: 'websocket', ...alice.session_headers }
		});
		assert.strictEqual(late.status, 503, 'an upgrade after the close is refused');
		const { c, create_events } = t.stub.upgrades.at(-1)!;
		const events = await create_events(c);
		const fake = create_fake_ws();
		const query = vi.spyOn(t.db, 'query');
		await (events.onOpen?.(new Event('open'), fake.ws) as Promise<void> | void);

		assert.deepStrictEqual(fake.closes, [GOING_AWAY_CLOSE]);
		assert.strictEqual(
			query.mock.calls.length,
			0,
			'no credential re-read for a born-closed upgrade'
		);
		const transport = t.server.ws_endpoints[WS_PATH]!;
		assert.strictEqual(transport.connection_count(), 0);
		assert.strictEqual(transport.pending_connection_count(), 0);
	});

	test('a shutdown waits for the admission re-read it lands in, then closes the database', async () => {
		let gated: GatedDb | undefined;
		const t = await create_test_server(
			{},
			default_audit_factory,
			(db) => (gated = create_gated_db(db)).db
		);
		const order: Array<string> = [];
		t.backend.close = async () => {
			order.push('db closed');
		};
		const alice = await t.create_account('alice');
		const res = await t.server.app.request(WS_PATH, {
			headers: { host: 'localhost', upgrade: 'websocket', ...alice.session_headers }
		});
		assert.strictEqual(res.status, 200);
		const { c, create_events } = t.stub.upgrades.at(-1)!;
		const events = await create_events(c);
		const fake = create_fake_ws();
		// the auth middleware's session read is behind us; the next is the re-read
		const stalled = gated!.stall(is_session_read);
		try {
			// typed `void` by Hono; `register_action_ws` returns the admission promise
			const opened = (events.onOpen?.(new Event('open'), fake.ws) as unknown as Promise<void>).then(
				() => {
					order.push('admission done');
				}
			);
			await stalled.reached;
			const transport = t.server.ws_endpoints[WS_PATH]!;
			assert.strictEqual(transport.pending_connection_count(), 1);
			assert.strictEqual(t.deps.request_tracker.inflight_count(), 1, 'the re-read is held');

			const closing = t.server.close();
			await wait();
			assert.deepStrictEqual(fake.closes, [GOING_AWAY_CLOSE], 'the close-all closed it pending');
			assert.deepStrictEqual(order, [], 'the database stays open under the held re-read');

			stalled.release();
			await closing;
			await opened;

			assert.deepStrictEqual(order, ['admission done', 'db closed']);
			assert.deepStrictEqual(
				fake.closes,
				[GOING_AWAY_CLOSE],
				'the refusal after the re-read sent no 1011 or 4001'
			);
			assert.strictEqual(transport.connection_count(), 0);
			assert.strictEqual(transport.pending_connection_count(), 0);
			assert.strictEqual(t.deps.request_tracker.inflight_count(), 0);
		} finally {
			stalled.release();
		}
	});

	test('a shutdown gives up on an admission re-read at its bound, and the late failure sends nothing', async () => {
		let gated: GatedDb | undefined;
		const errors: Array<string> = [];
		const recording_log = new Logger('test', {
			level: 'error',
			console: {
				error: (...args: Array<unknown>) => {
					errors.push(args.map(String).join(' '));
				},
				warn: () => {},
				log: () => {}
			}
		});
		const t = await create_test_server(
			{ shutdown_drain_timeout_ms: 20 },
			default_audit_factory,
			(db) => (gated = create_gated_db(db)).db,
			recording_log
		);
		const alice = await t.create_account('alice');
		const res = await t.server.app.request(WS_PATH, {
			headers: { host: 'localhost', upgrade: 'websocket', ...alice.session_headers }
		});
		assert.strictEqual(res.status, 200);
		const { c, create_events } = t.stub.upgrades.at(-1)!;
		const events = await create_events(c);
		const fake = create_fake_ws();
		const stalled = gated!.stall(is_session_read);
		try {
			const opened = events.onOpen?.(new Event('open'), fake.ws) as unknown as Promise<void>;
			await stalled.reached;

			await t.server.close();
			assert.deepStrictEqual(fake.closes, [GOING_AWAY_CLOSE]);
			assert.ok(
				errors.some((e) => e.includes('shutdown gave up') && e.includes('1 request(s)')),
				`the give-up is logged: ${JSON.stringify(errors)}`
			);

			// the database closed under the re-read after the bound
			stalled.fail(new Error('database closed'));
			await opened;
			assert.deepStrictEqual(fake.closes, [GOING_AWAY_CLOSE], 'no further frame');
			assert.deepStrictEqual(fake.sends, []);
			assert.strictEqual(t.deps.request_tracker.inflight_count(), 0);
		} finally {
			stalled.release();
		}
	});

	test('a WS reply precedes its audit write; the drain over a tracked emitter waits for it', async () => {
		// Hold the audit INSERT (the shared stall seam), so the write is
		// certainly in flight when the reply arrives. The pool's other queries
		// pass straight through.
		let gated: GatedDb | undefined;
		const t = await create_test_server(
			{
				ws_endpoints: (ctx) => [
					{
						path: WS_PATH,
						actions: [...protocol_actions, create_audited_action(ctx.deps.audit)],
						receive_timeout: null
					}
				]
			},
			({ db, log }) => {
				gated = create_gated_db(db);
				return create_audit_emitter({ db: gated.db, log });
			}
		);
		const stalled = gated!.stall((sql) => sql.includes('INSERT INTO audit_log'));
		const count_rows = async (): Promise<number> =>
			(await t.db.query('SELECT id FROM audit_log WHERE event_type = $1', ['logout'])).length;
		try {
			const alice = await t.create_account('alice_drain');
			const socket = await open_socket(t, alice.session_headers);

			const { frame, dispatched } = await socket.request_reply(audited_action_spec.method);
			assert_ok(frame);
			await stalled.reached;
			assert.strictEqual(await count_rows(), 0, 'the reply came before the audit row landed');

			const drain = create_testing_drain_effects_action(t.deps);
			let drained = false;
			const draining = Promise.resolve(drain.handler(undefined, null as never)).then(() => {
				drained = true;
			});
			await wait();
			assert.ok(!drained, 'the drain resolved with the audit write in flight');

			stalled.release();
			await draining;
			assert.strictEqual(await count_rows(), 1, 'the drained audit row is visible');
			await dispatched;
		} finally {
			// a failed assertion must not leave the dispatch held on the stall
			stalled.release();
		}
	});

	test('a rejected WS pending effect reaches the server on_effect_error', async () => {
		const errors: Array<{ error: unknown; context: EffectErrorContext }> = [];
		const failing_action: RpcAction = {
			spec: {
				method: 'failing_effect',
				kind: 'request_response',
				initiator: 'frontend',
				auth: { account: 'required', actor: 'none' },
				side_effects: false,
				input: fuz_void,
				output: object({ ok: literal(true) }),
				async: true,
				description: 'queues a rejecting pending effect'
			},
			handler: (_input, ctx) => {
				ctx.pending_effects.push(Promise.reject(new Error('effect failed')));
				return { ok: true };
			}
		};
		const t = await create_test_server({
			ws_endpoints: [
				{ path: WS_PATH, actions: [...protocol_actions, failing_action], receive_timeout: null }
			],
			on_effect_error: (error, context) => {
				errors.push({ error, context });
			}
		});
		const alice = await t.create_account('alice_effect');
		const socket = await open_socket(t, alice.session_headers);
		assert_ok(await socket.request('failing_effect'));
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0]!.error instanceof Error);
		assert.deepStrictEqual(errors[0]!.context, {
			transport: 'ws',
			method: 'failing_effect',
			path: WS_PATH
		});
	});

	test("close waits for a WS message's effects still in flight after its reply", async () => {
		// Neither effect is an audit write, so only the server's own flush
		// tracking can hold close for them: an eager promise the handler
		// queued, and an async post-commit thunk.
		const eager_gate = create_deferred<void>();
		const deferred_gate = create_deferred<void>();
		const landed: Array<string> = [];
		const slow_effects_action: RpcAction = {
			spec: {
				method: 'slow_effects',
				kind: 'request_response',
				initiator: 'frontend',
				auth: { account: 'required', actor: 'none' },
				side_effects: true,
				input: fuz_void,
				output: object({ ok: literal(true) }),
				async: true,
				description: 'queues an eager and a deferred effect, each held by the test'
			},
			handler: (_input, ctx) => {
				ctx.pending_effects.push(eager_gate.promise.then(() => void landed.push('eager')));
				emit_after_commit(ctx, async () => {
					await deferred_gate.promise;
					landed.push('deferred');
				});
				return { ok: true };
			}
		};
		const t = await create_test_server({
			ws_endpoints: [
				{
					path: WS_PATH,
					actions: [...protocol_actions, slow_effects_action],
					receive_timeout: null
				}
			]
		});
		try {
			const alice = await t.create_account('alice_close_ws');
			const socket = await open_socket(t, alice.session_headers);
			const { frame, dispatched } = await socket.request_reply('slow_effects');
			assert_ok(frame);

			let closed = false;
			const closing = t.server.close().then(() => {
				closed = true;
			});
			await wait(20);
			assert.ok(!closed, 'close returned with a WS message flush still running');

			eager_gate.resolve();
			await wait(20);
			assert.ok(!closed, 'close returned with a post-commit thunk still running');

			deferred_gate.resolve();
			await closing;
			assert.sameMembers(landed, ['eager', 'deferred'], 'both effects landed before close');
			await dispatched;
		} finally {
			// a failed assertion must not leave the flush held until the drain's bound
			eager_gate.resolve();
			deferred_gate.resolve();
		}
	});

	test("_testing_drain_effects waits for a WS message's post-commit effect still running after its reply", async () => {
		// Not an audit write: only the request tracker can hold the drain for it.
		const effect_gate = create_deferred<void>();
		const landed: Array<string> = [];
		const t = await create_test_server({
			ws_endpoints: [
				{
					path: WS_PATH,
					actions: [...protocol_actions, create_gated_effects_action(null, effect_gate, landed)],
					receive_timeout: null
				}
			]
		});
		try {
			const alice = await t.create_account('alice_drain_post_commit');
			const socket = await open_socket(t, alice.session_headers);
			const { frame, dispatched } = await socket.request_reply(GATED_EFFECTS_METHOD);
			assert_ok(frame);

			const drain = create_testing_drain_effects_action(t.deps);
			let drained = false;
			const draining = Promise.resolve(drain.handler(undefined, null as never)).then(() => {
				drained = true;
			});
			await wait(20);
			assert.ok(!drained, 'the drain resolved with a post-commit effect still running');

			effect_gate.resolve();
			await draining;
			assert.deepStrictEqual(landed, ['effect'], 'the effect landed before the drain answered');
			await dispatched;
		} finally {
			effect_gate.resolve();
		}
	});

	test('close waits for a WS handler still running when it starts, then for its flush', async () => {
		const handler_gate = create_deferred<void>();
		const effect_gate = create_deferred<void>();
		const landed: Array<string> = [];
		const t = await create_test_server({
			ws_endpoints: [
				{
					path: WS_PATH,
					actions: [
						...protocol_actions,
						create_gated_effects_action(handler_gate, effect_gate, landed)
					],
					receive_timeout: null
				}
			]
		});
		try {
			const alice = await t.create_account('alice_close_handler_ws');
			const socket = await open_socket(t, alice.session_headers);
			const dispatched = socket.send(GATED_EFFECTS_METHOD);
			await wait_for(() => landed.includes('handler entered'));

			const closing = track_settled(t.server.close());
			await wait(20);
			assert.ok(!closing.settled(), 'close returned with a WS handler still running');
			assert.deepStrictEqual(socket.closes, [GOING_AWAY_CLOSE], 'the socket closed meanwhile');

			handler_gate.resolve();
			await wait(20);
			assert.ok(!closing.settled(), "close returned with the handler's flush still running");

			effect_gate.resolve();
			await closing.promise;
			assert.deepStrictEqual(landed, ['handler entered', 'handler returned', 'effect']);
			await dispatched;
		} finally {
			handler_gate.resolve();
			effect_gate.resolve();
		}
	});

	test('close waits for an HTTP handler still running when it starts, then for its flush', async () => {
		const handler_gate = create_deferred<void>();
		const effect_gate = create_deferred<void>();
		const landed: Array<string> = [];
		// production mode: the response does not wait for the flush
		const t = await create_test_server({
			await_pending_effects: false,
			rpc_endpoints: [
				{
					path: RPC_PATH,
					actions: [create_gated_effects_action(handler_gate, effect_gate, landed)]
				}
			]
		});
		try {
			const alice = await t.create_account('alice_close_handler_http');
			const responding = t.server.app.request(RPC_PATH, {
				method: 'POST',
				headers: {
					host: 'localhost',
					'content-type': 'application/json',
					...alice.session_headers
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: GATED_EFFECTS_METHOD })
			});
			await wait_for(() => landed.includes('handler entered'));

			const closing = track_settled(t.server.close());
			await wait(20);
			assert.ok(!closing.settled(), 'close returned with an HTTP handler still running');

			handler_gate.resolve();
			const res = await responding;
			assert.strictEqual(res.status, 200, await res.text());
			await wait(20);
			assert.ok(!closing.settled(), "close returned with the handler's flush still running");

			effect_gate.resolve();
			await closing.promise;
			assert.deepStrictEqual(landed, ['handler entered', 'handler returned', 'effect']);
		} finally {
			handler_gate.resolve();
			effect_gate.resolve();
		}
	});
});

describe('the request tracker at the edges', () => {
	test('a request arriving after close started is refused 503, not run against the closing database', async () => {
		const handler_gate = create_deferred<void>();
		const effect_gate = create_deferred<void>();
		const landed: Array<string> = [];
		const gated = create_gated_effects_action(handler_gate, effect_gate, landed);
		const t = await create_test_server({
			rpc_endpoints: [
				{
					path: RPC_PATH,
					// no transaction, so the held handler leaves the test database's one
					// connection free for the late request's credential read
					actions: [counted_action, { ...gated, spec: { ...gated.spec, side_effects: false } }]
				}
			]
		});
		try {
			const alice = await t.create_account('alice_after_close');
			const rpc_headers = {
				host: 'localhost',
				'content-type': 'application/json',
				...alice.session_headers
			};
			// one request in flight holds the close in its drain
			const responding = t.server.app.request(RPC_PATH, {
				method: 'POST',
				headers: rpc_headers,
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: GATED_EFFECTS_METHOD })
			});
			await wait_for(() => landed.includes('handler entered'));
			const closing = track_settled(t.server.close());
			await wait();

			const late = await rpc_call(t.server, alice.session_headers);
			assert.strictEqual(late.status, 503);
			assert.deepStrictEqual(await late.json(), { error: 'service_unavailable' });
			assert.ok(!closing.settled());

			handler_gate.resolve();
			effect_gate.resolve();
			assert.strictEqual((await responding).status, 200, 'the request accepted first ran');
			await closing.promise;
		} finally {
			handler_gate.resolve();
			effect_gate.resolve();
		}
	});

	test('_testing_drain_effects over HTTP, awaiting its effects, never waits on itself — two at once included', async () => {
		const drain = create_testing_drain_effects_action(null as never);
		const t = await create_test_server({
			await_pending_effects: true,
			rpc_endpoints: (ctx) => [
				{
					path: RPC_PATH,
					// the drain's handler under a session-authed spec, so a test
					// account can call it
					actions: [
						{
							spec: { ...drain.spec, auth: { account: 'required', actor: 'none' } },
							handler: create_testing_drain_effects_action(ctx.deps).handler
						}
					]
				}
			]
		});
		const alice = await t.create_account('alice_self_drain');
		const call_drain = () =>
			t.server.app.request(RPC_PATH, {
				method: 'POST',
				headers: {
					host: 'localhost',
					'content-type': 'application/json',
					...alice.session_headers
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: drain.spec.method })
			});
		const answers = await Promise.all([call_drain(), call_drain()]);
		for (const res of answers) {
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual((await res.json()).result, { ok: true });
		}
	});
});

const GATED_EFFECTS_METHOD = 'gated_effects';

/**
 * An action whose handler waits on `handler_gate` (when given) and queues a
 * post-commit thunk that waits on `effect_gate` — each step recorded in
 * `landed`, so a test can hold it at either point.
 */
const create_gated_effects_action = (
	handler_gate: { promise: Promise<void> } | null,
	effect_gate: { promise: Promise<void> },
	landed: Array<string>
): RpcAction => ({
	spec: {
		method: GATED_EFFECTS_METHOD,
		kind: 'request_response',
		initiator: 'frontend',
		auth: { account: 'required', actor: 'none' },
		side_effects: true,
		input: fuz_void,
		output: object({ ok: literal(true) }),
		async: true,
		description: 'holds its handler and its post-commit effect on gates the test releases'
	},
	handler: async (_input, ctx) => {
		if (handler_gate) {
			landed.push('handler entered');
			await handler_gate.promise;
			landed.push('handler returned');
		}
		emit_after_commit(ctx, async () => {
			await effect_gate.promise;
			landed.push('effect');
		});
		return { ok: true };
	}
});

/** Wait until `predicate` holds, failing after a bound. */
const wait_for = async (predicate: () => boolean): Promise<void> => {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'condition never held');
		await wait();
	}
};

/** `promise`, with whether it has settled readable synchronously. */
const track_settled = <T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } => {
	let settled = false;
	const tracked = promise.finally(() => {
		settled = true;
	});
	return { promise: tracked, settled: () => settled };
};

const POKED_METHOD = 'poked';

/** Notifies the account it names, after the commit, through the handler context's sender. */
const poke_action: RpcAction = {
	spec: {
		method: 'poke',
		kind: 'request_response',
		initiator: 'frontend',
		auth: { account: 'required', actor: 'none' },
		side_effects: true,
		input: object({ account_id: UuidSchema }),
		output: object({ ok: literal(true) }),
		async: true,
		description: 'notifies an account'
	},
	handler: (input: { account_id: Uuid }, ctx) => {
		emit_after_commit(ctx, () => {
			ctx.notification_sender.send_to_account(
				input.account_id,
				create_jsonrpc_notification(POKED_METHOD, {})
			);
		});
		return { ok: true };
	}
};

const poke_over_rpc = async (
	server: AppServer,
	headers: Record<string, string>,
	account_id: string
): Promise<void> => {
	const res = await server.app.request(RPC_PATH, {
		method: 'POST',
		headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'poke', params: { account_id } })
	});
	assert.strictEqual(res.status, 200, await res.text());
};

const WS_TWO_PATH = '/api/ws_two';

describe('notifications reach every mounted registry through the handler context', () => {
	test("an HTTP RPC action's notification reaches the account's socket, once", async () => {
		// no factory or endpoint was handed a sender: the server put the
		// registry it mounted on the backend's, which the dispatcher hands over
		const t = await create_test_server({
			rpc_endpoints: [{ path: RPC_PATH, actions: [poke_action] }],
			await_pending_effects: true
		});
		const alice = await t.create_account('alice_poked');
		const bob = await t.create_account('bob_poker');
		const alice_socket = await open_socket(t, alice.session_headers);
		const bob_socket = await open_socket(t, bob.session_headers);

		await poke_over_rpc(t.server, bob.session_headers, alice.account_id);
		assert.deepStrictEqual(alice_socket.notifications(), [POKED_METHOD]);
		assert.deepStrictEqual(bob_socket.notifications(), [], 'only the named account hears it');
	});

	test("a WS action's notification reaches the account's socket on another endpoint's registry", async () => {
		// each endpoint mounts its own registry; the sender reaches both
		const t = await create_test_server({
			ws_endpoints: [
				{ path: WS_PATH, actions: [...protocol_actions, counted_action], receive_timeout: null },
				{ path: WS_TWO_PATH, actions: [...protocol_actions, poke_action], receive_timeout: null }
			]
		});
		const alice = await t.create_account('alice_poked');
		const bob = await t.create_account('bob_poker');
		const alice_socket = await open_socket(t, alice.session_headers);
		const bob_socket = await open_socket(t, bob.session_headers, WS_TWO_PATH);

		assert_ok(await bob_socket.request('poke', { account_id: alice.account_id }));
		assert.deepStrictEqual(alice_socket.notifications(), [POKED_METHOD]);
		assert.deepStrictEqual(bob_socket.notifications(), []);
	});

	test('a registry two endpoints share delivers a notification to each socket once', async () => {
		const shared = new ConnectionRegistry({ log });
		const t = await create_test_server({
			rpc_endpoints: [{ path: RPC_PATH, actions: [poke_action] }],
			ws_endpoints: [
				{ path: WS_PATH, actions: [...protocol_actions], registry: shared, receive_timeout: null },
				{
					path: WS_TWO_PATH,
					actions: [...protocol_actions],
					registry: shared,
					receive_timeout: null
				}
			],
			await_pending_effects: true
		});
		const alice = await t.create_account('alice_poked');
		const bob = await t.create_account('bob_poker');
		const first = await open_socket(t, alice.session_headers);
		const second = await open_socket(t, alice.session_headers, WS_TWO_PATH);

		await poke_over_rpc(t.server, bob.session_headers, alice.account_id);
		assert.deepStrictEqual(first.notifications(), [POKED_METHOD]);
		assert.deepStrictEqual(second.notifications(), [POKED_METHOD]);
	});
});

/** A WS mutation that emits one pool-written (failure) audit row through `audit`. */
const audited_action_spec = {
	method: 'audited',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: fuz_void,
	output: object({ ok: literal(true) }),
	async: true,
	description: 'emits one audit row'
} satisfies RequestResponseActionSpec;

const create_audited_action = (audit: AuditEmitter): RpcAction => ({
	spec: audited_action_spec,
	handler: async (_input, ctx) => {
		await audit.emit(ctx, {
			event_type: 'logout',
			// a failure row is the one written on the pool, outside the
			// request's transaction, so it can still be in flight at the reply
			outcome: 'failure',
			account_id: ctx.auth?.account.id ?? null,
			metadata: null
		});
		return { ok: true };
	}
});
