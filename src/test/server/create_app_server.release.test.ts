/**
 * `create_app_server`'s releases — what assembly acquires that outlives it
 * (the rate limiters it builds, the listeners it registers on `deps.audit`,
 * the members it adds to `deps.connection_closer`) is released:
 *
 * - when assembly throws, at any step — every acquisition made so far, last
 *   first, and the original error is the one rethrown; a release that throws
 *   is logged and spares the rest
 * - by `AppServer.close`, last first, so the backend's emitter and closer end
 *   where they started
 *
 * The close order and the limiter-ownership rules are
 * `create_app_server.close.test.ts`.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { z } from 'zod';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions
} from '$lib/server/app_server.ts';
import type { AppBackend } from '$lib/server/app_backend.ts';
import { create_stub_app_deps } from '$lib/testing/stubs.ts';
import { create_recording_audit_emitter } from '$lib/testing/audit_drift_guard.ts';
import { create_stub_upgrade } from '$lib/testing/ws_round_trip.ts';
import { create_recording_closer } from '$lib/testing/connection_closer_helpers.ts';
import { protocol_actions } from '$lib/actions/protocol.ts';
import { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import type { WsEndpointSpec } from '$lib/actions/ws_endpoint_spec.ts';
import { RateLimiter } from '$lib/rate_limiter.ts';

const log = new Logger('test', { level: 'off' });

/** How many limiters `rate_limiters: 'enforced'` builds when none is passed. */
const BUILT_LIMITER_COUNT = 7;

interface Harness {
	backend: AppBackend;
	/** Errors the server logged. */
	errors: Array<Array<unknown>>;
	/** The listener count and closer member count before any assembly. */
	baseline: { listeners: number; members: number };
}

/**
 * A stub backend whose emitter and closer already hold one entry each that
 * isn't the server's — a release must take out only what the server added.
 */
const create_harness = (): Harness => {
	const deps = create_stub_app_deps();
	const errors: Array<Array<unknown>> = [];
	deps.log = new Logger('test', { level: 'off' });
	deps.log.error = (...args: Array<unknown>) => {
		errors.push(args);
	};
	deps.audit = create_recording_audit_emitter().emitter;
	deps.audit.add_listener(() => {});
	deps.connection_closer.add(create_recording_closer().closer);
	const backend: AppBackend = {
		db_type: 'pglite-memory',
		db_name: '(stub)',
		migration_results: [],
		close: async () => {},
		deps
	};
	return {
		backend,
		errors,
		baseline: {
			listeners: deps.audit.listener_count(),
			members: deps.connection_closer.member_count()
		}
	};
};

/** One acquisition of each kind: audit SSE, built limiters, a WS endpoint with a guard and an extra handler. */
const acquiring_options = (backend: AppBackend): AppServerOptions => ({
	backend,
	session_options: create_session_config('test_session'),
	allowed_origins: [/^http:\/\/localhost/],
	proxy: { trusted_proxies: ['127.0.0.1'], get_connection_ip: () => '127.0.0.1' },
	env_schema: z.object({}),
	create_route_specs: () => [create_health_route_spec()],
	rate_limiters: 'enforced',
	audit_log_sse: true,
	create_upgrade_websocket: () => create_stub_upgrade().upgradeWebSocket,
	ws_endpoints: [ws_endpoint('/api/ws')]
});

const ws_endpoint = (path: string, overrides?: Partial<WsEndpointSpec>): WsEndpointSpec => ({
	path,
	actions: [...protocol_actions],
	heartbeat: false,
	extra_audit_handlers: [() => {}],
	...overrides
});

const current = (harness: Harness): { listeners: number; members: number } => ({
	listeners: harness.backend.deps.audit.listener_count(),
	members: harness.backend.deps.connection_closer.member_count()
});

/** Assemble expecting a throw; return what was thrown. */
const assemble_rejects = async (options: AppServerOptions): Promise<unknown> => {
	try {
		servers.push(await create_app_server(options));
	} catch (error) {
		return error;
	}
	assert.fail('assembly should have thrown');
};

/** The listeners and closer members are back to the baseline, every built limiter disposed. */
const assert_released = (harness: Harness, dispose: { mock: { contexts: Array<unknown> } }) => {
	assert.deepStrictEqual(current(harness), harness.baseline);
	assert.strictEqual(new Set(dispose.mock.contexts).size, BUILT_LIMITER_COUNT);
	assert.strictEqual(dispose.mock.contexts.length, BUILT_LIMITER_COUNT, 'each disposed once');
};

// any server a test did assemble is closed
const servers: Array<AppServer> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('a failed assembly releases what it acquired', () => {
	test('a throwing create_route_specs — the original error is rethrown', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const boom = new Error('route factory failed');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			create_route_specs: () => {
				throw boom;
			}
		});
		assert.strictEqual(thrown, boom);
		assert_released(harness, dispose);
		assert.deepStrictEqual(harness.errors, [], 'nothing failed to release');
	});

	test('a throwing create_upgrade_websocket — the original error is rethrown', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const boom = new Error('adapter failed');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			create_upgrade_websocket: () => {
				throw boom;
			}
		});
		assert.strictEqual(thrown, boom);
		assert_released(harness, dispose);
	});

	test('ws_endpoints without create_upgrade_websocket', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			create_upgrade_websocket: undefined
		});
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /create_upgrade_websocket is missing/);
		assert_released(harness, dispose);
	});

	test('a ws endpoint outside the auth scope', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			ws_endpoints: [ws_endpoint('/ws')]
		});
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /\/ws/);
		assert_released(harness, dispose);
	});

	test('a duplicate ws path fails before any endpoint mounts', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const upgrades = vi.fn(() => create_stub_upgrade().upgradeWebSocket);
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			create_upgrade_websocket: upgrades,
			ws_endpoints: [ws_endpoint('/api/ws'), ws_endpoint('/api/ws')]
		});
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /duplicate ws_endpoints path: \/api\/ws/);
		assert.strictEqual(upgrades.mock.calls.length, 0, 'the adapter was never built');
		assert_released(harness, dispose);
	});

	test('a ws path colliding with a GET RouteSpec fails before any endpoint mounts', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const upgrades = vi.fn(() => create_stub_upgrade().upgradeWebSocket);
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			create_upgrade_websocket: upgrades,
			ws_endpoints: [ws_endpoint('/api/ws'), ws_endpoint('/api/health')],
			create_route_specs: () => [{ ...create_health_route_spec(), path: '/api/health' }]
		});
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /collides with a GET RouteSpec: \/api\/health/);
		assert.strictEqual(upgrades.mock.calls.length, 0, 'the adapter was never built');
		assert_released(harness, dispose);
	});

	// the second endpoint's mount throws after the first endpoint has added its
	// transport, its auth guard, and its extra handler
	for (const { name, endpoint, message } of [
		{
			name: 'its registry fails to compile',
			endpoint: ws_endpoint('/api/ws_second', {
				actions: [...protocol_actions, ...protocol_actions]
			}),
			message: /Duplicate WS action method/
		},
		{
			name: 'its options are rejected',
			endpoint: ws_endpoint('/api/ws_second', {
				transport: new BackendWebsocketTransport({ log }),
				max_connections_per_account: 1
			}),
			message: /max_connections_per_account/
		}
	]) {
		test(`a second ws endpoint whose mount throws — ${name} — undoes the first`, async () => {
			const harness = create_harness();
			const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
			const thrown = await assemble_rejects({
				...acquiring_options(harness.backend),
				ws_endpoints: [ws_endpoint('/api/ws'), endpoint]
			});
			assert.instanceOf(thrown, Error);
			assert.match(thrown.message, message);
			assert_released(harness, dispose);
		});
	}

	test('a transform_middleware that moves the auth middleware', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			transform_middleware: (specs) =>
				specs.map((spec) => (spec.name === 'session' ? { ...spec, path: '*' } : spec))
		});
		assert.instanceOf(thrown, Error);
		assert.match(
			thrown.message,
			/transform_middleware must keep the middleware 'session' .*\(mounted at \*\)/
		);
		assert_released(harness, dispose);
	});

	test('a throwing serve_static, after every ws acquisition', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const boom = new Error('serve_static failed');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			static_serving: {
				serve_static: () => {
					throw boom;
				}
			}
		});
		assert.strictEqual(thrown, boom);
		assert_released(harness, dispose);
	});

	test('an invalid auth_cleanup interval, after every other acquisition', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			auth_cleanup: { interval_ms: 0 }
		});
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /interval_ms/);
		assert_released(harness, dispose);
	});

	test('a release that throws is logged, spares the rest, and the original error wins', async () => {
		const harness = create_harness();
		const release_failure = new Error('dispose failed');
		let calls = 0;
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose').mockImplementation(() => {
			calls++;
			if (calls === 1) throw release_failure;
		});
		const boom = new Error('route factory failed');
		const thrown = await assemble_rejects({
			...acquiring_options(harness.backend),
			create_route_specs: () => {
				throw boom;
			}
		});
		assert.strictEqual(thrown, boom);
		assert_released(harness, dispose);
		assert.strictEqual(harness.errors.length, 1);
		assert.strictEqual(harness.errors[0]![1], release_failure);
	});
});

describe('AppServer.close releases what assembly acquired', () => {
	test('the emitter and closer end where they started', async () => {
		const harness = create_harness();
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const server = await create_app_server(acquiring_options(harness.backend));
		// the SSE listener, the WS auth guard, the extra handler; the registry, the transport
		assert.deepStrictEqual(current(harness), {
			listeners: harness.baseline.listeners + 3,
			members: harness.baseline.members + 2
		});

		await server.close();
		assert_released(harness, dispose);
		await server.close();
		assert.deepStrictEqual(
			current(harness),
			harness.baseline,
			'a second close releases nothing more'
		);
	});

	test('releases run last acquired first — the listeners before the built limiters', async () => {
		const harness = create_harness();
		const events: Array<string> = [];
		const { audit } = harness.backend.deps;
		const add_listener = audit.add_listener.bind(audit);
		audit.add_listener = (listener) => {
			const remove = add_listener(listener);
			return () => {
				events.push('listener');
				remove();
			};
		};
		const dispose = RateLimiter.prototype.dispose;
		vi.spyOn(RateLimiter.prototype, 'dispose').mockImplementation(function (this: RateLimiter) {
			events.push('dispose');
			dispose.call(this);
		});
		const server = await create_app_server(acquiring_options(harness.backend));
		await server.close();
		// the limiters are built first, so they are disposed last
		assert.deepStrictEqual(events, [
			'listener',
			'listener',
			'listener',
			...Array.from({ length: BUILT_LIMITER_COUNT }, () => 'dispose')
		]);
	});

	test('a backend whose close is a no-op hosts a second server without piling listeners', async () => {
		// the harness backend's `close` does nothing, so the first server's close
		// leaves it usable — a real backend's `close` ends its database
		const harness = create_harness();
		const first = await create_app_server(acquiring_options(harness.backend));
		const assembled = current(harness);
		await first.close();

		const second = await create_app_server(acquiring_options(harness.backend));
		assert.deepStrictEqual(current(harness), assembled);
		await second.close();
		assert.deepStrictEqual(current(harness), harness.baseline);
	});

	test('a transport the consumer also added stays on the closer', async () => {
		// the server's release takes out its own addition, not the consumer's
		const harness = create_harness();
		const supplied = new BackendWebsocketTransport({ log });
		harness.backend.deps.connection_closer.add(supplied);
		const server = await create_app_server({
			...acquiring_options(harness.backend),
			ws_endpoints: [ws_endpoint('/api/ws', { transport: supplied })]
		});
		await server.close();
		assert.strictEqual(
			harness.backend.deps.connection_closer.member_count(),
			harness.baseline.members + 1
		);
	});
});
