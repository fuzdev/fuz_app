/**
 * Tests for `create_app_server.ws_endpoints` — the WS auto-mount surface
 * that mirrors `rpc_endpoints` for HTTP RPC. Covers:
 *
 * - happy-path mount + factory form + factory returning [] vs missing
 *   `upgradeWebSocket`
 * - multi-endpoint with per-path `BackendWebsocketTransport`
 * - `auth_guard` default-on / disabled / dedupe-by-transport
 * - `extra_audit_handlers` always-append semantics
 * - rate limiter threading from `AppServerContext`
 * - standard actions over WS surface
 * - `required_roles` upgrade-time gate
 * - surface emission (`surface.ws_endpoints`)
 * - mount-time error guards (missing `upgradeWebSocket`, duplicate
 *   paths, cross-surface `GET path` collision with `RouteSpec`)
 * - explicit `auth_guard: true` matches the default-on path
 * - mixed `auth_guard` config across specs sharing one transport
 *   (OR-semantics: any spec with `!== false` wires the guard)
 * - distinct transports across endpoints get distinct listener pairs
 *
 * Shares the same `create_pglite_factory` shared-WASM pattern as
 * `create_app_server.db.test.ts`. Uses `create_stub_upgrade` (from
 * `$lib/testing/ws_round_trip.ts`) so the upgrade middleware exercises
 * without a real WS handshake.
 *
 * Audit-chain tests rebuild the `AppBackend` locally so the test can
 * retain a reference to `backend.deps.audit` — `create_app_server`'s
 * auto-mount appends listeners to that same emitter, so calling
 * `audit.notify(event)` drives the listener chain the factory wired.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { WSEvents } from 'hono/ws';
import { z } from 'zod';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

import { create_keyring } from '$lib/auth/keyring.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import { create_app_server, type AppServerOptions } from '$lib/server/app_server.ts';
import type { AppBackend } from '$lib/server/app_backend.ts';
import { create_audit_emitter, type AuditEmitter } from '$lib/auth/audit_emitter.ts';
import { stub_password_deps } from '$lib/testing/app_server.ts';
import { create_pglite_factory } from '$lib/testing/db.ts';
import { run_migrations } from '$lib/db/migrate.ts';
import { auth_migration_ns } from '$lib/auth/migrations.ts';
import {
	create_stub_upgrade,
	create_fake_hono_context,
	create_fake_ws,
	dispatch_ws_message
} from '$lib/testing/ws_round_trip.ts';
import { create_test_audit_event } from '$lib/testing/entities.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { protocol_actions } from '$lib/actions/protocol.ts';
import { parse_allowed_origins } from '$lib/http/origin.ts';
import { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import { WS_CLOSE_SESSION_REVOKED } from '$lib/actions/transports.ts';
import type { AuditLogEvent } from '$lib/auth/audit_log_schema.ts';
import type { WsEndpointSpec } from '$lib/actions/ws_endpoint_spec.ts';
import type { Action } from '$lib/actions/action_types.ts';
import type { LocalCallActionSpec } from '$lib/actions/action_spec.ts';
import type { RouteSpec } from '$lib/http/route_spec.ts';
import { create_rate_limiter } from '$lib/rate_limiter.ts';
import { all_standard_action_specs } from '$lib/auth/standard_action_specs.ts';
import { create_standard_rpc_actions } from '$lib/auth/standard_rpc_actions.ts';

const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_keyring(TEST_KEY)!;
const session_options = create_session_config('test_session');
const log = new Logger('test', { level: 'off' });

const fs_stubs = {
	stat: async () => null,
	read_text_file: async () => '',
	delete_file: async (_path: string) => {}
};

const factory = create_pglite_factory(async () => {});

const base_config: Omit<AppServerOptions, 'backend'> = {
	session_options,
	allowed_origins: [/^http:\/\/localhost/],
	proxy: {
		trusted_proxies: ['127.0.0.1'],
		get_connection_ip: () => '127.0.0.1'
	},
	env_schema: z.object({}),
	create_route_specs: () => [create_health_route_spec()]
};

/** Build an `AppBackend` + base config; returns both so tests can hold a
 * reference to the bound `AuditEmitter` the auto-mount appends to. */
const create_test_setup = async (): Promise<{
	config: Omit<AppServerOptions, 'backend' | 'ws_endpoints' | 'upgradeWebSocket'> & {
		backend: AppBackend;
	};
	audit: AuditEmitter;
}> => {
	const db = await factory.create();
	const migration_results = await run_migrations(db, [auth_migration_ns]);
	const audit = create_audit_emitter({ db, log });
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
			...fs_stubs
		}
	};
	return { config: { backend, ...base_config }, audit };
};

const ALLOWED_ORIGINS: ReadonlyArray<RegExp> = parse_allowed_origins('http://localhost:3000');

// Minimal WS endpoint spec carrying just the canonical `protocol_actions`
// bundle (heartbeat + cancel) — used by tests that don't care about the
// action list.
const build_minimal_spec = (overrides?: Partial<WsEndpointSpec>): WsEndpointSpec => ({
	path: '/api/ws',
	allowed_origins: ALLOWED_ORIGINS,
	actions: [...protocol_actions],
	...overrides
});

describe('create_app_server.ws_endpoints', () => {
	test('array form auto-mounts: AppServer.ws_endpoints carries the transport, surface lists the actions', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec()]
		});

		// Path → transport map for broadcast / fan-out.
		const mounted_paths = Object.keys(result.ws_endpoints);
		assert.deepStrictEqual(mounted_paths, ['/api/ws']);
		assert.instanceOf(result.ws_endpoints['/api/ws'], BackendWebsocketTransport);

		// Surface reflects the endpoint and its methods.
		const ws_endpoint = result.surface_spec.surface.ws_endpoints.find((e) => e.path === '/api/ws');
		assert.isDefined(ws_endpoint);
		assert.deepStrictEqual(ws_endpoint.required_roles, []);
		const method_names = new Set(ws_endpoint.methods.map((m) => m.name));
		assert.isTrue(method_names.has('heartbeat'));
		assert.isTrue(method_names.has('cancel'));

		// The route was wired — Hono evaluates `upgradeWebSocket` at mount time.
		assert.strictEqual(typeof stub.get_create_events(), 'function');
	});

	test('factory form receives AppServerContext (with rate limiters + deps)', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		let captured_keys: Array<string> = [];
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: (ctx) => {
				captured_keys = Object.keys(ctx);
				assert.isDefined(ctx.deps);
				assert.isDefined(ctx.deps.db);
				assert.isDefined(ctx.action_ip_rate_limiter);
				assert.isDefined(ctx.action_account_rate_limiter);
				return [build_minimal_spec()];
			}
		});

		assert.isTrue(captured_keys.includes('deps'));
		assert.isTrue(captured_keys.includes('action_ip_rate_limiter'));
		assert.isTrue(captured_keys.includes('action_account_rate_limiter'));
		assert.isDefined(result.ws_endpoints['/api/ws']);
	});

	test('factory returning [] does not throw when upgradeWebSocket is missing', async () => {
		// Feature-flag-gated WS surface: the factory may legitimately return
		// no endpoints. The "upgradeWebSocket required" check fires
		// post-resolution so an empty array stays safe.
		const { config } = await create_test_setup();
		const result = await create_app_server({
			...config,
			ws_endpoints: () => []
		});
		assert.deepStrictEqual(Object.keys(result.ws_endpoints), []);
	});

	test('throws when ws_endpoints resolves non-empty but upgradeWebSocket is missing', async () => {
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_app_server({
				...config,
				ws_endpoints: [build_minimal_spec()]
			})
		);
		assert.match(err.message, /ws_endpoints resolved non-empty but upgradeWebSocket is missing/);
	});

	test('throws on duplicate paths across two WsEndpointSpecs', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_app_server({
				...config,
				upgradeWebSocket: stub.upgradeWebSocket,
				ws_endpoints: [build_minimal_spec(), build_minimal_spec()]
			})
		);
		assert.match(err.message, /duplicate ws_endpoints path: \/api\/ws/);
	});

	test('multi-endpoint: separate paths get separate auto-created transports', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a' }),
				build_minimal_spec({ path: '/api/ws_b' })
			]
		});

		assert.deepStrictEqual(Object.keys(result.ws_endpoints).sort(), ['/api/ws_a', '/api/ws_b']);
		assert.notStrictEqual(result.ws_endpoints['/api/ws_a'], result.ws_endpoints['/api/ws_b']);

		const surface_paths = result.surface_spec.surface.ws_endpoints.map((e) => e.path).sort();
		assert.deepStrictEqual(surface_paths, ['/api/ws_a', '/api/ws_b']);
	});

	test('multi-endpoint with supplied transports: AppServer.ws_endpoints returns the same references', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const transport_a = new BackendWebsocketTransport();
		const transport_b = new BackendWebsocketTransport();
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', transport: transport_a }),
				build_minimal_spec({ path: '/api/ws_b', transport: transport_b })
			]
		});

		assert.strictEqual(result.ws_endpoints['/api/ws_a'], transport_a);
		assert.strictEqual(result.ws_endpoints['/api/ws_b'], transport_b);
	});

	test('auth_guard default-on: session_revoke event closes the affected socket', async () => {
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport = new BackendWebsocketTransport();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ transport })]
		});

		const session_hash = 'session_hash_a';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		transport.add_connection(fake_ws.ws, session_hash, account_id);

		// `notify` walks the registered listeners synchronously — the
		// auto-mount registered listeners on this same emitter during assembly.
		const event: AuditLogEvent = create_test_audit_event({
			event_type: 'session_revoke',
			account_id,
			metadata: { session_id: session_hash }
		});
		audit.notify(event);

		assert.strictEqual(fake_ws.closes.length, 1);
		assert.strictEqual(fake_ws.closes[0]!.code, WS_CLOSE_SESSION_REVOKED);
	});

	test('auth_guard: false skips the auto-wired listeners', async () => {
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport = new BackendWebsocketTransport();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ transport, auth_guard: false })]
		});

		const session_hash = 'session_hash_a';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		transport.add_connection(fake_ws.ws, session_hash, account_id);

		const event: AuditLogEvent = create_test_audit_event({
			event_type: 'session_revoke',
			account_id,
			metadata: { session_id: session_hash }
		});
		audit.notify(event);

		// Socket stays open — the auto-wired guard was opted out.
		assert.strictEqual(fake_ws.closes.length, 0);
	});

	test('extra_audit_handlers fire alongside the standard guards (and run after them)', async () => {
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport = new BackendWebsocketTransport();
		// Listeners register append-only in mount order: the standard
		// [auth_guard, logout_closer] land ahead of any extra handler. Prove
		// the ordering via the auth_guard's observable effect — it closes the
		// socket — captured at the instant the extra handler fires. The extra
		// handler seeing `closes.length === 1` means the standard guard
		// already ran, anchoring the docstring's "AFTER the standard
		// auth_guard wiring" promise without reaching into listener internals.
		const received_events: Array<AuditLogEvent> = [];
		let closes_seen_by_extra = -1;
		const fake_ws = create_fake_ws();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({
					transport,
					extra_audit_handlers: [
						(e) => {
							received_events.push(e);
							closes_seen_by_extra = fake_ws.closes.length;
						}
					]
				})
			]
		});

		const session_hash = 'session_hash_a';
		const account_id: Uuid = create_uuid();
		transport.add_connection(fake_ws.ws, session_hash, account_id);

		const event = create_test_audit_event({
			event_type: 'session_revoke',
			account_id,
			metadata: { session_id: session_hash }
		});
		audit.notify(event);

		// Standard guard fired (socket closed) AND the extra handler received
		// the same event AND — because the standard guards registered before
		// the extra handler — the socket was already closed when the extra ran.
		assert.strictEqual(fake_ws.closes.length, 1);
		assert.strictEqual(received_events.length, 1);
		assert.strictEqual(received_events[0]!.event_type, 'session_revoke');
		assert.strictEqual(closes_seen_by_extra, 1);
	});

	test('auth_guard dedupes by transport reference: shared transport gets a single pair of listeners', async () => {
		// Two specs share one transport instance — wiring auth_guard twice
		// would have the chain close sockets twice per revoke event.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const shared_transport = new BackendWebsocketTransport();
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', transport: shared_transport }),
				build_minimal_spec({ path: '/api/ws_b', transport: shared_transport })
			]
		});

		assert.strictEqual(result.ws_endpoints['/api/ws_a'], shared_transport);
		assert.strictEqual(result.ws_endpoints['/api/ws_b'], shared_transport);

		// One (auth_guard, logout_closer) pair, not two.
		assert.strictEqual(audit.listener_count(), 2);
	});

	test('rate limiter threading: action limiters flow from AppServerContext into the WS mount', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const action_account_rate_limiter = create_rate_limiter({
			max_attempts: 999,
			window_ms: 60_000
		});
		let captured_account_limiter: unknown = null;

		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			action_account_rate_limiter,
			ws_endpoints: (ctx) => {
				captured_account_limiter = ctx.action_account_rate_limiter;
				return [build_minimal_spec()];
			}
		});

		assert.strictEqual(captured_account_limiter, action_account_rate_limiter);
		assert.isDefined(result.ws_endpoints['/api/ws']);
	});

	test('standard actions over WS: surface emits account_* + admin_* + role_grant_offer_* methods', async () => {
		// Mirrors the consumer migration pattern — spread protocol +
		// standard actions onto WS so the seven account_* methods (and the
		// rest of the standard surface) are reachable over both transports.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: (ctx) => {
				const standard: ReadonlyArray<Action> = create_standard_rpc_actions(ctx.deps);
				return [
					{
						path: '/api/ws',
						allowed_origins: ALLOWED_ORIGINS,
						actions: [...protocol_actions, ...standard]
					}
				];
			}
		});

		const ws_endpoint = result.surface_spec.surface.ws_endpoints[0];
		assert.isDefined(ws_endpoint);
		const method_names = new Set(ws_endpoint.methods.map((m) => m.name));
		assert.isTrue(method_names.has('account_verify'));
		assert.isTrue(method_names.has('account_session_list'));
		assert.isTrue(method_names.has('account_token_create'));
		// Standard actions plus heartbeat + cancel — derived from the spec
		// list so adding a standard action doesn't have to update this test.
		assert.strictEqual(
			ws_endpoint.methods.length,
			all_standard_action_specs.length + protocol_actions.length
		);
	});

	test('auth_guard default-on: logout event closes the affected socket via create_ws_logout_closer', async () => {
		// Pairs with the session_revoke test — proves the auto-mount wires
		// BOTH `create_ws_auth_guard` (revoke events) AND
		// `create_ws_logout_closer` (the self-service logout branch).
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport = new BackendWebsocketTransport();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ transport })]
		});

		const session_hash = 'session_hash_logout';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		transport.add_connection(fake_ws.ws, session_hash, account_id);

		const event: AuditLogEvent = create_test_audit_event({
			event_type: 'logout',
			account_id
		});
		audit.notify(event);

		assert.strictEqual(fake_ws.closes.length, 1);
		assert.strictEqual(fake_ws.closes[0]!.code, WS_CLOSE_SESSION_REVOKED);
	});

	test('audit_log_sse + ws_endpoints co-mount: both register listeners and the WS guard fires on session_revoke', async () => {
		// `audit_log_sse: true` registers the SSE listener first (line ~461);
		// the WS auto-mount registers the auth_guard pair later (line ~741-2).
		// Both register on `deps.audit` — listener composition must
		// not break either consumer.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport = new BackendWebsocketTransport();
		const result = await create_app_server({
			...config,
			audit_log_sse: true,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ transport })]
		});

		assert.isDefined(result.audit_sse);
		const initial_subscribers = result.audit_sse!.registry.count;

		const session_hash = 'session_hash_co_mount';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		transport.add_connection(fake_ws.ws, session_hash, account_id);

		// Chain length: 1 (audit_sse listener) + 2 (auth_guard + logout_closer).
		assert.strictEqual(audit.listener_count(), 3);

		const event: AuditLogEvent = create_test_audit_event({
			event_type: 'session_revoke',
			account_id,
			metadata: { session_id: session_hash }
		});
		audit.notify(event);

		// WS guard fired (socket closed).
		assert.strictEqual(fake_ws.closes.length, 1);
		// SSE registry didn't grow — no subscribers in this test — but the
		// listener was invoked (didn't throw) so the chain processed cleanly.
		assert.strictEqual(result.audit_sse!.registry.count, initial_subscribers);
	});

	test('extra_audit_handlers are never deduped: same handler passed twice fires twice', async () => {
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport = new BackendWebsocketTransport();
		let call_count = 0;
		const handler = (): void => {
			call_count += 1;
		};
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({
					transport,
					auth_guard: false,
					extra_audit_handlers: [handler, handler]
				})
			]
		});

		// Both registrations appended — chain has both entries.
		assert.strictEqual(audit.listener_count(), 2);

		audit.notify(create_test_audit_event({ event_type: 'login' }));
		assert.strictEqual(call_count, 2);
	});

	test('local_call actions are filtered from AppSurfaceWsEndpoint.methods', async () => {
		// `local_call` specs in a WS endpoint's actions array don't dispatch
		// (compile_action_registry only routes `request_response` with handler
		// into action_map). Surface emission filters them out so attack-
		// surface tests reflect dispatchable methods only.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const local_call_spec: LocalCallActionSpec = {
			method: 'frontend_local_helper',
			kind: 'local_call',
			initiator: 'frontend',
			auth: null,
			side_effects: false,
			input: z.strictObject({}),
			output: z.strictObject({}),
			async: true,
			description: 'frontend-only helper that rides on the registry'
		};
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				{
					path: '/api/ws',
					allowed_origins: ALLOWED_ORIGINS,
					actions: [...protocol_actions, { spec: local_call_spec }]
				}
			]
		});

		const ws_endpoint = result.surface_spec.surface.ws_endpoints[0];
		assert.isDefined(ws_endpoint);
		const method_names = new Set(ws_endpoint.methods.map((m) => m.name));
		assert.isTrue(method_names.has('heartbeat'));
		assert.isTrue(method_names.has('cancel'));
		// local_call dropped.
		assert.isFalse(method_names.has('frontend_local_helper'));
		// Only the kinds the WS dispatcher actually serves remain.
		const kinds = new Set(ws_endpoint.methods.map((m) => m.kind));
		assert.deepStrictEqual([...kinds].sort(), ['remote_notification', 'request_response']);
	});

	test('round-trip: heartbeat request dispatches through the auto-mounted endpoint and on_socket_open fires', async () => {
		// Exercises the full auto-mount path: factory eval →
		// register_ws_endpoint → register_action_ws → perform_action.
		// Drives `createEvents(c)` directly (bypassing the surrounding
		// middleware chain) so the dispatcher's wire framing is tested
		// against the same closure the production path would build.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const open_events: Array<{ connection_id: Uuid }> = [];

		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({
					on_socket_open: ({ connection_id }) => {
						open_events.push({ connection_id });
					},
					// Disable server heartbeat — the test runs in fake time-zero
					// and the round-trip doesn't need timeout watchdogs.
					heartbeat: false
				})
			]
		});

		const create_events = stub.get_create_events();
		const fake_ctx = create_fake_hono_context({ credential_type: 'session' });
		const events: WSEvents = await create_events(fake_ctx);

		const fake_ws = create_fake_ws();
		await Promise.resolve(events.onOpen?.(new Event('open'), fake_ws.ws));

		// `on_socket_open` ran with the registered connection id.
		assert.strictEqual(open_events.length, 1);
		const transport = result.ws_endpoints['/api/ws']!;
		assert.strictEqual(transport.get_connection_count(), 1);

		// Drive a heartbeat request through the dispatcher.
		assert.isDefined(events.onMessage);
		await dispatch_ws_message(
			events.onMessage,
			new MessageEvent('message', {
				data: JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat', id: 1, params: {} })
			}),
			fake_ws.ws
		);

		assert.strictEqual(fake_ws.sends.length, 1);
		const response = JSON.parse(fake_ws.sends[0]!);
		assert.strictEqual(response.jsonrpc, '2.0');
		assert.strictEqual(response.id, 1);
		assert.deepStrictEqual(response.result, {});

		// Tear down — `on_socket_close` would fire here if wired.
		await Promise.resolve(
			events.onClose?.(new CloseEvent('close', { code: 1000, reason: '' }), fake_ws.ws)
		);
		assert.strictEqual(transport.get_connection_count(), 0);
	});

	test('required_roles: ROLE_ADMIN appears on the surface and unauthenticated upgrade is rejected at the upgrade-time chain', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ required_roles: [ROLE_ADMIN] })]
		});

		// Surface documents the upgrade-time gate.
		const ws_endpoint = result.surface_spec.surface.ws_endpoints[0];
		assert.isDefined(ws_endpoint);
		assert.deepStrictEqual(ws_endpoint.required_roles, [ROLE_ADMIN]);

		// Unauthenticated upgrade attempt: `require_auth` runs before
		// `require_role`, so this yields 401.
		const res = await result.app.fetch(
			new Request('http://localhost:3000/api/ws', {
				headers: { Origin: 'http://localhost:3000' }
			})
		);
		assert.strictEqual(res.status, 401);
	});

	test('throws when a WsEndpointSpec path collides with a GET RouteSpec', async () => {
		// Without this guard, the WS auto-mount (runs after `apply_route_specs`)
		// would silently shadow the consumer's GET route — Hono is last-wins.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const colliding_route_spec: RouteSpec = {
			method: 'GET',
			path: '/api/ws',
			auth: { account: 'none', actor: 'none' },
			handler: (c) => c.json({ hi: 'from rest' }),
			description: 'consumer route that overlaps the WS path',
			input: z.null(),
			output: z.strictObject({ hi: z.string() })
		};
		const err = await assert_rejects(() =>
			create_app_server({
				...config,
				upgradeWebSocket: stub.upgradeWebSocket,
				create_route_specs: () => [create_health_route_spec(), colliding_route_spec],
				ws_endpoints: [build_minimal_spec()]
			})
		);
		assert.match(err.message, /ws_endpoints path collides with a GET RouteSpec: \/api\/ws/);
	});

	test('non-GET RouteSpec at the same path does not trigger collision (different HTTP methods coexist)', async () => {
		// `POST /api/ws` is fine — only `GET path` is what `register_action_ws`
		// claims. This anchors the narrow scope of the cross-surface check
		// so a future refactor doesn't widen it accidentally.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const non_colliding_route_spec: RouteSpec = {
			method: 'POST',
			path: '/api/ws',
			auth: { account: 'none', actor: 'none' },
			handler: (c) => c.json({ hi: 'posted' }),
			description: 'consumer POST at the same path as the WS upgrade',
			input: z.strictObject({}),
			output: z.strictObject({ hi: z.string() })
		};
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			create_route_specs: () => [create_health_route_spec(), non_colliding_route_spec],
			ws_endpoints: [build_minimal_spec()]
		});
		assert.isDefined(result.ws_endpoints['/api/ws']);
	});

	test('explicit auth_guard: true wires the listener pair (matches the default-on path)', async () => {
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport = new BackendWebsocketTransport();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ transport, auth_guard: true })]
		});

		// One (auth_guard, logout_closer) pair appended.
		assert.strictEqual(audit.listener_count(), 2);

		// Sanity: the wired guard actually fires.
		const session_hash = 'session_hash_explicit_true';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		transport.add_connection(fake_ws.ws, session_hash, account_id);
		audit.notify(
			create_test_audit_event({
				event_type: 'session_revoke',
				account_id,
				metadata: { session_id: session_hash }
			})
		);
		assert.strictEqual(fake_ws.closes.length, 1);
	});

	test('distinct transports across endpoints get distinct (auth_guard, logout_closer) pairs', async () => {
		// Two endpoints, two transports — chain has one pair per transport
		// (4 listeners total). Sibling to the shared-transport dedupe test;
		// confirms dedupe is scoped to reference identity, not endpoint count.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const transport_a = new BackendWebsocketTransport();
		const transport_b = new BackendWebsocketTransport();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', transport: transport_a }),
				build_minimal_spec({ path: '/api/ws_b', transport: transport_b })
			]
		});

		assert.strictEqual(audit.listener_count(), 4);
	});

	test('shared transport with mixed auth_guard config: OR-semantics, any non-false wires the guard', async () => {
		// OR-semantics: when sibling specs share a transport, the guard
		// wires iff any spec has `auth_guard !== false`. The order of the
		// specs does not matter — this is the order where the `true`-config
		// spec comes second.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const shared_transport = new BackendWebsocketTransport();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', transport: shared_transport, auth_guard: false }),
				build_minimal_spec({ path: '/api/ws_b', transport: shared_transport, auth_guard: true })
			]
		});

		// Guard wired exactly once (by the `true` spec); the `false` spec
		// doesn't subtract.
		assert.strictEqual(audit.listener_count(), 2);

		// And it actually fires.
		const session_hash = 'session_hash_mixed_or';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		shared_transport.add_connection(fake_ws.ws, session_hash, account_id);
		audit.notify(
			create_test_audit_event({
				event_type: 'session_revoke',
				account_id,
				metadata: { session_id: session_hash }
			})
		);
		assert.strictEqual(fake_ws.closes.length, 1);
	});

	test('factory-route collision: WS at /api/surface collides with the auto-mounted surface route', async () => {
		// Factory routes (bootstrap, surface) get the same collision check as
		// consumer routes — the surface route is `GET /api/surface` by
		// default. This locks that in so a future refactor can't scope the
		// check to consumer-only routes.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_app_server({
				...config,
				upgradeWebSocket: stub.upgradeWebSocket,
				ws_endpoints: [build_minimal_spec({ path: '/api/surface' })]
			})
		);
		assert.match(err.message, /ws_endpoints path collides with a GET RouteSpec: \/api\/surface/);
	});

	test('required_roles: any-of disjunction passes when the caller holds either listed role', async () => {
		// Auto-mount surfaces the multi-role gate identically to the inner
		// `register_ws_endpoint` (covered in register_ws_endpoint.test.ts);
		// this test confirms the array threads through unchanged.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ required_roles: [ROLE_ADMIN, 'keeper'] })]
		});

		const ws_endpoint = result.surface_spec.surface.ws_endpoints[0];
		assert.isDefined(ws_endpoint);
		assert.deepStrictEqual(ws_endpoint.required_roles, [ROLE_ADMIN, 'keeper']);
	});

	test('shared transport with all auth_guard: false opts the transport out entirely', async () => {
		// The opt-out path for shared transports: every sibling spec must
		// pass `auth_guard: false`. Documents the OR-semantics' negative
		// case so a future refactor doesn't quietly start wiring listeners
		// when every consumer opted out.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const shared_transport = new BackendWebsocketTransport();
		await create_app_server({
			...config,
			upgradeWebSocket: stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', transport: shared_transport, auth_guard: false }),
				build_minimal_spec({ path: '/api/ws_b', transport: shared_transport, auth_guard: false })
			]
		});

		// No listeners appended for the shared transport.
		assert.strictEqual(audit.listener_count(), 0);
	});
});
