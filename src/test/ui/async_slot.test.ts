/**
 * Tests for `AsyncSlot` — composable async-operation slot.
 *
 * Coverage focuses on the load-bearing behaviors:
 * - Explicit status transitions ('initial' → 'pending' → 'success' | 'failure').
 * - Supersession via internal AbortController (a second `run()` drops the
 *   first's commit even if it resolves successfully).
 * - Abort semantics that don't promote to 'failure' (manual abort,
 *   external signal, supersedence all leave `error` untouched).
 * - `undefined` sentinel for `data` so `null` stays a legitimate
 *   success value for nullable `T`s.
 * - `set()` aborts in-flight runs before writing, so a late callback
 *   can't overwrite the explicit value.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {AsyncSlot} from '$lib/ui/async_slot.svelte.ts';
import {make_deferred, signal_rejection} from './async_test_helpers.ts';

/** Resolves to a value after the next microtask; lets tests await between actions. */
const tick = async <T>(value: T): Promise<T> => value;

describe('AsyncSlot — initial state', () => {
	test('defaults: initial, no data, no error', () => {
		const slot = new AsyncSlot<number>();
		assert.strictEqual(slot.status, 'initial');
		assert.strictEqual(slot.data, undefined);
		assert.strictEqual(slot.error, null);
		assert.strictEqual(slot.error_data, null);
		assert.strictEqual(slot.initial, true);
		assert.strictEqual(slot.loading, false);
		assert.strictEqual(slot.succeeded, false);
		assert.strictEqual(slot.failed, false);
	});

	test('`initial` seeds data and marks success', () => {
		const slot = new AsyncSlot<number>({initial: 42});
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.data, 42);
		assert.strictEqual(slot.initial, false);
		assert.strictEqual(slot.succeeded, true);
	});
});

describe('AsyncSlot — run() success path', () => {
	test('sets status pending during run, success after', async () => {
		const slot = new AsyncSlot<number>();
		const deferred = make_deferred<number>();
		const run_promise = slot.run(() => deferred.promise);
		assert.strictEqual(slot.status, 'pending');
		assert.strictEqual(slot.loading, true);
		deferred.resolve(7);
		const result = await run_promise;
		assert.strictEqual(result, 7);
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.data, 7);
		assert.strictEqual(slot.loading, false);
		assert.strictEqual(slot.succeeded, true);
	});

	test('void payload: data stays undefined-ish, status flips to success', async () => {
		const slot = new AsyncSlot();
		await slot.run(async () => {
			await tick(undefined);
		});
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.succeeded, true);
	});

	test('clears prior error on successful run', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => {
			throw new Error('first');
		});
		assert.strictEqual(slot.error, 'first');
		await slot.run(async () => 99);
		assert.strictEqual(slot.error, null);
		assert.strictEqual(slot.error_data, null);
		assert.strictEqual(slot.data, 99);
	});
});

describe('AsyncSlot — run() failure path', () => {
	test('sets status failure and error message from default map_error', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => {
			throw new Error('boom');
		});
		assert.strictEqual(slot.status, 'failure');
		assert.strictEqual(slot.error, 'boom');
		assert.strictEqual(slot.failed, true);
		assert.strictEqual(slot.loading, false);
	});

	test('default map_error falls back to "Request failed" for non-Error throws', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error throw
			throw {reason: 'oops'};
		});
		assert.strictEqual(slot.error, 'Request failed');
	});

	test('error_data captures the raw throw', async () => {
		const slot = new AsyncSlot<number>();
		const thrown = new Error('inspect me');
		await slot.run(async () => {
			throw thrown;
		});
		assert.strictEqual(slot.error_data, thrown);
	});

	test('preserves prior data across failure (stale-while-revalidate)', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => 100);
		assert.strictEqual(slot.data, 100);
		await slot.run(async () => {
			throw new Error('refresh failed');
		});
		assert.strictEqual(slot.status, 'failure');
		assert.strictEqual(slot.data, 100);
	});

	test('returns undefined on failure', async () => {
		const slot = new AsyncSlot<number>();
		const result = await slot.run(async () => {
			throw new Error('nope');
		});
		assert.strictEqual(result, undefined);
	});

	test('custom map_error structures the error value', async () => {
		interface RpcError {
			reason: string;
			retry_after?: number;
		}
		const slot = new AsyncSlot<number, RpcError>({
			map_error: (e) => {
				if (e && typeof e === 'object' && 'reason' in e) {
					return e as RpcError;
				}
				return {reason: 'unknown'};
			},
		});
		await slot.run(async () => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- structured throw
			throw {reason: 'rate_limit', retry_after: 30};
		});
		assert.deepStrictEqual(slot.error, {reason: 'rate_limit', retry_after: 30});
	});
});

describe('AsyncSlot — preserve_error_on_retry', () => {
	test('default clears error at start of next run', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => {
			throw new Error('first');
		});
		const deferred = make_deferred<number>();
		const run_promise = slot.run(() => deferred.promise);
		assert.strictEqual(slot.error, null);
		assert.strictEqual(slot.error_data, null);
		deferred.resolve(1);
		await run_promise;
	});

	test('preserve_error_on_retry keeps prior error during pending state', async () => {
		const slot = new AsyncSlot<number>({preserve_error_on_retry: true});
		await slot.run(async () => {
			throw new Error('first');
		});
		assert.strictEqual(slot.error, 'first');
		const deferred = make_deferred<number>();
		const run_promise = slot.run(() => deferred.promise);
		assert.strictEqual(slot.error, 'first');
		assert.strictEqual(slot.status, 'pending');
		deferred.resolve(2);
		await run_promise;
		// Success clears the stale error.
		assert.strictEqual(slot.error, null);
	});

	test('preserve_error_on_retry + manual abort keeps the prior error visible', async () => {
		const slot = new AsyncSlot<number>({preserve_error_on_retry: true});
		await slot.run(async () => {
			throw new Error('first');
		});
		assert.strictEqual(slot.error, 'first');
		const run_promise = slot.run(signal_rejection<number>);
		assert.strictEqual(slot.error, 'first', 'preserved across the start of the retry');
		slot.abort();
		await run_promise;
		assert.strictEqual(slot.status, 'initial');
		assert.strictEqual(slot.error, 'first', 'abort does not clear the preserved error');
		assert.instanceOf(slot.error_data, Error);
	});
});

describe('AsyncSlot — supersession', () => {
	test('second run aborts first; only second result commits', async () => {
		const slot = new AsyncSlot<number>();
		const first = make_deferred<number>();
		const second = make_deferred<number>();
		const first_run = slot.run(() => first.promise);
		const second_run = slot.run(() => second.promise);
		// Resolve first AFTER second — first should be dropped.
		first.resolve(111);
		second.resolve(222);
		const [first_result, second_result] = await Promise.all([first_run, second_run]);
		assert.strictEqual(first_result, undefined, 'first run was superseded — returns undefined');
		assert.strictEqual(second_result, 222);
		assert.strictEqual(slot.data, 222);
		assert.strictEqual(slot.status, 'success');
	});

	test('superseded failing run does not overwrite second run pending status', async () => {
		const slot = new AsyncSlot<number>();
		const first = make_deferred<number>();
		const second = make_deferred<number>();
		const first_run = slot.run(() => first.promise);
		const second_run = slot.run(() => second.promise);
		// Reject first AFTER second has overtaken — error must not land.
		first.reject(new Error('first failed'));
		assert.strictEqual(slot.status, 'pending', 'second run keeps pending status');
		assert.strictEqual(slot.error, null);
		second.resolve(9);
		await Promise.all([first_run, second_run]);
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.error, null);
	});

	test('callback receives an AbortSignal that fires on supersession', async () => {
		const slot = new AsyncSlot<number>();
		let first_signal: AbortSignal | null = null;
		const first = make_deferred<number>();
		const first_run = slot.run((signal) => {
			first_signal = signal;
			return first.promise;
		});
		await slot.run(async () => 1);
		assert.strictEqual(first_signal!.aborted, true);
		first.resolve(0); // ignored
		await first_run;
	});
});

describe('AsyncSlot — abort()', () => {
	test('manual abort reverts pending → initial when no prior success', async () => {
		const slot = new AsyncSlot<number>();
		const run_promise = slot.run(signal_rejection<number>);
		assert.strictEqual(slot.status, 'pending');
		slot.abort();
		await run_promise;
		assert.strictEqual(slot.status, 'initial');
		assert.strictEqual(slot.error, null, 'abort does not promote to failure');
		assert.strictEqual(slot.error_data, null);
	});

	test('manual abort reverts pending → success when prior data exists', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => 5);
		const run_promise = slot.run(signal_rejection<number>);
		assert.strictEqual(slot.status, 'pending');
		slot.abort();
		await run_promise;
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.data, 5, 'prior data preserved');
		assert.strictEqual(slot.error, null);
	});

	test('manual abort reverts to success when prior run succeeded with null payload', async () => {
		const slot = new AsyncSlot<string | null>();
		await slot.run(async () => null);
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.data, null, 'null is a legitimate success value');
		const run_promise = slot.run(signal_rejection<string | null>);
		slot.abort();
		await run_promise;
		assert.strictEqual(
			slot.status,
			'success',
			'#has_succeeded tracks success independently of data sentinel',
		);
		assert.strictEqual(slot.data, null);
	});

	test('void slot: manual abort after prior success reverts to success', async () => {
		const slot = new AsyncSlot();
		await slot.run(async () => undefined);
		assert.strictEqual(slot.status, 'success');
		const run_promise = slot.run(signal_rejection<void>);
		slot.abort();
		await run_promise;
		assert.strictEqual(slot.status, 'success', 'void T success still revives via #has_succeeded');
	});

	test('callback ignoring the signal still has its result dropped after abort', async () => {
		const slot = new AsyncSlot<number>();
		const deferred = make_deferred<number>();
		const run_promise = slot.run(() => deferred.promise);
		slot.abort();
		// Callback resolves AFTER abort — both the slot's state and the
		// run()'s own promise drop the value. Abort means "I no longer
		// want this work," not "use it if it happens to land in time."
		deferred.resolve(77);
		const result = await run_promise;
		assert.strictEqual(result, undefined);
		assert.strictEqual(slot.data, undefined);
		assert.strictEqual(slot.status, 'initial');
	});
});

describe('AsyncSlot — external signal', () => {
	test('aborts the in-flight run', async () => {
		const slot = new AsyncSlot<number>();
		const ac = new AbortController();
		const run_promise = slot.run(signal_rejection<number>, {signal: ac.signal});
		ac.abort(new Error('caller cancelled'));
		await run_promise;
		assert.strictEqual(slot.status, 'initial');
		assert.strictEqual(slot.error, null);
	});

	test('pre-aborted signal aborts immediately', async () => {
		const slot = new AsyncSlot<number>();
		const ac = new AbortController();
		ac.abort();
		await slot.run(signal_rejection<number>, {signal: ac.signal});
		assert.strictEqual(slot.status, 'initial');
	});

	test('removes its abort listener on successful completion', async () => {
		const slot = new AsyncSlot<number>();
		const ac = new AbortController();
		let added = 0;
		let removed = 0;
		const original_add = ac.signal.addEventListener.bind(ac.signal);
		const original_remove = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = ((...args: Parameters<typeof original_add>) => {
			if (args[0] === 'abort') added++;
			original_add(...args);
		}) as typeof ac.signal.addEventListener;
		ac.signal.removeEventListener = ((...args: Parameters<typeof original_remove>) => {
			if (args[0] === 'abort') removed++;
			original_remove(...args);
		}) as typeof ac.signal.removeEventListener;
		await slot.run(async () => 1, {signal: ac.signal});
		assert.strictEqual(added, 1, 'one abort listener was attached');
		assert.strictEqual(removed, 1, 'and it was removed when the run completed');
	});

	test('removes its abort listener on failure', async () => {
		const slot = new AsyncSlot<number>();
		const ac = new AbortController();
		let added = 0;
		let removed = 0;
		const original_add = ac.signal.addEventListener.bind(ac.signal);
		const original_remove = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = ((...args: Parameters<typeof original_add>) => {
			if (args[0] === 'abort') added++;
			original_add(...args);
		}) as typeof ac.signal.addEventListener;
		ac.signal.removeEventListener = ((...args: Parameters<typeof original_remove>) => {
			if (args[0] === 'abort') removed++;
			original_remove(...args);
		}) as typeof ac.signal.removeEventListener;
		await slot.run(
			async () => {
				throw new Error('nope');
			},
			{signal: ac.signal},
		);
		assert.strictEqual(slot.status, 'failure');
		assert.strictEqual(added, 1);
		assert.strictEqual(removed, 1, 'failed run still cleans up its listener');
	});

	test("supersession cleans up the superseded run's external-signal listener", async () => {
		const slot = new AsyncSlot<number>();
		const ac = new AbortController();
		let added = 0;
		let removed = 0;
		const original_add = ac.signal.addEventListener.bind(ac.signal);
		const original_remove = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = ((...args: Parameters<typeof original_add>) => {
			if (args[0] === 'abort') added++;
			original_add(...args);
		}) as typeof ac.signal.addEventListener;
		ac.signal.removeEventListener = ((...args: Parameters<typeof original_remove>) => {
			if (args[0] === 'abort') removed++;
			original_remove(...args);
		}) as typeof ac.signal.removeEventListener;
		// First run holds the external signal; its callback ignores the
		// signal so it stays open until we resolve the deferred manually.
		const first = make_deferred<number>();
		const first_run = slot.run(() => first.promise, {signal: ac.signal});
		assert.strictEqual(added, 1, 'first run attached its listener');
		// Second run (no external signal) supersedes the first.
		await slot.run(async () => 2);
		// First run still pending until its deferred resolves — release it.
		first.resolve(99); // dropped on the bail-on-mismatch check
		await first_run;
		assert.strictEqual(
			removed,
			1,
			"first run's finally removes its external listener even after supersession",
		);
	});
});

describe('AsyncSlot — set() and reset()', () => {
	test('set() bypasses run() and marks success', () => {
		const slot = new AsyncSlot<number>();
		slot.set(123);
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.data, 123);
		assert.strictEqual(slot.error, null);
	});

	test('set() clears a prior error', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => {
			throw new Error('nope');
		});
		assert.strictEqual(slot.error, 'nope');
		slot.set(1);
		assert.strictEqual(slot.error, null);
		assert.strictEqual(slot.error_data, null);
		assert.strictEqual(slot.status, 'success');
	});

	test('set() aborts an in-flight run so a late callback cannot overwrite the value', async () => {
		const slot = new AsyncSlot<number>();
		const deferred = make_deferred<number>();
		let abort_fired = false;
		const run_promise = slot.run((signal) => {
			signal.addEventListener('abort', () => {
				abort_fired = true;
			});
			return deferred.promise;
		});
		assert.strictEqual(slot.status, 'pending');
		slot.set(99);
		assert.strictEqual(abort_fired, true, 'in-flight signal fires on set()');
		assert.strictEqual(slot.status, 'success');
		assert.strictEqual(slot.data, 99);
		// Callback resolves AFTER set() — its value must be dropped.
		deferred.resolve(77);
		const result = await run_promise;
		assert.strictEqual(result, undefined, 'superseded run returns undefined');
		assert.strictEqual(slot.data, 99, 'set() value preserved');
		assert.strictEqual(slot.status, 'success');
	});

	test('reset() returns to initial and aborts in-flight', async () => {
		const slot = new AsyncSlot<number>({initial: 1});
		assert.strictEqual(slot.data, 1);
		let abort_fired = false;
		const run_promise = slot.run((signal) => {
			signal.addEventListener('abort', () => {
				abort_fired = true;
			});
			return signal_rejection<number>(signal);
		});
		slot.reset();
		await run_promise;
		assert.strictEqual(abort_fired, true, 'reset() fires the in-flight signal');
		assert.strictEqual(slot.status, 'initial');
		assert.strictEqual(slot.data, undefined);
		assert.strictEqual(slot.error, null);
		assert.strictEqual(slot.error_data, null);
	});

	test('reset() clears #has_succeeded so a later abort reverts to initial, not success', async () => {
		const slot = new AsyncSlot<number>();
		await slot.run(async () => 5);
		assert.strictEqual(slot.status, 'success');
		slot.reset();
		assert.strictEqual(slot.status, 'initial');
		const run_promise = slot.run(signal_rejection<number>);
		slot.abort();
		await run_promise;
		assert.strictEqual(slot.status, 'initial', 'reset() forgot the prior success');
	});

	test('set() marks succeeded so a later aborted run reverts to success', async () => {
		const slot = new AsyncSlot<number>();
		slot.set(42);
		assert.strictEqual(slot.status, 'success');
		const run_promise = slot.run(signal_rejection<number>);
		slot.abort();
		await run_promise;
		assert.strictEqual(
			slot.status,
			'success',
			'set() counts as a prior success for the abort revert',
		);
		assert.strictEqual(slot.data, 42, 'set() value preserved across the aborted run');
	});
});
