/**
 * Coverage manifest for the spine test binary's **full** live RPC mount
 * (`build_full_spine_rpc_actions`).
 *
 * One row per method the binary exposes, tagging how each earns its
 * cross-backend coverage. `spine_method_coverage.test.ts` reconciles this
 * against the live mount — a method can't be added to the binary without a
 * row here, and a row can't go stale, without the test failing loud.
 *
 * Tiers (see `MethodCoverageEntry`):
 * - `declared` — on `create_spine_surface_spec`; auto-enumerated by the
 *   spec-derived round-trip + attack-surface suites (no bespoke suite).
 * - `off_surface` — live-mounted, off the declared surface; covered only by
 *   the named imperative `describe_*_cross_tests` suite.
 * - `backdoor` — a `_testing_*` daemon-token action; covered by the
 *   credential-gate suite + the in-process spec-level gate test.
 *
 * Not a test file (no `.test.` infix) — vitest skips it.
 *
 * @module
 */

import type {MethodCoverageEntry} from '$lib/testing/cross_backend/method_coverage.ts';

export const SPINE_METHOD_COVERAGE: ReadonlyArray<MethodCoverageEntry> = [
	// --- Declared surface — the `create_standard_rpc_actions` bundle ---
	// On `create_spine_surface_spec`; the spec-derived `describe_rpc_round_trip_tests`
	// + `describe_rpc_attack_surface_tests` enumerate every method below for
	// wire-shape + auth. Adding a method to these registries needs no manifest
	// edit beyond a new `declared` row.

	// admin + audit + invites + app-settings + account-lifecycle
	{method: 'admin_account_list', tier: 'declared'},
	{method: 'admin_session_list', tier: 'declared'},
	{method: 'admin_session_revoke_all', tier: 'declared'},
	{method: 'admin_token_revoke_all', tier: 'declared'},
	{method: 'account_delete', tier: 'declared'},
	{method: 'account_undelete', tier: 'declared'},
	{method: 'account_purge', tier: 'declared'},
	{method: 'invite_create', tier: 'declared'},
	{method: 'invite_delete', tier: 'declared'},
	{method: 'invite_list', tier: 'declared'},
	{method: 'app_settings_get', tier: 'declared'},
	{method: 'app_settings_update', tier: 'declared'},
	{method: 'audit_log_list', tier: 'declared'},
	{method: 'audit_log_role_grant_history', tier: 'declared'},

	// role-grant-offer (consentful grants)
	{method: 'role_grant_offer_create', tier: 'declared'},
	{method: 'role_grant_offer_accept', tier: 'declared'},
	{method: 'role_grant_offer_decline', tier: 'declared'},
	{method: 'role_grant_offer_retract', tier: 'declared'},
	{method: 'role_grant_offer_list', tier: 'declared'},
	{method: 'role_grant_offer_history', tier: 'declared'},
	{method: 'role_grant_revoke', tier: 'declared'},
	{method: 'role_grant_assign', tier: 'declared'},

	// account self-service
	{method: 'account_verify', tier: 'declared'},
	{method: 'account_session_list', tier: 'declared'},
	{method: 'account_session_revoke', tier: 'declared'},
	{method: 'account_session_revoke_all', tier: 'declared'},
	{method: 'account_token_create', tier: 'declared'},
	{method: 'account_token_list', tier: 'declared'},
	{method: 'account_token_revoke', tier: 'declared'},

	// --- Off-surface: cell CRUD (capability `cell_crud`) ---
	// Stateful verbs (`cell_get` has a top-level `.refine()`); off the declared
	// surface, driven by `describe_cell_crud_cross_tests`.
	{
		method: 'cell_create',
		tier: 'off_surface',
		capability: 'cell_crud',
		suite: 'describe_cell_crud_cross_tests',
	},
	{
		method: 'cell_get',
		tier: 'off_surface',
		capability: 'cell_crud',
		suite: 'describe_cell_crud_cross_tests',
	},
	{
		method: 'cell_update',
		tier: 'off_surface',
		capability: 'cell_crud',
		suite: 'describe_cell_crud_cross_tests',
	},
	{
		method: 'cell_delete',
		tier: 'off_surface',
		capability: 'cell_crud',
		suite: 'describe_cell_crud_cross_tests',
	},
	{
		method: 'cell_list',
		tier: 'off_surface',
		capability: 'cell_crud',
		suite: 'describe_cell_crud_cross_tests',
	},

	// --- Off-surface: cell relations / ACL / audit (capability `cell_relations`) ---
	// The grant / field / item / clone / audit verbs beyond plain CRUD; driven
	// by `describe_cell_relations_cross_tests`.
	{
		method: 'cell_grant_create',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_grant_list',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_grant_revoke',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_field_set',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_field_list',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_field_delete',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_item_insert',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_item_list',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_item_move',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_item_delete',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_clone',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	{
		method: 'cell_audit_list',
		tier: 'off_surface',
		capability: 'cell_relations',
		suite: 'describe_cell_relations_cross_tests',
	},
	// The moderation transition (`pending → approved | rejected`). Behavioral
	// coverage needs a *pending* contribution, which only exists when the
	// directory authorizer is mounted — so it rides the `cell_gated_create`
	// capability (the reference-spine-only policy), driven by the moderate cases
	// in the `cell_gated_create` cross file.
	{
		method: 'cell_moderate',
		tier: 'off_surface',
		capability: 'cell_gated_create',
		suite: 'describe_cell_moderate_cross_tests',
	},

	// --- Off-surface: opt-in actor resolvers (ungated) ---
	// Not in `create_standard_rpc_actions`; always mounted on the spine, their
	// cross suites run unconditionally (no capability flag).
	{method: 'actor_lookup', tier: 'off_surface', suite: 'describe_actor_lookup_cross_tests'},
	{method: 'actor_search', tier: 'off_surface', suite: 'describe_actor_search_cross_tests'},

	// --- Off-surface: peer/ping protocol action (capability `peer_request`) ---
	// A protocol action (filtered from the action manifest), but live-mounted on
	// the HTTP RPC endpoint too — so an HTTP invocation refuses `peer_no_transport`
	// rather than `method_not_found`. The WS endpoint registers it via the
	// `protocol_actions` spread. Covered by `describe_peer_ping_ws_tests`.
	{
		method: 'peer/ping',
		tier: 'off_surface',
		capability: 'peer_request',
		suite: 'describe_peer_ping_ws_tests',
	},

	// --- Backdoor: `_testing_*` daemon-token actions ---
	// Live-mounted on the test binary only, never on the declared surface
	// (`assert_no_testing_methods` guards that). The negative-credential gate is
	// `describe_testing_backdoor_cross_tests`; `_testing_drain_effects` is the
	// audit barrier the suites call, not itself credential-probed.
	{method: '_testing_reset', tier: 'backdoor', suite: 'describe_testing_backdoor_cross_tests'},
	{
		method: '_testing_mint_session',
		tier: 'backdoor',
		suite: 'describe_testing_backdoor_cross_tests',
	},
	{method: '_testing_put_fact', tier: 'backdoor', suite: 'describe_testing_backdoor_cross_tests'},
	{
		method: '_testing_schema_snapshot',
		tier: 'backdoor',
		suite: 'describe_testing_backdoor_cross_tests',
	},
	{
		method: '_testing_migration_tracker',
		tier: 'backdoor',
		suite: 'describe_testing_backdoor_cross_tests',
	},
	{
		method: '_testing_action_manifest',
		tier: 'backdoor',
		suite: 'describe_testing_backdoor_cross_tests',
	},
	{
		method: '_testing_drain_effects',
		tier: 'backdoor',
		note: 'audit barrier; not credential-probed',
	},
];
