/**
 * Tests for `periodic.ts` — `start_periodic`, the loop a scheduled sweep
 * runs on.
 *
 * Driven on fake timers with a pass whose length the test sets.
 *
 * Covers:
 * - The startup pass starts before the call returns; later passes follow one
 *   interval apart, start to start.
 * - Passes never overlap, and a slow pass delays the schedule instead of
 *   bursting.
 * - A failed pass — rejected or thrown — is logged with the task's name and
 *   its error, and the loop continues.
 * - `stop` ends the schedule, waits for a pass in progress, starts no pass
 *   that was already due, and never rejects — not for a failed pass, and not
 *   when the logger itself throws, which raises no unhandled rejection either.
 * - An interval that is not a positive finite timer delay is refused at the
 *   call site, before any pass.
 * - Every timer is unref'd, so none holds the process open.
 *
 * Twin of the Rust spine's `fuz_sys::periodic` tests, minus the dropped
 * in-flight pass — `stop` finishes it instead. The auth cleanup's use of the
 * loop is `auth/cleanup.schedule.test.ts`.
 *
 * @module
 */

import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';
import { Logger, type LogConsole } from '@fuzdev/fuz_util/log.ts';

import { PERIODIC_INTERVAL_MS_MAX, start_periodic, type PeriodicTask } from '$lib/periodic.ts';

const INTERVAL_MS = 10_000;

/** What one pass does; `index` counts passes from zero. */
type OnPass = (index: number) => Promise<void> | void;

interface Harness {
	/** Start the task under test on `INTERVAL_MS`, or the interval given. */
	start: (interval_ms?: number) => PeriodicTask;
	/** Fake-clock offset of each pass's start, in order. */
	starts: Array<number>;
	/** How many passes are in progress right now, and the most there ever were. */
	running: { now: number; max: number };
	warns: Array<Array<unknown>>;
	/** Replace what a pass does; default returns at once. */
	on_pass: (fn: OnPass) => void;
}

const create_harness = (log_overrides?: Partial<LogConsole>): Harness => {
	const started_at = Date.now();
	const starts: Array<number> = [];
	const running = { now: 0, max: 0 };
	let on_pass: OnPass = () => {};
	const warns: Array<Array<unknown>> = [];
	const recording_console: LogConsole = {
		error: () => {},
		warn: (...args: Array<unknown>) => {
			warns.push(args);
		},
		log: () => {},
		...log_overrides
	};
	const log = new Logger('periodic-test', {
		level: 'info',
		console: recording_console,
		colors: false
	});
	const pass = async (): Promise<void> => {
		const index = starts.length;
		starts.push(Date.now() - started_at);
		running.now++;
		running.max = Math.max(running.max, running.now);
		try {
			await on_pass(index);
		} finally {
			running.now--;
		}
	};
	return {
		start: (interval_ms = INTERVAL_MS) => start_periodic('test sweep', interval_ms, pass, log),
		starts,
		running,
		warns,
		on_pass: (fn) => {
			on_pass = fn;
		}
	};
};

/** A promise that resolves after `ms` on the fake clock. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('start_periodic', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test('the startup pass runs at once, then one per interval', async () => {
		const h = create_harness();
		const task = h.start();
		assert.deepEqual(h.starts, [0], 'the startup pass starts before the call returns');

		await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
		assert.deepEqual(h.starts, [0], 'no pass ahead of the interval');
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(h.starts, [0, INTERVAL_MS]);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		assert.deepEqual(h.starts, [0, INTERVAL_MS, INTERVAL_MS * 2]);

		await task.stop();
	});

	// the Rust loop's `MissedTickBehavior::Delay`, not a burst (which would
	// start passes at 25s, 25s, 30s) or a skip to the grid (25s, 30s)
	test('a slow pass delays the schedule instead of overlapping or bursting', async () => {
		const h = create_harness();
		// only the startup pass overruns: two and a half intervals
		h.on_pass(async (index) => {
			if (index === 0) await sleep((INTERVAL_MS * 5) / 2);
		});
		const task = h.start();

		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
		assert.deepEqual(h.starts, [0], 'no pass starts while one is in progress');

		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2.5);
		assert.deepEqual(
			h.starts,
			// the overdue pass starts when the slow one ends, and the schedule
			// restarts from there, a full interval apart
			[0, 25_000, 35_000, 45_000]
		);
		assert.strictEqual(h.running.max, 1, 'passes never overlap');

		await task.stop();
	});

	test('a pass shorter than the interval does not shift the schedule', async () => {
		const h = create_harness();
		h.on_pass(() => sleep(INTERVAL_MS / 4));
		const task = h.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
		// start to start, not end to start
		assert.deepEqual(h.starts, [0, INTERVAL_MS, INTERVAL_MS * 2]);
		// the third pass is in progress; stop resolves once the clock lets it end
		const stopping = task.stop();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		await stopping;
		assert.deepEqual(h.starts, [0, INTERVAL_MS, INTERVAL_MS * 2]);
	});

	test('a failed pass is logged with its name and error and does not end the loop', async () => {
		const h = create_harness();
		const failures: Array<Error> = [];
		h.on_pass((index) => {
			const error = new Error('the sweep failed', {
				cause: new Error('the database is unreachable')
			});
			failures.push(error);
			// a rejection and a synchronous throw are the same failed pass
			if (index % 2 === 0) return Promise.reject(error);
			throw error;
		});
		const task = h.start();

		// every pass fails, and each next one still runs on schedule
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
		assert.deepEqual(h.starts, [0, INTERVAL_MS, INTERVAL_MS * 2]);
		assert.strictEqual(h.warns.length, 3, 'one warning per failed pass');
		for (const [i, warn] of h.warns.entries()) {
			assert.ok(
				warn.some((arg) => typeof arg === 'string' && arg.includes('test sweep pass failed')),
				'the warning names the task'
			);
			// the error object itself, so the log carries its stack and its cause
			const logged = warn.find((arg) => arg === failures[i]);
			assert.ok(logged instanceof Error, 'the warning carries the thrown error');
			assert.ok(logged.cause instanceof Error);
			assert.strictEqual(logged.cause.message, 'the database is unreachable');
		}

		await task.stop();
	});

	test('stop ends the schedule', async () => {
		const h = create_harness();
		const task = h.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		assert.deepEqual(h.starts, [0, INTERVAL_MS]);

		await task.stop();
		assert.strictEqual(vi.getTimerCount(), 0, 'no timer is left pending');
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
		assert.deepEqual(h.starts, [0, INTERVAL_MS], 'no pass after stop');

		// safe to call again
		await task.stop();
	});

	test('stop waits for the pass in progress and starts no pass that was due', async () => {
		const h = create_harness();
		const release = Promise.withResolvers<void>();
		let finished = false;
		h.on_pass(async () => {
			await release.promise;
			finished = true;
		});
		const task = h.start();
		// the startup pass overruns its interval, so the next one is due
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		assert.deepEqual(h.starts, [0]);

		let stopped = false;
		const stopping = task.stop().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		assert.strictEqual(stopped, false, 'stop is still waiting on the pass in progress');

		release.resolve();
		await stopping;
		assert.strictEqual(finished, true, 'the pass ran to its end');
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
		assert.deepEqual(h.starts, [0], 'the due pass never started');
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	test('stop resolves when the pass in progress fails', async () => {
		const h = create_harness();
		const release = Promise.withResolvers<void>();
		h.on_pass(() => release.promise);
		const task = h.start();

		const stopping = task.stop();
		release.reject(new Error('the sweep failed'));
		// resolves — a failed pass is the loop's to log, not stop's to throw
		await stopping;
		assert.strictEqual(h.warns.length, 1);
	});

	test('a logger that throws rejects nothing: stop resolves and the loop continues', async () => {
		const unhandled: Array<unknown> = [];
		const on_unhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', on_unhandled);
		try {
			// the failure log is the one thing in a pass that is not caught
			const h = create_harness({
				warn: () => {
					throw new Error('the logger failed');
				}
			});
			const release = Promise.withResolvers<void>();
			h.on_pass((index) => {
				if (index === 2) return release.promise;
				throw new Error('the sweep failed');
			});
			const task = h.start();

			// two failed passes whose log threw, with nobody awaiting them: the
			// loop goes on, and — the advance below turns the real event loop —
			// nothing was left unhandled
			await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
			assert.deepEqual(h.starts, [0, INTERVAL_MS, INTERVAL_MS * 2]);
			await vi.advanceTimersByTimeAsync(0);
			assert.deepEqual(unhandled, [], 'no unhandled rejection');

			// and with the third in progress, stop still resolves when it fails
			const stopping = task.stop();
			release.reject(new Error('the sweep failed'));
			await stopping;
			await vi.advanceTimersByTimeAsync(0);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', on_unhandled);
		}
	});

	test('an interval that is not a positive timer delay is refused before any pass', () => {
		for (const interval_ms of [
			0,
			-1,
			-INTERVAL_MS,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			PERIODIC_INTERVAL_MS_MAX + 1
		]) {
			const h = create_harness();
			assert.throws(
				() => h.start(interval_ms),
				/test sweep.*interval_ms must be a positive number/
			);
			assert.deepEqual(h.starts, [], `no pass for interval_ms ${interval_ms}`);
			assert.strictEqual(vi.getTimerCount(), 0, `no timer for interval_ms ${interval_ms}`);
		}
	});

	test('the longest timer delay is accepted', async () => {
		const h = create_harness();
		const task = h.start(PERIODIC_INTERVAL_MS_MAX);
		assert.deepEqual(h.starts, [0]);
		await task.stop();
	});

	test('no timer holds the process open', async () => {
		const set_timeout = vi.spyOn(globalThis, 'setTimeout');
		const h = create_harness();
		const task = h.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
		assert.deepEqual(h.starts, [0, INTERVAL_MS, INTERVAL_MS * 2]);

		const timers = set_timeout.mock.results.map((result) => result.value as NodeJS.Timeout);
		assert.strictEqual(timers.length, 3, 'one timer per pass');
		for (const timer of timers) {
			assert.strictEqual(timer.hasRef(), false, 'the timer does not hold the process open');
		}
		await task.stop();
	});
});
