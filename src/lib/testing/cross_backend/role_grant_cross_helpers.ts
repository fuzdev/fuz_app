import '../assert_dev_env.ts';

/**
 * Role-grant fixtures for the cross-process suites — a pending offer, and an
 * active grant materialized through the real offer + accept handlers — shared
 * by the suites that need a grant to revoke
 * (`describe_role_grant_offer_notification_ws_tests`,
 * `describe_ws_role_gated_cross_tests`).
 *
 * Both drive the standard role-grant-offer RPC actions over the fixture's
 * HTTP transport, as the keeper unless a grantor is given.
 *
 * @module
 */

import { assert } from 'vitest';

import { rpc_call } from '../rpc_helpers.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import type { TestAccountFixture, TestFixture } from './setup.ts';

/** Options for the role-grant fixtures. */
export interface RoleGrantFixtureOptions {
	/** The role to offer. Default `ROLE_ADMIN`, the one builtin admin-grantable role. */
	readonly role?: string;
	/** The JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/**
 * Create a fresh pending offer of `role` from `grantor_headers` (defaults to
 * the keeper) to `to_account_id`, returning the created offer.
 *
 * @param fixture - the per-test fixture
 * @param to_account_id - the recipient account
 * @param grantor_headers - the grantor's session headers; the keeper's when omitted
 * @param options - the role and the RPC path
 * @returns the created offer
 */
export const create_pending_role_grant_offer = async (
	fixture: TestFixture,
	to_account_id: string,
	grantor_headers: Record<string, string> = fixture.create_session_headers(),
	options: RoleGrantFixtureOptions = {}
): Promise<{ id: string }> => {
	const { role = ROLE_ADMIN, rpc_path = SPINE_RPC_PATH } = options;
	const res = await rpc_call({
		app: fixture.transport,
		path: rpc_path,
		method: 'role_grant_offer_create',
		params: { to_account_id, role },
		headers: grantor_headers
	});
	if (!res.ok) assert.fail(`offer create failed: ${JSON.stringify(res)}`);
	return (res.result as { offer: { id: string } }).offer;
};

/**
 * Materialize an active global grant of `role` on `recipient` through a fresh
 * keeper offer and the recipient's accept, returning its `role_grant_id` — the
 * handle `role_grant_revoke` keys on. Idempotent on a grant the account
 * already holds: the accept returns that grant's id.
 *
 * @param fixture - the per-test fixture
 * @param recipient - the account that accepts the offer
 * @param options - the role and the RPC path
 * @returns the active grant's id
 */
export const create_active_role_grant = async (
	fixture: TestFixture,
	recipient: TestAccountFixture,
	options: RoleGrantFixtureOptions = {}
): Promise<string> => {
	const offer = await create_pending_role_grant_offer(
		fixture,
		recipient.account.id,
		fixture.create_session_headers(),
		options
	);
	const accepted = await rpc_call({
		app: fixture.transport,
		path: options.rpc_path ?? SPINE_RPC_PATH,
		method: 'role_grant_offer_accept',
		params: { offer_id: offer.id },
		headers: recipient.create_session_headers()
	});
	if (!accepted.ok) assert.fail(`accept failed: ${JSON.stringify(accepted)}`);
	return (accepted.result as { role_grant_id: string }).role_grant_id;
};
