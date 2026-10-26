import '../assert_dev_env.ts';

/**
 * Capability vocabulary for cross-backend integration testing.
 *
 * Backends declare which optional behaviors they support; suite bodies
 * call `test_if(capabilities.X, ...)` to skip cases the backend doesn't
 * implement. No `if (config.name === 'rust')` branches anywhere — name-
 * checking is a code smell that says capability vocabulary is missing.
 *
 * In-process Hono via `default_in_process_setup` declares every capability
 * its transport can exercise (see `in_process_capabilities` — the
 * cross-process-only flags stay `false`). Cross-process backends opt in
 * per-flag on their `BackendConfig`.
 *
 * **Where the per-backend declarations live** (this file owns only the
 * vocabulary + the in-process preset):
 *
 * - `in_process_capabilities` — here; every flag `true` except the
 *   cross-process-only ones.
 * - `ts_default_capabilities` / `rust_default_capabilities` — consumer-facing
 *   family defaults, in `default_backend_configs.ts` (full literals, so adding
 *   a capability is a compile error until each family declares it).
 * - `ts_spine_capabilities` / `ts_spine_bun_capabilities` — fuz_app's own TS
 *   spine presets, in `ts_spine_backend_config.ts` (deltas off the family
 *   default; Bun flips `ws_handshake_pipelining`).
 * - `rust_spine_stub_capabilities` — fuz_app's Rust spine-stub preset, in
 *   `rust_spine_stub_backend_config.ts` (delta off the rust family default).
 *
 * **Gating flags only.** `BackendCapabilities` holds only flags a suite
 * actually gates on (each has a `test_if(capabilities.X, ...)` reader, or —
 * `ws_refusal_body` — picks how a case reads a refusal). A wiring fact no suite
 * reads is not a capability.
 *
 * @module
 */

import { test } from 'vitest';

/**
 * Optional behaviors a backend may support. Each flag's TSDoc names the
 * tests that gate on it; add a new flag here before referencing it from
 * a suite body, and document the gating tests inline. A wiring fact no
 * suite reads doesn't belong here.
 */
export interface BackendCapabilities {
	/**
	 * WebSocket transport is reachable end-to-end. Gates the cross-process
	 * WS round-trip suite and the per-account connection-cap suite
	 * (`describe_ws_connection_cap_cross_tests`); the in-process
	 * `describe_ws_round_trip_tests` runs against `register_action_ws`
	 * directly and ignores this flag.
	 */
	readonly ws: boolean;
	/**
	 * SSE transport is reachable end-to-end. Gates the cross-process SSE
	 * suite (`describe_cross_process_sse_tests` — connect, audit data frame,
	 * close-on-revoke, the per-session stream cap); in-process SSE uses the
	 * `on_audit_event` hook and ignores this flag.
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
	 * The backend can **initiate** a JSON-RPC request to a connected client
	 * and await its typed reply (the server→client request/response direction
	 * ActionPeer adds). Gates `describe_peer_ping_ws_tests` — the on-demand
	 * `peer/ping` round-trip plus its security negatives (unsolicited-response
	 * rejection, per-connection id isolation, never-replying `Timeout`,
	 * wrong-shape reply rejection).
	 *
	 * `true` for both the Rust spine (server-initiated requests landed
	 * Rust-first canonical) and the TS spine
	 * (`BackendWebsocketTransport.request_connection` drives the round-trip,
	 * correlated by `register_action_ws`). The conservative
	 * `ts_default_capabilities` keeps it `false` like sse/ready — a TS backend
	 * opts in once it mounts `peer/ping` on a WS endpoint **and** the HTTP RPC
	 * endpoint (the no-transport refusal). Like ws/sse/cells, `peer/ping` stays
	 * off the standard declared surface (it's a protocol action,
	 * manifest-excluded), so this flag is the only opt-in into the peer parity
	 * coverage.
	 */
	readonly peer_request: boolean;
	/**
	 * The backend's HTTP server accepts WebSocket frames written in the same
	 * TCP write as the upgrade request, handing them to the socket once the
	 * handshake completes. Gates the `frames sent with the handshake` case in
	 * `describe_cross_process_ws_tests` — the deterministic form of "frames
	 * that arrive before the connection is admitted wait for admission", since
	 * those frames are in the backend's hands before it can have admitted
	 * anything.
	 *
	 * `true` for Node (`ws`), Deno, and the Rust spine (hyper hands the
	 * leftover bytes to the upgraded stream); `false` for a Bun backend that
	 * upgrades after an asynchronous check, as one behind auth does — `Bun.serve`
	 * answers such a request `400` (observed on Bun 1.4.3). A backend
	 * without it still runs the suite's client-library case (requests sent the
	 * moment the socket opens), which pins the same contract without forcing
	 * the ordering.
	 */
	readonly ws_handshake_pipelining: boolean;
	/**
	 * The backend's WebSocket endpoint mounts the self-service account actions
	 * (`account_session_revoke_all` among them), so a socket can revoke the
	 * session it is running on. Gates the self-revocation case in
	 * `describe_cross_process_ws_tests`: the socket reads the reply to its
	 * request, then is closed with `WS_CLOSE_SESSION_REVOKED`. Also gates that
	 * suite's WS-mutation audit case (with `rpc_path`; it calls
	 * `_testing_drain_effects`).
	 *
	 * `true` on fuz_app's own spine presets — the TS spine binary mounts its
	 * full action set on `/api/ws`, and the Rust `testing_spine_stub` serves
	 * one action registry on RPC and WS. `false` in the family defaults:
	 * a consumer's WS endpoint carries whatever its domain mounts, so it opts in
	 * once the account actions are there.
	 */
	readonly ws_account_actions: boolean;
	/**
	 * A test `CellCreateAuthorize` policy is live-mounted on the backend's cell
	 * layer — creating a `kind: 'gated'` cell requires the `participant` role
	 * or admin; every other kind (and a typeless cell) is open. Gates
	 * `describe_cell_gated_create_cross_tests`, the TS↔Rust cell-creation-
	 * authorizer parity proof. The authorizer adds no method / column / wire
	 * shape, so schema-snapshot + action-manifest parity are **blind** to an
	 * authorizer divergence — this behavioral cross case is the only gate that
	 * catches one. `true` only on the reference spine binaries that mount the
	 * test policy (the TS spine `full_spine_mount` + the Rust
	 * `testing_spine_stub`); consumers and the in-process default app don't
	 * mount it.
	 */
	readonly cell_gated_create: boolean;
	/**
	 * The backend mounts a second, role-gated WebSocket endpoint at
	 * `SPINE_ROLE_GATED_WS_PATH`, gated on `SPINE_ROLE_GATED_WS_ROLES`, beside
	 * its ungated `ws_path`. Gates `describe_ws_role_gated_cross_tests`: a
	 * revoked global grant of a listed role closes the account's gated socket
	 * with `WS_CLOSE_PERMISSION_REVOKED`, its ungated socket stays open and
	 * still receives the account's pushes, a re-upgrade is refused at the gate,
	 * and a scoped revoke closes nothing. `true` only on the reference spine binaries that
	 * mount that endpoint (the TS spine binary + the Rust `testing_spine_stub`).
	 */
	readonly ws_role_gated: boolean;
	/**
	 * A refused WebSocket upgrade carries its refusal body — the flat
	 * `{error, ...}` the same refusal answers over plain HTTP. Not a gate: it
	 * forks how `describe_transport_composition_cross_tests` reads its WS rows.
	 * `true`, an empty refusal body fails the case; `false`, an empty body is
	 * allowed (the case pins the status alone) and a non-empty one is still
	 * asserted.
	 *
	 * `false` on Node: `@hono/node-ws` writes a refused upgrade to the raw
	 * socket with `Content-Length: 0`, dropping the response body. `true` on
	 * Deno, Bun, and the Rust spine, which send the response as built.
	 */
	readonly ws_refusal_body: boolean;
}

/**
 * Capability declarations for the in-process Hono transport. Nearly every
 * flag is `true` because in-process testing exercises the full backend
 * with no missing optional behaviors. The exceptions are the flags whose
 * cases are cross-process-only: `peer_request` (`describe_peer_ping_ws_tests`
 * needs a real bound socket with an `on_request` responder via
 * `create_ws_transport`, so the in-process driver never runs it — the
 * transport itself supports server-initiated requests),
 * `ws_handshake_pipelining` (raw bytes on a real socket),
 * `ws_account_actions` (a real socket's reply-then-close ordering),
 * `cell_gated_create`, and `ws_role_gated`. Cross-process consumers declare each flag explicitly
 * per backend.
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
	peer_request: false,
	// Cross-process-only, like `peer_request`: the case needs a real bound socket
	// to write raw bytes to.
	ws_handshake_pipelining: false,
	// Cross-process-only: the case reads a real socket's frames in wire order.
	ws_account_actions: false,
	// Cross-process-only: the test `CellCreateAuthorize` policy is mounted on the
	// spine binaries' full mount + the Rust stub, not the in-process default app.
	cell_gated_create: false,
	// Cross-process-only: the gated endpoint is a spine-binary mount, and the
	// case reads a real socket's close.
	ws_role_gated: false,
	// Read only by the front-door table's WS rows, which skip in-process (no
	// socket to upgrade); Hono's own refusals carry their bodies.
	ws_refusal_body: true
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
