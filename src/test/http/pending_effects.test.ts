/**
 * Unit tests for the two-queue side-effect machinery.
 *
 * Covers:
 *
 * 1. `flush_pending_effects` — eager-queue helper. Logs every rejection
 *    via `log.error`, fans out to the optional `on_rejection` callback,
 *    and never rejects.
 * 2. `flush_post_commit_effects` — invariant that a throwing thunk does
 *    not starve siblings, and that thunk errors are routed through
 *    `log.error`.
 * 3. `emit_after_commit` — invariant that thunks are pushed verbatim
 *    onto `post_commit_effects` and only invoked at flush time, so a
 *    thunk pushed inside a transaction body fires strictly after the
 *    transaction commits.
 * 4. `dispatch_with_post_commit_rollback` — the shared rollback-discard
 *    wrapper both dispatch sites use. Unit-level coverage of the
 *    truncate-**not**-clear semantics (pre-seeded entries survive), the
 *    error re-throw identity, the success path (effects stay queued for
 *    the flush), and the undefined-queue bare-harness guard. The
 *    integration coupling across both real dispatch sites lives in
 *    `pending_effects.rollback.db.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger, type LogConsole } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	emit_after_commit,
	dispatch_with_post_commit_rollback,
	flush_pending_effects,
	flush_post_commit_effects
} from '$lib/http/pending_effects.ts';

const create_recording_logger = (): { log: Logger; errors: Array<Array<unknown>> } => {
	const errors: Array<Array<unknown>> = [];
	const recording_console: LogConsole = {
		error: (...args: Array<unknown>) => {
			errors.push(args);
		},
		warn: () => {},
		log: () => {}
	};
	const log = new Logger('pending_effects_test', { level: 'error', console: recording_console });
	return { log, errors };
};

describe('flush_post_commit_effects', () => {
	test('captures a throwing thunk without rejecting the flush promise', async () => {
		const { log, errors } = create_recording_logger();
		const post_commit_effects: Array<() => void | Promise<void>> = [];
		const boom = new Error('boom');
		emit_after_commit({ log, post_commit_effects }, () => {
			throw boom;
		});
		// `flush_post_commit_effects` is non-throwing — `await` directly
		// would reject if the helper let the throw escape.
		await flush_post_commit_effects(post_commit_effects, log);
		assert.strictEqual(errors.length, 1);
		assert.ok(
			errors[0]!.some((a) => a === boom),
			'error log must include the thrown value'
		);
	});

	test('a failing thunk does not starve later thunks queued in the same tick', async () => {
		const { log } = create_recording_logger();
		const post_commit_effects: Array<() => void | Promise<void>> = [];
		const seen: Array<string> = [];

		emit_after_commit({ log, post_commit_effects }, () => {
			seen.push('first');
			throw new Error('first failed');
		});
		emit_after_commit({ log, post_commit_effects }, () => {
			seen.push('second');
		});
		emit_after_commit({ log, post_commit_effects }, () => {
			seen.push('third');
			throw new Error('third failed');
		});

		await flush_post_commit_effects(post_commit_effects, log);
		assert.deepStrictEqual(seen, ['first', 'second', 'third']);
	});

	test('a passing thunk leaves the error log untouched', async () => {
		const { log, errors } = create_recording_logger();
		const post_commit_effects: Array<() => void | Promise<void>> = [];
		let ran = false;
		emit_after_commit({ log, post_commit_effects }, () => {
			ran = true;
		});
		await flush_post_commit_effects(post_commit_effects, log);
		assert.strictEqual(ran, true);
		assert.strictEqual(errors.length, 0);
	});

	test('async thunk rejection is captured and logged', async () => {
		const { log, errors } = create_recording_logger();
		const post_commit_effects: Array<() => void | Promise<void>> = [];
		const boom = new Error('async boom');
		emit_after_commit({ log, post_commit_effects }, async () => {
			throw boom;
		});
		await flush_post_commit_effects(post_commit_effects, log);
		assert.strictEqual(errors.length, 1);
		assert.ok(
			errors[0]!.some((a) => a === boom),
			'error log must include the rejected value'
		);
	});

	test('directly-pushed thunk (not via emit_after_commit) is still wrapped by the flush', async () => {
		// The flush owns the safety net so any thunk shape that lands on
		// the queue — including ones tests push by hand — cannot escape.
		const { log, errors } = create_recording_logger();
		const post_commit_effects: Array<() => void | Promise<void>> = [];
		post_commit_effects.push(() => {
			throw new Error('raw push boom');
		});
		await flush_post_commit_effects(post_commit_effects, log);
		assert.strictEqual(errors.length, 1);
	});
});

describe('emit_after_commit ordering', () => {
	test('thunk runs strictly after the wrapping transaction commits', async () => {
		const { log } = create_recording_logger();
		const post_commit_effects: Array<() => void | Promise<void>> = [];
		const events: Array<string> = [];

		// Mirror the shape of `apply_route_specs`' transaction wrapper:
		// `await db.transaction(async tx => { ...handler... })` then commit.
		// The commit step has at least one `await` boundary (real drivers
		// run `client.query('COMMIT')`); `await Promise.resolve()` is a
		// minimal stand-in for that boundary.
		const fake_transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
			events.push('begin');
			const result = await fn();
			events.push('about_to_commit');
			await Promise.resolve();
			events.push('commit_done');
			return result;
		};

		await fake_transaction(async () => {
			emit_after_commit({ log, post_commit_effects }, () => {
				events.push('fn_ran');
			});
			return { ok: true };
		});

		await flush_post_commit_effects(post_commit_effects, log);

		const fn_ran_index = events.indexOf('fn_ran');
		const commit_done_index = events.indexOf('commit_done');
		assert.ok(fn_ran_index !== -1, 'thunk must run');
		assert.ok(commit_done_index !== -1, 'commit must complete');
		assert.ok(
			fn_ran_index > commit_done_index,
			`thunk must run after commit, got events: ${events.join(' → ')}`
		);
	});
});

describe('dispatch_with_post_commit_rollback', () => {
	test('on throw, truncates to the pre-dispatch depth (pre-seeded survives) and re-throws the same error', async () => {
		const { log } = create_recording_logger();
		const pre_seeded = (): void => {};
		const post_commit_effects: Array<() => void | Promise<void>> = [pre_seeded];
		const boom = new Error('handler boom');

		const err = await assert_rejects(
			() =>
				dispatch_with_post_commit_rollback(post_commit_effects, () => {
					// The "handler" queues two deferred effects, then rolls back.
					emit_after_commit({ log, post_commit_effects }, () => {});
					emit_after_commit({ log, post_commit_effects }, () => {});
					throw boom;
				}),
			/handler boom/
		);

		assert.strictEqual(err, boom, 're-throws the original error unchanged');
		assert.deepStrictEqual(
			post_commit_effects,
			[pre_seeded],
			'truncate, not clear: the pre-seeded entry survives; both effects this dispatch queued are discarded'
		);
	});

	test('on success, returns the dispatch result and leaves queued effects for the flush to drain', async () => {
		const { log } = create_recording_logger();
		const post_commit_effects: Array<() => void | Promise<void>> = [];

		const result = await dispatch_with_post_commit_rollback(post_commit_effects, () => {
			emit_after_commit({ log, post_commit_effects }, () => {});
			emit_after_commit({ log, post_commit_effects }, () => {});
			return { ok: true } as const;
		});

		assert.deepStrictEqual(result, { ok: true }, 'returns the dispatch result verbatim');
		assert.strictEqual(
			post_commit_effects.length,
			2,
			'committed effects stay queued — the helper discards only on throw; the flush drains on success'
		);
	});

	test('tolerates an undefined queue (bare-harness dispatch) on both the success and throw paths', async () => {
		// `c.var.post_commit_effects` is absent when a handler runs without the
		// pending-effects middleware: absent ⇒ nothing to discard, never a crash.
		const value = await dispatch_with_post_commit_rollback(undefined, () => 'ok');
		assert.strictEqual(value, 'ok', 'success path passes the value through');

		const boom = new Error('bare boom');
		const err = await assert_rejects(
			() => dispatch_with_post_commit_rollback(undefined, () => Promise.reject(boom)),
			/bare boom/
		);
		assert.strictEqual(err, boom, 'throw still propagates with an absent queue');
	});
});

describe('flush_pending_effects', () => {
	test('drains an empty queue without touching the logger', async () => {
		const { log, errors } = create_recording_logger();
		await flush_pending_effects([], log);
		assert.strictEqual(errors.length, 0);
	});

	test('awaits every promise; all-resolved case leaves the logger untouched', async () => {
		const { log, errors } = create_recording_logger();
		const seen: Array<string> = [];
		const effects: Array<Promise<void>> = [
			Promise.resolve().then(() => {
				seen.push('a');
			}),
			Promise.resolve().then(() => {
				seen.push('b');
			})
		];
		await flush_pending_effects(effects, log);
		assert.deepStrictEqual(seen.sort(), ['a', 'b']);
		assert.strictEqual(errors.length, 0);
	});

	test('one rejection does not starve siblings; rejection is logged', async () => {
		const { log, errors } = create_recording_logger();
		const seen: Array<string> = [];
		const boom = new Error('boom');
		const effects: Array<Promise<void>> = [
			Promise.reject(boom),
			Promise.resolve().then(() => {
				seen.push('after-rejection');
			})
		];
		await flush_pending_effects(effects, log);
		assert.deepStrictEqual(seen, ['after-rejection']);
		assert.strictEqual(errors.length, 1);
		assert.ok(
			errors[0]!.some((a) => a === boom),
			'error log must include the rejected value'
		);
	});

	test('on_rejection callback fans out alongside the helper log', async () => {
		const { log, errors } = create_recording_logger();
		const fanout: Array<unknown> = [];
		const boom = new Error('callback boom');
		await flush_pending_effects([Promise.reject(boom)], log, (reason) => {
			fanout.push(reason);
		});
		assert.deepStrictEqual(fanout, [boom]);
		assert.strictEqual(errors.length, 1, 'helper still logs even when callback fires');
	});

	test('on_rejection fires once per rejected effect, not once per call', async () => {
		const { log } = create_recording_logger();
		const fanout_count: Array<number> = [];
		const effects: Array<Promise<void>> = [
			Promise.reject(new Error('first')),
			Promise.resolve(),
			Promise.reject(new Error('second'))
		];
		await flush_pending_effects(effects, log, () => {
			fanout_count.push(1);
		});
		assert.strictEqual(fanout_count.length, 2);
	});
});
