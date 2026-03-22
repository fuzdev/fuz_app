/**
 * Tests for ui_fetch - authenticated fetch helper.
 *
 * @module
 */

import {describe, assert, test, vi} from 'vitest';

import {ui_fetch} from '$lib/ui/ui_fetch.js';

describe('ui_fetch', () => {
	test('sets credentials to include', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
		await ui_fetch('/api/test');
		assert.strictEqual(spy.mock.calls.length, 1);
		const call = spy.mock.calls[0]!;
		const init = call[1]!;
		assert.strictEqual(init.credentials, 'include');
		spy.mockRestore();
	});

	test('merges provided init options', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
		await ui_fetch('/api/test', {method: 'POST', headers: {'X-Custom': 'value'}});
		const call = spy.mock.calls[0]!;
		const init = call[1]!;
		assert.strictEqual(call[0], '/api/test');
		assert.strictEqual(init.method, 'POST');
		assert.strictEqual(init.credentials, 'include');
		assert.strictEqual((init as any).headers['X-Custom'], 'value');
		spy.mockRestore();
	});

	test('does not clobber other init properties', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
		const signal = AbortSignal.timeout(5000);
		await ui_fetch('/api/test', {signal});
		const call = spy.mock.calls[0]!;
		const init = call[1]!;
		assert.strictEqual(init.signal, signal);
		assert.strictEqual(init.credentials, 'include');
		spy.mockRestore();
	});
});
