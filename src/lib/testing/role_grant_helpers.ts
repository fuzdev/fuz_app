import './assert_dev_env.ts';

/**
 * RPC-flow helpers for role_grant lifecycle in tests.
 *
 * Sibling to `testing/db_entities.ts`'s `create_test_role_grant_direct` — that one
 * seeds a role_grant directly via `query_create_role_grant` (bypassing the
 * consent flow) for tests that focus on revoke or isolation semantics. This
 * file ships the RPC-driven complement: `role_grant_offer_and_accept`
 * exercises the same `role_grant_offer_create` + `role_grant_offer_accept`
 * specs the admin UI consumes, so consumer tests pick up post-commit
 * fan-out (audit, SSE broadcasts, `_supersede` notifications) end-to-end.
 *
 * @module
 */

import {assert} from 'vitest';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';

import {
	role_grant_offer_accept_action_spec,
	role_grant_offer_create_action_spec,
} from '../auth/role_grant_offer_action_specs.ts';
import type {TestAccount, TestApp} from './app_server.ts';
import type {TestFixture} from './cross_backend/setup.ts';
import {rpc_call_for_spec, type RpcCallArgs} from './rpc_helpers.ts';

export interface RoleGrantOfferAndAcceptArgs {
	app: RpcCallArgs['app'];
	rpc_path: string;
	/**
	 * Account doing the granting. `TestApp` / `TestAccount` cover the
	 * in-process shape; `TestFixture` covers the cross-backend fixture
	 * protocol. All three carry `account.id` + `create_session_headers`.
	 */
	grantor: TestApp | TestAccount | TestFixture;
	recipient: TestAccount;
	role: string;
}

/**
 * Drive the full consent flow (grantor offer → recipient accept) over the
 * production RPC surface and return the materialized role_grant id.
 *
 * `grantor` and `recipient` carry both the account id (for `to_account_id`
 * derivation) and the `create_session_headers` factory (for cookie-threaded
 * auth) — closing that loop on a single object per party rules out
 * caller-side header/account mismatch.
 */
export const role_grant_offer_and_accept = async (
	args: RoleGrantOfferAndAcceptArgs,
): Promise<{offer_id: Uuid; role_grant_id: Uuid}> => {
	const create_res = await rpc_call_for_spec({
		app: args.app,
		path: args.rpc_path,
		spec: role_grant_offer_create_action_spec,
		params: {to_account_id: args.recipient.account.id, role: args.role},
		headers: args.grantor.create_session_headers(),
	});
	assert.ok(
		create_res.ok,
		`role_grant_offer_create failed: ${create_res.ok ? '' : JSON.stringify(create_res.error)}`,
	);
	const {offer} = create_res.result;
	const accept_res = await rpc_call_for_spec({
		app: args.app,
		path: args.rpc_path,
		spec: role_grant_offer_accept_action_spec,
		params: {offer_id: offer.id},
		headers: args.recipient.create_session_headers(),
	});
	assert.ok(
		accept_res.ok,
		`role_grant_offer_accept failed: ${accept_res.ok ? '' : JSON.stringify(accept_res.error)}`,
	);
	return {offer_id: offer.id, role_grant_id: accept_res.result.role_grant_id};
};
