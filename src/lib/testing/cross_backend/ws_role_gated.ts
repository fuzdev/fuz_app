import '../assert_dev_env.ts';

/**
 * Cross-process **role-gated WebSocket** suite — a socket admitted by an
 * endpoint's role gate (`register_action_ws`'s `required_roles`) loses it
 * with the role.
 *
 * A role gate decides who may hold a socket, and so who receives the
 * endpoint's server pushes, which reach every admitted connection with no
 * per-recipient filter. So both spines record the gating roles on each
 * registration and close the account's gated sockets when a global grant of a
 * listed role is revoked — with `WS_CLOSE_PERMISSION_REVOKED`, not the
 * session-revoked code, since the credential is still good — and send nothing
 * after the close. The ungated sockets of the same account, on the same
 * registry, stay open: the gate is per endpoint, not per account. A scoped
 * grant never admits at a role gate, so revoking one closes nothing.
 *
 * Runs against a backend that mounts, beside its ungated `ws_path`, a second
 * endpoint at `gated_ws_path` gated on `gated_roles` — which must include
 * `ROLE_ADMIN` (the revoked global grant) and a role that can be granted both
 * globally and scoped (the scoped revoke). fuz_app's spine binaries mount
 * `SPINE_ROLE_GATED_WS_PATH` gated on `SPINE_ROLE_GATED_WS_ROLES`. Gated on
 * `capabilities.ws` and `capabilities.ws_role_gated`; cross-process only.
 *
 * @module
 */

import { assert, describe } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { heartbeat_action_spec } from '../../actions/heartbeat.ts';
import {
	WS_CLOSE_PERMISSION_REVOKED,
	WS_CLOSE_PERMISSION_REVOKED_REASON
} from '../../actions/transports.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';
import { ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD } from '../../auth/role_grant_offer_notifications.ts';
import { rpc_call } from '../rpc_helpers.ts';
import { is_notification_with, type WsClient } from '../transports/ws_client.ts';
import { type BackendCapabilities, test_if } from './capabilities.ts';
import {
	create_active_role_grant,
	create_pending_role_grant_offer
} from './role_grant_cross_helpers.ts';
import type { TestAccount } from '../app_server.ts';
import type { SetupTest, TestFixture } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';
import { open_session_ws, type WsEndpointTarget } from './ws_endpoint.ts';

/** How long a socket that must stay open is watched for a close it must not get. */
const STAYS_OPEN_MS = 1500;

/** Configuration for `describe_ws_role_gated_cross_tests`. */
export interface WsRoleGatedCrossTestOptions extends WsEndpointTarget {
	/** The ungated WebSocket endpoint path (e.g. `/api/ws`). */
	readonly ws_path: string;
	/** Per-test fixture producer (`default_cross_process_setup(handle)`). */
	readonly setup_test: SetupTest;
	/** Backend capability flags; every case gates on `ws` and `ws_role_gated`. */
	readonly capabilities: BackendCapabilities;
	/** The role-gated WebSocket endpoint path. */
	readonly gated_ws_path: string;
	/**
	 * The roles `gated_ws_path` requires: `ROLE_ADMIN` and `scoped_role`
	 * among them.
	 */
	readonly gated_roles: ReadonlyArray<string>;
	/** A role in `gated_roles` an admin can grant both globally and scoped. */
	readonly scoped_role: string;
	/** JSON-RPC endpoint path. Default `SPINE_RPC_PATH`. */
	readonly rpc_path?: string;
}

/**
 * Register the role-gated WebSocket suite: a revoked global grant of a gating
 * role closes the account's gated socket with `WS_CLOSE_PERMISSION_REVOKED`,
 * its ungated socket stays open and still receives the account's pushes, and
 * a re-upgrade is refused at the gate; a scoped revoke of a gating role
 * closes nothing.
 *
 * That the closed registration is sent nothing more is beyond what a client
 * can observe once it has read the close frame, so the suite does not claim
 * it: each spine's own transport tests pin it.
 */
export const describe_ws_role_gated_cross_tests = (options: WsRoleGatedCrossTestOptions): void => {
	const {
		setup_test,
		capabilities,
		gated_ws_path,
		gated_roles,
		scoped_role,
		rpc_path = SPINE_RPC_PATH
	} = options;
	const enabled = capabilities.ws && capabilities.ws_role_gated;
	if (enabled && (!gated_roles.includes(ROLE_ADMIN) || !gated_roles.includes(scoped_role))) {
		throw new Error(
			`describe_ws_role_gated_cross_tests: gated_roles must include ${ROLE_ADMIN} and ${scoped_role}`
		);
	}

	const rpc = (
		fixture: TestFixture,
		method: string,
		params: unknown,
		headers: Record<string, string> = fixture.create_session_headers()
	) => rpc_call({ app: fixture.transport, path: rpc_path, method, params, headers });

	/** The role-gated endpoint, on the ungated one's backend and origin. */
	const gated_target: WsEndpointTarget = {
		base_url: options.base_url,
		ws_path: gated_ws_path,
		...(options.origin !== undefined && { origin: options.origin })
	};

	const open = (target: WsEndpointTarget, account: TestAccount): Promise<WsClient> =>
		open_session_ws(target, account, { admitted: true });

	describe('role-gated websocket (cross-process)', () => {
		test_if(
			enabled,
			'revoking a global grant of a gating role closes the gated socket with WS_CLOSE_PERMISSION_REVOKED',
			async () => {
				const fixture = await setup_test();
				const target = await fixture.create_account({ roles: [ROLE_ADMIN] });
				const role_grant_id = await create_active_role_grant(fixture, target, { rpc_path });

				const gated = await open(gated_target, target);
				const ungated = await open(options, target);
				try {
					const revoked = await rpc(fixture, 'role_grant_revoke', {
						actor_id: target.actor.id,
						role_grant_id
					});
					assert.isTrue(revoked.ok, `revoke failed: ${JSON.stringify(revoked)}`);

					assert.ok(await gated.wait_for_close(5000), 'the gated socket did not close');
					assert.strictEqual(gated.close_code, WS_CLOSE_PERMISSION_REVOKED);
					assert.strictEqual(gated.close_reason, WS_CLOSE_PERMISSION_REVOKED_REASON);

					// a push to the account still reaches its ungated socket, and the
					// closed client records nothing more
					const received_before = gated.messages.length;
					await create_pending_role_grant_offer(
						fixture,
						target.account.id,
						fixture.create_session_headers(),
						{ rpc_path }
					);
					await ungated.wait_for(
						is_notification_with<{ offer: { to_account_id: string } }>(
							ROLE_GRANT_OFFER_RECEIVED_NOTIFICATION_METHOD,
							(p) => p.offer.to_account_id === target.account.id
						),
						5000
					);
					assert.strictEqual(gated.messages.length, received_before);

					// the account's ungated socket on the same backend stays open
					assert.strictEqual(ungated.close_code, null);
					assert.deepStrictEqual(await ungated.request(2, heartbeat_action_spec.method, {}), {});

					// and the gate refuses the account a new gated socket
					await assert_rejects(
						() => open_session_ws(gated_target, target, { admitted: false }),
						/403/
					);
				} finally {
					await gated.close();
					await ungated.close();
				}
			}
		);

		test_if(enabled, 'a scoped revoke of a gating role closes nothing', async () => {
			const fixture = await setup_test();
			// a global grant of `scoped_role` admits the socket — which proves the
			// endpoint lists it, so the scoped revoke below is one of a gating role
			const target = await fixture.create_account();
			const assign = async (scope: Record<string, string>): Promise<string> => {
				const assigned = await rpc(fixture, 'role_grant_assign', {
					to_account_id: target.account.id,
					role: scoped_role,
					...scope
				});
				if (!assigned.ok) assert.fail(`assign failed: ${JSON.stringify(assigned)}`);
				return (assigned.result as { role_grant_id: string }).role_grant_id;
			};
			await assign({});
			const role_grant_id = await assign({
				scope_kind: 'space',
				scope_id: '33333333-3333-4333-8333-333333333333'
			});

			const gated = await open(gated_target, target);
			try {
				const revoked = await rpc(fixture, 'role_grant_revoke', {
					actor_id: target.actor.id,
					role_grant_id
				});
				assert.isTrue(revoked.ok, `revoke failed: ${JSON.stringify(revoked)}`);

				assert.isFalse(
					await gated.wait_for_close(STAYS_OPEN_MS),
					`closed with ${gated.close_code} on a scoped revoke`
				);
				assert.deepStrictEqual(await gated.request(2, heartbeat_action_spec.method, {}), {});
			} finally {
				await gated.close();
			}
		});
	});
};
