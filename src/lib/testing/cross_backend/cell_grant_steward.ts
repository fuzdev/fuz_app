import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the **steward-revoke seam**
 * (`CellGrantRevokeAuthorize`) on `cell_grant_revoke`.
 *
 * Like the creation authorizer, the revoke hook adds no method, column, or wire
 * shape, so the schema-snapshot and action-manifest parity gates are blind to a
 * TS↔Rust divergence in it — the fence, the refusal shape, the audit stamp.
 * This behavioral case is the gate that catches one.
 *
 * Both spines mount the same test policy (the TS spine binary via
 * `test_cell_grant_steward_revoke_authorize`, the Rust `testing_spine_stub` via
 * `TestCellGrantStewardRevokeAuthorize`): a scoped `participant` grant stewards
 * its scope. A cell owner shares a private cell with `participant` at a scope;
 * the suite asserts every spine agrees on:
 *
 * - **the scope's steward revokes** — a non-manager holding `participant` at
 *   the grant's scope revokes it: `{ok: true, still_admitted: false}`, the grant
 *   gone from the owner's list, and the `cell_grant_revoke` audit row stamped
 *   `steward: true`.
 * - **another scope's steward gets the 404 mask** — `cell_grant_not_found`, the
 *   same refusal as no hook, and the grant stays.
 * - **a scopeless role grant is fenced off** — a caller holding `participant`
 *   globally *and* at a scope still gets the 404 on a grant naming no scope:
 *   the spine never asks the hook, which would have admitted the global grant
 *   had it been asked with a null scope.
 *
 * Gated on `capabilities.cell_relations` (the grant verbs) and
 * `capabilities.cell_gated_create` (the reference spines' test cell policies,
 * which this one rides beside). The hook's in-process coverage, including the
 * manager, self-revoke, actor-shaped and deleted-cell fences, is
 * `auth/cell_grant_actions.authz.db.test.ts`.
 *
 * @module
 */

import { describe, assert } from 'vitest';

import { CellCreateOutput } from '../../auth/cell_action_specs.ts';
import {
	CellGrantCreateOutput,
	CellGrantListOutput,
	CellGrantRevokeOutput,
	ERROR_CELL_GRANT_NOT_FOUND
} from '../../auth/cell_grant_action_specs.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, error_reason, expect_output } from './cross_rpc.ts';
import { list_audit_events } from './audit_cross_helpers.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions } from './setup.ts';
import { SPINE_PARTICIPANT_ROLE, SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** The scope the shared grant is bound to. */
const STEWARDED_SCOPE_ID = '55555555-5555-4555-8555-555555555555';

/** A scope the shared grant isn't bound to. */
const OTHER_SCOPE_ID = '66666666-6666-4666-8666-666666666666';

/** The scope kind the test `participant` grants carry. */
const STEWARD_SCOPE_KIND = 'space';

export const describe_cell_grant_steward_cross_tests = (
	options: RpcPathCapabilityGatedCrossSuiteOptions
): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const enabled = capabilities.cell_relations && capabilities.cell_gated_create;

	type Fixture = Awaited<ReturnType<typeof setup_test>>;

	/** A fresh account holding `participant` at each of `scope_ids` (`null` = global). */
	const create_participant = async (
		fixture: Fixture,
		username: string,
		scope_ids: ReadonlyArray<string | null>
	) => {
		const account = await fixture.create_account({ username });
		for (const scope_id of scope_ids) {
			const assigned = await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'role_grant_assign',
				scope_id === null
					? { to_account_id: account.account.id, role: SPINE_PARTICIPANT_ROLE }
					: {
							to_account_id: account.account.id,
							role: SPINE_PARTICIPANT_ROLE,
							scope_kind: STEWARD_SCOPE_KIND,
							scope_id
						},
				fixture.create_session_headers()
			);
			assert.ok(assigned.ok, `role_grant_assign failed: ${JSON.stringify(assigned.error)}`);
		}
		return account;
	};

	/** An owner's private cell shared with `participant`, at `scope_id` when given. */
	const create_shared_cell = async (fixture: Fixture, scope_id: string | null) => {
		const owner = await fixture.create_account({ username: 'steward_cell_owner' });
		const created = expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_create',
				{ kind: 'note', data: {} },
				owner.create_session_headers()
			),
			CellCreateOutput
		);
		const granted = expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_grant_create',
				{
					cell_id: created.cell.id,
					level: 'viewer',
					principal: { kind: 'role', role: SPINE_PARTICIPANT_ROLE, scope_id }
				},
				owner.create_session_headers()
			),
			CellGrantCreateOutput
		);
		return { owner, cell_id: created.cell.id, grant_id: granted.grant.id };
	};

	const list_grant_ids = async (
		fixture: Fixture,
		owner: { create_session_headers: () => Record<string, string> },
		cell_id: string
	): Promise<Array<string>> =>
		expect_output(
			await cross_rpc_call(
				fixture.transport,
				rpc_path,
				'cell_grant_list',
				{ cell_id },
				owner.create_session_headers()
			),
			CellGrantListOutput
		).grants.map((g) => g.id);

	const revoke = (
		fixture: Fixture,
		caller: { create_session_headers: () => Record<string, string> },
		grant_id: string
	) =>
		cross_rpc_call(
			fixture.transport,
			rpc_path,
			'cell_grant_revoke',
			{ grant_id },
			caller.create_session_headers()
		);

	describe('cell_grant_steward revoke parity', () => {
		test_if(enabled, "the scope's steward revokes, audited steward: true", async () => {
			const fixture = await setup_test();
			const { owner, cell_id, grant_id } = await create_shared_cell(fixture, STEWARDED_SCOPE_ID);
			const steward = await create_participant(fixture, 'steward_of_scope', [STEWARDED_SCOPE_ID]);

			const revoked = expect_output(
				await revoke(fixture, steward, grant_id),
				CellGrantRevokeOutput
			);
			assert.deepStrictEqual(revoked, { ok: true, still_admitted: false });
			assert.notInclude(await list_grant_ids(fixture, owner, cell_id), grant_id);

			const events = await list_audit_events(
				fixture,
				{ event_type: 'cell_grant_revoke' },
				rpc_path
			);
			const event = events.find((e) => e.metadata?.grant_id === grant_id);
			assert.ok(event, 'the revoke is audited');
			assert.strictEqual(event.metadata?.steward, true);
			assert.notProperty(event.metadata, 'self');
		});

		test_if(enabled, "another scope's steward gets the 404 mask", async () => {
			const fixture = await setup_test();
			const { owner, cell_id, grant_id } = await create_shared_cell(fixture, STEWARDED_SCOPE_ID);
			const outsider = await create_participant(fixture, 'steward_elsewhere', [OTHER_SCOPE_ID]);

			const refused = await revoke(fixture, outsider, grant_id);
			assert.strictEqual(refused.status, 404);
			assert.strictEqual(error_reason(refused), ERROR_CELL_GRANT_NOT_FOUND);
			assert.include(await list_grant_ids(fixture, owner, cell_id), grant_id);
		});

		test_if(enabled, 'a scopeless role grant never reaches the hook', async () => {
			const fixture = await setup_test();
			const { owner, cell_id, grant_id } = await create_shared_cell(fixture, null);
			// a global `participant` grant would satisfy the policy asked with a
			// null scope, so only the fence keeps this caller out
			const caller = await create_participant(fixture, 'steward_global', [
				null,
				STEWARDED_SCOPE_ID
			]);

			const refused = await revoke(fixture, caller, grant_id);
			assert.strictEqual(refused.status, 404);
			assert.strictEqual(error_reason(refused), ERROR_CELL_GRANT_NOT_FOUND);
			assert.include(await list_grant_ids(fixture, owner, cell_id), grant_id);
		});
	});
};
