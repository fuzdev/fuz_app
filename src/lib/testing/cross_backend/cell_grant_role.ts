import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for **role-shaped** `cell_grant`s.
 *
 * The cell CRUD / relations suites exercise only actor-shaped grant
 * principals. This suite covers the role-shaped path and its closed-registry
 * gate — the security-correctness property that the Rust spine previously
 * lacked (it created inert grant rows for any role string). Both spines now
 * validate the role against a closed registry at create.
 *
 * - **role grant admits a holder; excludes a non-holder** — an owner grants
 *   `{role}` on a private cell; an account holding that role can `cell_get`
 *   it (200), an account without it gets the IDOR-mask 404.
 * - **unknown role rejected at create (security-correctness)** — granting a
 *   role outside the registry is `invalid_params` / `cell_grant_unknown_role`,
 *   not a silent inert row.
 * - **editor-level role grant admits edit** — a holder of an `editor`-level
 *   role grant can `cell_update` the cell's content.
 *
 * The holder is seeded via `extra_accounts` under `CELL_ROLE_HOLDER_USERNAME`
 * holding `CELL_EDITOR_ROLE` (the role has no grant path, so it can't be
 * offered — the bootstrap-cradle seed is the only path). Both legs configure
 * that seed and register `CELL_EDITOR_ROLE` in their role registry; the Rust
 * `testing_spine_stub` mirrors the same membership in its `known_roles`.
 *
 * Cites `security.md` §Authorization (role-shaped cell-grant validation).
 * Runs both legs via the shared `{setup_test}` protocol: in-process
 * (`auth/cell_grant_role_parity.db.test.ts`) + cross-process
 * (`cross_backend/cell_grant_role.cross.test.ts`). Gated on
 * `capabilities.cell_relations` (true on every spine, so it never skips).
 *
 * `$lib`-free by contract (relative specifiers only).
 *
 * @module
 */

import { describe, assert } from 'vitest';

import {
	CellCreateOutput,
	CellGetOutput,
	CellListOutput,
	CellUpdateOutput
} from '../../auth/cell_action_specs.ts';
import {
	CellGrantCreateOutput,
	ERROR_CELL_GRANT_UNKNOWN_ROLE
} from '../../auth/cell_grant_action_specs.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, error_reason, expect_output } from './cell_cross_helpers.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions } from './setup.ts';
import { SPINE_CELL_EDITOR_ROLE, SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** App role the holder is seeded with; matches the spine's registered role. */
export const CELL_EDITOR_ROLE = SPINE_CELL_EDITOR_ROLE;

/** Username the fixture seeds (via `extra_accounts`) holding `CELL_EDITOR_ROLE`. */
export const CELL_ROLE_HOLDER_USERNAME = 'cell_role_holder';

/** A role string deliberately absent from the registry. */
const UNREGISTERED_ROLE = 'not_a_registered_role';

export const describe_cell_grant_role_cross_tests = (
	options: RpcPathCapabilityGatedCrossSuiteOptions
): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('cell_grant role-shaped parity', () => {
		test_if(
			capabilities.cell_relations,
			'role grant admits a holder of the role and excludes a non-holder',
			async () => {
				const fixture = await setup_test();
				const t = fixture.transport;
				const owner = await fixture.create_account({ username: 'cell_role_owner' });
				const owner_h = owner.create_session_headers();
				const holder = fixture.extra_accounts[CELL_ROLE_HOLDER_USERNAME];
				assert.ok(holder, `fixture must seed the ${CELL_ROLE_HOLDER_USERNAME} extra account`);
				const stranger = await fixture.create_account({ username: 'cell_role_stranger' });

				// Owner creates a private cell (default visibility) and grants
				// view access to anyone holding CELL_EDITOR_ROLE.
				const created = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', { kind: 'note', data: {} }, owner_h),
					CellCreateOutput
				);
				const cell_id = created.cell.id;
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{ cell_id, level: 'viewer', principal: { kind: 'role', role: CELL_EDITOR_ROLE } },
						owner_h
					),
					CellGrantCreateOutput
				);

				// Holder of the role is admitted through the role-shaped grant.
				const holder_view = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_get',
						{ id: cell_id },
						holder.create_session_headers()
					),
					CellGetOutput
				);
				assert.strictEqual(holder_view.cell.id, cell_id, 'holder sees the granted cell');

				// A non-holder sees the IDOR-mask 404 — the grant keys on the role,
				// not mere authentication.
				const stranger_view = await cross_rpc_call(
					t,
					rpc_path,
					'cell_get',
					{ id: cell_id },
					stranger.create_session_headers()
				);
				assert.ok(!stranger_view.ok, 'non-holder must not see the cell');
				assert.strictEqual(error_reason(stranger_view), 'cell_not_found');
			}
		);

		test_if(
			capabilities.cell_relations,
			"cell_list shared_with:'me' admits through the role branch of the grant predicate",
			async () => {
				// The role-admit arm of the shared-with predicate (the
				// `caller_role_grants` branch of the CTE in the Rust
				// `query_cell_list` / the TS list query) — pinned nowhere else:
				// the actor-shaped `shared_with:'me'` case in `cell_relations.ts`
				// runs the CTE but its role branch never matches, and the
				// storage-half copy in `fuz_cell/tests` is a textually separate
				// EXISTS the CTE can silently drift from. An ungranted control
				// cell keeps the semi-join non-vacuous (dropping it must change
				// the result), and a non-holder proves the branch keys on the
				// role, not on authentication.
				const fixture = await setup_test();
				const t = fixture.transport;
				const owner = await fixture.create_account({ username: 'cell_role_list_owner' });
				const owner_h = owner.create_session_headers();
				const holder = fixture.extra_accounts[CELL_ROLE_HOLDER_USERNAME];
				assert.ok(holder, `fixture must seed the ${CELL_ROLE_HOLDER_USERNAME} extra account`);
				const stranger = await fixture.create_account({ username: 'cell_role_list_stranger' });

				const granted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ kind: 'note', data: { label: 'role-shared' } },
						owner_h
					),
					CellCreateOutput
				);
				// control: same owner, same visibility, no grant — must stay out
				const ungranted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_create',
						{ kind: 'note', data: { label: 'unshared control' } },
						owner_h
					),
					CellCreateOutput
				);
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{
							cell_id: granted.cell.id,
							level: 'viewer',
							principal: { kind: 'role', role: CELL_EDITOR_ROLE }
						},
						owner_h
					),
					CellGrantCreateOutput
				);

				const holder_list = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_list',
						{ shared_with: 'me' },
						holder.create_session_headers()
					),
					CellListOutput
				);
				const holder_ids = holder_list.cells.map((c) => c.id);
				assert.ok(
					holder_ids.includes(granted.cell.id),
					'the role-granted cell must reach a holder of the role via shared_with:me'
				);
				assert.ok(
					!holder_ids.includes(ungranted.cell.id),
					'the ungranted control cell must not — the semi-join is load-bearing'
				);

				const stranger_list = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_list',
						{ shared_with: 'me' },
						stranger.create_session_headers()
					),
					CellListOutput
				);
				assert.ok(
					!stranger_list.cells.some((c) => c.id === granted.cell.id),
					'a non-holder must not be admitted through the role branch'
				);
			}
		);

		test_if(
			capabilities.cell_relations,
			'role-shaped grant for an unregistered role is rejected at create',
			async () => {
				const fixture = await setup_test();
				const t = fixture.transport;
				const owner = await fixture.create_account({ username: 'cell_unknown_role_owner' });
				const owner_h = owner.create_session_headers();
				const created = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', { kind: 'note', data: {} }, owner_h),
					CellCreateOutput
				);
				const denied = await cross_rpc_call(
					t,
					rpc_path,
					'cell_grant_create',
					{
						cell_id: created.cell.id,
						level: 'viewer',
						principal: { kind: 'role', role: UNREGISTERED_ROLE }
					},
					owner_h
				);
				assert.ok(!denied.ok, 'granting an unregistered role must fail');
				assert.strictEqual(error_reason(denied), ERROR_CELL_GRANT_UNKNOWN_ROLE);
			}
		);

		test_if(
			capabilities.cell_relations,
			'editor-level role grant admits content edit',
			async () => {
				const fixture = await setup_test();
				const t = fixture.transport;
				const owner = await fixture.create_account({ username: 'cell_role_edit_owner' });
				const owner_h = owner.create_session_headers();
				const holder = fixture.extra_accounts[CELL_ROLE_HOLDER_USERNAME];
				assert.ok(holder, `fixture must seed the ${CELL_ROLE_HOLDER_USERNAME} extra account`);

				const created = expect_output(
					await cross_rpc_call(t, rpc_path, 'cell_create', { kind: 'note', data: {} }, owner_h),
					CellCreateOutput
				);
				const cell_id = created.cell.id;
				expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_grant_create',
						{ cell_id, level: 'editor', principal: { kind: 'role', role: CELL_EDITOR_ROLE } },
						owner_h
					),
					CellGrantCreateOutput
				);

				const edited = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'cell_update',
						{ cell_id, data: { label: 'by role editor' } },
						holder.create_session_headers()
					),
					CellUpdateOutput
				);
				assert.strictEqual(
					edited.cell.updated_by,
					holder.actor.id,
					'edit attributed to the holder'
				);
			}
		);
	});
};
