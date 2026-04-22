/**
 * Unit tests for `emit_after_commit`.
 *
 * Proves the two invariants handlers rely on:
 * 1. A throwing effect does not reject the pushed promise — awaiting
 *    `Promise.all(pending_effects)` stays clean — and a failing effect
 *    does not prevent later effects in the same tick from running.
 * 2. The caught error is routed through `ctx.log.error`, so test-visible
 *    failures are recoverable (not silently vanished).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger, type LogConsole} from '@fuzdev/fuz_util/log.js';

import {emit_after_commit} from '$lib/http/pending_effects.js';

const create_recording_logger = (): {log: Logger; errors: Array<Array<unknown>>} => {
	const errors: Array<Array<unknown>> = [];
	const recording_console: LogConsole = {
		error: (...args: Array<unknown>) => {
			errors.push(args);
		},
		warn: () => {},
		log: () => {},
	};
	const log = new Logger('pending_effects_test', {level: 'error', console: recording_console});
	return {log, errors};
};

describe('emit_after_commit', () => {
	test('captures a throwing effect without rejecting the queued promise', async () => {
		const {log, errors} = create_recording_logger();
		const pending_effects: Array<Promise<void>> = [];
		const boom = new Error('boom');
		emit_after_commit({log, pending_effects}, () => {
			throw boom;
		});
		// Using `all` (not `allSettled`) — if the helper let the throw escape,
		// this would reject. The guarantee is stronger than `allSettled`.
		await Promise.all(pending_effects);
		assert.strictEqual(errors.length, 1);
		assert.ok(
			errors[0]!.some((a) => a === boom),
			'error log must include the thrown value',
		);
	});

	test('a failing effect does not starve later effects queued in the same tick', async () => {
		const {log} = create_recording_logger();
		const pending_effects: Array<Promise<void>> = [];
		const seen: Array<string> = [];

		emit_after_commit({log, pending_effects}, () => {
			seen.push('first');
			throw new Error('first failed');
		});
		emit_after_commit({log, pending_effects}, () => {
			seen.push('second');
		});
		emit_after_commit({log, pending_effects}, () => {
			seen.push('third');
			throw new Error('third failed');
		});

		await Promise.all(pending_effects);
		assert.deepStrictEqual(seen, ['first', 'second', 'third']);
	});

	test('a passing effect leaves the error log untouched', async () => {
		const {log, errors} = create_recording_logger();
		const pending_effects: Array<Promise<void>> = [];
		let ran = false;
		emit_after_commit({log, pending_effects}, () => {
			ran = true;
		});
		await Promise.all(pending_effects);
		assert.strictEqual(ran, true);
		assert.strictEqual(errors.length, 0);
	});
});
