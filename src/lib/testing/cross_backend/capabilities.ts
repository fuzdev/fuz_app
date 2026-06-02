import '../assert_dev_env.js';

/**
 * Capability vocabulary for cross-backend integration testing.
 *
 * Backends declare which optional behaviors they support; suite bodies
 * call `test_if(capabilities.X, ...)` to skip cases the backend doesn't
 * implement. No `if (config.name === 'rust')` branches anywhere — name-
 * checking is a code smell that says capability vocabulary is missing.
 *
 * In-process Hono via `default_in_process_setup` declares every
 * capability `true` (see `in_process_capabilities`). Cross-process
 * backends opt in per-flag on their `BackendConfig`.
 *
 * @module
 */

import {test} from 'vitest';

/**
 * Optional behaviors a backend may support. Each flag's TSDoc names the
 * tests that gate on it; add a new flag here before referencing it from
 * a suite body, and document the gating tests inline.
 */
export interface BackendCapabilities {
	/**
	 * Bearer token auth (`Authorization: Bearer <token>`) is wired through
	 * the backend's middleware stack. Gates the bearer-token cases in
	 * `describe_standard_integration_tests` and `describe_rate_limiting_tests`.
	 */
	readonly bearer_auth: boolean;
	/**
	 * Trusted-proxy XFF parsing is wired (`X-Forwarded-For` etc.). Gates
	 * the proxy-resolution cases in `describe_standard_integration_tests`
	 * and the future cross-process proxy integration suite.
	 */
	readonly trusted_proxy: boolean;
	/**
	 * Per-account login rate limiting is wired. Gates the per-account
	 * rate-limit cases in `describe_rate_limiting_tests`.
	 */
	readonly login_rate_limit: boolean;
	/**
	 * WebSocket transport is reachable end-to-end. Gates the cross-process
	 * WS round-trip suite; the in-process `describe_ws_round_trip_tests`
	 * runs against `register_action_ws` directly and ignores this flag.
	 */
	readonly ws: boolean;
	/**
	 * SSE transport is reachable end-to-end. Gates the cross-process SSE
	 * suite (`describe_cross_process_sse_tests` — connect, audit data frame,
	 * close-on-revoke); in-process SSE uses the `on_audit_event` hook and
	 * ignores this flag.
	 */
	readonly sse: boolean;
	/**
	 * Cell CRUD verbs (`cell_create` / `cell_get` / `cell_update` /
	 * `cell_delete` / `cell_list`) are live-mounted on the backend's RPC
	 * path and its DB carries the `fuz_cell` migration namespace. Gates the
	 * dedicated `describe_cell_crud_cross_tests` suite. Like `ws` / `sse`,
	 * cells stay off the standard declared surface — only this flag opts a
	 * backend into the cell parity coverage.
	 */
	readonly cell_crud: boolean;
	/**
	 * The relation / ACL / audit cell verbs beyond plain CRUD
	 * (`cell_grant_*` / `cell_field_*` / `cell_item_*` / `cell_clone` /
	 * `cell_audit_list`) are live-mounted on the backend's RPC path. Gates
	 * the dedicated `describe_cell_relations_cross_tests` suite — grant
	 * lifecycle, field / item bidirectional relations, clone shallow + deep,
	 * manage-tier audit gating, and the now-reachable
	 * `cell_visibility_manage_only` 403 (editor-grant principal). Like
	 * `cell_crud`, these stay off the standard declared surface; a backend
	 * mounting only plain CRUD declares `cell_crud: true, cell_relations: false`.
	 */
	readonly cell_relations: boolean;
	/**
	 * The account-lifecycle admin verbs (`account_delete` soft-delete,
	 * `account_undelete` reactivation, `account_purge` keeper hard-delete)
	 * are live-mounted on the backend's RPC path. Gates the dedicated
	 * `describe_account_lifecycle_cross_tests` suite. Like cells, these
	 * destructive/stateful verbs stay off the standard declared surface (the
	 * generic round-trip can't drive them — they delete the subject), so
	 * this flag opts a backend into the lifecycle parity coverage.
	 */
	readonly account_lifecycle: boolean;
	/**
	 * The cell-gated fact-serving routes (`GET /api/cells/:cell_id/facts/:hash`
	 * + the admin-only `GET /api/facts/:hash`) are live-mounted on the backend,
	 * its DB carries the `fuz_facts` migration namespace, and it registers the
	 * `_testing_put_fact` seeder. Gates `describe_fact_serving_cross_tests` —
	 * the per-reference read model (cell-scoped admit via a viewable cell,
	 * cross-owner-dedup-no-leak, 404-mask, bare-hash admin-only). Like cells,
	 * the serve routes stay off the standard declared surface.
	 */
	readonly fact_serving: boolean;
}

/**
 * Capability declarations for the in-process Hono transport. Every flag
 * is `true` because in-process testing exercises the full backend with
 * no missing optional behaviors. Cross-process consumers
 * declare each flag explicitly per backend.
 */
export const in_process_capabilities: BackendCapabilities = Object.freeze({
	bearer_auth: true,
	trusted_proxy: true,
	login_rate_limit: true,
	ws: true,
	sse: true,
	cell_crud: true,
	cell_relations: true,
	account_lifecycle: true,
	fact_serving: true,
});

/**
 * Conditional `test()` wrapper — registers a vitest case only when
 * `cond` is true; otherwise registers it as `.skip` so the run still
 * surfaces the gated coverage in the report.
 *
 * Thin wrapper around vitest's `test.skipIf(!cond)` with the argument
 * order flipped to match the more readable `test_if(capabilities.bearer_auth, ...)`
 * call pattern.
 */
export const test_if = (cond: boolean, name: string, fn: () => void | Promise<void>): void => {
	if (cond) {
		test(name, fn);
	} else {
		test.skip(name, fn);
	}
};
