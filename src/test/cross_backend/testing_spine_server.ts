/**
 * Domain-free TS spine app builder for fuz_app's own cross-process
 * self-tests.
 *
 * The TS analog of the Rust `testing_spine_stub`: mounts ONLY the standard
 * fuz_app spine surface (auth / account / admin / audit + signup +
 * bootstrap) over a real HTTP socket, with `_testing_reset` and a WS
 * endpoint (auto-mounted from `ws_endpoints`), and no consumer domain layer. It exists so the
 * `describe_standard_cross_process_tests` bundle can run against fuz_app's
 * own TS impl over the wire — making drift in fuz_app's real HTTP path a
 * fuz_app failure rather than only surfacing through a downstream consumer.
 *
 * **`#lib`, not `$lib`, by contract.** This module + the Node/Deno/Bun
 * entries that wrap it are spawned as raw processes (Gro's loader, `deno
 * run`, `bun run`) — none of which resolve the Vite-only `$lib` SvelteKit
 * alias. They reach `src/lib` through the `#lib/*` package.json subpath
 * import (`"imports": {"#lib/*": "./src/lib/*"}`), which Node, Bun, Deno,
 * and Gro's loader all resolve uniformly. A `$lib` import anywhere in this
 * spawn graph would still typecheck under vitest but break the spawn.
 *
 * **NEVER ships in a release.** Lives under `src/test/` (excluded from the
 * `dist` package build) and uses `stub_password_deps` — a deterministic
 * non-Argon2 hasher.
 *
 * @module
 */

import { dirname, join } from 'node:path';
import type { Context } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { z } from 'zod';

import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '#lib/actions/transports.ts';
import { BackendWebsocketTransport } from '#lib/actions/transports_ws_backend.ts';
import type { AppSurface } from '#lib/http/surface.ts';
import { start_daemon_token_rotation } from '#lib/testing/daemon_token_rotation.ts';
import { load_env } from '#lib/env/load.ts';
import type { RuntimeDeps } from '#lib/runtime/deps.ts';
import { cell_audit_events } from '#lib/auth/cell_audit_events.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { create_audit_log_config } from '#lib/auth/audit_log_schema.ts';
import { CELL_MIGRATION_NS } from '#lib/db/cell_ddl.ts';
import { CELL_HISTORY_MIGRATION_NS } from '#lib/db/cell_history_ddl.ts';
import { FACT_MIGRATION_NS } from '#lib/db/fact_ddl.ts';
import {
	create_serve_cell_fact_route_spec,
	create_serve_fact_route_spec
} from '#lib/server/serve_fact_route.ts';
import { create_app_backend, type AuditFactory } from '#lib/server/app_backend.ts';
import { create_app_server } from '#lib/server/app_server.ts';
import {
	RateLimiter,
	default_action_account_rate_limit,
	default_action_ip_rate_limit,
	default_login_account_rate_limit,
	default_login_ip_rate_limit,
	type RateLimiterOptions
} from '#lib/rate_limiter.ts';
import { BaseServerEnv, validate_server_env } from '#lib/server/env.ts';
import { stub_password_deps } from '#lib/testing/app_server.ts';
import {
	create_spine_ready_route_spec,
	create_spine_route_specs,
	spine_session_options
} from '#lib/testing/cross_backend/default_spine_surface.ts';
import { build_full_spine_mount } from '#lib/testing/cross_backend/full_spine_mount.ts';
import {
	ACTION_RATE_LIMIT_ENABLED_ENV,
	ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV,
	LOGIN_RATE_LIMIT_ENABLED_ENV,
	SPINE_RPC_PATH
} from '#lib/testing/cross_backend/spine_surface_constants.ts';
import type {
	BuildTestingAppContext,
	BuiltTestingApp
} from '#lib/testing/cross_backend/testing_server_core.ts';

/** Resolved bind config the entry passes to `start_testing_server`. */
export interface SpineServerConfig {
	readonly host: string;
	readonly port: number;
}

/** Options for `build_spine_app`. */
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
	/**
	 * The core's WS preparation (`BuildTestingAppContext.prepare_websocket`) —
	 * its factory becomes `create_app_server`'s `create_upgrade_websocket`.
	 */
	readonly prepare_websocket: BuildTestingAppContext['prepare_websocket'];
	/** WS mount path. Default `/api/ws`. */
	readonly ws_path?: string;
}

/** The spine app plus its generated surface (for the surface-invariant test). */
export interface BuiltSpineApp extends BuiltTestingApp {
	readonly surface: AppSurface;
}

const WS_PATH_DEFAULT = '/api/ws';
const HEALTH_PATH = '/health';

/**
 * The WS endpoint's inbound message cap — passed to both the endpoint spec and
 * the adapter's preparation, so Node's `ws` frame cap matches it.
 */
const WS_MAX_MESSAGE_BYTES = DEFAULT_WS_MAX_MESSAGE_BYTES;

/** Zod's `stringbool` — the env boolean contract the Rust stub's `parse_stringbool` mirrors. */
const EnvStringbool = z.stringbool();

/**
 * Parse an optional boolean env toggle the way the Rust stub's
 * `parse_stringbool_env` does: unset is `false`; otherwise a case-insensitive
 * `true`/`1`/`yes`/`on`/`y`/`enabled` or `false`/`0`/`no`/`off`/`n`/`disabled`,
 * untrimmed. Anything else (the empty string included) throws, so a typo
 * can't silently leave a limiter off while a suite asserts its throttle.
 *
 * @param name - the env var, for the error
 * @param raw - its value, `undefined` when unset
 * @throws Error on a value outside the recognized set
 */
export const parse_stringbool_env = (name: string, raw: string | undefined): boolean => {
	if (raw === undefined) return false;
	const parsed = EnvStringbool.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`testing_spine_server: ${name}: expected a boolean string (true/false, 1/0, yes/no, on/off, y/n, enabled/disabled), got ${JSON.stringify(raw)}`
		);
	}
	return parsed.data;
};

/** `u32::MAX` — the largest cap the Rust stub's `u32` parse accepts. */
const U32_MAX = 0xffff_ffff;

/**
 * Parse `FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS` against the enable flag — a
 * positive integer, refused when set without `FUZ_ACTION_RATE_LIMIT_ENABLED`
 * (a cap that silently does nothing would leave a suite asserting a throttle
 * the binary never built). Mirrors the Rust stub's
 * `parse_action_rate_limit_max_attempts` (`raw.trim().parse::<u32>()`, then
 * `> 0`): surrounding Unicode whitespace is trimmed, one leading `+` and leading zeros
 * are accepted, and a value above `u32::MAX` is refused.
 *
 * @param raw - the env value, `undefined` when unset
 * @param enabled - the parsed enable flag
 * @returns the cap, or `undefined` when unset
 * @throws Error on a malformed or out-of-range cap, or a cap without the flag
 */
export const parse_action_rate_limit_max_attempts = (
	raw: string | undefined,
	enabled: boolean
): number | undefined => {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	const max_attempts = /^\+?[0-9]+$/.test(trimmed) ? Number(trimmed) : NaN;
	if (!(max_attempts > 0 && max_attempts <= U32_MAX)) {
		throw new Error(
			`testing_spine_server: ${ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV}: expected a positive integer, got ${JSON.stringify(raw)}`
		);
	}
	if (!enabled) {
		throw new Error(
			`testing_spine_server: ${ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV} is set but ${ACTION_RATE_LIMIT_ENABLED_ENV} is not`
		);
	}
	return max_attempts;
};

/**
 * Audit factory registering the cell event types so the live-mounted cell
 * handlers' `deps.audit.emit(...)` calls validate against the extended config
 * (and `cell_audit_list` reads them back) instead of tripping the
 * unknown-event drift counter. Models a real consumer that spreads
 * `cell_audit_events` into its `create_audit_log_config`.
 *
 * Tracks in-flight writes so `_testing_drain_effects` is a real barrier — a
 * WS mutation is answered before its audit write settles. The Rust stub
 * builds its emitter the same way (`new_with_inflight_tracking`).
 */
export const cell_audit_factory: AuditFactory = ({ db, log }) =>
	create_audit_emitter({
		db,
		log,
		audit_log_config: create_audit_log_config({ extra_events: cell_audit_events }),
		track_inflight: true
	});

/** Resolve `{host, port}` from the runtime's env via `BaseServerEnv`. */
export const resolve_spine_server_config = (runtime: RuntimeDeps): SpineServerConfig => {
	const env = load_env(BaseServerEnv, runtime.env_get);
	return { host: env.HOST, port: env.PORT };
};

/**
 * Build the no-domain spine Hono app + close.
 *
 * Uses `stub_password_deps` (fast deterministic hasher), in-memory PGlite
 * by default (`DATABASE_URL=memory://`), every rate limiter disabled
 * (`rate_limiters: 'disabled_for_testing'`) unless an env toggle opts the
 * login or action limiters in, and
 * appends `_testing_reset` to the standard RPC endpoint so the cross-process
 * fixture protocol can reset per test. Bootstrap runs live (the harness
 * consumes it once in `globalSetup`).
 */
export const build_spine_app = async (options: BuildSpineAppOptions): Promise<BuiltSpineApp> => {
	const {
		runtime,
		get_connection_ip,
		daemon_token_path,
		prepare_websocket,
		ws_path = WS_PATH_DEFAULT
	} = options;
	const log = new Logger('[testing_spine_server]');

	const env = load_env(BaseServerEnv, runtime.env_get);

	const env_config = validate_server_env(env);
	if (!env_config.ok) {
		throw new Error(
			`testing_spine_server: invalid ${env_config.field}: ${env_config.errors.join('; ')}`
		);
	}
	const { keyring, allowed_origins, bootstrap_token_path } = env_config;

	const app_backend = await create_app_backend({
		database_url: env.DATABASE_URL,
		keyring,
		password: stub_password_deps,
		read_secure_file: runtime.read_secure_file,
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
		migration_namespaces: [CELL_MIGRATION_NS, CELL_HISTORY_MIGRATION_NS, FACT_MIGRATION_NS]
	});

	// Facts dir for the disk-stream / X-Accel serving paths. The cross suite
	// seeds embedded facts via `_testing_put_fact`, so this is unused there;
	// it's a required option on the serve route factories.
	const facts_dir = join(dirname(dirname(daemon_token_path)), 'facts');

	// Ensure the daemon-token dir exists — `spawn_backend` creates the backend
	// root (for the bootstrap token) but not the `run/` subdir the rotation
	// writer lands the token in.
	await runtime.mkdir(dirname(daemon_token_path), { recursive: true });

	// Daemon-token rotation is required — `_testing_reset` gates on the
	// daemon-token credential, and the harness reads the rotated token to
	// authenticate the keeper channel.
	const daemon_token_rotation = await start_daemon_token_rotation(
		runtime,
		{ db: app_backend.deps.db },
		{ token_path: daemon_token_path },
		log
	);

	// Created up front so the role-grant-offer `notification_sender` binds to the
	// SAME transport the WS endpoint registers connections against (the
	// transport is the connection registry — a separate instance would fan out
	// to an empty registry and reach nobody). Threaded into
	// `build_full_spine_mount({notification_sender})` and the `ws_endpoints` spec
	// below; `create_app_server` adds it to the backend's connection closer and
	// wires its audit-revocation guard.
	const ws_transport = new BackendWebsocketTransport();

	// Login rate limiting is OFF by default — the standard cross suites fire
	// many login/signup round-trips per backend lifetime from one host (loopback),
	// which a live limiter would 429. The dedicated security cross project
	// spawns a backend with `FUZ_LOGIN_RATE_LIMIT_ENABLED=true` (any stringbool
	// truthy value; garbage refuses to boot) to exercise the
	// 429 + `Retry-After` path and XFF-keyed bucketing over the wire (see
	// `testing/cross_backend/login_security.ts`). `trusted_proxies` is always
	// wired below, so the resolved client IP keys the limiter; the security suite
	// spoofs per-case `X-Forwarded-For` IPs so each case is its own fresh bucket.
	const login_rate_limit_enabled = parse_stringbool_env(
		LOGIN_RATE_LIMIT_ENABLED_ENV,
		runtime.env_get(LOGIN_RATE_LIMIT_ENABLED_ENV)
	);
	const login_ip_rate_limiter = login_rate_limit_enabled
		? new RateLimiter(default_login_ip_rate_limit)
		: null;
	const login_account_rate_limiter = login_rate_limit_enabled
		? new RateLimiter(default_login_account_rate_limit)
		: null;

	// Action rate limiting is OFF by default for the same reason. The security
	// project's `FUZ_ACTION_RATE_LIMIT_ENABLED=true` builds one IP + one account
	// limiter (the action defaults' windows, `FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS`
	// replacing both caps) that `create_app_server` threads to the RPC endpoint
	// and the WS endpoint alike — one budget per axis across both transports,
	// which `testing/cross_backend/ws_action_rate_limit.ts` drives. The Rust stub
	// reads the same two env vars.
	const action_rate_limit_enabled = parse_stringbool_env(
		ACTION_RATE_LIMIT_ENABLED_ENV,
		runtime.env_get(ACTION_RATE_LIMIT_ENABLED_ENV)
	);
	const action_rate_limit_max_attempts = parse_action_rate_limit_max_attempts(
		runtime.env_get(ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV),
		action_rate_limit_enabled
	);
	const with_action_cap = (defaults: RateLimiterOptions): RateLimiterOptions => ({
		...defaults,
		max_attempts: action_rate_limit_max_attempts ?? defaults.max_attempts
	});
	const action_ip_rate_limiter = action_rate_limit_enabled
		? new RateLimiter(with_action_cap(default_action_ip_rate_limit))
		: null;
	const action_account_rate_limiter = action_rate_limit_enabled
		? new RateLimiter(with_action_cap(default_action_account_rate_limit))
		: null;

	// The full live mount, built once for both endpoints: the RPC list and the
	// WS list serving the same actions behind the protocol actions (see
	// `build_full_spine_mount`). Single-sourced in `full_spine_mount.ts` so the
	// binary, the in-process parity setup, and the `spine_method_coverage`
	// reconciliation test all build the same list — a method can't be mounted
	// here and forgotten elsewhere. The shared `ws_transport` is threaded as the
	// role-grant-offer `notification_sender` so the spine emits the WS
	// notification family — driving `describe_role_grant_offer_notification_ws_tests`.
	const full_mount = build_full_spine_mount(app_backend.deps, {
		notification_sender: ws_transport,
		daemon_token_state: daemon_token_rotation.state
	});

	const app_server = await create_app_server({
		backend: app_backend,
		session_options: spine_session_options,
		allowed_origins,
		proxy: { trusted_proxies: ['127.0.0.1', '::1'], get_connection_ip },
		// Every limiter not passed below stays off. The explicit ones win over
		// the mode: each is null unless its env toggle (above) built it.
		// `create_spine_route_specs` reads the login pair off `AppServerContext`
		// and wires them onto `POST /api/account/login`; the action pair is
		// threaded to the RPC + WS endpoints.
		rate_limiters: 'disabled_for_testing',
		login_ip_rate_limiter,
		login_account_rate_limiter,
		action_ip_rate_limiter,
		action_account_rate_limiter,
		daemon_token_state: daemon_token_rotation.state,
		bootstrap: bootstrap_token_path
			? { mode: 'live', token_path: bootstrap_token_path }
			: { mode: 'disabled' },
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
			create_serve_cell_fact_route_spec({ deps: ctx.deps, facts_dir, log }),
			create_serve_fact_route_spec({ deps: ctx.deps, facts_dir, log })
		],
		// The full live RPC mount: the standard bundle plus the off-declared-surface
		// families (`_testing_*` backdoors, the full cell verb set, the opt-in
		// `actor_lookup` / `actor_search` resolvers). Cells / actors stay off
		// `create_spine_surface_spec`, so the standard cross suite's generic
		// round-trip never drives them (they're covered by the dedicated cell /
		// actor cross suites).
		rpc_endpoints: [{ path: SPINE_RPC_PATH, actions: full_mount.rpc_actions }],
		// The WS endpoint serves the same actions behind the protocol actions,
		// as the Rust stub serves one registry on RPC and WS — so a socket can
		// revoke the session it is running on (`capabilities.ws_account_actions`)
		// and the cell verbs' dispatcher-charged rate limit is reachable over WS
		// on both spines (`describe_ws_action_rate_limit_cross_tests`). No
		// `required_roles` — the stub's WS state carries none either.
		create_upgrade_websocket: prepare_websocket({ max_message_bytes: WS_MAX_MESSAGE_BYTES }),
		ws_endpoints: [
			{
				path: ws_path,
				actions: full_mount.ws_actions,
				transport: ws_transport,
				max_message_bytes: WS_MAX_MESSAGE_BYTES
			}
		],
		env_schema: BaseServerEnv,
		env_values: env,
		// Await fire-and-forget effects before each HTTP response returns, so
		// an HTTP mutation's audit emits are durable by response time. WS
		// replies before its effects flush; `_testing_drain_effects` awaits
		// the tracked emitter for those (`cell_audit_factory`). Matches the
		// in-process `create_test_app` default.
		await_pending_effects: true,
		on_effect_error: (error, ctx) => {
			log.error(`Pending effect failed (${ctx.method} ${ctx.path}):`, error);
		}
		// `auth_cleanup` stays off (its default): a background pass would delete
		// rows and write audit rows under a running suite. The Rust
		// `testing_spine_stub` this binary is compared against leaves its twin
		// unscheduled too.
	});

	// Health probe endpoint — the spawn harness polls this for readiness.
	// `create_app_server` does not mount one.
	app_server.app.get(HEALTH_PATH, (c) => c.json({ status: 'ok' }));

	const close = async (): Promise<void> => {
		await daemon_token_rotation.stop();
		// closes the WS + SSE connections, then the DB
		await app_server.close();
		// caller-injected limiters are the caller's to dispose
		login_ip_rate_limiter?.dispose();
		login_account_rate_limiter?.dispose();
		action_ip_rate_limiter?.dispose();
		action_account_rate_limiter?.dispose();
	};

	return { app: app_server.app, close, surface: app_server.surface_spec.surface };
};
