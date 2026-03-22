/**
 * Tests for loadable.svelte - Loadable base class with loading/error management.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {Loadable} from '$lib/ui/loadable.svelte.js';

class TestLoadable extends Loadable {
	async do_run<T>(
		fn: () => Promise<T>,
		map_error?: (e: unknown) => string,
	): Promise<T | undefined> {
		return this.run(fn, map_error);
	}
}

describe('Loadable', () => {
	test('initial state has loading false, error null, and error_data null', () => {
		const loadable = new TestLoadable();
		assert.strictEqual(loadable.loading, false);
		assert.strictEqual(loadable.error, null);
		assert.strictEqual(loadable.error_data, null);
	});

	test('run sets loading during operation', async () => {
		const loadable = new TestLoadable();
		let resolve_fn: () => void;
		const promise: Promise<void> = new Promise((resolve) => {
			resolve_fn = resolve;
		});
		const run_promise = loadable.do_run(async () => {
			await promise;
		});
		assert.strictEqual(loadable.loading, true);
		resolve_fn!();
		await run_promise;
		assert.strictEqual(loadable.loading, false);
	});

	test('run clears error before operation', async () => {
		const loadable = new TestLoadable();
		await loadable.do_run(async () => {
			throw new Error('first error');
		});
		assert.strictEqual(loadable.error, 'first error');
		let resolve_fn: () => void;
		const promise: Promise<void> = new Promise((resolve) => {
			resolve_fn = resolve;
		});
		const run_promise = loadable.do_run(async () => {
			await promise;
		});
		assert.strictEqual(loadable.error, null);
		resolve_fn!();
		await run_promise;
	});

	test('run returns result on success', async () => {
		const loadable = new TestLoadable();
		const result = await loadable.do_run(async () => 42);
		assert.strictEqual(result, 42);
	});

	test('run sets error on throw', async () => {
		const loadable = new TestLoadable();
		await loadable.do_run(async () => {
			throw new Error('something broke');
		});
		assert.strictEqual(loadable.error, 'something broke');
	});

	test('run returns undefined on throw', async () => {
		const loadable = new TestLoadable();
		// eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
		const result = await loadable.do_run(async () => {
			throw new Error('fail');
		});
		assert.strictEqual(result, undefined);
	});

	test('run sets loading false after success', async () => {
		const loadable = new TestLoadable();
		await loadable.do_run(async () => 'ok');
		assert.strictEqual(loadable.loading, false);
	});

	test('run sets loading false after error', async () => {
		const loadable = new TestLoadable();
		await loadable.do_run(async () => {
			throw new Error('fail');
		});
		assert.strictEqual(loadable.loading, false);
	});

	test('reset clears loading, error, and error_data', async () => {
		const loadable = new TestLoadable();
		await loadable.do_run(async () => {
			throw new Error('some error');
		});
		assert.strictEqual(loadable.error, 'some error');
		assert.ok(loadable.error_data instanceof Error);
		loadable.reset();
		assert.strictEqual(loadable.loading, false);
		assert.strictEqual(loadable.error, null);
		assert.strictEqual(loadable.error_data, null);
	});

	test('error_data captures the thrown Error', async () => {
		const loadable = new TestLoadable();
		const thrown = new Error('test error');
		await loadable.do_run(async () => {
			throw thrown;
		});
		assert.strictEqual(loadable.error_data, thrown);
	});

	test('error_data captures non-Error thrown values', async () => {
		const loadable = new TestLoadable();
		const thrown = {error: 'rate_limit_exceeded', retry_after: 30};
		await loadable.do_run(async () => {
			throw thrown; // eslint-disable-line @typescript-eslint/only-throw-error -- testing non-Error throw behavior
		});
		assert.strictEqual(loadable.error, 'Request failed');
		assert.strictEqual(loadable.error_data, thrown);
	});

	test('error_data is cleared at start of new run', async () => {
		const loadable = new TestLoadable();
		await loadable.do_run(async () => {
			throw new Error('first');
		});
		assert.ok(loadable.error_data !== null);
		await loadable.do_run(async () => 'ok');
		assert.strictEqual(loadable.error_data, null);
	});

	test('error_data works with map_error', async () => {
		const loadable = new TestLoadable();
		const thrown = {error: 'rate_limit_exceeded', retry_after: 30};
		await loadable.do_run(
			async () => {
				throw thrown; // eslint-disable-line @typescript-eslint/only-throw-error -- testing non-Error throw behavior
			},
			(e) => (e && typeof e === 'object' && 'error' in e ? (e as any).error : 'unknown'),
		);
		assert.strictEqual(loadable.error, 'rate_limit_exceeded');
		assert.strictEqual(loadable.error_data, thrown);
	});
});
