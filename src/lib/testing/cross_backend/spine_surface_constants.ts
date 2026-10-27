import '../assert_dev_env.ts';

/**
 * Pure spine-surface constants — wire paths, roles, the fixture URL, the
 * `_testing_*` seams' shared `auth` shape, and the env-var names the backend
 * configs set for the spawned spine binaries. A hono-free leaf split out of
 * `default_spine_surface.ts`.
 *
 * Cross-process suite modules (which drive a separately-spawned backend binary
 * over HTTP) need only the wire path / role / fixture-URL, not the in-process
 * route handlers. Importing them from `default_spine_surface.ts` used to drag
 * its eager `account_routes.ts` / `signup_routes.ts` imports — and through them
 * `session_middleware` → `hono/cookie` — onto a backend-spawning consumer with
 * no `hono` peer installed (a Rust-only spine consumer). Keeping these constants
 * on this handler-free leaf lets such a consumer import the path without the
 * peer. `default_spine_surface.ts` imports the ones it uses from here.
 *
 * The env-var names live here so both sides of each contract share one
 * constant: the backend configs that set them (`default_backend_configs.ts`,
 * `ts_spine_backend_config.ts`, `rust_spine_stub_backend_config.ts`) and the
 * spawned TS spine binary that reads them, which imports this leaf rather than
 * the config builders.
 *
 * @module
 */

import type { RouteAuth } from '../../http/auth_shape.ts';

/**
 * Shared `auth` axis for every `_testing_*` action: keeper-only via the
 * daemon-token credential, no acting actor. This is the entire structural
 * fence on the backdoor surface (these actions run direct DB writes the
 * production wire never exposes), so every `_testing_*` spec references this
 * one const rather than re-declaring it — a single source of truth the gate test
 * (`testing_actions_auth.test.ts`) pins. Mirrors the Rust `DAEMON_TOKEN_ONLY`
 * / shared `AuthSpec` in `fuz_testing`.
 */
export const TESTING_ACTION_AUTH = {
	account: 'required',
	actor: 'none',
	credential_types: ['daemon_token']
} as const satisfies RouteAuth;

/**
 * Every `_testing_*` backdoor the shipped cross suites know: the daemon-token
 * actions a test binary may mount for the harness to drive. The one list a
 * backend's `capabilities.testing_backdoors` declares from, the
 * testing-backdoor suite probes, and `describe_spine_cross_suites` gates suites
 * on. A consumer's own seams stay off it — the testing-backdoor suite takes
 * those as `extra_methods`.
 *
 * `spine_surface_constants.testing_backdoors.test.ts` holds it to the `_testing_*` methods
 * fuz_app's spine binary mounts, so an action added there fails until it is
 * listed here.
 */
export const TESTING_BACKDOOR_METHODS = [
	'_testing_reset',
	'_testing_drain_effects',
	'_testing_mint_session',
	'_testing_put_fact',
	'_testing_flood_notifications',
	'_testing_schema_snapshot',
	'_testing_migration_tracker',
	'_testing_action_manifest',
	'_testing_origin_check',
	'_testing_shorten_credential_expiry'
] as const;

/** A `_testing_*` backdoor the shipped cross suites know — see `TESTING_BACKDOOR_METHODS`. */
export type TestingBackdoorMethod = (typeof TESTING_BACKDOOR_METHODS)[number];

/** RPC endpoint mount path — matches the binary's `/api/rpc`. */
export const SPINE_RPC_PATH = '/api/rpc';

/** Ungated WebSocket endpoint mount path — matches the binaries' `/api/ws`. */
export const SPINE_WS_PATH = '/api/ws';

/**
 * Mount prefix of the account REST routes (login, logout, password, status,
 * signup, bootstrap) on both spine binaries. The `SPINE_ACCOUNT_*_PATH`
 * constants below are the routes under it the suites drive.
 */
export const SPINE_ACCOUNT_PATH_PREFIX = '/api/account';

/** REST login route. */
export const SPINE_ACCOUNT_LOGIN_PATH = '/api/account/login';

/** REST logout route. */
export const SPINE_ACCOUNT_LOGOUT_PATH = '/api/account/logout';

/** REST password-change route. */
export const SPINE_ACCOUNT_PASSWORD_PATH = '/api/account/password';

/** REST account-status route. */
export const SPINE_ACCOUNT_STATUS_PATH = '/api/account/status';

/** REST signup route. */
export const SPINE_ACCOUNT_SIGNUP_PATH = '/api/account/signup';

/** REST bootstrap route — the default `BackendConfig.bootstrap_path`. */
export const SPINE_ACCOUNT_BOOTSTRAP_PATH = '/api/account/bootstrap';

/**
 * Audit-log SSE stream path — `/api/admin` prefix + the
 * `create_audit_log_route_specs` `/audit/stream` route. Matches the default
 * `BackendConfig.sse_path` and the cross-process SSE suite's default. Only
 * mounted by the TS spine binary (which wires `audit_log_sse`); the shared
 * surface stub leaves `ctx.audit_sse` null so the snapshot stays SSE-free.
 */
export const SPINE_SSE_PATH = '/api/admin/audit/stream';

/**
 * The request-body cap both spines ship by default, 1 MiB
 * (`DEFAULT_MAX_BODY_SIZE` in TS, `DEFAULT_BODY_LIMIT_BYTES` in `fuz_http`).
 * Kept here as the cross-impl contract value rather than imported from either
 * impl — the boundary the body-size suites pin is the shared default, and a
 * change to either is a deliberate cross-impl decision that would revisit them
 * regardless.
 */
export const SPINE_BODY_LIMIT_DEFAULT_BYTES = 1024 * 1024;

/**
 * App role the role-shaped-`cell_grant` cross suite exercises. Registered
 * with no grant path (`grant_paths: []`) so it stays a valid registry member
 * without entering the admin / self-service grant flows — holders are seeded
 * directly via `extra_accounts`. Must match the `cell_editor` entry in the
 * Rust stub's `RoleRegistry` (which the cell spec set also reads) — a
 * cross-language test contract.
 */
export const SPINE_CELL_EDITOR_ROLE = 'cell_editor';

/**
 * Admin-grantable app role the role-gated-participation cross suite exercises.
 * Registered with `grant_paths: ['admin']` so it enters the admin grant flow —
 * the cross-backend proof that an app-defined role is conferrable (offer /
 * `role_grant_assign`) admin-only on **both** spines. Must match the
 * `participant` entry in the Rust stub's `RoleRegistry` (which the cell spec
 * set also reads) — a cross-language test contract. Distinct from `SPINE_CELL_EDITOR_ROLE`
 * (no grant path): this one is the *grantable* role, that one is the
 * bootstrap-seed-only cell role.
 */
export const SPINE_PARTICIPANT_ROLE = 'participant';

/**
 * Mount path of the spine binaries' second, role-gated WebSocket endpoint —
 * the same actions as the ungated `/api/ws`, behind
 * `SPINE_ROLE_GATED_WS_ROLES`. Both spines mount it (the TS binary sharing
 * `/api/ws`'s transport, the Rust stub its connection registry), so one
 * account can hold a gated and an ungated socket side by side. Driven by
 * `describe_ws_role_gated_cross_tests`, behind `capabilities.ws_role_gated`.
 * Must match the Rust `testing_spine_stub`'s gated mount — a cross-language
 * test contract.
 */
export const SPINE_ROLE_GATED_WS_PATH = '/api/gated/ws';

/**
 * The roles `SPINE_ROLE_GATED_WS_PATH` requires, any-of: `admin`, the gate a
 * privileged-broadcast socket uses, and `participant`, a role that can be
 * granted scoped — so the suite can revoke a scoped grant of a listed role
 * and see nothing close. Must match the Rust `testing_spine_stub`'s gated
 * mount.
 */
export const SPINE_ROLE_GATED_WS_ROLES: ReadonlyArray<string> = Object.freeze([
	'admin',
	SPINE_PARTICIPANT_ROLE
]);

/**
 * Committed expected-schema fixture for the spine `/ready` deploy gate — the
 * column map a fresh full spine bootstrap (auth + cell + fact)
 * produces. Resolved relative to this module so the spawned TS binary (which
 * imports this source under its loader) reads it off disk via `node:fs`.
 * Regenerated + guarded by `src/test/cross_backend/spine_expected_schema.db.test.ts`.
 *
 * The Rust `testing_spine_stub` reads the **same** committed file (its absolute
 * path passed via env by `rust_spine_stub_backend_config`) — column-presence is
 * engine-portable, so one fixture is the cross-impl contract.
 */
export const SPINE_EXPECTED_SCHEMA_URL: URL = new URL('./expected_schema.json', import.meta.url);

/**
 * Env var both spine binaries read to enable their login rate limiters
 * (`'true'` on / unset off). The cross-language contract for the login-security
 * cross project: the TS binary reads it via `runtime.env_get` (a test-only flag,
 * not in `BaseServerEnv`); the Rust `testing_spine_stub` reads it via
 * `std::env::var` — so one backend-config option drives both impls
 * (`ts_spine_backend_config` and `rust_spine_stub_backend_config` set it).
 */
export const LOGIN_RATE_LIMIT_ENABLED_ENV = 'FUZ_LOGIN_RATE_LIMIT_ENABLED';

/**
 * Env var both spine binaries read to enable their action rate limiters
 * (`'true'` on / unset off) — one per-IP and one per-account limiter, shared by
 * the RPC and WS endpoints. The cross-language contract for the action
 * rate-limit cross suite (`ws_action_rate_limit.ts`); same delivery as
 * `LOGIN_RATE_LIMIT_ENABLED_ENV`. Off, neither spine builds an action
 * limiter.
 */
export const ACTION_RATE_LIMIT_ENABLED_ENV = 'FUZ_ACTION_RATE_LIMIT_ENABLED';

/**
 * Env var replacing both action limiters' `max_attempts` (a positive integer;
 * the windows stay `default_action_ip_rate_limit`'s /
 * `default_action_account_rate_limit`'s). Both spine binaries refuse to boot
 * when it is set without `ACTION_RATE_LIMIT_ENABLED_ENV` or is not a positive
 * integer, so a suite never asserts a throttle the backend didn't build.
 */
export const ACTION_RATE_LIMIT_MAX_ATTEMPTS_ENV = 'FUZ_ACTION_RATE_LIMIT_MAX_ATTEMPTS';

/**
 * Env var naming the TS spine backend's root dir, set by
 * `ts_spine_backend_config`; the spawned binary writes its daemon token to
 * `{dir}/run/daemon_token`, which must match `bootstrap.daemon_token_path`.
 */
export const TS_SPINE_DIR_ENV = 'FUZ_TESTING_TS_SPINE_DIR';
