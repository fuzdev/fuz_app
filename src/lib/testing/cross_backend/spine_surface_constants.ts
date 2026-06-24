import '../assert_dev_env.ts';

/**
 * Pure spine-surface path + role constants — the hono-free leaf split out of
 * `default_spine_surface.ts`.
 *
 * Cross-process suite modules (which drive a separately-spawned backend binary
 * over HTTP) need only the wire path / role / fixture-URL, not the in-process
 * route handlers. Importing them from `default_spine_surface.ts` used to drag
 * its eager `account_routes.ts` / `signup_routes.ts` imports — and through them
 * `session_middleware` → `hono/cookie` — onto a backend-spawning consumer with
 * no `hono` peer installed (a Rust-only spine consumer). Keeping these constants
 * on this handler-free leaf lets such a consumer import the path without the
 * peer. `default_spine_surface.ts` re-exports them for in-process callers.
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
