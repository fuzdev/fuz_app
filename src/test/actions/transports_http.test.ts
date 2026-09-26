/**
 * Tests for `FrontendHttpTransport` — the `fetch` adapter's handling of
 * JSON-RPC error bodies on non-2xx responses.
 *
 * @module
 */

import { describe, assert, test, vi, afterEach } from 'vitest';

import { FrontendHttpTransport } from '$lib/actions/transports_http.ts';
import { JSONRPC_ERROR_CODES } from '$lib/http/jsonrpc_errors.ts';
import { is_jsonrpc_error_response } from '$lib/http/jsonrpc_helpers.ts';
import type { JsonrpcRequest } from '$lib/http/jsonrpc.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

const request: JsonrpcRequest = { jsonrpc: '2.0', id: 'req-1', method: 'terminal_data_send' };

/** Stub `fetch` with one response. */
const stub_fetch = (body: string, status: number, status_text = ''): void => {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(body, { status, statusText: status_text })
	);
};

const error_body = (id: unknown, code: number, message: string, data?: unknown): string =>
	JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } });

describe('FrontendHttpTransport non-2xx responses', () => {
	test('returns the server error body as-is, keeping code, message, and data', async () => {
		stub_fetch(
			error_body('req-1', JSONRPC_ERROR_CODES.queue_overflow, 'terminal input full', {
				reason: 'full'
			}),
			429
		);
		const transport = new FrontendHttpTransport('/api/rpc');
		const response = await transport.send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.id, 'req-1');
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.queue_overflow);
		assert.strictEqual(response.error.message, 'terminal input full');
		assert.deepEqual(response.error.data, { reason: 'full' });
	});

	test('keeps a server message the status map would have lost', async () => {
		stub_fetch(
			error_body('req-1', JSONRPC_ERROR_CODES.internal_error, 'provider: invalid key'),
			500
		);
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.message, 'provider: invalid key');
	});

	test('accepts a null id (the server could not read the request id)', async () => {
		stub_fetch(error_body(null, JSONRPC_ERROR_CODES.parse_error, 'parse error'), 400);
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.parse_error);
		assert.strictEqual(response.error.message, 'parse error');
	});

	test('matches a numeric id the server echoes as a string (GET query param)', async () => {
		stub_fetch(error_body('5', JSONRPC_ERROR_CODES.not_found, 'no such thing'), 404);
		const transport = new FrontendHttpTransport('/api/rpc', undefined, () => false);
		const response = await transport.send({ jsonrpc: '2.0', id: 5, method: 'thing_get' });
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.message, 'no such thing');
		const url = vi.mocked(globalThis.fetch).mock.calls[0]![0] as string;
		assert.include(url, 'id=5');
	});

	test('synthesizes from the status when the body answers a different id', async () => {
		stub_fetch(error_body('other', JSONRPC_ERROR_CODES.forbidden, 'not yours'), 401);
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.id, 'req-1');
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.unauthenticated);
		assert.strictEqual(response.error.message, 'HTTP error: 401');
	});

	test('synthesizes from the status for a non-JSON body', async () => {
		stub_fetch('<html>bad gateway</html>', 503, 'Service Unavailable');
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.id, 'req-1');
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.service_unavailable);
		assert.strictEqual(response.error.message, 'HTTP error: 503 Service Unavailable');
	});

	test('synthesizes from the status for an empty body', async () => {
		stub_fetch('', 404);
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.not_found);
	});

	test('synthesizes from the status for a malformed error object', async () => {
		stub_fetch(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', error: { code: 'x' } }), 500);
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.internal_error);
		assert.strictEqual(response.error.message, 'HTTP error: 500');
	});

	test('DEV warns when the error code does not map to the response status', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stub_fetch(error_body('req-1', JSONRPC_ERROR_CODES.not_found, 'nope'), 500);
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok(is_jsonrpc_error_response(response));
		assert.strictEqual(response.error.code, JSONRPC_ERROR_CODES.not_found);
		assert.strictEqual(warn.mock.calls.length, 1);
	});

	test('no DEV warning when a shared status is correct for the code', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stub_fetch(error_body('req-1', JSONRPC_ERROR_CODES.queue_overflow, 'full'), 429);
		await new FrontendHttpTransport('/api/rpc').send(request);
		assert.strictEqual(warn.mock.calls.length, 0);
	});
});

describe('FrontendHttpTransport 2xx responses', () => {
	test('returns the success body', async () => {
		stub_fetch(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: { ok: 1 } }), 200);
		const response = await new FrontendHttpTransport('/api/rpc').send(request);
		assert.ok('result' in response);
		assert.deepEqual(response.result, { ok: 1 });
	});
});
