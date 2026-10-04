/**
 * Tests for the scheduler in `auth/cleanup.ts` — `start_auth_cleanup`, the
 * auth cleanup on the `start_periodic` loop.
 *
 * Driven on fake timers over a `Db` that answers every query with no rows, so
 * a pass is real (`run_auth_cleanup`, both sweeps) and what the session
 * delete returns is the test's. The loop's own rules — no overlap, a slow
 * pass delaying the schedule, `stop` waiting on a pass, the unref'd timer —
 * are `periodic.test.ts`; the sweeps are `cleanup.db.test.ts` and
 * `cleanup.sessions.db.test.ts`.
 *
 * Covers:
 * - The startup pass starts before the call returns and passes follow on the
 *   interval given, `DEFAULT_AUTH_CLEANUP_INTERVAL_MS` by default.
 * - A pass that swept something closes for it and logs its counts; one that
 *   swept nothing logs nothing.
 * - A failed pass is logged as the auth cleanup's, with its error, and the
 *   next interval retries.
 * - `stop` ends it.
 * - An invalid interval is refused before any pass.
 *
 * Twin of the scheduler case in the Rust spine's `fuz_auth`
 * `tests/auth_cleanup.rs`.
 *
 * @module
 */

import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';
import { Logger, type LogConsole } from '@fuzdev/fuz_util/log.ts';

import {
	DEFAULT_AUTH_CLEANUP_INTERVAL_MS,
	start_auth_cleanup,
	type AuthCleanupDeps
} from '$lib/auth/cleanup.ts';
import { PERIODIC_INTERVAL_MS_MAX } from '$lib/periodic.ts';
import { Db, no_nested_transaction } from '$lib/db/db.ts';
import { create_test_audit_emitter } from '$lib/testing/stubs.ts';

const INTERVAL_MS = 10_000;

/** What the session delete does on one pass — its return is the pass's swept ids. */
type OnPass = (index: number) => Promise<Array<string>> | Array<string>;

interface Harness {
	deps: AuthCleanupDeps;
	/** Fake-clock offset of each pass's start, in order. */
	starts: Array<number>;
	/** How many times the offer sweep's claim ran — a pass's second half. */
	offer_sweeps: () => number;
	/** Session ids the closer was asked to close. */
	closed: Array<string>;
	warns: Array<Array<unknown>>;
	infos: Array<Array<unknown>>;
	/** Replace what the session delete does; default sweeps nothing at once. */
	on_pass: (fn: OnPass) => void;
}

/**
 * Cleanup deps over a database with nothing in it: every query answers no
 * rows, except the session delete, which runs the test's `on_pass`.
 */
const create_harness = (): Harness => {
	const started_at = Date.now();
	const starts: Array<number> = [];
	let offer_sweeps = 0;
	let on_pass: OnPass = () => [];
	const client = {
		query: async <T>(text: string): Promise<{ rows: Array<T> }> => {
			if (text.includes('role_grant_offer')) offer_sweeps++;
			if (!text.includes('DELETE FROM auth_session')) return { rows: [] };
			const index = starts.length;
			starts.push(Date.now() - started_at);
			const ids = await on_pass(index);
			return { rows: ids.map((id) => ({ id })) as Array<T> };
		}
	};
	const db = new Db({
		client,
		transaction: async (fn) => fn(new Db({ client, transaction: no_nested_transaction }))
	});
	const warns: Array<Array<unknown>> = [];
	const infos: Array<Array<unknown>> = [];
	const recording_console: LogConsole = {
		error: () => {},
		warn: (...args: Array<unknown>) => {
			warns.push(args);
		},
		log: (...args: Array<unknown>) => {
			infos.push(args);
		}
	};
	const closed: Array<string> = [];
	const sessions_only = (): number => {
		throw new Error('the sweep closes sessions only');
	};
	return {
		deps: {
			db,
			log: new Logger('cleanup-schedule-test', {
				level: 'info',
				console: recording_console,
				colors: false
			}),
			audit: create_test_audit_emitter(),
			connection_closer: {
				close_sockets_for_session: (id) => {
					closed.push(id);
					return 1;
				},
				close_sockets_for_token: sessions_only,
				close_sockets_for_account: sessions_only
			}
		},
		starts,
		offer_sweeps: () => offer_sweeps,
		closed,
		warns,
		infos,
		on_pass: (fn) => {
			on_pass = fn;
		}
	};
};

describe('start_auth_cleanup', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('the startup pass runs both sweeps at once, then one pass per interval', async () => {
		const h = create_harness();
		const schedule = start_auth_cleanup(h.deps, { interval_ms: INTERVAL_MS });
		assert.deepEqual(h.starts, [0], 'the startup pass starts before the call returns');
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(h.offer_sweeps(), 1, 'the offer sweep follows the session sweep');

		await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
		assert.deepEqual(h.starts, [0], 'no pass ahead of the interval');
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(h.starts, [0, INTERVAL_MS]);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		assert.deepEqual(h.starts, [0, INTERVAL_MS, INTERVAL_MS * 2]);
		assert.strictEqual(h.offer_sweeps(), 3);

		await schedule.stop();
	});

	test('the default interval is ten minutes', async () => {
		assert.strictEqual(DEFAULT_AUTH_CLEANUP_INTERVAL_MS, 10 * 60 * 1000);
		const h = create_harness();
		const schedule = start_auth_cleanup(h.deps);
		await vi.advanceTimersByTimeAsync(DEFAULT_AUTH_CLEANUP_INTERVAL_MS - 1);
		assert.deepEqual(h.starts, [0]);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(h.starts, [0, DEFAULT_AUTH_CLEANUP_INTERVAL_MS]);
		await schedule.stop();
	});

	test('a pass that swept something closes for it and logs its counts', async () => {
		const h = create_harness();
		h.on_pass((index) => (index === 0 ? ['swept-session'] : []));
		const schedule = start_auth_cleanup(h.deps, { interval_ms: INTERVAL_MS });
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		assert.deepEqual(h.starts, [0, INTERVAL_MS]);

		assert.deepEqual(h.closed, ['swept-session']);
		const swept_logs = h.infos.filter((args) =>
			args.some((arg) => typeof arg === 'string' && arg.includes('auth cleanup swept expired rows'))
		);
		assert.strictEqual(swept_logs.length, 1, 'the pass that swept nothing logs nothing');
		assert.ok(
			swept_logs[0]!.some(
				(arg) =>
					typeof arg === 'object' &&
					arg !== null &&
					(arg as { expired_sessions?: number }).expired_sessions === 1 &&
					(arg as { expired_offers?: number }).expired_offers === 0
			)
		);
		assert.deepEqual(h.warns, []);

		await schedule.stop();
	});

	test('a failed pass is logged under the auth cleanup name and the next interval retries', async () => {
		const h = create_harness();
		const failure = new Error('the database is unreachable');
		h.on_pass((index) => {
			if (index === 0) throw failure;
			return [];
		});
		const schedule = start_auth_cleanup(h.deps, { interval_ms: INTERVAL_MS });
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		assert.deepEqual(h.starts, [0, INTERVAL_MS], 'the next interval retries');
		assert.strictEqual(h.warns.length, 1);
		assert.ok(
			h.warns[0]!.some(
				(arg) => typeof arg === 'string' && arg.includes('auth cleanup pass failed')
			),
			'the warning names the auth cleanup'
		);
		assert.ok(
			h.warns[0]!.some((arg) => arg === failure),
			'the warning carries the error'
		);
		// the failed session sweep ended its pass: no offer sweep ran in it
		assert.strictEqual(h.offer_sweeps(), 1);

		await schedule.stop();
	});

	test('stop ends the schedule', async () => {
		const h = create_harness();
		const schedule = start_auth_cleanup(h.deps, { interval_ms: INTERVAL_MS });
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		assert.deepEqual(h.starts, [0, INTERVAL_MS]);

		await schedule.stop();
		assert.strictEqual(vi.getTimerCount(), 0, 'no timer is left pending');
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
		assert.deepEqual(h.starts, [0, INTERVAL_MS], 'no pass after stop');
	});

	test('an invalid interval is refused before any pass', () => {
		for (const interval_ms of [0, -1, Number.NaN, PERIODIC_INTERVAL_MS_MAX + 1]) {
			const h = create_harness();
			assert.throws(
				() => start_auth_cleanup(h.deps, { interval_ms }),
				/auth cleanup.*interval_ms must be a positive number/
			);
			assert.deepEqual(h.starts, [], `no pass for interval_ms ${interval_ms}`);
			assert.strictEqual(vi.getTimerCount(), 0, `no timer for interval_ms ${interval_ms}`);
		}
	});
});
