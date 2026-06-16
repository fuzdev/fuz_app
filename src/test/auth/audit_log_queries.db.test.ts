import {assert, test, beforeEach, vi} from 'vitest';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.ts';

import {
	query_audit_log,
	query_audit_log_list,
	query_audit_log_list_with_usernames,
	query_audit_log_list_role_grant_history,
	query_audit_log_cleanup_before,
	get_audit_metadata_validation_failures,
	reset_audit_metadata_validation_failures,
	get_audit_unknown_event_type_failures,
	reset_audit_unknown_event_type_failures,
} from '$lib/auth/audit_log_queries.ts';
import {create_audit_emitter} from '$lib/auth/audit_emitter.ts';
import {AuditLogEventJson, create_audit_log_config} from '$lib/auth/audit_log_schema.ts';
import {query_create_account, query_create_actor} from '$lib/auth/account_queries.ts';
import type {Uuid} from '@fuzdev/fuz_util/id.ts';
import type {Db} from '$lib/db/db.ts';
import type {QueryDeps} from '$lib/db/query_deps.ts';

import {describe_db} from '../db_fixture.ts';

const create_test_account = async (
	db: Db,
	username: string,
): Promise<{account_id: Uuid; actor_id: Uuid}> => {
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
			event_type: 'role_grant_create',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', role_grant_id: 'test-role_grant-1' as Uuid},
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
		await query_audit_log(deps, {event_type: 'role_grant_create'});
		await query_audit_log(deps, {event_type: 'role_grant_revoke'});
		const events = await query_audit_log_list(deps, {
			event_type_in: ['role_grant_create', 'role_grant_revoke'],
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
		// bob grants alice a role_grant (alice is target)
		await query_audit_log(deps, {
			event_type: 'role_grant_create',
			account_id: bob.account_id,
			target_account_id: alice.account_id,
		});
		// bob logs in (unrelated)
		await query_audit_log(deps, {event_type: 'login', account_id: bob.account_id});
		const alice_events = await query_audit_log_list(deps, {account_id: alice.account_id});
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

	test('list with account_id filter respects limit', async () => {
		const alice = await create_test_account(get_db(), 'alice');
		await query_audit_log(deps, {event_type: 'login', account_id: alice.account_id});
		await query_audit_log(deps, {event_type: 'logout', account_id: alice.account_id});
		await query_audit_log(deps, {event_type: 'login', account_id: alice.account_id});
		const events = await query_audit_log_list(deps, {account_id: alice.account_id, limit: 2});
		assert.strictEqual(events.length, 2);
	});

	test('cleanup_before with no old entries returns 0', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		const deleted = await query_audit_log_cleanup_before(deps, new Date('2020-01-01'));
		assert.strictEqual(deleted, 0);
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
	});

	test('audit ids survive a hard account delete (no FK on identity columns)', async () => {
		// New contract (delete = soft, purge = hard): the audit_log identity
		// columns carry no FK, so a hard purge leaves the raw ids INTACT
		// instead of nulling them (the old `ON DELETE SET NULL` erased the
		// attribution the log exists to preserve).
		const {account_id, actor_id} = await create_test_account(get_db(), 'doomed');
		await query_audit_log(deps, {event_type: 'login', actor_id, account_id});
		// Hard-purge the account (cascades actor); the audit row's ids persist.
		await get_db().query(`DELETE FROM account WHERE id = $1`, [account_id]);
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.actor_id, actor_id);
		assert.strictEqual(events[0]!.account_id, account_id);
	});

	test('list_with_usernames resolves username via direct account JOIN', async () => {
		const alice = await create_test_account(get_db(), 'wu_direct');
		await query_audit_log(deps, {event_type: 'login', account_id: alice.account_id});
		const events = await query_audit_log_list_with_usernames(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.username, 'wu_direct');
		assert.strictEqual(events[0]!.target_username, null);
	});

	test('list_with_usernames resolves username via actor chain when account_id is null', async () => {
		// Stage 4 route-spec wrappers stamp `actor_id` but may leave
		// `account_id` null on actor-bound events; the chain branch of
		// the COALESCE must still produce a username.
		const alice = await create_test_account(get_db(), 'wu_chain');
		await query_audit_log(deps, {event_type: 'logout', actor_id: alice.actor_id});
		const events = await query_audit_log_list_with_usernames(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.username, 'wu_chain');
	});

	test('list_with_usernames prefers actor chain over account_id when both diverge', async () => {
		// Forensic future-proofing for N:1 multi-actor: if the denormalized
		// pair ever disagree, COALESCE must pick the actor-chained username.
		// Under v1 1:1 they always agree; the test forces divergence to pin
		// which branch wins.
		const truth = await create_test_account(get_db(), 'wu_truth');
		const decoy = await create_test_account(get_db(), 'wu_decoy');
		await query_audit_log(deps, {
			event_type: 'logout',
			actor_id: truth.actor_id,
			account_id: decoy.account_id,
		});
		const events = await query_audit_log_list_with_usernames(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.username, 'wu_truth');
	});

	test('list_with_usernames resolves target_username via actor chain', async () => {
		const admin = await create_test_account(get_db(), 'wu_t_admin');
		const target = await create_test_account(get_db(), 'wu_t_target');
		await query_audit_log(deps, {
			event_type: 'role_grant_revoke',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
			target_actor_id: target.actor_id,
		});
		const events = await query_audit_log_list_with_usernames(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.username, 'wu_t_admin');
		assert.strictEqual(events[0]!.target_username, 'wu_t_target');
	});

	test('list_with_usernames returns null usernames when both branches miss', async () => {
		await query_audit_log(deps, {event_type: 'login'});
		const events = await query_audit_log_list_with_usernames(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.username, null);
		assert.strictEqual(events[0]!.target_username, null);
	});

	test('list_role_grant_history returns role_grant_create and role_grant_revoke with usernames', async () => {
		const admin = await create_test_account(get_db(), 'ph_admin');
		const target = await create_test_account(get_db(), 'ph_target');
		await query_audit_log(deps, {
			event_type: 'role_grant_create',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', role_grant_id: 'test-role_grant-2' as Uuid},
		});
		await query_audit_log(deps, {
			event_type: 'role_grant_revoke',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', role_grant_id: 'test-role_grant-2' as Uuid},
		});
		// login event should NOT appear in role_grant history
		await query_audit_log(deps, {
			event_type: 'login',
			actor_id: admin.actor_id,
			account_id: admin.account_id,
		});
		const history = await query_audit_log_list_role_grant_history(deps);
		assert.strictEqual(history.length, 2);
		for (const entry of history) {
			assert.strictEqual(entry.username, 'ph_admin');
			assert.strictEqual(entry.target_username, 'ph_target');
		}
		const event_types = history.map((e) => e.event_type);
		assert.ok(event_types.includes('role_grant_create'));
		assert.ok(event_types.includes('role_grant_revoke'));
	});

	test('list_role_grant_history respects limit and offset', async () => {
		const admin = await create_test_account(get_db(), 'ph_limit_admin');
		const target = await create_test_account(get_db(), 'ph_limit_target');
		for (let i = 0; i < 3; i++) {
			await query_audit_log(deps, {
				event_type: 'role_grant_create',
				actor_id: admin.actor_id,
				account_id: admin.account_id,
				target_account_id: target.account_id,
				metadata: {role: 'admin', role_grant_id: `test-role_grant-${i}` as Uuid},
			});
		}
		const limited = await query_audit_log_list_role_grant_history(deps, 2);
		assert.strictEqual(limited.length, 2);
		const offset_results = await query_audit_log_list_role_grant_history(deps, 10, 1);
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

	test('list_role_grant_history returns null usernames for deleted accounts', async () => {
		const doomed = await create_test_account(get_db(), 'ph_doomed');
		const target = await create_test_account(get_db(), 'ph_doomed_target');
		await query_audit_log(deps, {
			event_type: 'role_grant_create',
			actor_id: doomed.actor_id,
			account_id: doomed.account_id,
			target_account_id: target.account_id,
			metadata: {role: 'admin', role_grant_id: 'test-role_grant-doomed' as Uuid},
		});
		// delete both accounts
		await get_db().query(`DELETE FROM account WHERE id = $1`, [doomed.account_id]);
		await get_db().query(`DELETE FROM account WHERE id = $1`, [target.account_id]);
		const history = await query_audit_log_list_role_grant_history(deps);
		assert.strictEqual(history.length, 1);
		assert.strictEqual(history[0]!.username, null);
		assert.strictEqual(history[0]!.target_username, null);
	});

	// --- metadata validation (always-on, fail-open + counter) -----------------

	test('metadata mismatch increments counter and writes the row anyway', async () => {
		reset_audit_metadata_validation_failures();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {
			// suppress the expected error log
		});
		try {
			const before = get_audit_metadata_validation_failures();
			await query_audit_log(deps, {
				event_type: 'login',
				// `login` metadata schema doesn't include `bogus_field`
				metadata: {bogus_field: 42} as any,
			});
			const after = get_audit_metadata_validation_failures();
			assert.strictEqual(after - before, 1);
			// Audit row was still written.
			const events = await query_audit_log_list(deps);
			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.event_type, 'login');
			assert.ok(error_spy.mock.calls.length >= 1);
		} finally {
			error_spy.mockRestore();
			reset_audit_metadata_validation_failures();
		}
	});

	test('valid metadata does not increment the counter', async () => {
		reset_audit_metadata_validation_failures();
		try {
			const before = get_audit_metadata_validation_failures();
			await query_audit_log(deps, {
				event_type: 'login',
				metadata: {username: 'alice', sessions_evicted: 2},
			});
			const after = get_audit_metadata_validation_failures();
			assert.strictEqual(after, before);
		} finally {
			reset_audit_metadata_validation_failures();
		}
	});

	// --- consumer-extensible audit-log config -----------------

	test('consumer event type round-trips through query_audit_log_list', async () => {
		const config = create_audit_log_config({
			extra_events: {
				classroom_create: z.looseObject({classroom_id: z.string(), name: z.string()}),
			},
		});
		await query_audit_log(
			deps,
			{
				event_type: 'classroom_create',
				metadata: {classroom_id: 'cls-1', name: 'Period 3 English'},
			},
			config,
		);
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.event_type, 'classroom_create');
		assert.strictEqual((events[0]!.metadata as any).name, 'Period 3 English');
	});

	test('consumer event type passes AuditLogEventJson schema (wire round-trip)', async () => {
		// Locks in the v0.39.x widening of `AuditLogEventJson.event_type`
		// from the closed `AuditEventType` enum to `AuditEventTypeName`.
		// Before the widening, `audit_log_list` RPC responses carrying a
		// consumer event type threw on `spec.output.safeParse`. The
		// JSON.parse(JSON.stringify(...)) hop simulates the Hono wire
		// serialization where Date → ISO string before `safeParse` runs.
		const config = create_audit_log_config({
			extra_events: {classroom_create: null},
		});
		await query_audit_log(
			deps,
			{event_type: 'classroom_create', metadata: {classroom_id: 'cls-1'}},
			config,
		);
		const events = await query_audit_log_list(deps);
		const wire = JSON.parse(JSON.stringify(events[0]));
		const parsed = AuditLogEventJson.safeParse(wire);
		assert.ok(
			parsed.success,
			`AuditLogEventJson rejected consumer event_type: ${JSON.stringify(parsed.error?.issues)}`,
		);
		assert.strictEqual(parsed.data.event_type, 'classroom_create');
	});

	test('consumer event type with metadata mismatch increments counter (fail-open)', async () => {
		reset_audit_metadata_validation_failures();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {
			// suppress
		});
		try {
			const config = create_audit_log_config({
				extra_events: {
					classroom_create: z.strictObject({classroom_id: z.string(), name: z.string()}),
				},
			});
			const before = get_audit_metadata_validation_failures();
			await query_audit_log(
				deps,
				{event_type: 'classroom_create', metadata: {wrong_field: 1} as any},
				config,
			);
			const after = get_audit_metadata_validation_failures();
			assert.strictEqual(after - before, 1);
			// row was still written
			const events = await query_audit_log_list(deps);
			assert.strictEqual(events.length, 1);
		} finally {
			error_spy.mockRestore();
			reset_audit_metadata_validation_failures();
		}
	});

	test('consumer event type registered with null schema skips validation', async () => {
		reset_audit_metadata_validation_failures();
		try {
			const config = create_audit_log_config({extra_events: {unschemaed_event: null}});
			const before = get_audit_metadata_validation_failures();
			await query_audit_log(
				deps,
				{event_type: 'unschemaed_event', metadata: {anything: true} as any},
				config,
			);
			const after = get_audit_metadata_validation_failures();
			assert.strictEqual(after, before);
			const events = await query_audit_log_list(deps);
			assert.strictEqual((events[0]!.metadata as any).anything, true);
		} finally {
			reset_audit_metadata_validation_failures();
		}
	});

	test('builtin event types still validate against builtin schemas with consumer config', async () => {
		reset_audit_metadata_validation_failures();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const config = create_audit_log_config({extra_events: {classroom_create: null}});
			const before = get_audit_metadata_validation_failures();
			// builtin metadata mismatch should still fire
			await query_audit_log(
				deps,
				{event_type: 'login', metadata: {bogus_field: 42} as any},
				config,
			);
			const after = get_audit_metadata_validation_failures();
			assert.strictEqual(after - before, 1);
		} finally {
			error_spy.mockRestore();
			reset_audit_metadata_validation_failures();
		}
	});

	test('unregistered event_type increments the unknown-event-type counter (fail-open)', async () => {
		reset_audit_unknown_event_type_failures();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const before = get_audit_unknown_event_type_failures();
			// emitting with the builtin config — 'classroom_create' is unregistered
			await query_audit_log(deps, {event_type: 'classroom_create', metadata: {anything: true}});
			const after = get_audit_unknown_event_type_failures();
			assert.strictEqual(after - before, 1);
			// row was still written
			const events = await query_audit_log_list(deps);
			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0]!.event_type, 'classroom_create');
		} finally {
			error_spy.mockRestore();
			reset_audit_unknown_event_type_failures();
		}
	});

	test('registered consumer event_type does not increment the unknown-event-type counter', async () => {
		reset_audit_unknown_event_type_failures();
		try {
			const config = create_audit_log_config({extra_events: {classroom_create: null}});
			const before = get_audit_unknown_event_type_failures();
			await query_audit_log(deps, {event_type: 'classroom_create', metadata: {ok: true}}, config);
			const after = get_audit_unknown_event_type_failures();
			assert.strictEqual(after, before);
		} finally {
			reset_audit_unknown_event_type_failures();
		}
	});

	test('builtin event_types pass the registration check by default', async () => {
		reset_audit_unknown_event_type_failures();
		try {
			const before = get_audit_unknown_event_type_failures();
			await query_audit_log(deps, {event_type: 'login'});
			const after = get_audit_unknown_event_type_failures();
			assert.strictEqual(after, before);
		} finally {
			reset_audit_unknown_event_type_failures();
		}
	});

	test('AuditEmitter.emit forwards config to query_audit_log', async () => {
		const audit_log_config = create_audit_log_config({
			extra_events: {
				classroom_create: z.looseObject({classroom_id: z.string(), name: z.string()}),
			},
		});
		const log = new Logger('test', {level: 'off'});
		const pending_effects: Array<Promise<void>> = [];
		const seen: Array<string> = [];
		const audit = create_audit_emitter({
			db: get_db(),
			log,
			on_audit_event: (event) => {
				seen.push(event.event_type);
			},
			audit_log_config,
		});
		audit.emit(
			{pending_effects},
			{
				event_type: 'classroom_create',
				metadata: {classroom_id: 'cls-1', name: 'Period 3 English'},
			},
		);
		await Promise.allSettled(pending_effects);
		assert.deepStrictEqual(seen, ['classroom_create']);
		const events = await query_audit_log_list(deps);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.event_type, 'classroom_create');
	});
});
