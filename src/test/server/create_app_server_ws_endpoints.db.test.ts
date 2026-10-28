/**
 * Tests for `create_app_server.ws_endpoints` — the WS auto-mount surface
 * that mirrors `rpc_endpoints` for HTTP RPC. Covers:
 *
 * - happy-path mount + factory form + factory returning [] vs missing
 *   `create_upgrade_websocket`
 * - `create_upgrade_websocket` called once with the assembled app, and not
 *   at all when nothing mounts
 * - `allowed_origins` defaulting to the server's list, or narrowing it
 * - endpoint paths outside the auth middleware's scope throw (RPC and WS)
 * - multi-endpoint with per-path `ConnectionRegistry`
 * - `max_connections_per_account` threading into the auto-created registry
 * - one revocation guard on `deps.connection_closer`, whatever mounts
 * - every mounted registry, and the audit stream registry, joins
 *   `deps.connection_closer`
 * - `actions` omitted: the sole RPC endpoint's set, through `to_ws_actions`
 * - standard actions over WS surface
 * - `required_roles` upgrade-time gate
 * - surface emission (`surface.ws_endpoints`)
 * - mount-time error guards (missing `create_upgrade_websocket`, duplicate
 *   paths, cross-surface `GET path` collision with `RouteSpec`)
 * - distinct transports across endpoints share the one guard
 *
 * Shares the same `create_default_db_factory` shared-WASM pattern as
 * `create_app_server.db.test.ts`, and closes every server it assembles. Uses `create_stub_upgrade` (from
 * `#lib/testing/ws_round_trip.ts`) so the upgrade middleware exercises
 * without a real WS handshake. Dispatch through the assembled app — the
 * action rate limiters, middleware order — is in
 * `create_app_server_ws_endpoints.dispatch.db.test.ts`.
 *
 * Audit-chain tests rebuild the `AppBackend` locally so the test can
 * retain a reference to `backend.deps.audit` — `create_app_server`
 * appends its listeners to that same emitter, so calling
 * `audit.notify(event)` drives the listener chain the factory wired.
 *
 * @module
 */

import { afterEach, describe, test, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import type { Hono } from 'hono';
import type { UpgradeWebSocket, WSEvents } from 'hono/ws';
import { z } from 'zod';
import { create_uuid, type Uuid } from '#lib/primitive_schemas.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions
} from '#lib/server/app_server.ts';
import type { AppBackend } from '#lib/server/app_backend.ts';
import { create_audit_emitter, type AuditEmitter } from '#lib/auth/audit_emitter.ts';
import { create_loopback_app_server_options, stub_password_deps } from '#lib/testing/app_server.ts';
import { create_default_db_factory } from '#lib/testing/db.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import {
	create_stub_upgrade,
	create_fake_hono_context,
	create_fake_ws,
	dispatch_ws_message
} from '#lib/testing/ws_round_trip.ts';
import { create_test_audit_event } from '#lib/testing/entities.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { protocol_actions, to_ws_actions } from '#lib/actions/protocol.ts';
import { peer_ping_action } from '#lib/actions/peer_ping.ts';
import { parse_allowed_origins } from '#lib/http/origin.ts';
import {
	ConnectionRegistry,
	DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT
} from '#lib/actions/connection_registry.ts';
import {
	WS_CLOSE_CONNECTION_LIMIT,
	WS_CLOSE_CONNECTION_LIMIT_REASON,
	WS_CLOSE_SESSION_REVOKED
} from '#lib/actions/transports.ts';
import type { AuditLogEvent } from '#lib/auth/audit_log_schema.ts';
import type { WsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';
import type { Action, RpcAction } from '#lib/actions/action_types.ts';
import type { LocalCallActionSpec } from '#lib/actions/action_spec.ts';
import type { RouteSpec } from '#lib/http/route_spec.ts';
import { all_standard_action_specs } from '#lib/auth/standard_action_specs.ts';
import { create_standard_rpc_actions } from '#lib/auth/standard_rpc_actions.ts';
import { create_realtime_closer } from '#lib/actions/connection_closer.ts';
import { AUTH_MIDDLEWARE_PATH } from '#lib/auth/middleware.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';
import { create_test_identity } from '../actions/connection_identity_helpers.ts';

/** Parse an allowlist the test knows is valid. */
const parse_origins = (raw: string): Array<RegExp> => {
	const result = parse_allowed_origins(raw);
	if (!result.ok) throw new Error(`invalid allowlist: ${raw}`);
	return result.origins;
};

const TEST_KEY = 'test-key-that-is-at-least-32-chars-long!!';
const keyring = create_test_keyring(TEST_KEY);
const session_options = create_session_config('test_session');
const log = new Logger('test', { level: 'off' });

const fs_stubs = {
	read_secure_file: async (path: string): Promise<Uint8Array> => {
		throw new Error(`ENOENT: no such file or directory: ${path}`);
	},
	delete_file: async (_path: string) => {}
};

const factory = create_default_db_factory(async () => {});

const base_config: Omit<AppServerOptions, 'backend'> = {
	...create_loopback_app_server_options(),
	// the endpoints' own lists name :3000; the server takes both dev ports
	allowed_origins: parse_origins('http://localhost:3000, http://localhost:5173'),
	session_options,
	create_route_specs: () => [create_health_route_spec()]
};

/** Build an `AppBackend` + base config; returns both so tests can hold a
 * reference to the bound `AuditEmitter` the auto-mount appends to. */
const create_test_setup = async (): Promise<{
	config: Omit<AppServerOptions, 'backend' | 'ws_endpoints' | 'create_upgrade_websocket'> & {
		backend: AppBackend;
	};
	audit: AuditEmitter;
}> => {
	const db = await factory.create();
	const migration_results = await run_migrations(db, [AUTH_MIGRATION_NS]);
	const audit = create_audit_emitter({ db, log });
	const backend: AppBackend = {
		db_type: 'pglet-memory',
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
			...fs_stubs
		}
	};
	return { config: { backend, ...base_config }, audit };
};

// Every server a test assembles is closed after it — that disposes the
// limiters it built and closes its connections. The database is the shared
// instance the default factory hands out, which outlives the file, so the
// backend's `close` leaves it open.
const servers: Array<AppServer> = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** `create_app_server`, with the server closed after the test. */
const create_tracked_app_server = async (options: AppServerOptions): Promise<AppServer> => {
	const server = await create_app_server(options);
	servers.push(server);
	return server;
};

const ALLOWED_ORIGINS: ReadonlyArray<RegExp> = parse_origins('http://localhost:3000');

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
	test('array form auto-mounts: AppServer.ws_endpoints carries the registry, surface lists the actions', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec()]
		});

		// Path → registry map for broadcast / fan-out.
		const mounted_paths = Object.keys(result.ws_endpoints);
		assert.deepStrictEqual(mounted_paths, ['/api/ws']);
		assert.instanceOf(result.ws_endpoints['/api/ws'], ConnectionRegistry);

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
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
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

	test('factory returning [] does not throw when create_upgrade_websocket is missing', async () => {
		// Feature-flag-gated WS surface: the factory may legitimately return
		// no endpoints. The "create_upgrade_websocket required" check fires
		// post-resolution so an empty array stays safe.
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			ws_endpoints: () => []
		});
		assert.deepStrictEqual(Object.keys(result.ws_endpoints), []);
	});

	test('throws when ws_endpoints resolves non-empty but create_upgrade_websocket is missing', async () => {
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_tracked_app_server({
				...config,
				ws_endpoints: [build_minimal_spec()]
			})
		);
		assert.match(
			err.message,
			/ws_endpoints resolved non-empty but create_upgrade_websocket is missing/
		);
	});

	test('create_upgrade_websocket is called once, with the assembled app, for every endpoint', async () => {
		// Node's adapter is built from the app (`createNodeWebSocket({app})`), so
		// the factory must see the instance the server returns — and one adapter
		// serves every endpoint
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const calls: Array<Hono> = [];
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: (app) => {
				calls.push(app);
				return stub.upgradeWebSocket;
			},
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a' }),
				build_minimal_spec({ path: '/api/ws_b' })
			]
		});
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0], result.app);
	});

	test('create_upgrade_websocket is not called when no endpoint mounts', async () => {
		const { config } = await create_test_setup();
		let calls = 0;
		const create_upgrade_websocket = (): UpgradeWebSocket => {
			calls++;
			return create_stub_upgrade().upgradeWebSocket;
		};
		await create_tracked_app_server({ ...config, create_upgrade_websocket });
		await create_tracked_app_server({ ...config, create_upgrade_websocket, ws_endpoints: [] });
		await create_tracked_app_server({
			...config,
			create_upgrade_websocket,
			ws_endpoints: () => []
		});
		assert.strictEqual(calls, 0);
	});

	test('allowed_origins defaults to the server list; a spec list narrows it', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		// the server admits :3000 and :5173; `/api/ws_narrow` only :3000
		const narrowed = parse_origins('http://localhost:3000');
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_default', allowed_origins: undefined }),
				build_minimal_spec({ path: '/api/ws_narrow', allowed_origins: narrowed })
			]
		});

		// the surface records the effective patterns, the server's for the default
		const surface_origins = Object.fromEntries(
			result.surface_spec.surface.ws_endpoints.map((e) => [e.path, e.allowed_origins])
		);
		assert.deepStrictEqual(surface_origins, {
			'/api/ws_default': config.allowed_origins.map((re) => re.toString()),
			'/api/ws_narrow': narrowed.map((re) => re.toString())
		});

		// no credential: an origin that passes reaches `require_auth` (401), one
		// the endpoint refuses stops at its origin check (403)
		const upgrade = async (path: string): Promise<Response> =>
			result.app.request(path, {
				headers: { origin: 'http://localhost:5173', upgrade: 'websocket' }
			});
		assert.strictEqual((await upgrade('/api/ws_default')).status, 401);
		assert.strictEqual((await upgrade('/api/ws_narrow')).status, 403);
		assert.strictEqual(stub.upgrades.length, 0);
	});

	test('throws when a ws_endpoints path is outside the auth middleware scope', async () => {
		// outside `AUTH_MIDDLEWARE_PATH` no session or bearer is parsed — every
		// upgrade would be a 401, so assembly refuses it
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		for (const path of ['/ws', '/apiws']) {
			const err = await assert_rejects(() =>
				create_tracked_app_server({
					...config,
					create_upgrade_websocket: () => stub.upgradeWebSocket,
					ws_endpoints: [build_minimal_spec({ path })]
				})
			);
			assert.include(
				err.message,
				`ws_endpoints path ${path} is outside the auth middleware's scope (${AUTH_MIDDLEWARE_PATH})`
			);
		}
	});

	test('throws when an rpc_endpoints path is outside the auth middleware scope', async () => {
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_tracked_app_server({
				...config,
				rpc_endpoints: [{ path: '/rpc', actions: [] }]
			})
		);
		assert.include(
			err.message,
			`rpc_endpoints path /rpc is outside the auth middleware's scope (${AUTH_MIDDLEWARE_PATH})`
		);
	});

	test('the bare scope prefix is inside it, as Hono matches it', async () => {
		// `'/api/*'` matches `/api` itself, so `/api` mounts
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			rpc_endpoints: [{ path: '/api', actions: [] }]
		});
		assert.deepStrictEqual(
			result.surface_spec.surface.rpc_endpoints.map((e) => e.path),
			['/api']
		);
	});

	test('throws on duplicate paths across two WsEndpointSpecs', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_tracked_app_server({
				...config,
				create_upgrade_websocket: () => stub.upgradeWebSocket,
				ws_endpoints: [build_minimal_spec(), build_minimal_spec()]
			})
		);
		assert.match(err.message, /duplicate ws_endpoints path: \/api\/ws/);
	});

	test('throws on an endpoint whose own allowed_origins is empty', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_tracked_app_server({
				...config,
				create_upgrade_websocket: () => stub.upgradeWebSocket,
				ws_endpoints: [build_minimal_spec({ path: '/api/ws_open', allowed_origins: [] })]
			})
		);
		assert.match(err.message, /ws_endpoints allowed_origins is empty for \/api\/ws_open/);
	});

	test('multi-endpoint: separate paths get separate auto-created transports', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
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
		const registry_a = new ConnectionRegistry();
		const registry_b = new ConnectionRegistry();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', registry: registry_a }),
				build_minimal_spec({ path: '/api/ws_b', registry: registry_b })
			]
		});

		assert.strictEqual(result.ws_endpoints['/api/ws_a'], registry_a);
		assert.strictEqual(result.ws_endpoints['/api/ws_b'], registry_b);
	});

	test('max_connections_per_account configures the auto-created registry', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_capped', max_connections_per_account: 1 }),
				build_minimal_spec({ path: '/api/ws_uncapped', max_connections_per_account: null })
			]
		});

		const account_id: Uuid = create_uuid();
		const capped = result.ws_endpoints['/api/ws_capped']!;
		const first = create_fake_ws();
		const second = create_fake_ws();
		capped.add_connection(
			first.ws,
			create_test_identity({ session_hash: 'session_hash_a', account_id })
		);
		capped.add_connection(
			second.ws,
			create_test_identity({ session_hash: 'session_hash_a', account_id })
		);
		assert.deepStrictEqual(first.closes, [
			{ code: WS_CLOSE_CONNECTION_LIMIT, reason: WS_CLOSE_CONNECTION_LIMIT_REASON }
		]);
		assert.deepStrictEqual(second.closes, []);

		const uncapped = result.ws_endpoints['/api/ws_uncapped']!;
		const sockets = Array.from({ length: DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT + 1 }, () => {
			const fake = create_fake_ws();
			uncapped.add_connection(
				fake.ws,
				create_test_identity({ session_hash: 'session_hash_a', account_id })
			);
			return fake;
		});
		assert.ok(sockets.every((s) => s.closes.length === 0));
	});

	test('throws when max_connections_per_account is set alongside a supplied registry', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		await assert_rejects(
			() =>
				create_tracked_app_server({
					...config,
					create_upgrade_websocket: () => stub.upgradeWebSocket,
					ws_endpoints: [
						build_minimal_spec({
							registry: new ConnectionRegistry(),
							max_connections_per_account: 5
						})
					]
				}),
			/max_connections_per_account configures the registry created for \/api\/ws/
		);
	});

	test('the revocation guard: a session_revoke row closes the affected socket', async () => {
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const registry = new ConnectionRegistry();
		await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ registry })]
		});

		const session_hash = 'session_hash_a';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		registry.add_connection(fake_ws.ws, create_test_identity({ session_hash, account_id }));

		// `notify` walks the registered listeners synchronously — assembly
		// registered the revocation guard on this same emitter.
		const event: AuditLogEvent = create_test_audit_event({
			event_type: 'session_revoke',
			account_id,
			metadata: { session_id: session_hash }
		});
		audit.notify(event);

		assert.strictEqual(fake_ws.closes.length, 1);
		assert.strictEqual(fake_ws.closes[0]!.code, WS_CLOSE_SESSION_REVOKED);
	});

	test('one revocation guard however many endpoints share a registry', async () => {
		// Two specs share one registry instance — one guard on the backend's
		// closer, which holds the registry once.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const shared_registry = new ConnectionRegistry();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', registry: shared_registry }),
				build_minimal_spec({ path: '/api/ws_b', registry: shared_registry })
			]
		});

		assert.strictEqual(result.ws_endpoints['/api/ws_a'], shared_registry);
		assert.strictEqual(result.ws_endpoints['/api/ws_b'], shared_registry);

		// One guard, not two — and the closer holds the shared registry once.
		assert.strictEqual(audit.listener_count(), 1);
		assert.strictEqual(config.backend.deps.connection_closer.member_count(), 1);
	});

	test("a spec that omits actions serves the sole RPC endpoint's, protocol actions first", async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		let rpc_actions: Array<RpcAction> = [];
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			rpc_endpoints: (ctx) => {
				// `peer_ping_action` rides the RPC list too — served once on WS
				rpc_actions = [...create_standard_rpc_actions(ctx.deps), peer_ping_action];
				return [{ path: '/api/rpc', actions: rpc_actions }];
			},
			ws_endpoints: [{ path: '/api/ws' }]
		});

		const ws_endpoint = result.surface_spec.surface.ws_endpoints[0];
		assert.isDefined(ws_endpoint);
		const expected = to_ws_actions(rpc_actions).map((a) => a.spec.method);
		assert.deepStrictEqual(ws_endpoint.methods.map((m) => m.name).sort(), [...expected].sort());
		assert.strictEqual(new Set(expected).size, expected.length, 'no method registered twice');
		assert.deepStrictEqual(
			expected.slice(0, protocol_actions.length),
			protocol_actions.map((a) => a.spec.method)
		);
		// and the upgrade mounted with them
		assert.ok(result.ws_endpoints['/api/ws']);
	});

	test('a spec that omits actions throws unless exactly one RPC endpoint resolves', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		for (const rpc_endpoints of [
			undefined,
			[
				{ path: '/api/rpc', actions: [] },
				{ path: '/api/rpc2', actions: [] }
			]
		]) {
			const err = await assert_rejects(() =>
				create_tracked_app_server({
					...config,
					create_upgrade_websocket: () => stub.upgradeWebSocket,
					rpc_endpoints,
					ws_endpoints: [{ path: '/api/ws' }]
				})
			);
			assert.match(err.message, /ws_endpoints \/api\/ws omits actions/);
		}
	});

	test('standard actions over WS: surface emits account_* + admin_* + role_grant_offer_* methods', async () => {
		// Mirrors the consumer migration pattern — spread protocol +
		// standard actions onto WS so the seven account_* methods (and the
		// rest of the standard surface) are reachable over both transports.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
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

	test('the revocation guard: a logout row closes the affected socket', async () => {
		// Pairs with the session_revoke test — the one guard dispatches on
		// each event's revocation scope, and `logout` is account-wide.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const registry = new ConnectionRegistry();
		await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ registry })]
		});

		const session_hash = 'session_hash_logout';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		registry.add_connection(fake_ws.ws, create_test_identity({ session_hash, account_id }));

		const event: AuditLogEvent = create_test_audit_event({
			event_type: 'logout',
			account_id
		});
		audit.notify(event);

		assert.strictEqual(fake_ws.closes.length, 1);
		assert.strictEqual(fake_ws.closes[0]!.code, WS_CLOSE_SESSION_REVOKED);
	});

	test('audit_log_sse + ws_endpoints co-mount: both register listeners and the guard fires on session_revoke', async () => {
		// `audit_log_sse: true` registers the SSE listener first, then assembly
		// registers the revocation guard. Both register on `deps.audit` —
		// listener composition must not break either consumer.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const registry = new ConnectionRegistry();
		const result = await create_tracked_app_server({
			...config,
			audit_log_sse: true,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ registry })]
		});

		assert.isDefined(result.audit_sse);
		const initial_subscribers = result.audit_sse!.registry.count;

		const session_hash = 'session_hash_co_mount';
		const account_id: Uuid = create_uuid();
		const fake_ws = create_fake_ws();
		registry.add_connection(fake_ws.ws, create_test_identity({ session_hash, account_id }));

		// Chain length: 1 (audit_sse listener) + 1 (revocation guard).
		assert.strictEqual(audit.listener_count(), 2);

		const event: AuditLogEvent = create_test_audit_event({
			event_type: 'session_revoke',
			account_id,
			metadata: { session_id: session_hash }
		});
		audit.notify(event);

		// the guard fired (socket closed)
		assert.strictEqual(fake_ws.closes.length, 1);
		// SSE registry didn't grow — no subscribers in this test — but the
		// listener was invoked (didn't throw) so the chain processed cleanly.
		assert.strictEqual(result.audit_sse!.registry.count, initial_subscribers);
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
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
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
		// register_action_ws → perform_action.
		// Drives `createEvents(c)` directly (bypassing the surrounding
		// middleware chain) so the dispatcher's wire framing is tested
		// against the same closure the production path would build.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const open_events: Array<{ connection_id: Uuid }> = [];

		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({
					on_socket_open: ({ connection_id }) => {
						open_events.push({ connection_id });
					},
					// Disable server heartbeat — the test runs in fake time-zero
					// and the round-trip doesn't need timeout watchdogs.
					receive_timeout: null
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
		const registry = result.ws_endpoints['/api/ws']!;
		assert.strictEqual(registry.connection_count(), 1);

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
		assert.strictEqual(registry.connection_count(), 0);
	});

	test('required_roles: ROLE_ADMIN appears on the surface and unauthenticated upgrade is rejected at the upgrade-time chain', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
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
			create_tracked_app_server({
				...config,
				create_upgrade_websocket: () => stub.upgradeWebSocket,
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
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			create_route_specs: () => [create_health_route_spec(), non_colliding_route_spec],
			ws_endpoints: [build_minimal_spec()]
		});
		assert.isDefined(result.ws_endpoints['/api/ws']);
	});

	test('distinct transports across endpoints share the one guard, which closes on each', async () => {
		// Two endpoints, two transports — one guard on the closer reaches both.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const registry_a = new ConnectionRegistry();
		const registry_b = new ConnectionRegistry();
		await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', registry: registry_a }),
				build_minimal_spec({ path: '/api/ws_b', registry: registry_b })
			]
		});

		assert.strictEqual(audit.listener_count(), 1);
		const account_id: Uuid = create_uuid();
		const on_a = create_fake_ws();
		const on_b = create_fake_ws();
		registry_a.add_connection(
			on_a.ws,
			create_test_identity({ session_hash: 'session_hash_a', account_id })
		);
		registry_b.add_connection(
			on_b.ws,
			create_test_identity({ session_hash: 'session_hash_b', account_id })
		);
		audit.notify(create_test_audit_event({ event_type: 'logout', account_id }));
		assert.strictEqual(on_a.closes[0]?.code, WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(on_b.closes[0]?.code, WS_CLOSE_SESSION_REVOKED);
	});

	test('no live connection mounted, no revocation guard registered', async () => {
		// the guard is registered with a WS endpoint or the audit stream, which
		// is what a revocation has to reach
		const { config, audit } = await create_test_setup();
		await create_tracked_app_server({ ...config });
		assert.strictEqual(audit.listener_count(), 0);
	});

	test('the audit stream alone registers the revocation guard, which closes a stream after its row reaches it', async () => {
		// no WS endpoint: the audit stream is the live connection the guard has
		// to reach, and the stream's broadcast listener runs before the guard,
		// so a revoked admin's stream gets the revocation row, then ends
		const { config, audit } = await create_test_setup();
		const result = await create_tracked_app_server({ ...config, audit_log_sse: true });
		assert.ok(result.audit_sse);
		// 1 (audit_sse broadcast) + 1 (revocation guard)
		assert.strictEqual(audit.listener_count(), 2);

		const account_id: Uuid = create_uuid();
		const log_of_stream: Array<string> = [];
		result.audit_sse.registry.subscribe(
			{
				send: (notification) => log_of_stream.push(`send:${notification.method}`),
				close: () => log_of_stream.push('close'),
				on_close: () => {}
			},
			{ scope: 'session_hash_stream_only', groups: [account_id] }
		);

		audit.notify(
			create_test_audit_event({
				event_type: 'role_grant_revoke',
				account_id: create_uuid(),
				target_account_id: account_id,
				metadata: { role: ROLE_ADMIN, role_grant_id: create_uuid(), scope_id: null }
			})
		);

		assert.deepStrictEqual(log_of_stream, ['send:role_grant_revoke', 'close']);
		assert.strictEqual(result.audit_sse.registry.count, 0);
	});

	test('every mounted registry joins deps.connection_closer', async () => {
		// The revocation handlers and the revocation guard close through
		// `deps.connection_closer`. A registry left out of it would keep a
		// revoked credential's sockets open, so the mount adds every
		// registry, supplied or created.
		const stub = create_stub_upgrade();
		const { config, audit } = await create_test_setup();
		const supplied = new ConnectionRegistry();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				build_minimal_spec({ path: '/api/ws_a', registry: supplied }),
				// no registry supplied — the mount creates one
				build_minimal_spec({ path: '/api/ws_b' })
			]
		});
		assert.strictEqual(audit.listener_count(), 1, 'the one revocation guard');
		const created = result.ws_endpoints['/api/ws_b'];
		assert.ok(created);
		assert.notStrictEqual(created, supplied);

		const account_id: Uuid = create_uuid();
		const other_account_id: Uuid = create_uuid();
		const on_supplied = create_fake_ws();
		const on_created = create_fake_ws();
		const bystander = create_fake_ws();
		supplied.add_connection(
			on_supplied.ws,
			create_test_identity({ session_hash: 'session_hash_supplied', account_id })
		);
		created.add_connection(
			on_created.ws,
			create_test_identity({ session_hash: 'session_hash_created', account_id })
		);
		created.add_connection(
			bystander.ws,
			create_test_identity({ session_hash: 'session_hash_bystander', account_id: other_account_id })
		);

		const { connection_closer } = config.backend.deps;
		assert.strictEqual(connection_closer.close_connections({ kind: 'account', account_id }), 2);
		assert.strictEqual(on_supplied.closes[0]?.code, WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(on_created.closes[0]?.code, WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(bystander.closes.length, 0);
	});

	test('audit_log_sse joins deps.connection_closer alongside the WS transports', async () => {
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const registry = new ConnectionRegistry();
		const result = await create_tracked_app_server({
			...config,
			audit_log_sse: true,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ registry })]
		});
		assert.ok(result.audit_sse);

		const account_id: Uuid = create_uuid();
		const session_hash = 'session_hash_both_transports';
		const fake_ws = create_fake_ws();
		registry.add_connection(fake_ws.ws, create_test_identity({ session_hash, account_id }));
		let stream_closed = false;
		result.audit_sse.registry.subscribe(
			{
				send: () => {},
				close: () => {
					stream_closed = true;
				},
				on_close: () => {}
			},
			{ scope: session_hash, groups: [account_id] }
		);

		// one close, both transports — the socket and the stream
		const { connection_closer } = config.backend.deps;
		assert.strictEqual(connection_closer.close_connections({ kind: 'session', session_hash }), 2);
		assert.strictEqual(fake_ws.closes[0]?.code, WS_CLOSE_SESSION_REVOKED);
		assert.ok(stream_closed);
		assert.strictEqual(result.audit_sse.registry.count, 0);
	});

	test('factory-route collision: WS at /api/surface collides with the opted-in surface route', async () => {
		// Factory routes (bootstrap, surface) get the same collision check as
		// consumer routes — the opted-in surface route is `GET /api/surface`.
		// This locks that in so a future refactor can't scope the check to
		// consumer-only routes.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const err = await assert_rejects(() =>
			create_tracked_app_server({
				...config,
				surface_route: true,
				create_upgrade_websocket: () => stub.upgradeWebSocket,
				ws_endpoints: [build_minimal_spec({ path: '/api/surface' })]
			})
		);
		assert.match(err.message, /ws_endpoints path collides with a GET RouteSpec: \/api\/surface/);
	});

	test('required_roles: any-of disjunction passes when the caller holds either listed role', async () => {
		// Auto-mount surfaces the multi-role gate identically to
		// `register_action_ws` (covered in register_action_ws.upgrade.test.ts);
		// this test confirms the array threads through unchanged.
		const stub = create_stub_upgrade();
		const { config } = await create_test_setup();
		const result = await create_tracked_app_server({
			...config,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [build_minimal_spec({ required_roles: [ROLE_ADMIN, 'keeper'] })]
		});

		const ws_endpoint = result.surface_spec.surface.ws_endpoints[0];
		assert.isDefined(ws_endpoint);
		assert.deepStrictEqual(ws_endpoint.required_roles, [ROLE_ADMIN, 'keeper']);
	});
});
