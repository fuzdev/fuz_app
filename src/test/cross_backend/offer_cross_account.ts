/**
 * The offer reads' cross-account refusal says nothing about the account named.
 *
 * `role_grant_offer_list` and `role_grant_offer_history` take an admin-only
 * `account_id`. A non-admin naming another account is refused 403, and the
 * refusal must be the same whether that account exists or not, or the reads
 * become an account-existence oracle. The existing account here is the
 * keeper's, whose id only the fixture knows, so this is an imperative test
 * rather than a conformance row. Called from `conformance.db.test.ts` and
 * `conformance.cross.test.ts` beside the conformance table, over the same
 * setup.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { rpc_call } from '#lib/testing/rpc_helpers.ts';
import type { RpcPathCrossSuiteOptions } from '#lib/testing/cross_backend/setup.ts';
import { SPINE_RPC_PATH } from '#lib/testing/cross_backend/spine_surface_constants.ts';

/** A well-formed UUID that names no account. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The two offer reads whose `account_id` is admin-only. */
const OFFER_READ_METHODS = ['role_grant_offer_list', 'role_grant_offer_history'] as const;

/** Options for `describe_offer_cross_account_tests`. */
export type OfferCrossAccountTestOptions = RpcPathCrossSuiteOptions;

export const describe_offer_cross_account_tests = (options: OfferCrossAccountTestOptions): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	describe('offer reads across accounts', () => {
		for (const method of OFFER_READ_METHODS) {
			test(`fresh non-admin → ${method} {account_id: <the keeper>} → 403, identical to NIL`, async () => {
				const fixture = await setup_test();
				const non_admin = await fixture.create_account();
				const call = async (account_id: string) => {
					const res = await rpc_call({
						app: fixture.fresh_transport(),
						path: rpc_path,
						method,
						params: { account_id },
						headers: non_admin.create_session_headers()
					});
					assert.ok(!res.ok, `${method} {account_id: ${account_id}} must be refused`);
					return { status: res.status, body: res.error };
				};
				const existing = await call(fixture.account.id);
				const absent = await call(NIL_UUID);
				assert.strictEqual(existing.status, 403);
				assert.deepStrictEqual(
					existing,
					absent,
					`${method}: the refusal for an existing account differs from the one for an absent ` +
						`account, so it discloses whether the account exists`
				);
			});
		}
	});
};
