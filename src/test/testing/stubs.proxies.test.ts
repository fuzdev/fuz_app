/**
 * Tests for the proxy stubs: `stub`, `create_throwing_stub` and `create_noop_stub`.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import {
	stub,
	stub_handler,
	stub_mw,
	create_throwing_stub,
	create_noop_stub
} from '#lib/testing/stubs.ts';

describe('stubs', () => {
	test('stub throws on property access', () => {
		assert.throws(() => stub.foo, /Throwing stub 'stub'/);
	});

	test('stub_handler returns a raw 200 text answer', () => {
		assert.deepStrictEqual(stub_handler(), {
			ok: 'raw',
			status: 200,
			headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
			body: 'stub'
		});
	});

	test('stub_mw calls next', async () => {
		let called = false;
		await stub_mw({}, () => {
			called = true;
		});
		assert.strictEqual(called, true);
	});
});

describe('create_throwing_stub', () => {
	test('throws on property access with descriptive label', () => {
		const s = create_throwing_stub('test_dep');
		assert.throws(() => s.some_method, /Throwing stub 'test_dep'.*'some_method'/);
	});

	test('allows symbol access without throwing', () => {
		const s = create_throwing_stub('test_dep');
		assert.strictEqual(s[Symbol.toPrimitive], undefined);
	});

	test('allows then access without throwing (Promise compatibility)', () => {
		const s = create_throwing_stub('test_dep');
		assert.strictEqual(s.then, undefined);
	});
});

describe('create_noop_stub', () => {
	test('returns async undefined for any method call', async () => {
		const s = create_noop_stub('test_dep');
		const result = await s.any_method();
		assert.strictEqual(result, undefined);
	});

	test('respects overrides', () => {
		const s = create_noop_stub('test_dep', { name: 'explicit' });
		assert.strictEqual(s.name, 'explicit');
	});

	test('returns different functions for different methods', async () => {
		const s = create_noop_stub('test_dep');
		const r1 = await s.method_a();
		const r2 = await s.method_b();
		assert.strictEqual(r1, undefined);
		assert.strictEqual(r2, undefined);
	});
	test('serializes to its label', () => {
		const s = create_noop_stub('test_dep');
		assert.strictEqual(JSON.stringify(s), '"[noop_stub:test_dep]"');
	});
});
