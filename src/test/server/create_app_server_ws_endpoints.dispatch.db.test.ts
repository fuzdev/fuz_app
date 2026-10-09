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
 *   upgrade after it is born closed (going-away, no re-read), and one whose
 *   re-read the shutdown lands in is closed going-away, never as revoked
 * - a WS reply arrives before its audit write lands, and
 *   `_testing_drain_effects` over a tracked emitter waits for it
 *
 * Every server is closed after its test — that disposes the limiters it
 * built. The database is the shared PGlite instance the factory hands out,
 * which outlives the file, so the backend's `close` leaves it open.
 *
 * Mount-time behavior (guards, surface, audit wiring) is in
 * `create_app_server_ws_endpoints.db.test.ts`.
 *
 * @module
 */

import { afterEach, describe, test, assert, vi } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { z } from 'zod';

import { create_keyring } from '$lib/auth/keyring.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions
} from '$lib/server/app_server.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import { wait } from '@fuzdev/fuz_util/async.ts';
import type { Db } from '$lib/db/db.ts';
import { create_gated_db, is_session_read, type GatedDb } from '../gated_db.ts';
import { create_audit_emitter, type AuditEmitter } from '$lib/auth/audit_emitter.ts';
import {
	default_audit_factory,
	type AppBackend,
	type AuditFactory
} from '$lib/server/app_backend.ts';
import { create_testing_drain_effects_action } from '$lib/testing/cross_backend/testing_reset_actions.ts';
import {
	create_test_account_with_credentials,
	create_loopback_app_server_options,
	stub_password_deps
} from '$lib/testing/app_server.ts';
import { create_pglite_factory } from '$lib/testing/db.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import {
	create_fake_ws,
	create_stub_upgrade,
	dispatch_ws_message,
	type StubUpgrade
} from '$lib/testing/ws_round_trip.ts';
import { protocol_actions } from '$lib/actions/protocol.ts';
import { PEER_PING_METHOD } from '$lib/actions/peer_ping.ts';
import type { RpcAction } from '$lib/actions/action_rpc.ts';
import type { RequestResponseActionSpec } from '$lib/actions/action_spec.ts';
import type { MiddlewareSpec } from '$lib/http/middleware_spec.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import { create_rate_limiter, type RateLimiter } from '$lib/rate_limiter.ts';
import { create_realtime_closer } from '$lib/actions/connection_closer.ts';
import { WS_CLOSE_GOING_AWAY, WS_CLOSE_GOING_AWAY_REASON } from '$lib/actions/transports.ts';

const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_keyring(TEST_KEY)!;
const session_options = create_session_config('test_session');
const log = new Logger('test', { level: 'off' });

const WS_PATH = '/api/ws';
const GOING_AWAY_CLOSE = { code: WS_CLOSE_GOING_AWAY, reason: WS_CLOSE_GOING_AWAY_REASON };
const RPC_PATH = '/api/rpc';
const ORIGIN = 'http://localhost:5173';

const factory = create_pglite_factory(async () => {});

/** An account-keyed action — the shape `rate_limit: 'account'` requires. */
const counted_action_spec = {
	method: 'counted',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: z.void(),
	output: z.strictObject({ ok: z.literal(true) }),
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
	/** Session cookie header for a fresh account. */
	create_account: (username: string) => Promise<{
		account_id: string;
		session_headers: Record<string, string>;
		bearer_headers: Record<string, string>;
	}>;
}

/**
 * Assemble a server over a fresh database, with the WS endpoint at `/api/ws`.
 * `wrap_db` replaces the backend's pool — a `create_gated_db` wrapper, say.
 */
const create_test_server = async (
	options: Partial<Omit<AppServerOptions, 'backend' | 'create_upgrade_websocket'>> = {},
	audit_factory: AuditFactory = default_audit_factory,
	wrap_db: (db: Db) => Db = (db) => db
): Promise<TestServer> => {
	const db = wrap_db(await factory.create());
	const migration_results = await run_migrations(db, [auth_migration_ns]);
	const audit = audit_factory({ db, log });
	const backend: AppBackend = {
		db_type: 'pglite-memory',
		db_name: '(memory)',
		migration_results,
		close: async () => {},
		deps: {
			log,
			keyring,
			password: stub_password_deps,
			db,
			audit,
			connection_closer: create_realtime_closer(),
			read_secure_file: async (path: string): Promise<Uint8Array> => {
				throw new Error(`ENOENT: ${path}`);
			},
			delete_file: async () => {}
		}
	};
	const stub = create_stub_upgrade();
	const server = await create_app_server({
		// the loopback proxy is trusted, so `X-Forwarded-For` sets the client IP
		...create_loopback_app_server_options(),
		backend,
		session_options,
		create_route_specs: () => [create_health_route_spec()],
		create_upgrade_websocket: () => stub.upgradeWebSocket,
		ws_endpoints: [
			{ path: WS_PATH, actions: [...protocol_actions, counted_action], heartbeat: false }
		],
		...options
	});
	servers.push(server);
	const create_account: TestServer['create_account'] = async (username) => {
		const { account, session_cookie, api_token } = await create_test_account_with_credentials({
			db,
			keyring,
			session_options,
			password: stub_password_deps,
			username
		});
		return {
			account_id: account.id,
			session_headers: {
				origin: ORIGIN,
				cookie: `${session_options.cookie_name}=${session_cookie}`
			},
			// bearer is refused beside an Origin header
			bearer_headers: { authorization: `Bearer ${api_token}` }
		};
	};
	return { server, stub, db, audit, create_account };
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
	/** The close frames the server sent the socket. */
	closes: Array<{ code?: number; reason?: string }>;
}

let next_request_id = 0;

/**
 * Upgrade through the assembled app and open the socket on the `Context`
 * the middleware chain built — admission included.
 */
const open_socket = async (
	{ server, stub }: TestServer,
	headers: Record<string, string>
): Promise<TestSocket> => {
	const upgrades_before = stub.upgrades.length;
	const res = await server.app.request(WS_PATH, {
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
					{ path: WS_PATH, actions: [...protocol_actions, counted_action], heartbeat: false }
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
		assert.strictEqual(t.server.ws_endpoints[WS_PATH]!.get_connection_count(), 0);
		// the afterEach close is a no-op on a closed server
		await t.server.close();
		assert.strictEqual(socket.closes.length, 1);
	});

	test('an upgrade after close is born closed: going-away, never admitted, no re-read', async () => {
		const t = await create_test_server();
		const alice = await t.create_account('alice');
		await t.server.close();

		// the request still reaches the app — a listener stops accepting, but
		// one already accepted runs on
		const res = await t.server.app.request(WS_PATH, {
			headers: { host: 'localhost', upgrade: 'websocket', ...alice.session_headers }
		});
		assert.strictEqual(res.status, 200);
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
		assert.strictEqual(transport.get_connection_count(), 0);
		assert.strictEqual(transport.get_pending_connection_count(), 0);
	});

	test('a shutdown during the admission re-read closes the upgrade going-away, never as revoked', async () => {
		let gated: GatedDb | undefined;
		const t = await create_test_server(
			{},
			default_audit_factory,
			(db) => (gated = create_gated_db(db)).db
		);
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
			const opened = events.onOpen?.(new Event('open'), fake.ws) as unknown as Promise<void>;
			await stalled.reached;
			const transport = t.server.ws_endpoints[WS_PATH]!;
			assert.strictEqual(transport.get_pending_connection_count(), 1);

			await t.server.close();
			assert.deepStrictEqual(fake.closes, [GOING_AWAY_CLOSE], 'the close-all closed it pending');
			// the database closes under the re-read
			stalled.fail(new Error('database closed'));
			await opened;

			assert.deepStrictEqual(
				fake.closes,
				[GOING_AWAY_CLOSE],
				'the refusal after the failed re-read sent no 1011 or 4001'
			);
			assert.strictEqual(transport.get_connection_count(), 0);
			assert.strictEqual(transport.get_pending_connection_count(), 0);
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
						heartbeat: false
					}
				]
			},
			({ db, log }) => {
				gated = create_gated_db(db);
				return create_audit_emitter({ db: gated.db, log, track_inflight: true });
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

			const drain = create_testing_drain_effects_action(t.audit);
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
});

/** A WS mutation that emits one success audit row through `audit`. */
const audited_action_spec = {
	method: 'audited',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: z.void(),
	output: z.strictObject({ ok: z.literal(true) }),
	async: true,
	description: 'emits one audit row'
} satisfies RequestResponseActionSpec;

const create_audited_action = (audit: AuditEmitter): RpcAction => ({
	spec: audited_action_spec,
	handler: (_input, ctx) => {
		audit.emit(ctx, {
			event_type: 'logout',
			outcome: 'success',
			account_id: ctx.auth?.account.id ?? null,
			metadata: null
		});
		return { ok: true };
	}
});
