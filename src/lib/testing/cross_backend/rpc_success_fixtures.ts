import '../assert_dev_env.ts';

/**
 * Success fixtures for the standard spine RPC methods that act on an existing
 * row — revoke a token or a session, delete an invite, revoke a role grant,
 * accept, decline, or retract an offer. The generic round-trip sends nil ids,
 * so on its own it only ever sees these methods refuse with `not_found`; each
 * fixture here builds the real row through the backend's own RPC surface and
 * returns the params (and, where the row must belong to the caller, the
 * caller's headers) that drive a **success** response, which
 * `describe_rpc_round_trip_tests` then validates against the method's output
 * schema on every backend.
 *
 * Spine-generic: the fixtures use only standard RPC actions and the builtin
 * `ROLE_ADMIN`, so any consumer mounting `create_standard_rpc_actions` can
 * pass the map to `describe_standard_cross_process_tests` (as
 * `rpc_success_fixtures`), `describe_standard_tests`, or
 * `describe_rpc_round_trip_tests` (as `success_fixtures`). Each fixture mints
 * its own accounts and calls as one of them, so none touches or calls as the
 * suite's shared identities.
 *
 * @module
 */

import { assert } from 'vitest';

import {
	account_session_list_action_spec,
	account_token_create_action_spec
} from '../../auth/account_action_specs.ts';
import { invite_create_action_spec } from '../../auth/admin_action_specs.ts';
import {
	role_grant_assign_action_spec,
	role_grant_offer_create_action_spec
} from '../../auth/role_grant_offer_action_specs.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { rpc_call_typed } from '../rpc_helpers.ts';
import type { RpcSuccessFixture, RpcSuccessFixtures } from '../rpc_round_trip.ts';
import type { RequestResponseActionSpec } from '../../actions/action_spec.ts';
import type { z } from 'zod';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import type { TestAccount } from '../app_server.ts';
import type { TestFixture } from './setup.ts';

/** Options for `create_spine_rpc_success_fixtures`. */
export interface SpineRpcSuccessFixturesOptions {
	/** The JSON-RPC endpoint path the standard actions are mounted on. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/**
 * Build the success-fixture map for the standard spine methods that need a
 * real row id: `account_token_revoke`, `account_session_revoke`,
 * `invite_delete`, `role_grant_revoke`, `role_grant_offer_accept`,
 * `role_grant_offer_decline`, and `role_grant_offer_retract`.
 *
 * Each factory mints fresh accounts — a fresh `ROLE_ADMIN` holder as grantor
 * where the setup step is admin-gated — and builds its row as a real client
 * would, then returns the headers of the account that calls: the owner for
 * token and session revoke, accept, decline, and retract; the fresh admin
 * for invite delete and role grant revoke.
 *
 * @param options - the RPC endpoint path
 * @returns the method → fixture-factory map
 */
export const create_spine_rpc_success_fixtures = (
	options: SpineRpcSuccessFixturesOptions = {}
): RpcSuccessFixtures => {
	const { rpc_path = SPINE_RPC_PATH } = options;

	const call = <TSpec extends RequestResponseActionSpec>(
		fixture: TestFixture,
		spec: TSpec,
		params: z.input<TSpec['input']>,
		headers: Record<string, string>
	): Promise<z.infer<TSpec['output']>> =>
		rpc_call_typed(
			{ app: fixture.transport, path: rpc_path, method: spec.method, params, headers },
			spec.output as z.ZodType<z.infer<TSpec['output']>>
		);

	const create_grantor = (fixture: TestFixture): Promise<TestAccount> =>
		fixture.create_account({ roles: [ROLE_ADMIN] });

	const create_pending_offer = async (
		fixture: TestFixture
	): Promise<{ grantor: TestAccount; recipient: TestAccount; offer_id: string }> => {
		const grantor = await create_grantor(fixture);
		const recipient = await fixture.create_account();
		const { offer } = await call(
			fixture,
			role_grant_offer_create_action_spec,
			{ to_account_id: recipient.account.id, role: ROLE_ADMIN },
			grantor.create_session_headers()
		);
		return { grantor, recipient, offer_id: offer.id };
	};

	const fixtures: RpcSuccessFixtures = new Map<string, RpcSuccessFixture>([
		[
			'account_token_revoke',
			async (fixture) => {
				const owner = await fixture.create_account();
				const headers = owner.create_session_headers();
				const token = await call(
					fixture,
					account_token_create_action_spec,
					{
						name: 'rpc success fixture',
						scope: { kind: 'full' },
						lifetime: { kind: 'eternal' }
					},
					headers
				);
				return { params: { token_id: token.id }, headers };
			}
		],
		[
			'account_session_revoke',
			async (fixture) => {
				// a throwaway account revokes its own session, the one it calls with
				const owner = await fixture.create_account();
				const headers = owner.create_session_headers();
				const { sessions } = await call(
					fixture,
					account_session_list_action_spec,
					undefined,
					headers
				);
				const session = sessions[0];
				assert.ok(session, 'account_session_revoke fixture: the fresh account lists no session');
				return { params: { session_id: session.id }, headers };
			}
		],
		[
			'invite_delete',
			async (fixture) => {
				const grantor = await create_grantor(fixture);
				const { invite } = await call(
					fixture,
					invite_create_action_spec,
					{ username: `inv${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}` },
					grantor.create_session_headers()
				);
				return { params: { invite_id: invite.id }, headers: grantor.create_session_headers() };
			}
		],
		[
			'role_grant_revoke',
			async (fixture) => {
				const grantor = await create_grantor(fixture);
				const grantee = await fixture.create_account();
				const { role_grant_id } = await call(
					fixture,
					role_grant_assign_action_spec,
					{ to_account_id: grantee.account.id, role: ROLE_ADMIN },
					grantor.create_session_headers()
				);
				return {
					params: { actor_id: grantee.actor.id, role_grant_id },
					headers: grantor.create_session_headers()
				};
			}
		],
		[
			'role_grant_offer_accept',
			async (fixture) => {
				const { recipient, offer_id } = await create_pending_offer(fixture);
				return { params: { offer_id }, headers: recipient.create_session_headers() };
			}
		],
		[
			'role_grant_offer_decline',
			async (fixture) => {
				const { recipient, offer_id } = await create_pending_offer(fixture);
				return { params: { offer_id }, headers: recipient.create_session_headers() };
			}
		],
		[
			'role_grant_offer_retract',
			async (fixture) => {
				const { grantor, offer_id } = await create_pending_offer(fixture);
				return { params: { offer_id }, headers: grantor.create_session_headers() };
			}
		]
	]);
	return fixtures;
};
