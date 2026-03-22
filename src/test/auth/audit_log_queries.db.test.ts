import {assert, test, beforeEach} from 'vitest';

import {
	query_audit_log,
	query_audit_log_list,
	query_audit_log_list_for_account,
	query_audit_log_list_permit_history,
	query_audit_log_cleanup_before,
} from '$lib/auth/audit_log_queries.js';
import {query_create_account, query_create_actor} from '$lib/auth/account_queries.js';
import type {Db} from '$lib/db/db.js';
import type {QueryDeps} from '$lib/db/query_deps.js';

import {describe_db} from '../db_fixture.js';

const create_test_account = async (
	db: Db,
	username: string,
): Promise<{account_id: string; actor_id: string}> => {
	const deps = {db};
	const account = await query_create_account(deps, {username, password_hash: 'hash'});
	const actor = await query_create_actor(deps, account.id, username);
	return {account_id: account.id, actor_id: actor.id};
};

describe_db('AuditLogQueries', (get_db) => {
	let deps: QueryDeps;

	beforeEach(() => {
		deps = {db: get_db()};
	});

	test('log creates an entry', async () => {
		await query_audit_log(deps, {event_type: 'login', outcome: 'success', ip: '127.0.0.1'});
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.event_type, 'login');
		assert.strictEqual(events[0]!.outcome, 'success');
		assert.strictEqual(events[0]!.ip, '127.0.0.1');
	});

	test('log defaults outcome to success', async () => {
		await query_audit_log(deps, {event_type: 'logout'});
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events[0]!.outcome, 'success');
	});

	test('log stores metadata as JSON', async () => {
		await query_audit_log(deps, {
			event_type: 'login',
			metadata: {username: 'alice', sessions_evicted: 2},
		});
		const events = await query_audit_log_list(deps);
		assert.strictEqual((events[0]!.metadata as any).username, 'alice');
		assert.strictEqual((events[0]!.metadata as any).sessions_evicted, 2);
	});

	test('log stores actor_id and account_id', async () => {
		const {account_id, actor_id} = await create_test_account(get_db(), 'alice');
		await query_audit_log(deps, {
			event_type: 'logout',
			actor_id,
			account_id,
		});
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events[0]!.actor_id, actor_id);
		assert.strictEqual(events[0]!.account_id, account_id);
	});

	test('log stores target_account_id for cross-account actions', async () => {
		const admin = await create_test_account(get_db(), 'admin');
		const target = await create_test_account(get_db(), 'target');
		await query_audit_log(deps, {
			event_type: 'permit_grant',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', permit_id: 'test-permit-1'},
		});
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events[0]!.target_account_id, target.account_id);
	});

	test('list returns newest first', async () => {
		await query_audit_log(deps, {event_type: 'login', ip: '1.1.1.1'});
		await query_audit_log(deps, {event_type: 'logout', ip: '2.2.2.2'});
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 2);
		assert.strictEqual(events[0]!.event_type, 'logout');
		assert.strictEqual(events[1]!.event_type, 'login');
	});

	test('list respects limit', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		await query_audit_log(deps, {event_type: 'logout'});
		await query_audit_log(deps, {event_type: 'bootstrap'});
		const events = await query_audit_log_list(deps, {limit: 2});
		assert.strictEqual(events.length, 2);
	});

	test('list respects offset', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		await query_audit_log(deps, {event_type: 'logout'});
		await query_audit_log(deps, {event_type: 'bootstrap'});
		const events = await query_audit_log_list(deps, {limit: 10, offset: 1});
		assert.strictEqual(events.length, 2);
	});

	test('list filters by event_type', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		await query_audit_log(deps, {event_type: 'logout'});
		await query_audit_log(deps, {event_type: 'login'});
		const events = await query_audit_log_list(deps, {event_type: 'login'});
		assert.strictEqual(events.length, 2);
		for (const e of events) {
			assert.strictEqual(e.event_type, 'login');
		}
	});

	test('list filters by event_type_in', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		await query_audit_log(deps, {event_type: 'logout'});
		await query_audit_log(deps, {event_type: 'permit_grant'});
		await query_audit_log(deps, {event_type: 'permit_revoke'});
		const events = await query_audit_log_list(deps, {
			event_type_in: ['permit_grant', 'permit_revoke'],
		});
		assert.strictEqual(events.length, 2);
	});

	test('list filters by outcome', async () => {
		await query_audit_log(deps, {event_type: 'login', outcome: 'success'});
		await query_audit_log(deps, {event_type: 'login', outcome: 'failure'});
		await query_audit_log(deps, {event_type: 'login', outcome: 'success'});
		const failures = await query_audit_log_list(deps, {outcome: 'failure'});
		assert.strictEqual(failures.length, 1);
		assert.strictEqual(failures[0]!.outcome, 'failure');
	});

	test('list filters by account_id (matches account_id or target_account_id)', async () => {
		const alice = await create_test_account(get_db(), 'alice');
		const bob = await create_test_account(get_db(), 'bob');
		// alice logs in
		await query_audit_log(deps, {event_type: 'login', account_id: alice.account_id});
		// bob grants alice a permit (alice is target)
		await query_audit_log(deps, {
			event_type: 'permit_grant',
			account_id: bob.account_id,
			target_account_id: alice.account_id,
		});
		// bob logs in (unrelated)
		await query_audit_log(deps, {event_type: 'login', account_id: bob.account_id});
		const alice_events = await query_audit_log_list(deps, {account_id: alice.account_id});
		assert.strictEqual(alice_events.length, 2);
	});

	test('list_for_account returns entries for both roles', async () => {
		const alice = await create_test_account(get_db(), 'alice');
		const bob = await create_test_account(get_db(), 'bob');
		await query_audit_log(deps, {event_type: 'login', account_id: alice.account_id});
		await query_audit_log(deps, {
			event_type: 'permit_grant',
			account_id: bob.account_id,
			target_account_id: alice.account_id,
		});
		await query_audit_log(deps, {event_type: 'login', account_id: bob.account_id});
		const alice_events = await query_audit_log_list_for_account(deps, alice.account_id);
		assert.strictEqual(alice_events.length, 2);
	});

	test('cleanup_before removes old entries and returns count', async () => {
		// insert an entry, then manually backdate it
		await query_audit_log(deps, {event_type: 'login'});
		await query_audit_log(deps, {event_type: 'logout'});
		await get_db().query(
			`UPDATE audit_log SET created_at = '2020-01-01T00:00:00Z' WHERE event_type = 'login'`,
		);
		const deleted = await query_audit_log_cleanup_before(deps, new Date('2024-01-01'));
		assert.strictEqual(deleted, 1);
		const remaining = await query_audit_log_list(deps);
		assert.strictEqual(remaining.length, 1);
		assert.strictEqual(remaining[0]!.event_type, 'logout');
	});

	test('log generates UUID id and sets created_at', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
		// id is a UUID
		assert.match(events[0]!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		// created_at is a valid recent timestamp
		const created = new Date(events[0]!.created_at);
		assert.ok(!isNaN(created.getTime()), 'created_at should be a valid date');
		assert.ok(Date.now() - created.getTime() < 10_000, 'created_at should be recent');
	});

	test('log with null metadata stores null', async () => {
		await query_audit_log(deps, {event_type: 'login', metadata: null});
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events[0]!.metadata, null);
	});

	test('list with combined filters (event_type + outcome)', async () => {
		await query_audit_log(deps, {event_type: 'login', outcome: 'success'});
		await query_audit_log(deps, {event_type: 'login', outcome: 'failure'});
		await query_audit_log(deps, {event_type: 'logout', outcome: 'success'});
		const events = await query_audit_log_list(deps, {event_type: 'login', outcome: 'failure'});
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.event_type, 'login');
		assert.strictEqual(events[0]!.outcome, 'failure');
	});

	test('list with empty event_type_in returns all events', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		await query_audit_log(deps, {event_type: 'logout'});
		const events = await query_audit_log_list(deps, {event_type_in: []});
		assert.strictEqual(events.length, 2);
	});

	test('list filters by since_seq', async () => {
		const e1 = await query_audit_log(deps, {event_type: 'login'});
		const e2 = await query_audit_log(deps, {event_type: 'logout'});
		await query_audit_log(deps, {event_type: 'bootstrap'});
		// only events after e1's seq
		const events = await query_audit_log_list(deps, {since_seq: e1.seq});
		assert.strictEqual(events.length, 2);
		// newest first — e3 then e2
		assert.ok(events.every((e) => e.seq > e1.seq));
		// only events after e2's seq
		const events2 = await query_audit_log_list(deps, {since_seq: e2.seq});
		assert.strictEqual(events2.length, 1);
		assert.strictEqual(events2[0]!.event_type, 'bootstrap');
	});

	test('query_audit_log returns inserted row with DB-assigned fields', async () => {
		const event = await query_audit_log(deps, {
			event_type: 'login',
			outcome: 'success',
			ip: '10.0.0.1',
		});
		assert.ok(event.id, 'should have a UUID id');
		assert.ok(event.seq > 0, 'should have a positive seq');
		assert.ok(event.created_at, 'should have created_at');
		assert.strictEqual(event.event_type, 'login');
		assert.strictEqual(event.outcome, 'success');
		assert.strictEqual(event.ip, '10.0.0.1');
	});

	test('list_for_account respects limit', async () => {
		const alice = await create_test_account(get_db(), 'alice');
		await query_audit_log(deps, {event_type: 'login', account_id: alice.account_id});
		await query_audit_log(deps, {event_type: 'logout', account_id: alice.account_id});
		await query_audit_log(deps, {event_type: 'login', account_id: alice.account_id});
		const events = await query_audit_log_list_for_account(deps, alice.account_id, 2);
		assert.strictEqual(events.length, 2);
	});

	test('cleanup_before with no old entries returns 0', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		const deleted = await query_audit_log_cleanup_before(deps, new Date('2020-01-01'));
		assert.strictEqual(deleted, 0);
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
	});

	test('FK SET NULL preserves entries when account is deleted', async () => {
		const {account_id, actor_id} = await create_test_account(get_db(), 'doomed');
		await query_audit_log(deps, {event_type: 'login', actor_id, account_id});
		// delete the account (cascades actor)
		await get_db().query(`DELETE FROM account WHERE id = $1`, [account_id]);
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.actor_id, null);
		assert.strictEqual(events[0]!.account_id, null);
	});

	test('list_permit_history returns permit_grant and permit_revoke with usernames', async () => {
		const admin = await create_test_account(get_db(), 'ph_admin');
		const target = await create_test_account(get_db(), 'ph_target');
		await query_audit_log(deps, {
			event_type: 'permit_grant',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', permit_id: 'test-permit-2'},
		});
		await query_audit_log(deps, {
			event_type: 'permit_revoke',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', permit_id: 'test-permit-2'},
		});
		// login event should NOT appear in permit history
		await query_audit_log(deps, {
			event_type: 'login',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
		});
		const history = await query_audit_log_list_permit_history(deps);
		assert.strictEqual(history.length, 2);
		for (const entry of history) {
			assert.strictEqual(entry.username, 'ph_admin');
			assert.strictEqual(entry.target_username, 'ph_target');
		}
		const event_types = history.map((e) => e.event_type);
		assert.ok(event_types.includes('permit_grant'));
		assert.ok(event_types.includes('permit_revoke'));
	});

	test('list_permit_history respects limit and offset', async () => {
		const admin = await create_test_account(get_db(), 'ph_limit_admin');
		const target = await create_test_account(get_db(), 'ph_limit_target');
		for (let i = 0; i < 3; i++) {
			await query_audit_log(deps, {
				event_type: 'permit_grant',
				actor_id: admin.actor_id,
				account_id: admin.account_id,
				target_account_id: target.account_id,
				metadata: {role: 'admin', permit_id: `test-permit-${i}`},
			});
		}
		const limited = await query_audit_log_list_permit_history(deps, 2);
		assert.strictEqual(limited.length, 2);
		const offset_results = await query_audit_log_list_permit_history(deps, 10, 1);
		assert.strictEqual(offset_results.length, 2);
	});

	test('conflicting event_type and event_type_in returns empty results', async () => {
		// Documents the AND behavior: event_type = 'login' AND event_type IN ('logout', 'bootstrap')
		// produces no results because 'login' is not in the IN list.
		await query_audit_log(deps, {event_type: 'login'});
		await query_audit_log(deps, {event_type: 'logout'});
		await query_audit_log(deps, {event_type: 'bootstrap'});

		const events = await query_audit_log_list(deps, {
			event_type: 'login',
			event_type_in: ['logout', 'bootstrap'],
		});
		assert.strictEqual(events.length, 0);
	});

	test('list_permit_history returns null usernames for deleted accounts', async () => {
		const doomed = await create_test_account(get_db(), 'ph_doomed');
		const target = await create_test_account(get_db(), 'ph_doomed_target');
		await query_audit_log(deps, {
			event_type: 'permit_grant',
			actor_id: doomed.actor_id,
			account_id: doomed.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', permit_id: 'test-permit-doomed'},
		});
		// delete both accounts
		await get_db().query(`DELETE FROM account WHERE id = $1`, [doomed.account_id]);
		await get_db().query(`DELETE FROM account WHERE id = $1`, [target.account_id]);
		const history = await query_audit_log_list_permit_history(deps);
		assert.strictEqual(history.length, 1);
		assert.strictEqual(history[0]!.username, null);
		assert.strictEqual(history[0]!.target_username, null);
	});
});
