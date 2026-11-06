/**
 * Tests for ui_fetch - authenticated fetch helper.
 *
 * @module
 */

import { describe, assert, test, vi } from 'vitest';

import { ui_fetch, parse_response_error, format_error_body } from '#lib/ui/ui_fetch.ts';

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
		await ui_fetch('/api/test', { method: 'POST', headers: { 'X-Custom': 'value' } });
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
		await ui_fetch('/api/test', { signal });
		const call = spy.mock.calls[0]!;
		const init = call[1]!;
		assert.strictEqual(init.signal, signal);
		assert.strictEqual(init.credentials, 'include');
		spy.mockRestore();
	});
});

describe('parse_response_error', () => {
	test('extracts error field from JSON response', async () => {
		const response = new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
		const result = await parse_response_error(response);
		assert.strictEqual(result, 'unauthorized');
	});

	test('prefers the message to the error code', async () => {
		const response = new Response(
			JSON.stringify({ error: 'file_not_found', message: 'No file at that path.' }),
			{ status: 404 }
		);
		assert.strictEqual(await parse_response_error(response), 'No file at that path.');
	});

	test('reads a message with no error code', async () => {
		const response = new Response(JSON.stringify({ message: 'oops' }), { status: 500 });
		assert.strictEqual(await parse_response_error(response, 'Something went wrong'), 'oops');
	});

	test('an empty or non-string message falls back to the code', async () => {
		for (const message of ['', 42, null]) {
			const response = new Response(JSON.stringify({ error: 'conflict', message }), {
				status: 409
			});
			assert.strictEqual(await parse_response_error(response), 'conflict');
		}
	});

	test('uses fallback when JSON has neither message nor error', async () => {
		const response = new Response(JSON.stringify({ detail: 'oops' }), { status: 500 });
		assert.strictEqual(
			await parse_response_error(response, 'Something went wrong'),
			'Something went wrong'
		);
		const bare = new Response(JSON.stringify({ detail: 'oops' }), { status: 500 });
		assert.strictEqual(await parse_response_error(bare), 'Error: 500');
	});

	test('uses fallback for non-JSON response body', async () => {
		const response = new Response('<html>404 Not Found</html>', {
			status: 404,
			headers: { 'Content-Type': 'text/html' }
		});
		const result = await parse_response_error(response, 'Not found');
		assert.strictEqual(result, 'Not found');
	});

	test('uses default message for non-JSON response without fallback', async () => {
		const response = new Response('<html>500</html>', {
			status: 500,
			headers: { 'Content-Type': 'text/html' }
		});
		const result = await parse_response_error(response);
		assert.strictEqual(result, 'Error: 500');
	});

	test('uses fallback when error field is not a string', async () => {
		const response = new Response(JSON.stringify({ error: 42 }), { status: 400 });
		const result = await parse_response_error(response, 'Bad request');
		assert.strictEqual(result, 'Bad request');
	});
});

describe('format_error_body', () => {
	test('the message, else the code, else the fallback', () => {
		assert.strictEqual(format_error_body({ error: 'a_code', message: 'Prose.' }, 'f'), 'Prose.');
		assert.strictEqual(format_error_body({ error: 'a_code' }, 'f'), 'a_code');
		assert.strictEqual(format_error_body({ error: '', message: '' }, 'f'), 'f');
		assert.strictEqual(format_error_body({ error: 1 }, 'f'), 'f');
	});

	test('a body that is no object is the fallback', () => {
		for (const body of [null, undefined, 'text', 3, ['error']]) {
			assert.strictEqual(format_error_body(body, 'f'), 'f');
		}
	});
});
