/**
 * The duplicate-invite refusal, on both transports.
 *
 * A two-request case, so it can't be a conformance row: an admin creates an
 * invite, then the same invite again, and the second is refused with 409
 * `invite_duplicate` — an unclaimed invite for a username already exists.
 * Called from `conformance.db.test.ts` and `conformance.cross.test.ts` beside
 * the conformance table, over the same setup.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { ERROR_INVITE_DUPLICATE } from '#lib/http/error_schemas.ts';
import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import type { RpcPathCrossSuiteOptions } from '#lib/testing/cross_backend/setup.ts';
import { SPINE_RPC_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';

/** Options for `describe_invite_duplicate_tests`. */
export type InviteDuplicateTestOptions = RpcPathCrossSuiteOptions;

export const describe_invite_duplicate_tests = (options: InviteDuplicateTestOptions): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	describe('invite_create duplicate', () => {
		test('admin → the same invite twice → 409 invite_duplicate', async () => {
			const fixture = await setup_test();
			const call = () =>
				rpc_call({
					app: fixture.transport,
					path: rpc_path,
					method: 'invite_create',
					params: { username: 'invitee_twice' },
					headers: fixture.create_session_headers()
				});
			const first = await call();
			assert.ok(first.ok, `first invite_create failed: ${JSON.stringify(first)}`);
			const second = await call();
			assert.ok(!second.ok, 'second invite_create must be refused');
			assert.strictEqual(second.status, 409);
			const reason = (second.error.data as { reason?: unknown } | undefined)?.reason;
			assert.strictEqual(reason, ERROR_INVITE_DUPLICATE);
		});
	});
};
