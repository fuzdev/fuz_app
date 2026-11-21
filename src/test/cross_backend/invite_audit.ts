/**
 * The audit rows of `invite_create` and `invite_delete`, on both spines.
 *
 * A success row is the acting admin's — `actor_id` and `account_id` both set,
 * no target — with the event's metadata. A delete of an id naming no unclaimed
 * invite is refused 404 `invite_not_found` and writes one `failure` row, its
 * metadata the reason and the probed id (`attempted_invite_id`): the probe key
 * is a UUID, so the row holds nothing an admin's typo would leak, unlike the
 * `invite_create` refusals, whose keys are an email or a username and which
 * write none. The failure row is written outside the handler's transaction,
 * which the refusal rolls back, so reading it after the 404 pins that too.
 * Called from `conformance.cross.test.ts` beside the conformance table, over
 * the same setup; cross-process only, since it reads rows behind the
 * `_testing_drain_effects` barrier the in-process conformance mount lacks.
 * The TS in-process pin is `auth/invite_actions.db.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { ERROR_INVITE_NOT_FOUND } from '#lib/http/error_schemas.ts';
import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import {
	assert_audit_metadata_fields,
	list_audit_events
} from '#lib/testing/cross_backend/audit_cross_helpers.ts';
import type { RpcPathCrossSuiteOptions } from '#lib/testing/cross_backend/setup.ts';
import { SPINE_RPC_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';

/** A well-formed UUID that names no invite. */
const MISSING_INVITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Options for `describe_invite_audit_tests`. */
export type InviteAuditTestOptions = RpcPathCrossSuiteOptions;

export const describe_invite_audit_tests = (options: InviteAuditTestOptions): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	describe('invite audit rows', () => {
		test('invite_create and invite_delete each write a success row carrying the acting actor', async () => {
			const fixture = await setup_test();
			const call = (method: string, params: unknown) =>
				rpc_call({
					app: fixture.fresh_transport(),
					path: rpc_path,
					method,
					params,
					headers: fixture.create_session_headers()
				});
			const created = await call('invite_create', { username: 'invitee_audited' });
			assert.ok(created.ok, `invite_create failed: ${JSON.stringify(created)}`);
			const invite_id = (created.result as { invite: { id: string } }).invite.id;
			const deleted = await call('invite_delete', { invite_id });
			assert.ok(deleted.ok, `invite_delete failed: ${JSON.stringify(deleted)}`);

			for (const [event_type, metadata] of [
				['invite_create', { invite_id, email: null, username: 'invitee_audited' }],
				['invite_delete', { invite_id }]
			] as const) {
				const rows = (await list_audit_events(fixture, { event_type }, rpc_path)).filter(
					(e) => (e.metadata as { invite_id?: unknown } | null)?.invite_id === invite_id
				);
				assert.strictEqual(rows.length, 1, `one ${event_type} row`);
				const row = rows[0]!;
				assert.strictEqual(row.outcome, 'success', event_type);
				assert.strictEqual(row.actor_id, fixture.actor.id, `${event_type} actor_id`);
				assert.strictEqual(row.account_id, fixture.account.id, `${event_type} account_id`);
				assert.strictEqual(row.target_account_id, null, `${event_type} target_account_id`);
				assert.strictEqual(row.target_actor_id, null, `${event_type} target_actor_id`);
				assert_audit_metadata_fields(fixture, row.metadata, metadata);
			}
		});

		test('invite_delete of a missing invite → 404 invite_not_found and one failure row', async () => {
			const fixture = await setup_test();
			const res = await rpc_call({
				app: fixture.fresh_transport(),
				path: rpc_path,
				method: 'invite_delete',
				params: { invite_id: MISSING_INVITE_ID },
				headers: fixture.create_session_headers()
			});
			assert.ok(!res.ok, 'invite_delete of a missing invite must be refused');
			assert.strictEqual(res.status, 404);
			assert.deepStrictEqual(res.error.data, { reason: ERROR_INVITE_NOT_FOUND });

			const rows = await list_audit_events(
				fixture,
				{ event_type: 'invite_delete', outcome: 'failure' },
				rpc_path
			);
			assert.strictEqual(rows.length, 1, `one invite_delete failure row: ${JSON.stringify(rows)}`);
			const row = rows[0]!;
			assert.strictEqual(row.outcome, 'failure');
			assert.strictEqual(row.actor_id, fixture.actor.id);
			assert.strictEqual(row.account_id, fixture.account.id);
			assert.strictEqual(row.target_account_id, null);
			assert.strictEqual(row.target_actor_id, null);
			assert_audit_metadata_fields(
				fixture,
				row.metadata,
				{ reason: ERROR_INVITE_NOT_FOUND, attempted_invite_id: MISSING_INVITE_ID },
				['invite_id']
			);
		});
	});
};
