import '../assert_dev_env.ts';

/**
 * Canonical no-domain spine surface — the standard fuz_app
 * auth/account/admin/audit surface with no consumer domain layer on top.
 *
 * This is the single source of truth for "the standard spine surface",
 * shared by:
 *
 * - the Rust `testing_spine_stub` cross-process self-tests (which build the
 *   `AppSurfaceSpec` via `create_spine_surface_spec` and drive the binary's
 *   wire shape),
 * - the TS `testing_spine_server` cross-process binary (which feeds
 *   `create_spine_route_specs` + `spine_rpc_endpoints` into a live
 *   `create_app_server`), and
 * - the `cross_backend_ts_*` self-test projects.
 *
 * **`$lib`-free by contract.** This module and everything it imports use
 * relative specifiers (no `$lib` SvelteKit alias) so the spawned TS test
 * binary — run under Gro's loader, which resolves `.js`→`.ts` and package
 * imports but **not** the `$lib` alias — can import it transitively. Keep
 * it that way: a `$lib` import anywhere in this graph breaks the binary
 * spawn while still typechecking under vitest.
 *
 * @module
 */

import type {Logger} from '@fuzdev/fuz_util/log.ts';

import {create_account_route_specs} from '../../auth/account_routes.ts';
import {create_audit_log_route_specs} from '../../auth/audit_log_routes.ts';
import type {NotificationSender} from '../../auth/role_grant_offer_notifications.ts';
import {create_role_schema, type RoleSchemaResult} from '../../auth/role_schema.ts';
import {GRANT_PATH_ADMIN} from '../../auth/grant_path_schema.ts';
import {create_session_config, type SessionOptions} from '../../auth/session_cookie.ts';
import {create_signup_route_specs} from '../../auth/signup_routes.ts';
import {create_standard_rpc_actions} from '../../auth/standard_rpc_actions.ts';
import {create_ready_route_spec, load_expected_schema} from '../../http/common_routes.ts';
import {prefix_route_specs, type RouteSpec} from '../../http/route_spec.ts';
import type {AppSurfaceSpec, RpcEndpointSpec} from '../../http/surface.ts';
import type {AppServerContext} from '../../server/app_server_context.ts';
import {create_test_app_surface_spec} from '../stubs.ts';

// Pure path / role / fixture-URL constants live on the hono-free
// `spine_surface_constants.ts` leaf so cross-process suite modules can import them
// without dragging this module's eager in-process route handlers
// (→ `session_middleware` → `hono/cookie`). Import only the constants this
// module uses internally; callers that need a bare constant reach for the leaf.
import {
	SPINE_CELL_EDITOR_ROLE,
	SPINE_EXPECTED_SCHEMA_URL,
	SPINE_PARTICIPANT_ROLE,
	SPINE_RPC_PATH,
} from './spine_surface_constants.ts';

/**
 * Session config — cookie name matches the binary's issued session cookie
 * (`fuz_session`) so cookie-attribute assertions + jar extraction line up.
 */
export const spine_session_options: SessionOptions<string> = create_session_config('fuz_session');

/**
 * The spine's closed role registry: built-ins plus two app roles —
 * `SPINE_CELL_EDITOR_ROLE` (no grant path; the role-shaped-`cell_grant`
 * suite's bootstrap-seeded role) and `SPINE_PARTICIPANT_ROLE`
 * (`grant_paths: ['admin']`; the role-gated-participation suite's
 * admin-grantable role). Threaded into the cell spec set's role-validity gate
 * **and** the auth grantability gates; the Rust stub mirrors the same
 * membership in both its `RoleRegistry` and `known_roles`. The `participant`
 * entry also gives the admin suite real app-role grant-path coverage
 * (`admin_account_list.grantable_roles` carries it on both spines).
 */
export const spine_roles: RoleSchemaResult = create_role_schema([
	{name: SPINE_CELL_EDITOR_ROLE, grant_paths: []},
	{name: SPINE_PARTICIPANT_ROLE, grant_paths: [GRANT_PATH_ADMIN]},
]);

/** Options for {@link spine_rpc_endpoints}. */
export interface SpineRpcEndpointsOptions {
	/**
	 * WS notification sender threaded into the role-grant-offer sub-factory for
	 * server-initiated fan-out (`role_grant_offer_received` / `_accepted` /
	 * `_declined` / `_retracted` / `_supersede`, flat `role_grant_revoke`).
	 *
	 * **Shared-instance trap.** Pass the SAME `BackendWebsocketTransport`
	 * instance the WS endpoint registers connections against — the transport
	 * *is* the connection registry, so a separate instance would fan out to an
	 * empty registry and reach nobody (silently). The TS spine binary
	 * constructs one `ws_transport` and threads it both here and into
	 * `register_ws_endpoint`.
	 *
	 * Omitted (the default) for the shared `create_spine_surface_spec` path —
	 * surface generation doesn't depend on it, and it must stay absent there so
	 * the declared snapshot is unaffected.
	 */
	readonly notification_sender?: NotificationSender | null;
}

/**
 * Factory-form RPC endpoints over the per-test `ctx.deps`. `create_app_server`
 * (in the binary) owns live dispatch; the surface builder invokes the factory
 * once with a stub ctx for setup-time path/method lookup, so the handler
 * closures are never called across the process boundary.
 *
 * Test binaries append their own `_testing_reset` action to this endpoint's
 * `actions` (see `testing/cross_backend/testing_reset_actions.ts`); it is intentionally excluded
 * here so it stays off the declared surface (the harness calls it directly
 * over the daemon-token channel).
 *
 * `options.notification_sender`, when supplied, reaches the role-grant-offer
 * sub-factory so the spine emits the WS notification family — see
 * `SpineRpcEndpointsOptions`.
 */
export const spine_rpc_endpoints = (
	ctx: AppServerContext,
	options?: SpineRpcEndpointsOptions,
): Array<RpcEndpointSpec> => [
	{
		path: SPINE_RPC_PATH,
		actions: create_standard_rpc_actions(
			{...ctx.deps, notification_sender: options?.notification_sender ?? null},
			{roles: spine_roles},
		),
	},
];

/**
 * Account REST + signup route specs under `/api/account` (bootstrap
 * auto-mounted by the surface builder / `create_app_server`), plus the
 * audit-log SSE stream under `/api/admin` **only when `ctx.audit_sse` is
 * set** (the TS spine binary passes `audit_log_sse: true`).
 *
 * The shared `create_spine_surface_spec()` builds its ctx with
 * `audit_sse: null`, so the declared surface snapshot stays SSE-free and the
 * Rust `spine_stub` cross test is unaffected — only the live TS binary mounts
 * the stream at `SPINE_SSE_PATH`.
 */
export const create_spine_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options: spine_session_options,
			// Honor the limiters the server was assembled with (on `AppServerContext`
			// per the `ip_rate_limiter` / `login_account_rate_limiter` TSDoc) rather
			// than hardcoding `null`. The standard spine binary passes `null` (the
			// cross suites fire many loopback logins and must not trip a limiter), so
			// this is behavior-preserving there; the dedicated login-security cross
			// backend passes real limiters to exercise the 429 + `Retry-After` path
			// and XFF-keyed bucketing over the wire (see `login_security.ts`).
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			login_fail_floor_ms: 0,
			bootstrap_status: ctx.bootstrap_status,
		}),
		...create_signup_route_specs(ctx.deps, {
			session_options: spine_session_options,
			ip_rate_limiter: null,
			signup_account_rate_limiter: null,
			// Disable the denial floor so the identity-parity suite's accepted
			// cases (valid username/email, no invite → 403 no-matching-invite)
			// don't each pay the 250ms timing floor. Mirrors `login_fail_floor_ms: 0`
			// above — the floor is a production timing-oracle defense, not
			// behavior any cross test asserts.
			signup_fail_floor_ms: 0,
		}),
	]),
	...(ctx.audit_sse
		? prefix_route_specs('/api/admin', create_audit_log_route_specs({stream: ctx.audit_sse}))
		: []),
];

/**
 * The spine's `/ready` route spec — the column-presence schema-drift deploy
 * gate, reading {@link SPINE_EXPECTED_SCHEMA_URL}. Mounted **live** by the TS
 * spine binary (in `build_spine_app`) and the in-process readiness parity leg,
 * but kept **off** the declared surface (`create_spine_surface_spec`) like the
 * fact-serving / ws / sse behaviors — `describe_ready_cross_tests` (gated on
 * `capabilities.ready`) is its explicit coverage, not the generic round-trip.
 *
 * @param log - optional logger for server-side drift diagnostics
 */
export const create_spine_ready_route_spec = (log?: Logger): RouteSpec =>
	create_ready_route_spec({expected: load_expected_schema(SPINE_EXPECTED_SCHEMA_URL), log});

/**
 * The `AppSurfaceSpec` for the standard spine surface — the wire-shape
 * source the cross-process round-trip + RPC-round-trip suites validate
 * against. `bootstrap: {mode: 'surface_only'}` mounts
 * `POST /api/account/bootstrap`'s shape to match the binary (which wires
 * bootstrap for real); the harness's `globalSetup` already consumed the
 * live bootstrap, so the cross-process round-trip validates the binary's
 * 409 against the route's declared error schema.
 */
export const create_spine_surface_spec = (): AppSurfaceSpec =>
	create_test_app_surface_spec({
		session_options: spine_session_options,
		create_route_specs: create_spine_route_specs,
		rpc_endpoints: spine_rpc_endpoints,
		bootstrap: {mode: 'surface_only'},
	});
