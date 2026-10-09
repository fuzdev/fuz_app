/**
 * `create_app_server`'s ownership of shutdown and of the rate limiters it
 * builds.
 *
 * - `AppServer.close` order: connections closed, then the built limiters
 *   disposed, then the database closed — after the auth cleanup schedule
 *   stops (`create_app_server.auth_cleanup.db.test.ts` pins that step)
 * - `close` reaches every live connection on the backend's closer — the
 *   auto-created WS transport, one supplied through `WsEndpointSpec.transport`,
 *   the audit SSE registry — and a member that throws spares neither the rest
 *   nor the database
 * - `close` is idempotent, and concurrent calls share one shutdown
 * - only the limiters the server built are disposed, never an injected one
 * - `rate_limiters` mode precedence: an explicit option wins, the mode decides
 *   an omitted one
 * - the disabled-limiter diagnostics
 *
 * A socket opened through the assembled app's upgrade path and closed by
 * `close` is in `create_app_server_ws_endpoints.dispatch.db.test.ts`.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';
import { z } from 'zod';

import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions
} from '$lib/server/app_server.ts';
import type { AppServerContext } from '$lib/server/app_server_context.ts';
import type { AppBackend } from '$lib/server/app_backend.ts';
import { create_stub_app_deps } from '$lib/testing/stubs.ts';
import { create_recording_audit_emitter } from '$lib/testing/audit_drift_guard.ts';
import { create_fake_ws, create_stub_upgrade } from '$lib/testing/ws_round_trip.ts';
import { create_recording_closer } from '$lib/testing/connection_closer_helpers.ts';
import { protocol_actions } from '$lib/actions/protocol.ts';
import { BackendWebsocketTransport } from '$lib/actions/transports_ws_backend.ts';
import { WS_CLOSE_GOING_AWAY } from '$lib/actions/transports.ts';
import type { ConnectionCloser } from '$lib/actions/connection_closer.ts';
import type { SseStream } from '$lib/realtime/sse.ts';
import { RateLimiter, create_rate_limiter, type RateLimiterMode } from '$lib/rate_limiter.ts';

const log = new Logger('test', { level: 'off' });

/** The seven limiter options, and the `AppServerContext` field each resolves to. */
const LIMITER_NAMES = [
	'login_ip_rate_limiter',
	'signup_ip_rate_limiter',
	'bootstrap_ip_rate_limiter',
	'login_account_rate_limiter',
	'signup_account_rate_limiter',
	'action_ip_rate_limiter',
	'action_account_rate_limiter'
] as const;
type LimiterName = (typeof LIMITER_NAMES)[number];

interface Harness {
	backend: AppBackend;
	/** What happened during shutdown, in order. */
	events: Array<string>;
	/** How many times the backend's `close` ran. */
	backend_closes: () => number;
}

const create_harness = (): Harness => {
	const events: Array<string> = [];
	let backend_closes = 0;
	const deps = create_stub_app_deps();
	deps.log = log;
	// accepts the listeners `audit_log_sse` and the WS auth guard register
	deps.audit = create_recording_audit_emitter().emitter;
	const backend: AppBackend = {
		db_type: 'pglite-memory',
		db_name: '(stub)',
		migration_results: [],
		close: async () => {
			backend_closes++;
			events.push('db');
		},
		deps
	};
	return { backend, events, backend_closes: () => backend_closes };
};

const base_options = (
	backend: AppBackend
): Pick<
	AppServerOptions,
	'backend' | 'session_options' | 'allowed_origins' | 'proxy' | 'env_schema' | 'create_route_specs'
> => ({
	backend,
	session_options: create_session_config('test_session'),
	allowed_origins: [/^http:\/\/localhost/],
	proxy: { trusted_proxies: ['127.0.0.1'], get_connection_ip: () => '127.0.0.1' },
	env_schema: z.object({}),
	create_route_specs: () => [create_health_route_spec()]
});

/** Assemble a server and capture the `AppServerContext` its route factory saw. */
const assemble = async (
	options: Partial<AppServerOptions> = {}
): Promise<{ server: AppServer; ctx: AppServerContext; harness: Harness }> => {
	const harness = create_harness();
	let ctx: AppServerContext | null = null;
	const server = await create_app_server({
		...base_options(harness.backend),
		...options,
		create_route_specs: (context) => {
			ctx = context;
			return [create_health_route_spec()];
		}
	});
	servers.push(server);
	return { server, ctx: ctx!, harness };
};

const create_mock_stream = (): SseStream & { closed: boolean } => {
	let closed = false;
	return {
		get closed() {
			return closed;
		},
		send() {},
		comment() {},
		close() {
			closed = true;
		},
		on_close() {}
	};
};

// every server a test assembles is closed, whatever the test asserted
const servers: Array<AppServer> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('AppServer.close', () => {
	test('closes connections, then disposes the built limiters, then closes the database', async () => {
		const { server, harness } = await assemble();
		harness.backend.deps.connection_closer.add({
			...create_recording_closer().closer,
			close_all_sockets: () => {
				harness.events.push('connections');
				return 0;
			}
		});
		vi.spyOn(RateLimiter.prototype, 'dispose').mockImplementation(() => {
			harness.events.push('dispose');
		});

		await server.close();
		assert.deepStrictEqual(harness.events, [
			'connections',
			...LIMITER_NAMES.map(() => 'dispose'),
			'db'
		]);
	});

	test('reaches every live connection: the auto-created transport, a supplied one, the audit streams', async () => {
		const stub = create_stub_upgrade();
		const supplied = new BackendWebsocketTransport({ log });
		const { server } = await assemble({
			audit_log_sse: true,
			create_upgrade_websocket: () => stub.upgradeWebSocket,
			ws_endpoints: [
				{ path: '/api/ws', actions: [...protocol_actions], heartbeat: false },
				{ path: '/api/ws_supplied', actions: [...protocol_actions], transport: supplied }
			]
		});
		const auto = server.ws_endpoints['/api/ws']!;
		assert.notStrictEqual(auto, supplied);
		const auto_socket = create_fake_ws();
		const supplied_socket = create_fake_ws();
		auto.add_connection(auto_socket.ws, 'session_hash', create_uuid());
		supplied.add_connection(supplied_socket.ws, null, create_uuid(), 'token_id');
		const stream = create_mock_stream();
		server.audit_sse!.registry.subscribe(stream, { scope: 'session_hash' });

		await server.close();
		assert.strictEqual(auto_socket.closes[0]?.code, WS_CLOSE_GOING_AWAY);
		assert.strictEqual(supplied_socket.closes[0]?.code, WS_CLOSE_GOING_AWAY);
		assert.ok(stream.closed, 'the audit stream closed');
		assert.strictEqual(auto.get_connection_count(), 0);
		assert.strictEqual(supplied.get_connection_count(), 0);
		assert.strictEqual(server.audit_sse!.registry.count, 0);
	});

	test('a closer member that throws spares neither the rest nor the database', async () => {
		const { server, harness } = await assemble();
		const errors: Array<Array<unknown>> = [];
		harness.backend.deps.log.error = (...args: Array<unknown>) => {
			errors.push(args);
		};
		const boom = new Error('transport close failed');
		const throwing: ConnectionCloser = {
			...create_recording_closer().closer,
			close_all_sockets: () => {
				throw boom;
			}
		};
		const after = create_recording_closer();
		harness.backend.deps.connection_closer.add(throwing);
		harness.backend.deps.connection_closer.add(after.closer);

		await server.close();
		assert.deepStrictEqual(after.calls, [{ method: 'all', id: null }]);
		assert.strictEqual(harness.backend_closes(), 1, 'the database still closed');
		assert.strictEqual(errors.length, 1, 'the failure was logged');
		assert.strictEqual(errors[0]![1], boom);
	});

	test('is idempotent, and concurrent calls share one shutdown', async () => {
		const { server, harness } = await assemble();
		const recording = create_recording_closer();
		harness.backend.deps.connection_closer.add(recording.closer);
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');

		const first = server.close();
		const second = server.close();
		assert.strictEqual(first, second, 'a concurrent call joins the shutdown in progress');
		await Promise.all([first, second]);
		await server.close();

		assert.strictEqual(harness.backend_closes(), 1);
		assert.strictEqual(recording.calls.length, 1);
		assert.strictEqual(dispose.mock.calls.length, LIMITER_NAMES.length);
	});

	test('disposes only the limiters it built, never an injected one', async () => {
		const injected = create_rate_limiter({ cleanup_interval_ms: 0 });
		const dispose = vi.spyOn(RateLimiter.prototype, 'dispose');
		const { server, ctx } = await assemble({
			login_ip_rate_limiter: injected,
			action_account_rate_limiter: null
		});
		const built = LIMITER_NAMES.map((name) => ctx[name]).filter(
			(l): l is RateLimiter => l !== null && l !== injected
		);
		assert.strictEqual(built.length, LIMITER_NAMES.length - 2);

		await server.close();
		const disposed = dispose.mock.contexts;
		assert.strictEqual(disposed.length, built.length);
		for (const limiter of built) assert.ok(disposed.includes(limiter));
		assert.ok(!disposed.includes(injected), 'the caller owns the injected limiter');
	});
});

describe('AppServerOptions.rate_limiters', () => {
	const modes: Array<RateLimiterMode | undefined> = [undefined, 'enforced', 'disabled_for_testing'];

	for (const mode of modes) {
		describe(`mode ${mode ?? '(omitted)'}`, () => {
			test(
				mode === 'disabled_for_testing'
					? 'an omitted limiter is null'
					: 'an omitted limiter is a default instance, one per surface',
				async () => {
					const { ctx } = await assemble({ rate_limiters: mode });
					const resolved = LIMITER_NAMES.map((name) => ctx[name]);
					if (mode === 'disabled_for_testing') {
						for (const limiter of resolved) assert.strictEqual(limiter, null);
					} else {
						for (const limiter of resolved) assert.instanceOf(limiter, RateLimiter);
						assert.strictEqual(new Set(resolved).size, LIMITER_NAMES.length, 'no shared bucket');
					}
				}
			);

			test('an explicit instance wins', async () => {
				const injected: Partial<Record<LimiterName, RateLimiter>> = {};
				for (const name of LIMITER_NAMES) {
					injected[name] = create_rate_limiter({ cleanup_interval_ms: 0 });
				}
				const { ctx } = await assemble({ rate_limiters: mode, ...injected });
				for (const name of LIMITER_NAMES) assert.strictEqual(ctx[name], injected[name], name);
			});

			test('an explicit null wins', async () => {
				const nulls: Partial<Record<LimiterName, null>> = {};
				for (const name of LIMITER_NAMES) nulls[name] = null;
				const { ctx } = await assemble({ rate_limiters: mode, ...nulls });
				for (const name of LIMITER_NAMES) assert.strictEqual(ctx[name], null, name);
			});
		});
	}

	test('an explicit limiter under the disabled mode reaches the context', async () => {
		// the mode reaches the RPC mount: a disabled action limiter lets a
		// `rate_limit: 'ip'` action through past any default budget
		const { ctx } = await assemble({
			rate_limiters: 'disabled_for_testing',
			action_ip_rate_limiter: create_rate_limiter({ cleanup_interval_ms: 0 })
		});
		assert.instanceOf(ctx.action_ip_rate_limiter, RateLimiter);
		assert.strictEqual(ctx.action_account_rate_limiter, null);
	});
});

describe('disabled rate limiter diagnostics', () => {
	const limiter_warnings = (server: AppServer): Array<string> =>
		server.surface_spec.surface.diagnostics
			.filter((d) => d.level === 'warning' && d.message.includes('rate limiter'))
			.map((d) => d.message);

	test('none when every limiter is enforced', async () => {
		const { server } = await assemble();
		assert.deepStrictEqual(limiter_warnings(server), []);
	});

	test('one per explicitly-null limiter, naming its surface', async () => {
		const nulls: Partial<Record<LimiterName, null>> = {};
		for (const name of LIMITER_NAMES) nulls[name] = null;
		const { server } = await assemble(nulls);
		assert.deepStrictEqual(limiter_warnings(server), [
			'login IP rate limiter explicitly disabled (null)',
			'signup IP rate limiter explicitly disabled (null)',
			'bootstrap IP rate limiter explicitly disabled (null)',
			'login account rate limiter explicitly disabled (null)',
			'signup account rate limiter explicitly disabled (null)',
			'action IP rate limiter explicitly disabled (null)',
			'action account rate limiter explicitly disabled (null)'
		]);
		for (const d of server.surface_spec.surface.diagnostics) {
			if (d.message.includes('rate limiter')) assert.strictEqual(d.category, 'security');
		}
	});

	test('only the null ones', async () => {
		const { server } = await assemble({ action_account_rate_limiter: null });
		assert.deepStrictEqual(limiter_warnings(server), [
			'action account rate limiter explicitly disabled (null)'
		]);
	});

	test('one warning for the disabled mode, not one per limiter', async () => {
		const { server } = await assemble({
			rate_limiters: 'disabled_for_testing',
			login_ip_rate_limiter: null
		});
		const warnings = server.surface_spec.surface.diagnostics.filter((d) =>
			d.message.includes('rate limiter')
		);
		assert.strictEqual(warnings.length, 1);
		assert.strictEqual(warnings[0]!.level, 'warning');
		assert.strictEqual(warnings[0]!.category, 'security');
		assert.match(warnings[0]!.message, /disabled_for_testing/);
	});

	test('the disabled mode is logged at warn during assembly', async () => {
		const warnings: Array<string> = [];
		const harness = create_harness();
		harness.backend.deps.log = new Logger('test', { level: 'warn' });
		harness.backend.deps.log.warn = (...args: Array<unknown>) => {
			warnings.push(args.map(String).join(' '));
		};
		const server = await create_app_server({
			...base_options(harness.backend),
			rate_limiters: 'disabled_for_testing'
		});
		servers.push(server);
		assert.ok(
			warnings.some((w) => w.includes('disabled_for_testing')),
			`no warning logged: ${JSON.stringify(warnings)}`
		);
	});
});

describe('disabled-mode stderr banner', () => {
	/**
	 * A fresh module graph, so the once-per-process flag starts unset whatever
	 * earlier tests in this file assembled.
	 */
	const import_fresh = async () => {
		vi.resetModules();
		const { create_app_server: fresh_create_app_server } =
			await import('$lib/server/app_server.ts');
		const { RATE_LIMITERS_DISABLED_BANNER } = await import('$lib/rate_limiter.ts');
		return { fresh_create_app_server, RATE_LIMITERS_DISABLED_BANNER };
	};

	const assemble_fresh = async (
		create: typeof create_app_server,
		options: Partial<AppServerOptions>
	): Promise<void> => {
		const harness = create_harness();
		servers.push(await create({ ...base_options(harness.backend), ...options }));
	};

	test('prints once per process, past a silenced logger', async () => {
		const { fresh_create_app_server, RATE_LIMITERS_DISABLED_BANNER } = await import_fresh();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// the harness logger is `level: 'off'`, so only the banner can reach stderr
		await assemble_fresh(fresh_create_app_server, { rate_limiters: 'disabled_for_testing' });
		await assemble_fresh(fresh_create_app_server, { rate_limiters: 'disabled_for_testing' });
		assert.deepStrictEqual(error_spy.mock.calls, [[RATE_LIMITERS_DISABLED_BANNER]]);
		assert.include(RATE_LIMITERS_DISABLED_BANNER, 'RATE LIMITERS DISABLED');
	});

	test('silent when the mode nulls no limiter', async () => {
		const { fresh_create_app_server } = await import_fresh();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const nulls: Partial<Record<LimiterName, null>> = {};
		for (const name of LIMITER_NAMES) nulls[name] = null;
		// enforced, with or without explicit nulls — the surface warnings cover those
		await assemble_fresh(fresh_create_app_server, {});
		await assemble_fresh(fresh_create_app_server, nulls);
		// disabled, but every limiter passed explicitly
		const explicit: Partial<Record<LimiterName, RateLimiter>> = {};
		for (const name of LIMITER_NAMES)
			explicit[name] = create_rate_limiter({ cleanup_interval_ms: 0 });
		await assemble_fresh(fresh_create_app_server, {
			rate_limiters: 'disabled_for_testing',
			...explicit
		});
		assert.deepStrictEqual(error_spy.mock.calls, []);
	});
});
