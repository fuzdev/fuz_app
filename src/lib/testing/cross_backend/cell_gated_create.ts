import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **cell-creation authorizer**
 * (`CellCreateAuthorize`).
 *
 * The authorizer adds no method, column, or wire shape, so the schema-snapshot
 * and action-manifest parity gates are **blind** to a TS↔Rust authorizer
 * divergence (the authorizer in the wrong phase, a different deny shape,
 * create-vs-update). This behavioral cross case is the only gate that catches
 * one — proven *here in fuz_app*, against both reference spines.
 *
 * Both spines mount the same `test_cell_gated_create_authorize` policy (the
 * TS spine binary via `full_spine_mount`, the Rust `testing_spine_stub` via
 * `TestCellGatedCreateAuthorize`): creating a `kind: 'gated'` cell requires the
 * `participant` app-role or admin; every other kind (and a typeless cell) is
 * open. The suite asserts all three spines agree:
 *
 * - **non-participant → gated kind is denied** with the `cell_not_found` 404
 *   IDOR mask (a gated kind is wire-indistinguishable from a missing resource).
 * - **non-participant → ungated kind succeeds** (the policy gates only `gated`).
 * - **participant → gated kind succeeds** (the role unlocks it).
 * - **admin → gated kind succeeds** (the admin bypass).
 *
 * Gated on `capabilities.cell_gated_create` — `true` only on the reference
 * spine binaries that mount the policy, so it skips for generic consumers and
 * the in-process default app (the authorizer hook's in-process coverage is the
 * standalone `auth/cell_create_authorize.db.test.ts`).
 *
 * `$lib`-free by contract (relative specifiers only).
 *
 * @module
 */

import {describe, assert} from 'vitest';

import {CellCreateOutput} from '../../auth/cell_action_specs.ts';
import {test_if} from './capabilities.ts';
import {cross_rpc_call, error_reason, expect_output} from './cell_cross_helpers.ts';
import type {RpcPathCrossSuiteOptions} from './setup.ts';
import {SPINE_RPC_PATH} from './spine_surface_constants.ts';
import {GATED_CELL_KIND, GATED_CELL_ROLE} from './test_cell_gated_create_authorize.ts';

export const describe_cell_gated_create_cross_tests = (options: RpcPathCrossSuiteOptions): void => {
	const {setup_test, capabilities} = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('cell_gated_create authorizer parity', () => {
		test_if(
			capabilities.cell_gated_create,
			'a non-participant is denied the gated kind (cell_not_found 404 IDOR mask)',
			async () => {
				const fixture = await setup_test();
				const stranger = await fixture.create_account({username: 'gated_stranger'});
				const denied = await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{kind: GATED_CELL_KIND, data: {}},
					stranger.create_session_headers(),
				);
				assert.ok(!denied.ok, 'a non-participant must not create the gated kind');
				assert.strictEqual(error_reason(denied), 'cell_not_found');
			},
		);

		test_if(
			capabilities.cell_gated_create,
			'a non-participant may create an ungated kind (the policy gates only `gated`)',
			async () => {
				const fixture = await setup_test();
				const stranger = await fixture.create_account({username: 'ungated_stranger'});
				const created = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{kind: 'note', data: {}},
						stranger.create_session_headers(),
					),
					CellCreateOutput,
				);
				assert.strictEqual(created.cell.kind, 'note', 'the ungated cell keeps its kind');
			},
		);

		test_if(capabilities.cell_gated_create, 'a participant may create the gated kind', async () => {
			const fixture = await setup_test();
			const participant = await fixture.create_account({
				username: 'gated_participant',
				roles: [GATED_CELL_ROLE],
			});
			const created = expect_output(
				await cross_rpc_call(
					fixture.transport,
					rpc_path,
					'cell_create',
					{kind: GATED_CELL_KIND, data: {}},
					participant.create_session_headers(),
				),
				CellCreateOutput,
			);
			assert.strictEqual(
				created.cell.kind,
				GATED_CELL_KIND,
				'the participant created the gated kind',
			);
		});

		test_if(
			capabilities.cell_gated_create,
			'an admin (keeper) may create the gated kind (admin bypass)',
			async () => {
				const fixture = await setup_test();
				const created = expect_output(
					await cross_rpc_call(
						fixture.transport,
						rpc_path,
						'cell_create',
						{kind: GATED_CELL_KIND, data: {}},
						fixture.create_session_headers(),
					),
					CellCreateOutput,
				);
				assert.strictEqual(created.cell.kind, GATED_CELL_KIND, 'admin bypasses the gate');
			},
		);
	});
};
