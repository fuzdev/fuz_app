import '../assert_dev_env.ts';

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
 * **Where the per-backend declarations live** (this file owns only the
 * vocabulary + the in-process preset):
 *
 * - `in_process_capabilities` — here; every flag `true`.
 * - `ts_default_capabilities` / `rust_default_capabilities` — consumer-facing
 *   family defaults, in `default_backend_configs.ts` (full literals, so adding
 *   a capability is a compile error until each family declares it).
 * - `ts_spine_capabilities` / `ts_spine_bun_capabilities` — fuz_app's own TS
 *   spine presets, in `ts_spine_backend_config.ts` (deltas off the family
 *   default; Bun flips `oversized_reject_closes_connection`).
 * - `rust_spine_stub_capabilities` — fuz_app's Rust spine-stub preset, in
 *   `rust_spine_stub_backend_config.ts` (delta off the rust family default).
 *
 * **Gating flags vs shape notes.** `BackendCapabilities` holds only flags a
 * suite actually gates on (each has a `test_if(capabilities.X, ...)` reader).
 * Wiring facts that gate nothing — `bearer_auth` / `trusted_proxy` /
 * `login_rate_limit` — live in the parallel `BackendShapeNotes` record
 * (`in_process_shape_notes` here, `ts_default_shape_notes` /
 * `rust_default_shape_notes` in `default_backend_configs.ts`) so the
 * capability type never claims gating power it doesn't have.
 *
 * @module
 */

import {test} from 'vitest';

/**
 * Backend wiring facts recorded for documentation — **not** gating flags.
 *
 * The companion to `BackendCapabilities`: where each capability flag has a
 * `test_if(capabilities.X, ...)` reader that skips a suite the backend doesn't
 * implement, nothing reads these. They record middleware / limiter wiring that
 * differs between the TS and Rust families (a backend-shape record) but gates
 * no cross test today. They live in their own type precisely so
 * `BackendCapabilities` stops claiming gating power it doesn't have — fold a
 * flag in here the moment it has no `test_if` reader, and promote it back the
 * day a suite genuinely gates on it.
 */
export interface BackendShapeNotes {
	/**
	 * Bearer-token auth (`Authorization: Bearer <token>`) is wired through the
	 * backend's middleware stack. `true` on every spine — the bearer-token cases
	 * in `describe_standard_integration_tests` / `describe_rate_limiting_tests`
	 * run unconditionally.
	 */
	readonly bearer_auth: boolean;
	/**
	 * Trusted-proxy XFF parsing (`X-Forwarded-For` etc.) is wired. Records the
	 * proxy-default difference between the TS family (`false` — the test binary
	 * leaves proxy parsing off) and the Rust family (`true` — the client-IP
	 * middleware is always wired; the env-gate only chooses XFF vs the TCP peer).
	 */
	readonly trusted_proxy: boolean;
	/**
	 * Per-account login rate limiting is wired. `false` for the TS family (the
	 * canonical path leaves the limiter null in test mode), `true` for the Rust
	 * family (env-gated bucket on `/login` + `/password`).
	 */
	readonly login_rate_limit: boolean;
}

/**
 * Optional behaviors a backend may support. Each flag's TSDoc names the
 * tests that gate on it; add a new flag here before referencing it from
 * a suite body, and document the gating tests inline. Wiring facts that gate
 * nothing belong in `BackendShapeNotes`, not here.
 */
export interface BackendCapabilities {
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
	 * `describe_account_lifecycle_cross_tests` suite.
	 *
	 * Unlike cells / fact-serving / ws / sse, these verbs **are** on the
	 * standard declared surface — they live in `create_admin_actions`, so
	 * `create_spine_surface_spec` carries them and the spec-derived round-trip
	 * + attack-surface suites already auto-enumerate their wire shape + auth.
	 * This flag gates the *behavioral* parity the generic round-trip can't
	 * provide: it can't drive verbs that delete their own subject (soft-delete →
	 * undelete round-trip, keeper-confirmed purge, the keeper-guard refusal), so
	 * the dedicated cross suite adds them.
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
	/**
	 * The `/ready` readiness deploy gate (`GET /ready`) is live-mounted on the
	 * backend — the public column-presence schema-drift probe over the committed
	 * `expected_schema.json`. Gates `describe_ready_cross_tests` (anonymous
	 * `GET /ready` → `200 {ready: true}` on a clean spine bootstrap). Like
	 * ws/sse/cells, the route stays off the standard declared surface
	 * (`create_spine_surface_spec`); this flag opts a backend into the dedicated
	 * readiness parity coverage. The drift → `503` path stays per-impl unit tests.
	 */
	readonly ready: boolean;
	/**
	 * The account surface serves `GET /api/account/status` (account info +
	 * `bootstrap_available` flag). Bundled into `create_account_route_specs`, so
	 * any backend mounting the account routes serves it — `true` for every
	 * spine. Gates the `account status response body` case in
	 * `describe_standard_integration_tests`: when `true` the case asserts the
	 * route is present (fail-loud on 404, no silent skip); when `false` it skips
	 * explicitly (a backend that deliberately omits the route).
	 */
	readonly account_status: boolean;
	/**
	 * On an oversized-body `413` reject the backend **closes the connection
	 * without reading the body** (the defense-in-depth posture), rather than
	 * draining the declared `Content-Length` and keeping the socket alive.
	 * Gates the strong half of `describe_body_size_smuggling_cross_tests`: when
	 * `true`, the pipelined GET is never reached (at most one response); when
	 * `false`, the suite instead asserts the weaker but still-load-bearing
	 * no-desync property (the body is framed on `Content-Length`, not reparsed
	 * as request bytes).
	 *
	 * `true` for the Node / Deno (`@hono/node-server` graceful close) and Rust
	 * (hyper RST) backends; `false` for Bun — `Bun.serve` reads the full body
	 * and processes the correctly-framed pipelined request even when the `413`
	 * carries `Connection: close`. Bun is not insecure (no desync — it answers
	 * the cleanly-delimited GET with a proper `400`); the flag records the
	 * connection-handling divergence so the suite stays green without losing the
	 * smuggle detector. See `docs/security.md` §"Body Size Limiting".
	 */
	readonly oversized_reject_closes_connection: boolean;
	/**
	 * The backend can **initiate** a JSON-RPC request to a connected client
	 * and await its typed reply (the server→client request/response direction
	 * `ActionPeer` adds). Gates `describe_peer_ping_ws_tests` — the on-demand
	 * `peer/ping` round-trip plus its security negatives (unsolicited-response
	 * rejection, per-connection id isolation, never-replying `Timeout`,
	 * wrong-shape reply rejection).
	 *
	 * `true` for the Rust spine (server-initiated requests landed Rust-first
	 * canonical); `false` for the TS family — the TS server
	 * `BackendWebsocketTransport.send()` request path is the deferred
	 * twin-impl convergence item, so a TS backend can't yet drive the
	 * round-trip. Like ws/sse/cells, `peer/ping` stays off the standard
	 * declared surface (it's a protocol action, manifest-excluded), so this
	 * flag is the only opt-in into the peer parity coverage.
	 */
	readonly peer_request: boolean;
}

/**
 * Capability declarations for the in-process Hono transport. Nearly every
 * flag is `true` because in-process testing exercises the full backend
 * with no missing optional behaviors. The one exception is `peer_request`:
 * the in-process driver runs the **TS** server (`register_action_ws`),
 * whose server-initiated request transport is deferred, so it can't drive
 * a `peer/ping` round-trip — and `describe_peer_ping_ws_tests` is
 * cross-process-only regardless. Cross-process consumers declare each flag
 * explicitly per backend.
 */
export const in_process_capabilities: BackendCapabilities = Object.freeze({
	ws: true,
	sse: true,
	cell_crud: true,
	cell_relations: true,
	account_lifecycle: true,
	fact_serving: true,
	ready: true,
	account_status: true,
	oversized_reject_closes_connection: true,
	peer_request: false,
});

/**
 * Shape notes for the in-process Hono transport — every wiring fact present
 * (the in-process app exercises the full middleware stack). Documentation
 * only, like every `BackendShapeNotes` (nothing reads it).
 */
export const in_process_shape_notes: BackendShapeNotes = Object.freeze({
	bearer_auth: true,
	trusted_proxy: true,
	login_rate_limit: true,
});

/**
 * Conditional `test()` wrapper — registers a vitest case only when
 * `cond` is true; otherwise registers it as `.skip` so the run still
 * surfaces the gated coverage in the report.
 *
 * Thin wrapper around vitest's `test.skipIf(!cond)` with the argument
 * order flipped to match the more readable `test_if(capabilities.ws, ...)`
 * call pattern.
 */
export const test_if = (cond: boolean, name: string, fn: () => void | Promise<void>): void => {
	if (cond) {
		test(name, fn);
	} else {
		test.skip(name, fn);
	}
};
