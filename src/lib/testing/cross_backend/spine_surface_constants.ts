import '../assert_dev_env.ts';

/**
 * Pure spine-surface constants — wire paths, roles, the fixture URL, and the
 * env-var names the backend configs set for the spawned spine binaries. A
 * hono-free leaf split out of `default_spine_surface.ts`.
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

/** RPC endpoint mount path — matches the binary's `/api/rpc`. */
export const SPINE_RPC_PATH = '/api/rpc';

/**
 * Audit-log SSE stream path — `/api/admin` prefix + the
 * `create_audit_log_route_specs` `/audit/stream` route. Matches the default
 * `BackendConfig.sse_path` and the cross-process SSE suite's default. Only
 * mounted by the TS spine binary (which wires `audit_log_sse`); the shared
 * surface stub leaves `ctx.audit_sse` null so the snapshot stays SSE-free.
 */
export const SPINE_SSE_PATH = '/api/admin/audit/stream';

/**
 * App role the role-shaped-`cell_grant` cross suite exercises. Registered
 * with no grant path (`grant_paths: []`) so it stays a valid registry member
 * without entering the admin / self-service grant flows — holders are seeded
 * directly via `extra_accounts`. Must match the `cell_editor` entry in the
 * Rust `testing_spine_stub`'s `known_roles` (cross-language test contract).
 */
export const SPINE_CELL_EDITOR_ROLE = 'cell_editor';

/**
 * Admin-grantable app role the role-gated-participation cross suite exercises.
 * Registered with `grant_paths: ['admin']` so it enters the admin grant flow —
 * the cross-backend proof that an app-defined role is conferrable (offer /
 * `role_grant_assign`) admin-only on **both** spines. Must match the
 * `participant` entry in the Rust `testing_spine_stub`'s `RoleRegistry`
 * **and** its `known_roles` (the registry feeds the cell vocabulary too) — a
 * cross-language test contract. Distinct from `SPINE_CELL_EDITOR_ROLE`
 * (no grant path): this one is the *grantable* role, that one is the
 * bootstrap-seed-only cell role.
 */
export const SPINE_PARTICIPANT_ROLE = 'participant';

/**
 * Committed expected-schema fixture for the spine `/ready` deploy gate — the
 * column map a fresh full spine bootstrap (auth + cell + cell_history + fact)
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
 * the RPC and WS endpoints (and, on the Rust stub, the auth-family handlers
 * that charge in-handler). The cross-language contract for the action
 * rate-limit cross suite (`ws_action_rate_limit.ts`); same delivery as
 * `LOGIN_RATE_LIMIT_ENABLED_ENV`. Off, the TS spine builds no action limiter
 * and the Rust stub keeps its default posture (only its auth families charge,
 * against an always-on per-account limiter at the production cap).
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
