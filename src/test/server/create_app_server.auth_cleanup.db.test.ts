/**
 * Tests for `create_app_server`'s `auth_cleanup` option — the opt-in
 * `start_auth_cleanup` schedule over `backend.deps`, stopped by
 * `AppServer.close`.
 *
 * Covers:
 * - Off by default: no pass runs and no cleanup timer is set.
 * - `true` runs the startup pass through the server's own deps (its `db`, its
 *   audit emitter, its `connection_closer`) on the default interval, with an
 *   unref'd timer.
 * - `{interval_ms}` keeps sweeping on that interval, and `close()` ends it —
 *   nothing is swept afterwards.
 * - `close()` waits for a pass in progress before it closes the database.
 * - `create_test_app` leaves it off, and its `cleanup()` stops a schedule a
 *   suite opted into through `app_options`.
 * - An invalid interval fails assembly.
 *
 * The scheduler's own timing rules are `auth/cleanup.schedule.test.ts`; the
 * sweeps are `auth/cleanup.db.test.ts` and `auth/cleanup.sessions.db.test.ts`.
 *
 * @module
 */

import { afterEach, assert, test, vi } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { create_keyring } from '$lib/auth/keyring.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import { create_health_route_spec } from '$lib/http/common_routes.ts';
import { create_app_server, type AppServerOptions } from '$lib/server/app_server.ts';
import type { AppBackend } from '$lib/server/app_backend.ts';
import { create_audit_emitter } from '$lib/auth/audit_emitter.ts';
import type { AuditLogEvent } from '$lib/auth/audit_log_schema.ts';
import { DEFAULT_AUTH_CLEANUP_INTERVAL_MS } from '$lib/auth/cleanup.ts';
import { query_create_account_with_actor } from '$lib/auth/account_queries.ts';
import { query_role_grant_offer_create } from '$lib/auth/role_grant_offer_queries.ts';
import { hash_session_token, query_create_session } from '$lib/auth/session_queries.ts';
import { create_realtime_closer } from '$lib/actions/connection_closer.ts';
import type { Db } from '$lib/db/db.ts';
import {
	create_test_app,
	create_loopback_app_server_options,
	stub_password_deps
} from '$lib/testing/app_server.ts';
import {
	assert_close_call,
	create_recording_closer,
	type RecordedClose
} from '$lib/testing/connection_closer_helpers.ts';

import { describe_db } from '../db_fixture.ts';
import { create_gated_db } from '../gated_db.ts';

const keyring = create_keyring('test-key-that-is-at-least-32-chars-long!!')!;
const log = new Logger('test', { level: 'off' });
const hour_ms = 60 * 60 * 1000;

/** Poll until `predicate` holds, failing with `message` after two seconds. */
const until = async (
	predicate: () => boolean | Promise<boolean>,
	message: string
): Promise<void> => {
	const deadline = Date.now() + 2000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, message);
		await wait(5);
	}
};

interface Harness {
	options: AppServerOptions;
	/** Closes made through the backend's `connection_closer`. */
	closes: Array<RecordedClose>;
	/** Events the backend's audit emitter announced. */
	audit_events: Array<AuditLogEvent>;
	/** How many times the backend's `close` ran. */
	backend_closes: () => number;
}

/** Options over `db`, with the backend's closer, emitter, and `close` observable. */
const create_harness = (db: Db, overrides?: Partial<AppServerOptions>): Harness => {
	const { closer, calls } = create_recording_closer();
	const connection_closer = create_realtime_closer();
	connection_closer.add(closer);
	const audit_events: Array<AuditLogEvent> = [];
	let backend_closes = 0;
	const backend: AppBackend = {
		db_type: 'pglite-memory',
		db_name: '(test)',
		migration_results: [],
		close: async () => {
			backend_closes++;
		},
		deps: {
			log,
			keyring,
			password: stub_password_deps,
			db,
			audit: create_audit_emitter({ db, log, on_audit_event: (e) => audit_events.push(e) }),
			connection_closer,
			read_secure_file: async (path: string): Promise<Uint8Array> => {
				throw new Error(`ENOENT: no such file or directory: ${path}`);
			},
			delete_file: async () => {}
		}
	};
	return {
		options: {
			...create_loopback_app_server_options(),
			backend,
			session_options: create_session_config('test_session'),
			create_route_specs: () => [create_health_route_spec()],
			...overrides
		},
		closes: calls,
		audit_events,
		backend_closes: () => backend_closes
	};
};

interface Seeded {
	account_id: Uuid;
	actor_id: Uuid;
	other_account_id: Uuid;
}

const seed_accounts = async (db: Db): Promise<Seeded> => {
	const { account, actor } = await query_create_account_with_actor(
		{ db },
		{ username: 'cleanup_server', password_hash: 'hash' }
	);
	const { account: other } = await query_create_account_with_actor(
		{ db },
		{ username: 'cleanup_server_other', password_hash: 'hash' }
	);
	return { account_id: account.id, actor_id: actor.id, other_account_id: other.id };
};

/** Seed a session an hour past its expiry and return its id. */
const seed_expired_session = async (db: Db, name: string, account_id: Uuid): Promise<string> => {
	const id = hash_session_token(name);
	await query_create_session({ db }, id, account_id, new Date(Date.now() - hour_ms));
	return id;
};

const session_exists = async (db: Db, id: string): Promise<boolean> =>
	(await db.query('SELECT 1 FROM auth_session WHERE id = $1', [id])).length > 0;

/** The delays of the `setTimeout` calls a spy saw. */
const timer_delays = (spy: { mock: { calls: Array<Array<unknown>> } }): Array<unknown> =>
	spy.mock.calls.map((call) => call[1]);

describe_db('create_app_server auth_cleanup', (get_db) => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('is off by default: no pass runs and no cleanup timer is set', async () => {
		const db = get_db();
		const seeded = await seed_accounts(db);
		const expired = await seed_expired_session(db, 'server-expired', seeded.account_id);
		const h = create_harness(db);

		const set_timeout = vi.spyOn(globalThis, 'setTimeout');
		const server = await create_app_server(h.options);
		// long enough for a startup pass to have swept, had one started
		await wait(50);
		const delays = timer_delays(set_timeout);
		set_timeout.mockRestore();

		assert.strictEqual(await session_exists(db, expired), true, 'nothing swept the session');
		assert.deepEqual(h.closes, []);
		assert.ok(
			!delays.includes(DEFAULT_AUTH_CLEANUP_INTERVAL_MS),
			'no timer on the cleanup interval'
		);

		await server.close();
		assert.strictEqual(h.backend_closes(), 1);
	});

	test('true runs the startup pass through the server deps on the default interval', async () => {
		const db = get_db();
		const seeded = await seed_accounts(db);
		const expired = await seed_expired_session(db, 'server-expired', seeded.account_id);
		const offer = await query_role_grant_offer_create(
			{ db },
			{
				from_actor_id: seeded.actor_id,
				to_account_id: seeded.other_account_id,
				role: 'teacher',
				scope_id: null,
				message: null,
				expires_at: new Date(Date.now() - hour_ms)
			}
		);
		const h = create_harness(db, { auth_cleanup: true });

		const set_timeout = vi.spyOn(globalThis, 'setTimeout');
		const server = await create_app_server(h.options);
		const cleanup_timers = set_timeout.mock.calls
			.map((call, i) => ({ delay: call[1], timer: set_timeout.mock.results[i]!.value }))
			.filter((t) => t.delay === DEFAULT_AUTH_CLEANUP_INTERVAL_MS);
		set_timeout.mockRestore();

		// the offer sweep is the pass's last step
		await until(() => h.audit_events.length > 0, 'the startup pass swept the expired offer');
		assert.strictEqual(await session_exists(db, expired), false, 'the session sweep ran');
		// through the backend's own closer and emitter
		assert.strictEqual(h.closes.length, 1);
		assert_close_call(h.closes[0], 'session', expired);
		assert.strictEqual(h.audit_events.length, 1);
		assert.strictEqual(h.audit_events[0]!.event_type, 'role_grant_offer_expire');
		assert.strictEqual(h.audit_events[0]!.metadata?.offer_id, offer.id);

		assert.strictEqual(cleanup_timers.length, 1, 'one timer, on the default interval');
		assert.strictEqual(
			(cleanup_timers[0]!.timer as NodeJS.Timeout).hasRef(),
			false,
			'the timer does not hold the process open'
		);

		await server.close();
		assert.strictEqual(h.backend_closes(), 1);
	});

	test('an interval keeps sweeping, and close stops it', async () => {
		const db = get_db();
		const seeded = await seed_accounts(db);
		const at_startup = await seed_expired_session(db, 'server-at-startup', seeded.account_id);
		const h = create_harness(db, { auth_cleanup: { interval_ms: 20 } });
		const server = await create_app_server(h.options);

		await until(
			async () => !(await session_exists(db, at_startup)),
			'the startup pass swept the expired session'
		);
		// a session that expires afterwards is picked up by a later pass
		const later = await seed_expired_session(db, 'server-later', seeded.account_id);
		await until(
			async () => !(await session_exists(db, later)),
			'a later pass swept the newly expired session'
		);
		assert.sameMembers(
			h.closes.map((c) => c.id),
			[at_startup, later]
		);

		await server.close();
		assert.strictEqual(h.backend_closes(), 1);

		// several intervals on, nothing sweeps what expired after the close
		const after_close = await seed_expired_session(db, 'server-after-close', seeded.account_id);
		await wait(150);
		assert.strictEqual(await session_exists(db, after_close), true, 'no pass after close');
		// the two sweeps' closes, then the shutdown's close of every connection
		assert.strictEqual(h.closes.length, 3);
		assert_close_call(h.closes[2], 'all', null);
	});

	test('close waits for the pass in progress before closing the database', async () => {
		const db = get_db();
		const seeded = await seed_accounts(db);
		const expired = await seed_expired_session(db, 'server-expired', seeded.account_id);
		const gated = create_gated_db(db);
		// hold the startup pass inside its session sweep, the delete uncommitted
		const hold = gated.hold_commit();
		const h = create_harness(gated.db, { auth_cleanup: true });
		const server = await create_app_server(h.options);
		await hold.reached;

		let closed = false;
		const closing = server.close().then(() => {
			closed = true;
		});
		await wait(30);
		const closed_while_held = closed;
		const backend_closes_while_held = h.backend_closes();
		// released before asserting, so a failure here leaves no transaction open
		hold.release();
		await closing;
		assert.strictEqual(closed_while_held, false, 'close waited on the pass');
		assert.strictEqual(
			backend_closes_while_held,
			0,
			'the database is not closed under a running pass'
		);
		assert.strictEqual(h.backend_closes(), 1);
		// the pass finished on a live database: its delete landed and it closed
		assert.strictEqual(await session_exists(db, expired), false);
		// the held pass's close lands before the shutdown closes every connection
		assert.strictEqual(h.closes.length, 2);
		assert_close_call(h.closes[0], 'session', expired);
		assert_close_call(h.closes[1], 'all', null);
	});

	test('create_test_app leaves it off, and its cleanup stops a schedule a suite opted into', async () => {
		const db = get_db();
		const session_options = create_session_config('test_session');
		const create_route_specs = () => [create_health_route_spec()];

		const off = await create_test_app({ session_options, create_route_specs, db });
		const untouched = await seed_expired_session(db, 'harness-off', off.backend.account.id);
		await wait(50);
		assert.strictEqual(await session_exists(db, untouched), true, 'the harness schedules nothing');
		await off.cleanup();

		const on = await create_test_app({
			session_options,
			create_route_specs,
			db,
			username: 'keeper_on',
			app_options: { auth_cleanup: { interval_ms: 20 } }
		});
		await until(
			async () => !(await session_exists(db, untouched)),
			'the opted-in schedule swept the expired session'
		);
		await on.cleanup();
		const after_cleanup = await seed_expired_session(db, 'harness-after', on.backend.account.id);
		await wait(150);
		assert.strictEqual(await session_exists(db, after_cleanup), true, 'no pass after cleanup');
	});

	test('an invalid interval fails assembly', async () => {
		const h = create_harness(get_db(), { auth_cleanup: { interval_ms: 0 } });
		await assert_rejects(
			() => create_app_server(h.options),
			/interval_ms must be a positive number/
		);
	});
});
