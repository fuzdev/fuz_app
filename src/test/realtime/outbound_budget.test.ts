/**
 * Tests for `OutboundBudget` — the byte budget of one connection's waiting
 * frames: the charge is exact and includes a per-frame overhead, nothing else
 * limits how many frames wait, and a frame is always admitted when nothing is
 * waiting.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { OUTBOUND_FRAME_OVERHEAD_BYTES, OutboundBudget } from '#lib/realtime/outbound_budget.ts';

describe('OutboundBudget', () => {
	test('the per-frame overhead is 64 bytes', () => {
		// part of the contract the Rust spine's queue shares
		assert.strictEqual(OUTBOUND_FRAME_OVERHEAD_BYTES, 64);
	});

	test('the byte budget is exact: payload plus one overhead per frame', () => {
		const max_bytes = 10 + 2 * OUTBOUND_FRAME_OVERHEAD_BYTES;
		const budget = new OutboundBudget(max_bytes);
		assert.strictEqual(budget.admit(4), true);
		assert.strictEqual(budget.admit(6), true);
		assert.strictEqual(budget.queued_bytes, 10);
		assert.strictEqual(budget.queued_frames, 2);

		// exactly at the budget: an empty frame still costs its overhead
		assert.strictEqual(budget.admit(0), false);
		assert.deepStrictEqual(budget.to_overflow(0), {
			queued_bytes: 10,
			queued_frames: 2,
			frame_bytes: 0
		});
		// a refused frame is not charged
		assert.strictEqual(budget.queued_bytes, 10);
		assert.strictEqual(budget.queued_frames, 2);

		// one byte less of budget and the second frame is the one too many
		const smaller = new OutboundBudget(max_bytes - 1);
		assert.strictEqual(smaller.admit(4), true);
		assert.strictEqual(smaller.admit(6), false);
	});

	test('each frame is charged its overhead, not once for the queue', () => {
		const len = 1;
		const fit = 15;
		const per_frame = len + OUTBOUND_FRAME_OVERHEAD_BYTES;
		// room for `fit` frames and all but one byte of another
		const max_bytes = (fit + 1) * per_frame - 1;
		const budget = new OutboundBudget(max_bytes);
		for (let n = 1; n <= fit; n++) {
			assert.strictEqual(budget.admit(len), true, `frame ${n} fits`);
		}
		assert.strictEqual(budget.admit(len), false, 'the next crosses the budget by one byte');

		// the same frames with one more byte of budget all fit
		const larger = new OutboundBudget(max_bytes + 1);
		for (let n = 0; n <= fit; n++) assert.strictEqual(larger.admit(len), true);
		assert.strictEqual(larger.queued_frames, fit + 1);
	});

	test('zero-length frames are bounded by their overhead', () => {
		const fit = 10;
		const budget = new OutboundBudget(fit * OUTBOUND_FRAME_OVERHEAD_BYTES);
		for (let n = 0; n < fit; n++) assert.strictEqual(budget.admit(0), true);
		assert.strictEqual(budget.queued_bytes, 0);
		assert.strictEqual(budget.admit(0), false);
	});

	test('only bytes bound the queue: thousands of small frames fit together', () => {
		const frames = 5000;
		const len = 8;
		const budget = new OutboundBudget(frames * (len + OUTBOUND_FRAME_OVERHEAD_BYTES));
		for (let n = 0; n < frames; n++) assert.strictEqual(budget.admit(len), true);
		assert.strictEqual(budget.queued_frames, frames);
		assert.strictEqual(budget.admit(len), false);
	});

	test('an oversized frame is admitted only when nothing is waiting', () => {
		const max_bytes = 2 * OUTBOUND_FRAME_OVERHEAD_BYTES + 10;
		const budget = new OutboundBudget(max_bytes);
		assert.strictEqual(budget.admit(5 * max_bytes), true);
		budget.release(5 * max_bytes);

		assert.strictEqual(budget.admit(1), true);
		assert.strictEqual(budget.admit(5 * max_bytes), false);

		// a budget of zero is all exception: one frame at a time
		const zero = new OutboundBudget(0);
		assert.strictEqual(zero.admit(3), true);
		assert.strictEqual(zero.admit(0), false);
		zero.release(3);
		assert.strictEqual(zero.admit(3), true);
	});

	test('a released frame frees its charge, and clear frees them all', () => {
		const budget = new OutboundBudget(2 * (10 + OUTBOUND_FRAME_OVERHEAD_BYTES));
		for (let round = 0; round < 100; round++) {
			assert.strictEqual(budget.admit(10), true);
			assert.strictEqual(budget.admit(10), true, 'exactly the budget');
			budget.release(10);
			budget.release(10);
		}
		assert.strictEqual(budget.queued_bytes, 0);
		assert.strictEqual(budget.queued_frames, 0);

		assert.strictEqual(budget.admit(10), true);
		assert.strictEqual(budget.admit(10), true);
		budget.clear();
		assert.strictEqual(budget.queued_bytes, 0);
		assert.strictEqual(budget.queued_frames, 0);
	});

	test('a budget that is not a non-negative integer is refused', () => {
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => new OutboundBudget(bad), /max_bytes must be a non-negative integer/);
		}
	});
});
