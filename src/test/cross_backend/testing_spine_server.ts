/**
 * Domain-free TS spine app builder for fuz_app's own cross-process
 * self-tests.
 *
 * The TS analog of the Rust `testing_spine_stub`: mounts ONLY the standard
 * fuz_app spine surface (auth / account / admin / audit + signup +
 * bootstrap) over a real HTTP socket, with `_testing_reset` and a WS
 * endpoint, and no consumer domain layer. It exists so the
 * `describe_standard_cross_process_tests` bundle can run against fuz_app's
 * own TS impl over the wire — making drift in fuz_app's real HTTP path a
 * fuz_app failure rather than only surfacing through a downstream consumer.
 *
 * **`$lib`-free by contract.** This module + the Node/Deno entries that wrap
 * it are spawned under Gro's loader (which resolves `.js`→`.ts` + package
 * imports but NOT the `$lib` SvelteKit alias), so everything here uses
 * relative `../../lib/...` specifiers and the shared
 * `default_spine_surface.ts` (also `$lib`-free). A `$lib` import anywhere in
 * this graph would still typecheck under vitest but break the spawn.
 *
 * **NEVER ships in a release.** Lives under `src/test/` (excluded from the
 * `dist` package build) and uses `stub_password_deps` — a deterministic
 * non-Argon2 hasher.
 *
 * @module
 */

import {dirname, join} from 'node:path';
import type {Context} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {protocol_actions} from '$lib/actions/protocol.ts';
import {register_ws_endpoint} from '$lib/actions/register_ws_endpoint.ts';
import {BackendWebsocketTransport} from '$lib/actions/transports_ws_backend.ts';
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
} from '$lib/actions/transports_ws_auth_guard.ts';
import {start_daemon_token_rotation} from '$lib/auth/daemon_token_middleware.ts';
import {load_env} from '$lib/env/load.ts';
import type {RuntimeDeps} from '$lib/runtime/deps.ts';
import {cell_audit_events} from '$lib/auth/cell_audit_events.ts';
import {create_audit_emitter} from '$lib/auth/audit_emitter.ts';
import {create_audit_log_config} from '$lib/auth/audit_log_schema.ts';
import {CELL_MIGRATION_NS} from '$lib/db/cell_ddl.ts';
import {CELL_HISTORY_MIGRATION_NS} from '$lib/db/cell_history_ddl.ts';
import {FACT_MIGRATION_NS} from '$lib/db/fact_ddl.ts';
import {
	create_serve_cell_fact_route_spec,
	create_serve_fact_route_spec,
} from '$lib/server/serve_fact_route.ts';
import {create_app_backend, type AuditFactory} from '$lib/server/app_backend.ts';
import {create_app_server} from '$lib/server/app_server.ts';
import {
	RateLimiter,
	default_login_account_rate_limit,
	default_login_ip_rate_limit,
} from '$lib/rate_limiter.ts';
import {BaseServerEnv, validate_server_env} from '$lib/server/env.ts';
import {stub_password_deps} from '$lib/testing/app_server.ts';
import {
	create_spine_ready_route_spec,
	create_spine_route_specs,
	spine_session_options,
} from '$lib/testing/cross_backend/default_spine_surface.ts';
import {full_spine_rpc_endpoints} from '$lib/testing/cross_backend/full_spine_mount.ts';
import type {BuiltTestingApp} from '$lib/testing/cross_backend/testing_server_core.ts';

/** Resolved bind config the entry passes to `start_testing_server`. */
export interface SpineServerConfig {
	readonly host: string;
	readonly port: number;
}

/** Options for {@link build_spine_app}. */
export interface BuildSpineAppOptions {
	/** `RuntimeDeps` from the runtime adapter (env + fs capabilities). */
	readonly runtime: RuntimeDeps;
	/** Extract the raw TCP connection IP from a Hono context (adapter-specific). */
	readonly get_connection_ip: (c: Context) => string | undefined;
	/**
	 * Path where daemon-token rotation writes the deterministic token. The
	 * cross-process harness reads it after the health probe, so it must equal
	 * `BackendConfig.bootstrap.daemon_token_path` (`{root}/run/daemon_token`).
	 */
	readonly daemon_token_path: string;
	/** WS mount path. Default `/api/ws`. */
	readonly ws_path?: string;
}

const WS_PATH_DEFAULT = '/api/ws';
const HEALTH_PATH = '/health';

/**
 * Audit factory registering the cell event types so the live-mounted cell
 * handlers' `deps.audit.emit(...)` calls validate against the extended config
 * (and `cell_audit_list` reads them back) instead of tripping the
 * unknown-event drift counter. Models a real consumer that spreads
 * `cell_audit_events` into its `create_audit_log_config`.
 */
const cell_audit_factory: AuditFactory = ({db, log}) =>
	create_audit_emitter({
		db,
		log,
		audit_log_config: create_audit_log_config({extra_events: cell_audit_events}),
	});

/** Resolve `{host, port}` from the runtime's env via `BaseServerEnv`. */
export const resolve_spine_server_config = (runtime: RuntimeDeps): SpineServerConfig => {
	const env = load_env(BaseServerEnv, runtime.env_get);
	return {host: env.HOST, port: env.PORT};
};

/**
 * Build the no-domain spine Hono app + close + WS mount hook.
 *
 * Uses `stub_password_deps` (fast deterministic hasher), in-memory PGlite
 * by default (`DATABASE_URL=memory://`), every rate limiter disabled, and
 * appends `_testing_reset` to the standard RPC endpoint so the cross-process
 * fixture protocol can reset per test. Bootstrap runs live (the harness
 * consumes it once in `globalSetup`).
 */
export const build_spine_app = async (options: BuildSpineAppOptions): Promise<BuiltTestingApp> => {
	const {runtime, get_connection_ip, daemon_token_path, ws_path = WS_PATH_DEFAULT} = options;
	const log = new Logger('[testing_spine_server]');

	const env = load_env(BaseServerEnv, runtime.env_get);

	const env_config = validate_server_env(env);
	if (!env_config.ok) {
		throw new Error(
			`testing_spine_server: invalid ${env_config.field}: ${env_config.errors.join('; ')}`,
		);
	}
	const {keyring, allowed_origins, bootstrap_token_path} = env_config;

	const app_backend = await create_app_backend({
		database_url: env.DATABASE_URL,
		keyring,
		password: stub_password_deps,
		stat: runtime.stat,
		read_text_file: runtime.read_text_file,
		delete_file: runtime.remove,
		audit_factory: cell_audit_factory,
		// Splice the `fuz_cell` + `fuz_facts` schemas after the builtin auth
		// namespace so the cell verbs + the fact-serving routes below have their
		// tables. Both stay off the standard declared surface
		// (`create_spine_surface_spec`) — driven only by the dedicated cell /
		// fact-serving cross suites, ws/sse-style. `CELL_HISTORY_MIGRATION_NS`
		// stages the dormant `cell_history` table (the Rust `fuz_cell` migration
		// bundles it; TS isolates it in its own namespace) so the schema-parity
		// gate sees the same full spine schema on both backends.
		migration_namespaces: [CELL_MIGRATION_NS, CELL_HISTORY_MIGRATION_NS, FACT_MIGRATION_NS],
	});

	// Facts dir for the disk-stream / X-Accel serving paths. The cross suite
	// seeds embedded facts via `_testing_put_fact`, so this is unused there;
	// it's a required option on the serve route factories.
	const facts_dir = join(dirname(dirname(daemon_token_path)), 'facts');

	// Ensure the daemon-token dir exists — `spawn_backend` creates the backend
	// root (for the bootstrap token) but not the `run/` subdir the rotation
	// writer lands the token in.
	await runtime.mkdir(dirname(daemon_token_path), {recursive: true});

	// Daemon-token rotation is required — `_testing_reset` gates on the
	// daemon-token credential, and the harness reads the rotated token to
	// authenticate the keeper channel.
	const daemon_token_rotation = await start_daemon_token_rotation(
		runtime,
		{db: app_backend.deps.db},
		{token_path: daemon_token_path},
		log,
	);

	// Created up front so the audit-revocation guards AND the role-grant-offer
	// `notification_sender` bind to the SAME transport the WS endpoint registers
	// connections against (the transport is the connection registry — a separate
	// instance would fan out to an empty registry and reach nobody). Threaded
	// into `spine_rpc_endpoints({notification_sender})` below and into
	// `register_ws_endpoint` in `mount_websocket`.
	const ws_transport = new BackendWebsocketTransport();

	// Login rate limiting is OFF by default — the standard cross suites fire
	// many login/signup round-trips per backend lifetime from one host (loopback),
	// which a live limiter would 429. The dedicated login-security cross project
	// spawns a backend with `FUZ_LOGIN_RATE_LIMIT_ENABLED=true` to exercise the
	// 429 + `Retry-After` path and XFF-keyed bucketing over the wire (see
	// `testing/cross_backend/login_security.ts`). `trusted_proxies` is always
	// wired below, so the resolved client IP keys the limiter; the security suite
	// spoofs per-case `X-Forwarded-For` IPs so each case is its own fresh bucket.
	// Read the raw flag directly — it's a test-binary-only toggle, not part of the
	// production `BaseServerEnv` schema. The literal is the canonical
	// `LOGIN_RATE_LIMIT_ENABLED_ENV` (in `default_backend_configs.ts`, where the
	// backend configs set it for both impls), re-declared here because that module
	// transitively pulls `vitest` and can't be imported into the spawned binary —
	// the same local-redeclare `testing_spine_server_node.ts` does for `TS_SPINE_DIR_ENV`.
	const login_rate_limit_enabled = runtime.env_get('FUZ_LOGIN_RATE_LIMIT_ENABLED') === 'true';
	const ip_rate_limiter = login_rate_limit_enabled
		? new RateLimiter(default_login_ip_rate_limit)
		: null;
	const login_account_rate_limiter = login_rate_limit_enabled
		? new RateLimiter(default_login_account_rate_limit)
		: null;

	const app_server = await create_app_server({
		backend: app_backend,
		session_options: spine_session_options,
		allowed_origins,
		proxy: {trusted_proxies: ['127.0.0.1', '::1'], get_connection_ip},
		// Login limiters: null unless `FUZ_LOGIN_RATE_LIMIT_ENABLED` is set (above).
		// `create_spine_route_specs` reads these off `AppServerContext` and wires
		// them onto `POST /api/account/login`. Every other limiter stays disabled
		// for the same many-round-trips-from-one-host reason.
		ip_rate_limiter,
		login_account_rate_limiter,
		signup_account_rate_limiter: null,
		bearer_ip_rate_limiter: null,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null,
		daemon_token_state: daemon_token_rotation.state,
		bootstrap: bootstrap_token_path
			? {mode: 'live', token_path: bootstrap_token_path}
			: {mode: 'disabled'},
		// Auto-wires the SSE registry + auth guard + broadcaster and sets
		// `ctx.audit_sse`, which `create_spine_route_specs` reads to mount
		// `GET /api/admin/audit/stream` (`audit_log_event_specs` join the
		// surface automatically). Drives the cross-process SSE self-test.
		audit_log_sse: true,
		// Standard spine REST routes + the cell-gated fact-serving routes
		// (cell-scoped per-reference + admin-only bare-hash), twinning the Rust
		// `testing_spine_stub`'s `fact_routers`. The serve routes carry full
		// `/api/...` paths and stay off `create_spine_surface_spec` (the shared
		// surface), so the standard round-trip never tries to drive them — the
		// dedicated `describe_fact_serving_cross_tests` suite does.
		create_route_specs: (ctx) => [
			...create_spine_route_specs(ctx),
			// `/ready` deploy gate — column-presence schema-drift probe over the
			// committed `expected_schema.json`. Live-mounted but off the declared
			// surface (`create_spine_surface_spec`), like the fact-serving routes —
			// driven by the dedicated `describe_ready_cross_tests` suite, not the
			// generic round-trip.
			create_spine_ready_route_spec(log),
			create_serve_cell_fact_route_spec({deps: ctx.deps, facts_dir, log}),
			create_serve_fact_route_spec({deps: ctx.deps, facts_dir, log}),
		],
		// The full live RPC mount: the standard bundle plus the off-declared-surface
		// families (`_testing_*` backdoors, the full cell verb set, the opt-in
		// `actor_lookup` / `actor_search` resolvers). Single-sourced in
		// `full_spine_mount.ts` so the binary, the in-process parity setup, and the
		// `spine_method_coverage` reconciliation test all build the same list — a
		// method can't be mounted here and forgotten elsewhere. Cells / actors stay
		// off `create_spine_surface_spec`, so the standard cross suite's generic
		// round-trip never drives them (they're covered by the dedicated cell /
		// actor cross suites). The shared `ws_transport` is threaded as the
		// role-grant-offer `notification_sender` so the spine emits the WS
		// notification family — driving `describe_role_grant_offer_notification_ws_tests`.
		rpc_endpoints: (ctx) =>
			full_spine_rpc_endpoints(ctx, {
				notification_sender: ws_transport,
				daemon_token_state: daemon_token_rotation.state,
			}),
		env_schema: BaseServerEnv,
		env_values: env,
		// Await fire-and-forget effects before each response returns, so a
		// mutation's audit emits are durable by response time. Makes the
		// `_testing_drain_effects` barrier satisfied by construction on the TS
		// spine (the Rust stub, whose audit writes are detached tasks, does the
		// real await in `AuditEmitter::drain_inflight`). Matches the in-process
		// `create_test_app` default.
		await_pending_effects: true,
		on_effect_error: (error, ctx) => {
			log.error(`Pending effect failed (${ctx.method} ${ctx.path}):`, error);
		},
	});

	// Health probe endpoint — the spawn harness polls this for readiness.
	// `create_app_server` does not mount one.
	app_server.app.get(HEALTH_PATH, (c) => c.json({status: 'ok'}));

	const close = async (): Promise<void> => {
		await daemon_token_rotation.stop();
		ip_rate_limiter?.dispose();
		login_account_rate_limiter?.dispose();
		await app_server.close();
	};

	// WS is mounted after the app exists (Node's `createNodeWebSocket` needs
	// the app) — see `testing_server_core.ts`. Protocol actions only; the
	// no-domain spine carries no domain WS surface.
	const mount_websocket = (upgrade_websocket: UpgradeWebSocket): void => {
		register_ws_endpoint({
			app: app_server.app,
			path: ws_path,
			allowed_origins,
			db: app_backend.deps.db,
			upgradeWebSocket: upgrade_websocket,
			actions: protocol_actions,
			transport: ws_transport,
			log,
		});
		app_backend.deps.audit.on_event_chain.push(
			create_ws_auth_guard(ws_transport, log),
			create_ws_logout_closer(ws_transport, log),
		);
	};

	return {app: app_server.app, close, mount_websocket};
};
