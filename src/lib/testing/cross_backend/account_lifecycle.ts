import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for the account-lifecycle admin verbs:
 * `account_delete` (soft), `account_undelete` (reactivation), and
 * `account_purge` (keeper hard-delete), plus the keeper guard and the
 * session-only self-delete (an API token can't end its own account; an admin
 * token still deletes another).
 *
 * Like the cell suites, these verbs can't ride the generic
 * `describe_rpc_round_trip_tests`: they're stateful and destructive (a
 * generic round-trip would tombstone the bootstrapped keeper). They are on
 * the declared surface, so shape and auth are auto-enumerated; this suite is
 * the behavioral parity the generic round-trip can't drive. Every success
 * `result` is parsed against the verb's declared **output** schema, so
 * a TS↔Rust envelope drift fails the assertion.
 *
 * Also pinned: a soft-deleted account's session and bearer stop
 * authenticating; a bearer self-delete is 403 `credential_type_required` with
 * the session left live; the delete, undelete and purge success rows snapshot
 * the victim's `username`; the keeper guard and a second undelete each write
 * an `outcome: 'failure'` row; `admin_account_list` with `include_deleted`
 * lists tombstoned rows with `deleted_at` set.
 *
 * Two credential end states, each proven live before it is killed: a session
 * and an API token minted before a soft delete stay dead after the undelete
 * (the delete removed their rows, and the undelete clears only the
 * tombstones), each answering as an anonymous request does, while a fresh
 * login authenticates; and a password change made over one session ends the
 * account's other session and its API token as well as its own, leaves
 * another account's session live, and only the new password logs in. The
 * password case needs no lifecycle verb, so it runs on every backend.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	AccountDeleteOutput,
	AccountUndeleteOutput,
	AccountPurgeOutput,
	AdminAccountListOutput,
	ERROR_CANNOT_DELETE_KEEPER
} from '../../auth/admin_action_specs.ts';
import {
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_CREDENTIAL_TYPE_REQUIRED
} from '../../http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { assert_audit_metadata_fields, list_audit_events } from './audit_cross_helpers.ts';
import { test_if } from './capabilities.ts';
import { cross_rpc_call, error_reason, expect_output } from './cross_rpc.ts';
import { assert_iso8601_seconds } from './wire_shapes.ts';
import { create_test_request_headers } from '../test_origin.ts';
import type { TestAccount } from '../app_server.ts';
import type { RpcPathCapabilityGatedCrossSuiteOptions, TestFixture } from './setup.ts';
import {
	SPINE_ACCOUNT_LOGIN_PATH,
	SPINE_ACCOUNT_PASSWORD_PATH,
	SPINE_RPC_PATH
} from './spine_surface_constants.ts';

/**
 * Options for the account-lifecycle parity suite: the standard
 * capability-gating RPC-dispatched cross-suite shape (`setup_test` /
 * `capabilities` / `rpc_path`) plus the two REST account routes the
 * credential cases call.
 */
export interface AccountLifecycleCrossTestOptions extends RpcPathCapabilityGatedCrossSuiteOptions {
	/** REST login route path. Default `/api/account/login`. */
	readonly login_path?: string;
	/** REST password-change route path. Default `/api/account/password`. */
	readonly password_path?: string;
}

/** The password the credential cases create their accounts with. */
const LIFECYCLE_PASSWORD = 'lifecycle-password-before';

/** The password the password-change case changes to. */
const LIFECYCLE_PASSWORD_CHANGED = 'lifecycle-password-after';

export const describe_account_lifecycle_cross_tests = (
	options: AccountLifecycleCrossTestOptions
): void => {
	const { setup_test, capabilities } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;
	const login_path = options.login_path ?? SPINE_ACCOUNT_LOGIN_PATH;
	const password_path = options.password_path ?? SPINE_ACCOUNT_PASSWORD_PATH;

	/**
	 * `account_verify` carrying `headers` and no other credential — a
	 * cookie-free transport, no `Origin` added (a bearer beside one is
	 * discarded as browser context).
	 */
	const verify = (fixture: TestFixture, headers: Record<string, string>) =>
		cross_rpc_call(
			fixture.fresh_transport({ origin: null }),
			rpc_path,
			'account_verify',
			undefined,
			headers
		);

	/** Who `headers` authenticate as: the account id `account_verify` answers, or `null`. */
	const verified_account_id = async (
		fixture: TestFixture,
		headers: Record<string, string>
	): Promise<string | null> => {
		const res = await verify(fixture, headers);
		return res.ok ? (res.result as { id: string }).id : null;
	};

	/** A request carrying no credential, with `account`'s non-credential headers. */
	const anonymous_headers = (account: TestAccount): Record<string, string> => {
		const { authorization: _, ...rest } = account.create_bearer_headers();
		return rest;
	};

	/**
	 * Assert `headers` answer exactly as an anonymous request does — a dead
	 * credential must not be told apart from no credential.
	 */
	const assert_answers_as_anonymous = async (
		fixture: TestFixture,
		account: TestAccount,
		headers: Record<string, string>,
		label: string
	): Promise<void> => {
		const dead = await verify(fixture, headers);
		const anonymous = await verify(fixture, anonymous_headers(account));
		assert.strictEqual(anonymous.status, 401, 'the anonymous control is refused');
		assert.strictEqual(dead.status, anonymous.status, label);
		assert.strictEqual(error_reason(dead), ERROR_AUTHENTICATION_REQUIRED, label);
		assert.deepStrictEqual(dead.error, anonymous.error, label);
	};

	/** Log in on a fresh transport; the session cookie the login sets, as a `Cookie` value. */
	const login = async (
		fixture: TestFixture,
		username: string,
		password: string
	): Promise<{ status: number; cookie: string | null }> => {
		const res = await fixture.fresh_transport()(login_path, {
			method: 'POST',
			headers: create_test_request_headers({ 'content-type': 'application/json' }),
			body: JSON.stringify({ username, password })
		});
		await res.body?.cancel();
		const lines = res.headers.getSetCookie();
		if (res.status !== 200) return { status: res.status, cookie: null };
		assert.strictEqual(lines.length, 1, 'a login sets exactly the session cookie');
		return { status: res.status, cookie: lines[0]!.split(';')[0]! };
	};

	describe('account lifecycle parity', () => {
		test_if(
			capabilities.account_lifecycle,
			'soft-delete → undelete round-trip (admin)',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({ username: 'lifecycle_victim' });
				const t = fixture.fresh_transport();
				// Keeper account holds ROLE_ADMIN — its session is admin-capable.
				const admin_headers = fixture.create_session_headers();

				const deleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_delete',
						{ account_id: victim.account.id },
						admin_headers
					),
					AccountDeleteOutput
				);
				assert.strictEqual(deleted.deleted, true);

				const undeleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_undelete',
						{ account_id: victim.account.id },
						admin_headers
					),
					AccountUndeleteOutput
				);
				assert.strictEqual(undeleted.undeleted, true);

				// each verb audits the victim's identity snapshot, attributed to
				// the admin (`list_audit_events` parses the metadata)
				for (const event_type of ['account_delete', 'account_undelete'] as const) {
					const events = await list_audit_events(fixture, { event_type }, rpc_path);
					const row = events.find(
						(e) => e.outcome === 'success' && e.target_account_id === victim.account.id
					);
					assert.ok(row, `${event_type} writes a success row targeting the victim`);
					assert.strictEqual(row.account_id, fixture.account.id, event_type);
					assert.strictEqual(
						(row.metadata as { username?: unknown } | null)?.username,
						victim.account.username,
						`${event_type} snapshots the username`
					);
				}
			}
		);

		test_if(capabilities.account_lifecycle, 'purge (keeper, confirmed)', async () => {
			const fixture = await setup_test();
			const victim = await fixture.create_account({ username: 'lifecycle_purge' });
			const t = fixture.fresh_transport({ origin: null });
			// Purge is keeper-gated: daemon-token credential, not a session.
			const purged = expect_output(
				await cross_rpc_call(
					t,
					rpc_path,
					'account_purge',
					{ account_id: victim.account.id, confirm: true },
					fixture.create_daemon_token_headers()
				),
				AccountPurgeOutput
			);
			assert.strictEqual(purged.purged, true);

			// the purge row outlives the account it names, carrying its identity
			const events = await list_audit_events(fixture, { event_type: 'account_purge' }, rpc_path);
			const row = events.find(
				(e) => e.outcome === 'success' && e.target_account_id === victim.account.id
			);
			assert.ok(row, 'account_purge writes a success row targeting the victim');
			assert.strictEqual(
				(row.metadata as { username?: unknown } | null)?.username,
				victim.account.username,
				'account_purge snapshots the username'
			);
		});

		test_if(
			capabilities.account_lifecycle,
			'keeper guard: delete + purge refuse the keeper account',
			async () => {
				const fixture = await setup_test();
				const t = fixture.fresh_transport();

				const del = await cross_rpc_call(
					t,
					rpc_path,
					'account_delete',
					{ account_id: fixture.account.id },
					fixture.create_session_headers()
				);
				assert.strictEqual(del.ok, false, 'delete of keeper account must be refused');
				assert.strictEqual(error_reason(del), ERROR_CANNOT_DELETE_KEEPER);

				const tp = fixture.fresh_transport({ origin: null });
				const purge = await cross_rpc_call(
					tp,
					rpc_path,
					'account_purge',
					{ account_id: fixture.account.id, confirm: true },
					fixture.create_daemon_token_headers()
				);
				assert.strictEqual(purge.ok, false, 'purge of keeper account must be refused');
				assert.strictEqual(error_reason(purge), ERROR_CANNOT_DELETE_KEEPER);
			}
		);

		test_if(
			capabilities.account_lifecycle,
			'self-delete is session-only; an admin bearer still deletes another account',
			async () => {
				const fixture = await setup_test();
				const member = await fixture.create_account({ username: 'lifecycle_self_bearer' });

				// The member's own bearer may not end its account (handler-enforced,
				// the dispatcher's credential-type refusal).
				const refused = await cross_rpc_call(
					fixture.fresh_transport({ origin: null }),
					rpc_path,
					'account_delete',
					{},
					member.create_bearer_headers()
				);
				assert.strictEqual(refused.ok, false, 'a bearer self-delete must be refused');
				assert.strictEqual(refused.error?.code, JSONRPC_ERROR_CODES.forbidden);
				assert.strictEqual(error_reason(refused), ERROR_CREDENTIAL_TYPE_REQUIRED);
				assert.deepStrictEqual(
					(refused.error?.data as { required_credential_types?: unknown } | undefined)
						?.required_credential_types,
					['session']
				);

				// An explicit own id is self in either case (`Uuid` admits both) — the
				// keeper's too, whose refusal is the credential one, not the keeper guard.
				for (const [label, account_id, headers] of [
					['member', member.account.id, member.create_bearer_headers()],
					['keeper', fixture.account.id, fixture.create_bearer_headers()]
				] as const) {
					const upper = await cross_rpc_call(
						fixture.fresh_transport({ origin: null }),
						rpc_path,
						'account_delete',
						{ account_id: account_id.toUpperCase() },
						headers
					);
					assert.strictEqual(upper.ok, false, `${label}: an uppercased own id is self`);
					assert.deepStrictEqual(upper.error, refused.error, label);
				}

				// Nothing was tombstoned: the member's session still verifies.
				const still = await cross_rpc_call(
					fixture.fresh_transport(),
					rpc_path,
					'account_verify',
					undefined,
					member.create_session_headers()
				);
				assert.ok(still.ok, 'the refused self-delete leaves the account live');

				// The keeper's bearer (admin-capable) deletes another account.
				const deleted = expect_output(
					await cross_rpc_call(
						fixture.fresh_transport({ origin: null }),
						rpc_path,
						'account_delete',
						{ account_id: member.account.id },
						fixture.create_bearer_headers()
					),
					AccountDeleteOutput
				);
				assert.strictEqual(deleted.deleted, true);

				// A self-delete over a session goes through.
				const self = await fixture.create_account({ username: 'lifecycle_self_session' });
				const self_deleted = expect_output(
					await cross_rpc_call(
						fixture.fresh_transport(),
						rpc_path,
						'account_delete',
						{},
						self.create_session_headers()
					),
					AccountDeleteOutput
				);
				assert.strictEqual(self_deleted.deleted, true);
			}
		);

		test_if(
			capabilities.account_lifecycle,
			'fail-closed: a soft-deleted account’s session + bearer credentials no longer authenticate',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({ username: 'lifecycle_failclosed' });
				const admin_headers = fixture.create_session_headers();

				// Sanity: the victim's session authenticates while active, so the
				// post-deletion 401 is a real fail-closed transition, not a
				// never-valid credential passing vacuously.
				const before = await cross_rpc_call(
					fixture.fresh_transport(),
					rpc_path,
					'account_verify',
					undefined,
					victim.create_session_headers()
				);
				assert.ok(before.ok, 'victim session authenticates before deletion');

				const deleted = expect_output(
					await cross_rpc_call(
						fixture.fresh_transport(),
						rpc_path,
						'account_delete',
						{ account_id: victim.account.id },
						admin_headers
					),
					AccountDeleteOutput
				);
				assert.strictEqual(deleted.deleted, true);

				// The tombstone blocks auth resolution (and the soft-delete
				// revoked sessions/tokens) — the stale session credential must
				// fail closed with a generic 401, not partially authenticate.
				const session_probe = await cross_rpc_call(
					fixture.fresh_transport(),
					rpc_path,
					'account_verify',
					undefined,
					victim.create_session_headers()
				);
				assert.strictEqual(
					session_probe.ok,
					false,
					'soft-deleted account session must not authenticate'
				);
				assert.strictEqual(error_reason(session_probe), ERROR_AUTHENTICATION_REQUIRED);

				// The victim's bearer token must fail closed too.
				const bearer_probe = await cross_rpc_call(
					fixture.fresh_transport({ origin: null }),
					rpc_path,
					'account_verify',
					undefined,
					victim.create_bearer_headers()
				);
				assert.strictEqual(
					bearer_probe.ok,
					false,
					'soft-deleted account bearer token must not authenticate'
				);
				assert.strictEqual(error_reason(bearer_probe), ERROR_AUTHENTICATION_REQUIRED);
			}
		);

		test_if(
			capabilities.account_lifecycle,
			'keeper guard emits a fail-loud failure-audit row (drained, cross-impl)',
			async () => {
				const fixture = await setup_test();
				const t = fixture.fresh_transport();

				// Refused keeper self-delete — the guard fires before any mutation
				// and emits a forensic `outcome: failure` audit row.
				const del = await cross_rpc_call(
					t,
					rpc_path,
					'account_delete',
					{ account_id: fixture.account.id },
					fixture.create_session_headers()
				);
				assert.strictEqual(error_reason(del), ERROR_CANNOT_DELETE_KEEPER);

				// Read behind the drain barrier, so the failure row is authoritative
				// on both spines. `_testing_reset` wiped audit_log at setup, so the
				// refused delete is the only account_delete event.
				const events = await list_audit_events(fixture, { event_type: 'account_delete' }, rpc_path);
				const failure = events.find(
					(e) =>
						e.outcome === 'failure' &&
						(e.metadata as { reason?: unknown } | null)?.reason === ERROR_CANNOT_DELETE_KEEPER
				);
				assert.ok(
					failure,
					'keeper-removal guard must emit an account_delete outcome=failure audit row with reason cannot_delete_keeper'
				);
				// Byte-shape gate on the audit row's timestamp — the `Timestamp` in
				// `AuditLogEventWithUsernamesJson` accepts a millisecond stamp too.
				assert_iso8601_seconds(failure.created_at, 'audit_log_list.created_at');
			}
		);

		test_if(
			capabilities.account_lifecycle,
			'deterministic: double-undelete → second call is not_found',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({ username: 'lifecycle_double' });
				const t = fixture.fresh_transport();
				const admin_headers = fixture.create_session_headers();

				const deleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_delete',
						{ account_id: victim.account.id },
						admin_headers
					),
					AccountDeleteOutput
				);
				assert.strictEqual(deleted.deleted, true);

				// First undelete clears the tombstone.
				const undeleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_undelete',
						{ account_id: victim.account.id },
						admin_headers
					),
					AccountUndeleteOutput
				);
				assert.strictEqual(undeleted.undeleted, true);

				// Second undelete on the now-active account is a deterministic
				// not_found — the query only matches soft-deleted rows, so the
				// outcome is the same on both spines (no silent idempotent ok).
				const again = await cross_rpc_call(
					t,
					rpc_path,
					'account_undelete',
					{ account_id: victim.account.id },
					admin_headers
				);
				assert.strictEqual(again.ok, false, 'double-undelete must not silently succeed');
				assert.strictEqual(error_reason(again), ERROR_ACCOUNT_NOT_FOUND);

				// the refused undelete is audited as a failure naming the probed id
				const events = await list_audit_events(
					fixture,
					{ event_type: 'account_undelete', outcome: 'failure' },
					rpc_path
				);
				assert.strictEqual(events.length, 1, 'one account_undelete failure row');
				assert_audit_metadata_fields(fixture, events[0]!.metadata, {
					reason: ERROR_ACCOUNT_NOT_FOUND,
					attempted_account_id: victim.account.id
				});
			}
		);

		// The last-admin guard (`ERROR_CANNOT_DELETE_LAST_ADMIN`) is **not**
		// cross-process-testable against this fixture: the per-test keeper
		// permanently holds `ROLE_ADMIN` (bootstrap seeds `[ROLE_KEEPER,
		// ROLE_ADMIN]` and there is no remove-admin-from-keeper path), so a
		// non-keeper admin is never the *sole* active admin and the guard
		// never fires here. Its logic is covered in-process by
		// `src/test/auth/account_keeper_guard.db.test.ts`.

		test_if(
			capabilities.account_lifecycle,
			'admin_account_list include_deleted surfaces tombstoned rows with deleted_at set',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({ username: 'lifecycle_listed' });
				const admin_headers = fixture.create_session_headers();

				const t = fixture.fresh_transport();
				const deleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'account_delete',
						{ account_id: victim.account.id },
						admin_headers
					),
					AccountDeleteOutput
				);
				assert.strictEqual(deleted.deleted, true);

				// Default listing excludes the tombstone.
				const active_only = expect_output(
					await cross_rpc_call(t, rpc_path, 'admin_account_list', {}, admin_headers),
					AdminAccountListOutput
				);
				assert.ok(
					!active_only.accounts.some((a) => a.account.id === victim.account.id),
					'default listing excludes the soft-deleted account'
				);

				// `include_deleted` surfaces it with `deleted_at` populated.
				const with_deleted = expect_output(
					await cross_rpc_call(
						t,
						rpc_path,
						'admin_account_list',
						{ include_deleted: true },
						admin_headers
					),
					AdminAccountListOutput
				);
				const row = with_deleted.accounts.find((a) => a.account.id === victim.account.id);
				assert.ok(row, 'include_deleted surfaces the tombstoned row');
				assert.ok(
					row.account.deleted_at !== null,
					'tombstoned row carries a non-null deleted_at on both spines'
				);
				assert_iso8601_seconds(row.account.created_at, 'admin_account_list.created_at');
				assert_iso8601_seconds(row.account.updated_at, 'admin_account_list.updated_at');
				assert_iso8601_seconds(row.account.deleted_at, 'admin_account_list.deleted_at');
			}
		);

		test_if(
			capabilities.account_lifecycle,
			'credentials minted before a delete stay dead after the undelete; a fresh login authenticates',
			async () => {
				const fixture = await setup_test();
				const victim = await fixture.create_account({
					username: 'lifecycle_revived',
					password_value: LIFECYCLE_PASSWORD
				});
				const admin_headers = fixture.create_session_headers();
				const victim_id = victim.account.id;

				// each credential authenticates as the victim before the delete, so
				// its refusal after the undelete is a transition
				assert.strictEqual(
					await verified_account_id(fixture, victim.create_session_headers()),
					victim_id
				);
				assert.strictEqual(
					await verified_account_id(fixture, victim.create_bearer_headers()),
					victim_id
				);

				for (const method of ['account_delete', 'account_undelete']) {
					const res = await cross_rpc_call(
						fixture.fresh_transport(),
						rpc_path,
						method,
						{ account_id: victim_id },
						admin_headers
					);
					assert.ok(res.ok, `${method} must succeed: ${JSON.stringify(res)}`);
				}

				await assert_answers_as_anonymous(
					fixture,
					victim,
					victim.create_session_headers(),
					'a session minted before the delete stays dead after the undelete'
				);
				await assert_answers_as_anonymous(
					fixture,
					victim,
					victim.create_bearer_headers(),
					'an API token minted before the delete stays dead after the undelete'
				);

				const fresh = await login(fixture, victim.account.username, LIFECYCLE_PASSWORD);
				assert.strictEqual(fresh.status, 200, 'the reactivated account logs in');
				assert.ok(fresh.cookie);
				assert.strictEqual(
					await verified_account_id(fixture, {
						...anonymous_headers(victim),
						cookie: fresh.cookie
					}),
					victim_id,
					'the fresh session authenticates as the reactivated account'
				);
			}
		);

		test('a password change ends every session and API token of the account, and only the new password logs in', async () => {
			const fixture = await setup_test();
			const account = await fixture.create_account({
				username: 'lifecycle_rotated',
				password_value: LIFECYCLE_PASSWORD
			});
			const account_id = account.account.id;
			const sibling = await login(fixture, account.account.username, LIFECYCLE_PASSWORD);
			assert.strictEqual(sibling.status, 200, 'a second session for the account');
			assert.ok(sibling.cookie);
			const sibling_headers = { ...anonymous_headers(account), cookie: sibling.cookie };

			// both sessions and the token authenticate as the account first
			assert.strictEqual(
				await verified_account_id(fixture, account.create_session_headers()),
				account_id
			);
			assert.strictEqual(await verified_account_id(fixture, sibling_headers), account_id);
			assert.strictEqual(
				await verified_account_id(fixture, account.create_bearer_headers()),
				account_id
			);

			// the change goes through the sibling session; the account's first
			// session is the other one
			const change = await fixture.fresh_transport()(password_path, {
				method: 'POST',
				headers: create_test_request_headers({
					'content-type': 'application/json',
					cookie: sibling.cookie
				}),
				body: JSON.stringify({
					current_password: LIFECYCLE_PASSWORD,
					new_password: LIFECYCLE_PASSWORD_CHANGED
				})
			});
			await change.body?.cancel();
			assert.strictEqual(change.status, 200, 'the password change succeeds');

			await assert_answers_as_anonymous(
				fixture,
				account,
				account.create_session_headers(),
				'the session the change was not made on is ended'
			);
			await assert_answers_as_anonymous(
				fixture,
				account,
				sibling_headers,
				'the session the change was made on is ended'
			);
			await assert_answers_as_anonymous(
				fixture,
				account,
				account.create_bearer_headers(),
				'the account’s API token is ended'
			);
			// scoped to the account: the keeper's session is untouched
			assert.strictEqual(
				await verified_account_id(fixture, fixture.create_session_headers()),
				fixture.account.id,
				'another account’s session stays live'
			);

			const old_login = await login(fixture, account.account.username, LIFECYCLE_PASSWORD);
			assert.strictEqual(old_login.status, 401, 'the old password no longer logs in');
			const new_login = await login(fixture, account.account.username, LIFECYCLE_PASSWORD_CHANGED);
			assert.strictEqual(new_login.status, 200, 'the new password logs in');
		});
	});
};
