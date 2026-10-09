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
 * in another.
 *
 * The binary's WS endpoint serves the same list: `build_full_spine_mount`
 * builds it once and hands the WS mount the protocol actions plus every RPC
 * action, twinning the Rust `testing_spine_stub`, which compiles one action
 * registry and serves it on both transports. The reconciliation test
 * enumerates `build_full_spine_rpc_actions` with stub deps and asserts the live method set equals the tagged coverage
 * manifest; see `src/test/cross_backend/spine_method_coverage.ts`.
 *
 * **`$lib`-free by contract** — like `default_spine_surface.ts`, this module
 * is reached by the spawned TS binary under Gro's loader (which resolves
 * `.js`→`.ts` but not the `$lib` alias), so every import is relative. Keep
 * it that way.
 *
 * @module
 */

import type { RpcAction } from '../../actions/action_rpc.ts';
import type { Action } from '../../actions/action_types.ts';
import { peer_ping_action } from '../../actions/peer_ping.ts';
import { protocol_actions } from '../../actions/protocol.ts';
import type { AppDeps } from '../../auth/deps.ts';
import type { DaemonTokenState } from '../../auth/daemon_token.ts';
import type { NotificationSender } from '../../auth/role_grant_offer_notifications.ts';
import { create_standard_rpc_actions } from '../../auth/standard_rpc_actions.ts';
import { create_all_cell_actions } from '../../auth/all_cell_actions.ts';
import { create_actor_lookup_actions } from '../../auth/actor_lookup_actions.ts';
import { create_actor_search_actions } from '../../auth/actor_search_actions.ts';
import {
	create_testing_action_manifest_action,
	create_testing_actions
} from './testing_reset_actions.ts';
import { test_cell_gated_create_authorize } from './test_cell_gated_create_authorize.ts';
import { spine_roles, spine_session_options } from './default_spine_surface.ts';

/** Options for `build_full_spine_rpc_actions` / `build_full_spine_mount`. */
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
	options: FullSpineMountOptions
): Array<RpcAction> => {
	const actions: Array<RpcAction> = [
		...create_standard_rpc_actions(
			{ ...deps, notification_sender: options.notification_sender ?? null },
			{ roles: spine_roles }
		),
		...create_testing_actions(deps, {
			session_options: spine_session_options,
			daemon_token_state: options.daemon_token_state
		}),
		// Mount the directory-model `cell_gated_create` test policy (twin of the
		// Rust stub's `TestCellGatedCreateAuthorize`) so the cross-backend
		// authorizer-parity suite has a known gate: `kind: 'space'` roots are
		// admin-only, contributions are gated by the root's `data.policy`, and
		// plain parentless creates stay open (the other cell suites are
		// unaffected). The handler hands the governing root's `data` to the
		// (pure) authorizer.
		...create_all_cell_actions(
			{ ...deps, authorize_create: test_cell_gated_create_authorize },
			{ roles: spine_roles }
		),
		...create_actor_lookup_actions(deps),
		...create_actor_search_actions(deps),
		// `peer/ping` is mounted on the HTTP RPC endpoint too (not just WS) so an
		// HTTP invocation reaches the handler and refuses with `peer_no_transport`
		// rather than `method_not_found`. It's a protocol action, so it's filtered
		// out of the action manifest (`create_testing_action_manifest_action`) —
		// the WS endpoint registers it via the `protocol_actions` spread.
		peer_ping_action
	];
	// Append the `_testing_action_manifest` backdoor last — it closes over the
	// complete `actions` list (plus its own spec) to dump the live method set
	// for the cross-impl manifest-parity gate, so it must come after every
	// method it enumerates.
	actions.push(create_testing_action_manifest_action(actions));
	return actions;
};

/** The spine binary's RPC and WS action sets, built from one action list. */
export interface FullSpineMount {
	/** Every action on the RPC endpoint — `build_full_spine_rpc_actions`'s list. */
	readonly rpc_actions: Array<RpcAction>;
	/**
	 * The WS endpoint's actions: `protocol_actions` first, then every RPC
	 * action not already among them (`peer/ping` is on both lists). The same
	 * handler instances as `rpc_actions`.
	 */
	readonly ws_actions: Array<Action>;
}

/**
 * Build the full live mount for both of the spine binary's endpoints: the
 * RPC list, and the WS list that serves the same actions behind the protocol
 * actions.
 *
 * The Rust `testing_spine_stub` serves one action registry on RPC and WS, so
 * mounting the full list on WS keeps the two spines' WS method sets equal —
 * the cell verbs among them, whose dispatcher-charged rate limit
 * `describe_ws_action_rate_limit_cross_tests` drives over a socket. The one
 * difference is `cancel`: a registered protocol action on TS, read-loop-owned
 * (never dispatched) on Rust.
 *
 * @param deps - the backend `AppDeps`
 * @param options - daemon-token state + optional WS notification sender
 * @returns the RPC and WS action lists, built once and sharing handler instances
 */
export const build_full_spine_mount = (
	deps: AppDeps,
	options: FullSpineMountOptions
): FullSpineMount => {
	const rpc_actions = build_full_spine_rpc_actions(deps, options);
	const protocol_methods = new Set(protocol_actions.map((action) => action.spec.method));
	return {
		rpc_actions,
		ws_actions: [
			...protocol_actions,
			...rpc_actions.filter((action) => !protocol_methods.has(action.spec.method))
		]
	};
};
