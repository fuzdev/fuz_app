import '../assert_dev_env.ts';

/**
 * The **full** live RPC mount for fuz_app's own spine test binary — the
 * complete action set `testing_spine_server.ts` exposes on a single RPC
 * endpoint, in one place.
 *
 * Where `default_spine_surface.ts` defines the **declared** surface
 * (`create_spine_surface_spec` / `spine_rpc_endpoints` — the
 * `create_standard_rpc_actions` bundle the spec-derived suites
 * auto-enumerate), this module defines its superset: the standard bundle
 * **plus** the families the binary live-mounts but keeps off the declared
 * surface —
 *
 * - the `_testing_*` daemon-token backdoors (`create_testing_actions`),
 * - the full cell verb set (CRUD + grant + field + item + audit),
 * - the opt-in `actor_lookup` / `actor_search` resolvers,
 * - the `_testing_action_manifest` backdoor, appended last (it dumps the live
 *   method set for the cross-impl manifest-parity gate, so it must enumerate
 *   every method above it).
 *
 * Single-sourcing the mount here lets the binary, the in-process parity
 * setup, and the `spine_method_coverage` reconciliation test all build the
 * same list — so a method can never be mounted in one place and forgotten
 * in another. The reconciliation test enumerates `build_full_spine_rpc_actions`
 * with stub deps and asserts the live method set equals the tagged coverage
 * manifest; see `src/test/cross_backend/spine_method_coverage.ts`.
 *
 * **`$lib`-free by contract** — like `default_spine_surface.ts`, this module
 * is reached by the spawned TS binary under Gro's loader (which resolves
 * `.js`→`.ts` but not the `$lib` alias), so every import is relative. Keep
 * it that way.
 *
 * @module
 */

import type {RpcAction} from '../../actions/action_rpc.ts';
import {peer_ping_action} from '../../actions/peer_ping.ts';
import type {AppDeps} from '../../auth/deps.ts';
import type {DaemonTokenState} from '../../auth/daemon_token.ts';
import type {NotificationSender} from '../../auth/role_grant_offer_notifications.ts';
import {create_standard_rpc_actions} from '../../auth/standard_rpc_actions.ts';
import {create_all_cell_actions} from '../../auth/all_cell_actions.ts';
import {create_actor_lookup_actions} from '../../auth/actor_lookup_actions.ts';
import {create_actor_search_actions} from '../../auth/actor_search_actions.ts';
import type {RpcEndpointSpec} from '../../http/surface.ts';
import type {AppServerContext} from '../../server/app_server_context.ts';
import {
	create_testing_action_manifest_action,
	create_testing_actions,
} from './testing_reset_actions.ts';
import {test_cell_gated_create_authorize} from './test_cell_gated_create_authorize.ts';
import {spine_roles, spine_session_options} from './default_spine_surface.ts';
import {SPINE_RPC_PATH} from './spine_surface_constants.ts';

/** Options for {@link build_full_spine_rpc_actions} / {@link full_spine_rpc_endpoints}. */
export interface FullSpineMountOptions {
	/**
	 * Daemon-token runtime state threaded into `create_testing_actions` — the
	 * `_testing_reset` handler mutates `keeper_account_id` after re-seeding.
	 * Pass the same instance the daemon-token middleware reads. For the
	 * coverage test (method enumeration only, handlers never run) any stub
	 * state satisfies it.
	 */
	readonly daemon_token_state: DaemonTokenState;
	/**
	 * WS notification sender for the role-grant-offer fan-out. Pass the SAME
	 * `BackendWebsocketTransport` the WS endpoint registers connections against
	 * (the transport is the connection registry). Omitted for enumeration.
	 */
	readonly notification_sender?: NotificationSender | null;
}

/**
 * Build the complete live RPC action list the spine test binary mounts on
 * its single endpoint: the declared `create_standard_rpc_actions` bundle plus
 * the off-surface families (`_testing_*` backdoors, cells, actor resolvers).
 *
 * Mirrors the previous inline assembly in `testing_spine_server.ts` exactly —
 * `session_options` is pinned to `spine_session_options` (the binary's cookie
 * config) and `roles` to `spine_roles` (carrying `cell_editor`), so the only
 * runtime-varying inputs are the daemon-token state + notification sender.
 *
 * @param deps - the backend `AppDeps` (stub deps suffice for method enumeration)
 * @param options - daemon-token state + optional WS notification sender
 * @returns every `RpcAction` the binary exposes, in mount order
 */
export const build_full_spine_rpc_actions = (
	deps: AppDeps,
	options: FullSpineMountOptions,
): Array<RpcAction> => {
	const actions: Array<RpcAction> = [
		...create_standard_rpc_actions(
			{...deps, notification_sender: options.notification_sender ?? null},
			{roles: spine_roles},
		),
		...create_testing_actions(deps, {
			session_options: spine_session_options,
			daemon_token_state: options.daemon_token_state,
		}),
		// Mount the directory-model `cell_gated_create` test policy (twin of the
		// Rust stub's `TestCellGatedCreateAuthorize`) so the cross-backend
		// authorizer-parity suite has a known gate: `kind: 'space'` roots are
		// admin-only, contributions are gated by the root's `data.policy`, and
		// plain parentless creates stay open (the other cell suites are
		// unaffected). The handler hands the governing root's `data` to the
		// (pure) authorizer.
		...create_all_cell_actions(
			{...deps, authorize_create: test_cell_gated_create_authorize},
			{roles: spine_roles},
		),
		...create_actor_lookup_actions(deps),
		...create_actor_search_actions(deps),
		// `peer/ping` is mounted on the HTTP RPC endpoint too (not just WS) so an
		// HTTP invocation reaches the handler and refuses with `peer_no_transport`
		// rather than `method_not_found`. It's a protocol action, so it's filtered
		// out of the action manifest (`create_testing_action_manifest_action`) —
		// the WS endpoint registers it via the `protocol_actions` spread.
		peer_ping_action,
	];
	// Append the `_testing_action_manifest` backdoor last — it closes over the
	// complete `actions` list (plus its own spec) to dump the live method set
	// for the cross-impl manifest-parity gate, so it must come after every
	// method it enumerates.
	actions.push(create_testing_action_manifest_action(actions));
	return actions;
};

/**
 * Factory-form full mount at {@link SPINE_RPC_PATH}, the shape
 * `create_app_server`'s `rpc_endpoints` slot accepts. The spine binary wires
 * this directly; the surface builder (`create_spine_surface_spec`) keeps using
 * the narrower `spine_rpc_endpoints` so the declared surface stays the
 * standard bundle only.
 */
export const full_spine_rpc_endpoints = (
	ctx: AppServerContext,
	options: FullSpineMountOptions,
): Array<RpcEndpointSpec> => [
	{path: SPINE_RPC_PATH, actions: build_full_spine_rpc_actions(ctx.deps, options)},
];
