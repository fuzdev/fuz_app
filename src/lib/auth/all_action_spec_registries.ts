/**
 * Canonical list of every fuz_auth action-spec registry — **for cross-cutting
 * walkers and codegen only**. Not a mounting surface; consumers continue to
 * import individual `all_*_action_specs` bundles (and `create_*_actions`
 * factories) per registration site.
 *
 * The "one main bundle" alternative is an antipattern for mounting:
 * `create_standard_rpc_actions` (admin + role_grant_offer + account) is the
 * canonical surface, and opt-in registries (`self_service_role`,
 * `actor_lookup`) are deliberately opt-in because their eligibility
 * (`eligible_roles`) or coverage (byline labels) is app-specific. Spreading
 * everything into a single mount would silently widen the dispatch surface
 * the moment a new opt-in landed — the exact failure mode this module is
 * built to detect, not propagate. See `./CLAUDE.md` §RPC actions
 * (`auth/standard_rpc_actions.ts`).
 *
 * Use cases for this registry:
 *
 * - Cross-registry walker tests (input-invariants, auth-shape
 *   biconditional) — iterate the spec arrays once, fail when a new
 *   registry slips by without an entry here.
 * - Codegen that needs to see every fuz_auth surface at once
 *   (typed-client filters, attack-surface reports). For typed-client
 *   wiring of the standard surface, prefer `all_standard_action_specs`
 *   in `auth/standard_action_specs.ts` — it mirrors the
 *   `create_standard_rpc_actions` mount and stays narrower than this
 *   registry-of-registries (no opt-in bundles).
 *
 * `protocol_action_specs` (heartbeat / cancel) is **not** included —
 * those are transport-level wire-protocol concerns shipped by fuz_app
 * and spread by every consumer at registration via `protocol_actions`
 * from `actions/protocol.ts`. Walker tests that need protocol
 * coverage spread `protocol_action_specs` separately.
 *
 * @module
 */

import type { RequestResponseActionSpec } from '../actions/action_spec.ts';
import { all_admin_action_specs } from './admin_action_specs.ts';
import { all_role_grant_offer_action_specs } from './role_grant_offer_action_specs.ts';
import { all_account_action_specs } from './account_action_specs.ts';
import { all_self_service_role_action_specs } from './self_service_role_action_specs.ts';
import { all_actor_lookup_action_specs } from './actor_lookup_action_specs.ts';
import { all_actor_search_action_specs } from './actor_search_action_specs.ts';

/** One named entry in the registry-of-registries. */
export interface FuzAuthActionSpecRegistry {
	/** Stable identifier matching the source bundle name (`'admin'`, `'role_grant_offer'`, etc.). */
	name: string;
	/** The bundle's spec array — kept readonly here even when the source declares it mutable. */
	specs: ReadonlyArray<RequestResponseActionSpec>;
}

/**
 * Every fuz_auth action-spec registry, in dependency-stable order.
 *
 * Update this list when a new fuz_auth registry lands. The walker tests
 * (`action_spec_input_invariants.test.ts`,
 * `all_action_spec_registries.acting_biconditional.test.ts`) iterate
 * over it — a missing entry silently skips coverage, which is the
 * failure mode the registry-of-registries shape exists to prevent.
 */
export const all_fuz_auth_action_spec_registries: ReadonlyArray<FuzAuthActionSpecRegistry> = [
	{ name: 'admin', specs: all_admin_action_specs },
	{ name: 'role_grant_offer', specs: all_role_grant_offer_action_specs },
	{ name: 'account', specs: all_account_action_specs },
	{ name: 'self_service_role', specs: all_self_service_role_action_specs },
	{ name: 'actor_lookup', specs: all_actor_lookup_action_specs },
	{ name: 'actor_search', specs: all_actor_search_action_specs }
];
