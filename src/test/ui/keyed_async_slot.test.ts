/**
 * Tests for `KeyedAsyncSlot` — keyed sibling of `AsyncSlot`.
 *
 * Coverage focuses on the load-bearing behaviors the keyed shape adds
 * on top of `AsyncSlot`:
 *
 * - Cross-key independence: a `run()` on key B does NOT abort an
 *   in-flight `run()` on key A.
 * - Per-key supersession matches the unkeyed semantics: a second
 *   `run(key, ...)` aborts the first's signal AND drops its commit.
 * - Lazy slot creation: `loading(absent_key)` reports `false`; the
 *   entry appears only after the first `run()` for that key.
 * - Resolved entries persist (no auto-cleanup) so per-row error UI
 *   can read `error(key)` after the run completes.
 * - `delete(key)` aborts + removes; `reset()` clears everything;
 *   `abort_all` aborts in-flight without removing entries.
 * - Options propagate to every child slot (`map_error`,
 *   `preserve_error_on_retry`).
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {KeyedAsyncSlot} from '$lib/ui/keyed_async_slot.svelte.ts';
import {make_deferred, signal_rejection} from './async_test_helpers.ts';

describe('KeyedAsyncSlot — empty state', () => {
	test('size is 0; absent keys return safe defaults', () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		assert.strictEqual(keyed.size, 0);
		assert.strictEqual(keyed.has('a'), false);
		assert.strictEqual(keyed.get('a'), undefined);
		assert.strictEqual(keyed.loading('a'), false);
		assert.strictEqual(keyed.error('a'), null);
		assert.strictEqual(keyed.failed('a'), false);
		assert.strictEqual(keyed.succeeded('a'), false);
	});
});

describe('KeyedAsyncSlot — run() basic path', () => {
	test('creates a child slot on first run; entry persists after success', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		const result = await keyed.run('a', async () => 7);
		assert.strictEqual(result, 7);
		assert.strictEqual(keyed.has('a'), true);
		assert.strictEqual(keyed.size, 1);
		assert.strictEqual(keyed.succeeded('a'), true);
		assert.strictEqual(keyed.loading('a'), false);
		assert.strictEqual(keyed.get('a')?.data, 7);
	});

	test('per-key loading flips during the run', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		const deferred = make_deferred<number>();
		const run_promise = keyed.run('a', () => deferred.promise);
		assert.strictEqual(keyed.loading('a'), true);
		assert.strictEqual(keyed.loading('b'), false, 'other keys unaffected');
		deferred.resolve(1);
		await run_promise;
		assert.strictEqual(keyed.loading('a'), false);
	});

	test('per-key error surfaces only for the failing key', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		await keyed.run('a', async () => {
			throw new Error('a-boom');
		});
		await keyed.run('b', async () => 2);
		assert.strictEqual(keyed.error('a'), 'a-boom');
		assert.strictEqual(keyed.failed('a'), true);
		assert.strictEqual(keyed.error('b'), null);
		assert.strictEqual(keyed.succeeded('b'), true);
	});

	test('reuses the child slot across runs for the same key', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		await keyed.run('a', async () => 1);
		const first_slot = keyed.get('a');
		await keyed.run('a', async () => 2);
		assert.strictEqual(keyed.get('a'), first_slot, 'same slot instance reused');
		assert.strictEqual(first_slot!.data, 2);
		assert.strictEqual(keyed.size, 1);
	});
});

describe('KeyedAsyncSlot — cross-key independence', () => {
	test('run(b) does NOT abort an in-flight run(a)', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		let a_signal: AbortSignal | null = null;
		const a_deferred = make_deferred<number>();
		const a_run = keyed.run('a', (signal) => {
			a_signal = signal;
			return a_deferred.promise;
		});
		// Second run on a different key while 'a' is still in flight.
		await keyed.run('b', async () => 22);
		assert.strictEqual(a_signal!.aborted, false, "'a' was not aborted by 'b'");
		assert.strictEqual(keyed.loading('a'), true);
		a_deferred.resolve(11);
		const a_result = await a_run;
		assert.strictEqual(a_result, 11, "'a' run committed independently");
		assert.strictEqual(keyed.get('a')?.data, 11);
		assert.strictEqual(keyed.get('b')?.data, 22);
	});

	test('two concurrent runs on different keys both commit their results', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		const a = make_deferred<number>();
		const b = make_deferred<number>();
		const a_run = keyed.run('a', () => a.promise);
		const b_run = keyed.run('b', () => b.promise);
		// Resolve out of order to make sure each key tracks its own commit.
		b.resolve(200);
		a.resolve(100);
		const [a_result, b_result] = await Promise.all([a_run, b_run]);
		assert.strictEqual(a_result, 100);
		assert.strictEqual(b_result, 200);
		assert.strictEqual(keyed.get('a')?.data, 100);
		assert.strictEqual(keyed.get('b')?.data, 200);
	});

	test('failure on one key leaves another key successful', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		await Promise.all([
			keyed.run('a', async () => 1),
			keyed.run('b', async () => {
				throw new Error('b-failed');
			}),
		]);
		assert.strictEqual(keyed.succeeded('a'), true);
		assert.strictEqual(keyed.failed('b'), true);
		assert.strictEqual(keyed.error('a'), null);
		assert.strictEqual(keyed.error('b'), 'b-failed');
	});
});

describe('KeyedAsyncSlot — per-key supersession', () => {
	test('second run on same key aborts first; only second result commits', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		const first = make_deferred<number>();
		const second = make_deferred<number>();
		const first_run = keyed.run('a', () => first.promise);
		const second_run = keyed.run('a', () => second.promise);
		first.resolve(111); // dropped on bail-on-mismatch
		second.resolve(222);
		const [first_result, second_result] = await Promise.all([first_run, second_run]);
		assert.strictEqual(first_result, undefined);
		assert.strictEqual(second_result, 222);
		assert.strictEqual(keyed.get('a')?.data, 222);
	});

	test('superseded run on same key receives an aborted signal', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		let first_signal: AbortSignal | null = null;
		const first = make_deferred<number>();
		const first_run = keyed.run('a', (signal) => {
			first_signal = signal;
			return first.promise;
		});
		await keyed.run('a', async () => 9);
		assert.strictEqual(first_signal!.aborted, true);
		first.resolve(0);
		await first_run;
	});
});

describe('KeyedAsyncSlot — abort / abort_all', () => {
	test('abort(key) reverts to initial when no prior success', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		const run_promise = keyed.run('a', signal_rejection<number>);
		keyed.abort('a');
		await run_promise;
		assert.strictEqual(keyed.get('a')?.status, 'initial');
		assert.strictEqual(keyed.error('a'), null);
		assert.strictEqual(keyed.has('a'), true, 'entry persists; only the slot reverted');
	});

	test('abort(key) reverts to success when prior data exists', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		await keyed.run('a', async () => 5);
		const run_promise = keyed.run('a', signal_rejection<number>);
		keyed.abort('a');
		await run_promise;
		assert.strictEqual(keyed.succeeded('a'), true);
		assert.strictEqual(keyed.get('a')?.data, 5);
	});

	test('abort(key) is a no-op for absent keys', () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		keyed.abort('never-used'); // must not throw
		assert.strictEqual(keyed.size, 0);
	});

	test('abort_all aborts every in-flight run but preserves entries', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		const a = make_deferred<number>();
		const b = make_deferred<number>();
		const a_run = keyed.run('a', () => a.promise);
		const b_run = keyed.run('b', () => b.promise);
		keyed.abort_all();
		a.resolve(0);
		b.resolve(0);
		await Promise.all([a_run, b_run]);
		assert.strictEqual(keyed.size, 2, 'abort_all does NOT remove entries');
		assert.strictEqual(keyed.loading('a'), false);
		assert.strictEqual(keyed.loading('b'), false);
		assert.strictEqual(keyed.get('a')?.status, 'initial');
		assert.strictEqual(keyed.get('b')?.status, 'initial');
	});
});

describe('KeyedAsyncSlot — delete / reset', () => {
	test('delete(key) aborts + removes; subsequent reads see no entry', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		await keyed.run('a', async () => 1);
		const deleted = keyed.delete('a');
		assert.strictEqual(deleted, true);
		assert.strictEqual(keyed.has('a'), false);
		assert.strictEqual(keyed.get('a'), undefined);
		assert.strictEqual(keyed.error('a'), null);
		assert.strictEqual(keyed.size, 0);
	});

	test('delete(key) on an in-flight run aborts it', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		let aborted = false;
		const deferred = make_deferred<number>();
		const run_promise = keyed.run('a', (signal) => {
			signal.addEventListener('abort', () => {
				aborted = true;
			});
			return deferred.promise;
		});
		keyed.delete('a');
		assert.strictEqual(aborted, true);
		deferred.resolve(99);
		const result = await run_promise;
		assert.strictEqual(result, undefined);
		assert.strictEqual(keyed.has('a'), false);
	});

	test('delete(key) returns false when the key has no entry', () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		assert.strictEqual(keyed.delete('never-used'), false);
	});

	test('reset() aborts every in-flight run and clears the map', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		const a = make_deferred<number>();
		const a_run = keyed.run('a', () => a.promise);
		await keyed.run('b', async () => 1);
		keyed.reset();
		a.resolve(0);
		await a_run;
		assert.strictEqual(keyed.size, 0);
		assert.strictEqual(keyed.has('a'), false);
		assert.strictEqual(keyed.has('b'), false);
	});
});

describe('KeyedAsyncSlot — iteration', () => {
	test('keys / values / entries iterate every entry', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		await keyed.run('a', async () => 1);
		await keyed.run('b', async () => 2);
		const keys = [...keyed.keys()].sort();
		assert.deepStrictEqual(keys, ['a', 'b']);
		const values = [...keyed.values()].map((slot) => slot.data).sort((a, b) => a! - b!);
		assert.deepStrictEqual(values, [1, 2]);
		const entries = [...keyed.entries()].sort(([a], [b]) => a.localeCompare(b));
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0]![0], 'a');
		assert.strictEqual(entries[0]![1].data, 1);
	});
});

describe('KeyedAsyncSlot — options propagation', () => {
	test('map_error applies to every child slot', async () => {
		interface RpcError {
			reason: string;
		}
		const keyed = new KeyedAsyncSlot<string, number, RpcError>({
			map_error: (e) => {
				if (e && typeof e === 'object' && 'reason' in e) return e as RpcError;
				return {reason: 'unknown'};
			},
		});
		await keyed.run('a', async () => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- structured throw
			throw {reason: 'rate_limit'};
		});
		await keyed.run('b', async () => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- structured throw
			throw {reason: 'forbidden'};
		});
		assert.deepStrictEqual(keyed.error('a'), {reason: 'rate_limit'});
		assert.deepStrictEqual(keyed.error('b'), {reason: 'forbidden'});
	});

	test('preserve_error_on_retry applies to every child slot', async () => {
		const keyed = new KeyedAsyncSlot<string, number>({preserve_error_on_retry: true});
		await keyed.run('a', async () => {
			throw new Error('first');
		});
		assert.strictEqual(keyed.error('a'), 'first');
		const deferred = make_deferred<number>();
		const retry = keyed.run('a', () => deferred.promise);
		assert.strictEqual(keyed.error('a'), 'first', 'preserved across the start of retry');
		assert.strictEqual(keyed.loading('a'), true);
		deferred.resolve(2);
		await retry;
		assert.strictEqual(keyed.error('a'), null, 'success clears the preserved error');
	});
});

describe('KeyedAsyncSlot — generic key types', () => {
	test('works with branded-string keys (SameValueZero identity)', async () => {
		type Uuid = string & {__brand: 'Uuid'};
		const a = 'aaa' as Uuid;
		const b = 'bbb' as Uuid;
		const keyed = new KeyedAsyncSlot<Uuid, number>();
		await keyed.run(a, async () => 1);
		await keyed.run(b, async () => 2);
		assert.strictEqual(keyed.get(a)?.data, 1);
		assert.strictEqual(keyed.get(b)?.data, 2);
		assert.strictEqual(keyed.size, 2);
	});

	test('works with composite string keys', async () => {
		const keyed = new KeyedAsyncSlot<string, number>();
		await keyed.run('acct-1:admin', async () => 1);
		await keyed.run('acct-1:admin:actor-9', async () => 2);
		assert.strictEqual(keyed.size, 2, 'distinct composite keys are distinct');
		assert.strictEqual(keyed.get('acct-1:admin')?.data, 1);
		assert.strictEqual(keyed.get('acct-1:admin:actor-9')?.data, 2);
	});
});
