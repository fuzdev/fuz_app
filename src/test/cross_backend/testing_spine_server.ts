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

import {dirname} from 'node:path';
import type {Context} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {protocol_actions} from '../../lib/actions/protocol.js';
import {register_ws_endpoint} from '../../lib/actions/register_ws_endpoint.js';
import {BackendWebsocketTransport} from '../../lib/actions/transports_ws_backend.js';
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
} from '../../lib/actions/transports_ws_auth_guard.js';
import {start_daemon_token_rotation} from '../../lib/auth/daemon_token_middleware.js';
import {load_env} from '../../lib/env/load.js';
import type {RuntimeDeps} from '../../lib/runtime/deps.js';
import {create_cell_actions} from '../../lib/auth/cell_actions.js';
import {create_cell_grant_actions} from '../../lib/auth/cell_grant_actions.js';
import {create_cell_field_actions} from '../../lib/auth/cell_field_actions.js';
import {create_cell_item_actions} from '../../lib/auth/cell_item_actions.js';
import {create_cell_audit_actions} from '../../lib/auth/cell_audit_actions.js';
import {cell_audit_events} from '../../lib/auth/cell_audit_events.js';
import {create_audit_emitter} from '../../lib/auth/audit_emitter.js';
import {create_audit_log_config} from '../../lib/auth/audit_log_schema.js';
import {CELL_MIGRATION_NS} from '../../lib/db/cell_ddl.js';
import {create_app_backend, type AuditFactory} from '../../lib/server/app_backend.js';
import {create_app_server} from '../../lib/server/app_server.js';
import {BaseServerEnv, validate_server_env} from '../../lib/server/env.js';
import {stub_password_deps} from '../../lib/testing/app_server.js';
import {
	create_spine_route_specs,
	spine_roles,
	spine_rpc_endpoints,
	spine_session_options,
} from '../../lib/testing/cross_backend/default_spine_surface.js';
import {create_testing_actions} from '../../lib/testing/cross_backend/testing_reset_actions.js';
import type {BuiltTestingApp} from '../../lib/testing/cross_backend/testing_server_core.js';

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
		// Splice the `fuz_cell` schema after the builtin auth namespace so the
		// cell verbs below have their tables. Cells stay off the standard
		// declared surface (`create_spine_surface_spec`) — they're driven only
		// by the dedicated cell cross suites, ws/sse-style.
		migration_namespaces: [CELL_MIGRATION_NS],
	});

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

	// Created up front so the audit-revocation guards bind to the same
	// transport the WS endpoint registers connections against.
	const ws_transport = new BackendWebsocketTransport();

	const app_server = await create_app_server({
		backend: app_backend,
		session_options: spine_session_options,
		allowed_origins,
		proxy: {trusted_proxies: ['127.0.0.1', '::1'], get_connection_ip},
		// Disable every limiter — the cross-process harness fires many
		// signup/login round-trips per backend lifetime from one host.
		ip_rate_limiter: null,
		login_account_rate_limiter: null,
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
		create_route_specs: create_spine_route_specs,
		// Append `_testing_reset` + the full cell surface (CRUD + grant +
		// field + item + audit) to the standard RPC endpoint. Both are
		// live-mounted but stay off the declared surface
		// (`create_spine_surface_spec`) so the standard cross suite's generic
		// round-trip never tries to drive them — cells are stateful and are
		// covered by the dedicated cell cross suites instead. Only actor-shaped
		// grants are exercised, so `spine_roles` (built-in only) suffices for
		// the grant role-validity gate.
		rpc_endpoints: (ctx) =>
			spine_rpc_endpoints(ctx).map((endpoint) => ({
				...endpoint,
				actions: [
					...endpoint.actions,
					...create_testing_actions(ctx.deps, {
						session_options: spine_session_options,
						daemon_token_state: daemon_token_rotation.state,
					}),
					...create_cell_actions(ctx.deps),
					...create_cell_grant_actions({...ctx.deps, roles: spine_roles}),
					...create_cell_field_actions(ctx.deps),
					...create_cell_item_actions(ctx.deps),
					...create_cell_audit_actions(),
				],
			})),
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
