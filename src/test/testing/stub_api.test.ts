/**
 * Tests for `testing/stub_api.ts` — the throwing-API stub and the refusal it
 * rejects with, held to what `create_throwing_api` throws.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_throwing_api } from '#lib/actions/rpc_client.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import { create_stub_api, rpc_error } from '#lib/testing/stub_api.ts';

interface Api {
	thing_get: (input: { id: string }) => Promise<{ name: string }>;
	thing_delete: (input: { id: string }) => Promise<void>;
}

describe('create_stub_api', () => {
	test('a stubbed method answers as given', async () => {
		const api = create_stub_api<Api>({ thing_get: async ({ id }) => ({ name: id }) });
		assert.deepEqual(await api.thing_get({ id: 'a' }), { name: 'a' });
	});

	test('an unstubbed method throws naming itself', () => {
		const api = create_stub_api<Api>({});
		assert.throws(() => api.thing_delete({ id: 'a' }), /unexpected call to 'thing_delete'/);
	});

	test('reads no then, so awaiting the stub is no call', async () => {
		const api = create_stub_api<Api>({});
		assert.strictEqual((api as unknown as { then?: unknown }).then, undefined);
		assert.strictEqual(await Promise.resolve(api), api);
	});

	test('reads no toJSON, so serializing the stub serializes its methods', () => {
		const api = create_stub_api<Api>({});
		assert.strictEqual((api as unknown as { toJSON?: unknown }).toJSON, undefined);
		assert.strictEqual(JSON.stringify(api), '{}');
	});
});

describe('rpc_error', () => {
	test('carries the reason as data and message, forbidden by default', () => {
		const err = rpc_error('thing_locked');
		assert.ok(err instanceof Error);
		assert.strictEqual(err.message, 'thing_locked');
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.forbidden);
		assert.deepEqual(err.data, { reason: 'thing_locked' });
		assert.strictEqual(rpc_error('gone', JSONRPC_ERROR_CODES.not_found).code, -32003);
	});

	test('is shaped as the throwing api throws a refusal', async () => {
		const error = {
			code: JSONRPC_ERROR_CODES.forbidden,
			message: 'thing_locked',
			data: { reason: 'thing_locked' }
		};
		const api = create_throwing_api({ thing_get: async () => ({ ok: false, error }) });
		const thrown = await assert_rejects(() => api.thing_get());
		const stubbed = rpc_error('thing_locked');
		assert.deepEqual(Object.entries(thrown), Object.entries(stubbed));
		assert.strictEqual(thrown.message, stubbed.message);
	});
});
