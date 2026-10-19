/**
 * Tests for `auth/credential_deadline.ts` — the deadline a long-lived
 * connection closes at, and the bounded-timer wait that reaches it.
 *
 * The wait runs under fake timers that fake `performance` too, so a 30-day
 * deadline is reached without waiting. The fake `setTimeout` keeps the real
 * one's ceiling — a delay past 2^31 - 1 ms fires after 1 ms — which is the
 * overflow the bounded timers exist to avoid. The wait re-reads the clock
 * after every timer, so an overflowed one does not fire the deadline early:
 * it wakes after 1 ms and re-arms, spinning. The cases pin the first wake-up
 * an hour out, which a spin fails at once.
 *
 * A host suspend stops the monotonic clock and not the wall clock; the fake
 * clock models it with `vi.setSystemTime`, which moves `Date` and leaves
 * `performance` and the timers where they are.
 *
 * @module
 */

import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';

import {
	CREDENTIAL_DEADLINE_TIMER_CAP_MS,
	credential_deadline_after,
	next_credential_deadline_delay,
	schedule_credential_deadline
} from '#lib/auth/credential_deadline.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe('credential_deadline_after', () => {
	test('the deadline is the shortest remaining lifetime', () => {
		assert.strictEqual(credential_deadline_after([30 * DAY_MS, 2000], 100), 2100);
		assert.strictEqual(credential_deadline_after([2000, 30 * DAY_MS], 100), 2100);
		// an absent entry (an eternal token's row) never wins
		assert.strictEqual(credential_deadline_after([null, DAY_MS], 0), DAY_MS);
	});

	test('no lifetime is no deadline', () => {
		assert.strictEqual(credential_deadline_after([], 0), null);
		assert.strictEqual(credential_deadline_after([null, null], 0), null);
	});

	test('a negative or NaN lifetime counts as zero', () => {
		assert.strictEqual(credential_deadline_after([-5], 100), 100);
		assert.strictEqual(credential_deadline_after([Number.NaN, DAY_MS], 100), 100);
	});
});

describe('next_credential_deadline_delay', () => {
	test('a far deadline is waited toward in capped steps', () => {
		for (const lifetime of [30 * DAY_MS, 36_500 * DAY_MS]) {
			assert.strictEqual(
				next_credential_deadline_delay(lifetime, 0),
				CREDENTIAL_DEADLINE_TIMER_CAP_MS,
				`a ${lifetime}ms deadline waits one capped step at a time`
			);
		}
		// an hour: far inside setTimeout's ceiling, and the most a suspend can
		// add past the wall-clock deadline
		assert.strictEqual(CREDENTIAL_DEADLINE_TIMER_CAP_MS, HOUR_MS);
		assert.strictEqual(next_credential_deadline_delay(2000, 0), 2000);
		assert.strictEqual(next_credential_deadline_delay(100, 100), null);
		assert.strictEqual(next_credential_deadline_delay(100, 200), null);
	});
});

describe('schedule_credential_deadline', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('a 30-day deadline does not fire at once, nor a day short, and fires at the deadline', () => {
		let fired = 0;
		const start = performance.now();
		schedule_credential_deadline(start + 30 * DAY_MS, () => fired++);
		// one 30-day timer would overflow and wake after 1 ms, then re-arm and
		// spin; the capped chain wakes first an hour out
		vi.advanceTimersToNextTimer();
		assert.strictEqual(performance.now() - start, HOUR_MS, 'the first wake-up is not an hour out');
		assert.strictEqual(fired, 0);
		vi.advanceTimersByTime(29 * DAY_MS - HOUR_MS);
		assert.strictEqual(fired, 0, 'fired a day early');
		vi.advanceTimersByTime(DAY_MS - 1);
		assert.strictEqual(fired, 0, 'fired a millisecond early');
		vi.advanceTimersByTime(1);
		assert.strictEqual(fired, 1, 'did not fire at the deadline');
		vi.advanceTimersByTime(30 * DAY_MS);
		assert.strictEqual(fired, 1, 'fires once');
	});

	test("an API token's longest lifetime does not fire early", () => {
		let fired = 0;
		const start = performance.now();
		schedule_credential_deadline(start + 36_500 * DAY_MS, () => fired++);
		vi.advanceTimersToNextTimer();
		assert.strictEqual(performance.now() - start, HOUR_MS, 'the first wake-up is not an hour out');
		vi.advanceTimersByTime(3 * 366 * DAY_MS);
		assert.strictEqual(fired, 0);
	});

	test('a suspend does not extend the deadline: the first wake-up after the resume fires', () => {
		let fired = 0;
		const start = performance.now();
		schedule_credential_deadline(start + 30 * DAY_MS, () => fired++);
		vi.advanceTimersByTime(20 * DAY_MS);
		assert.strictEqual(fired, 0, 'fired before either deadline');
		// the host sleeps an hour short of 10 days: only the wall clock moves,
		// so the next wake-up lands on the wall deadline exactly
		vi.setSystemTime(Date.now() + 10 * DAY_MS - HOUR_MS);
		assert.strictEqual(
			performance.now() - start,
			20 * DAY_MS,
			'the suspend moved the monotonic clock'
		);
		vi.advanceTimersByTime(HOUR_MS - 1);
		assert.strictEqual(fired, 0, 'fired before its next wake-up');
		vi.advanceTimersByTime(1);
		assert.strictEqual(fired, 1, 'the first wake-up after the resume did not fire');
		vi.advanceTimersByTime(30 * DAY_MS);
		assert.strictEqual(fired, 1, 'fires once');
	});

	test('a wall clock stepped back does not extend the deadline', () => {
		let fired = 0;
		schedule_credential_deadline(performance.now() + 2 * DAY_MS, () => fired++);
		vi.setSystemTime(Date.now() - 30 * DAY_MS);
		vi.advanceTimersByTime(2 * DAY_MS - 1);
		assert.strictEqual(fired, 0, 'fired before its deadline');
		vi.advanceTimersByTime(1);
		assert.strictEqual(fired, 1, 'the monotonic deadline did not fire');
	});

	test('a deadline already passed fires at once', () => {
		let fired = 0;
		schedule_credential_deadline(performance.now() - 1, () => fired++);
		assert.strictEqual(fired, 1);
	});

	test('cancel stops the wait, and is safe to repeat', () => {
		let fired = 0;
		const cancel = schedule_credential_deadline(performance.now() + 2 * DAY_MS, () => fired++);
		vi.advanceTimersByTime(DAY_MS + 5);
		cancel();
		cancel();
		vi.advanceTimersByTime(5 * DAY_MS);
		assert.strictEqual(fired, 0);
		assert.strictEqual(vi.getTimerCount(), 0, 'no timer is left behind');
	});

	test('no deadline schedules nothing', () => {
		let fired = 0;
		const cancel = schedule_credential_deadline(null, () => fired++);
		assert.strictEqual(vi.getTimerCount(), 0);
		vi.advanceTimersByTime(400 * DAY_MS);
		cancel();
		assert.strictEqual(fired, 0);
	});
});
