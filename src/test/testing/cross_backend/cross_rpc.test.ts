import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { cross_rpc_call } from '#lib/testing/cross_backend/cross_rpc.ts';
import type { FetchTransport } from '#lib/testing/transports/fetch_transport.ts';

/** A transport answering every request with `body` at `status`. */
const replying = (status: number, body: string): FetchTransport =>
	Object.assign(async () => new Response(body, { status }), { cookies: () => [] });

describe('cross_rpc_call', () => {
	test('reads an envelope', async () => {
		const res = await cross_rpc_call(
			replying(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })),
			'/api/rpc',
			'probe',
			{},
			{}
		);
		assert.deepEqual(res, { ok: true, result: { ok: true }, error: undefined });
	});

	test('a non-JSON reply throws with the method, the status and the body head', async () => {
		const page = '<html>' + 'x'.repeat(1000) + '</html>';
		const error = await assert_rejects(() =>
			cross_rpc_call(replying(502, page), '/api/rpc', 'probe', {}, {})
		);
		assert.include(error.message, 'probe');
		assert.include(error.message, 'status 502');
		assert.include(error.message, '<html>xxx');
		assert.notInclude(error.message, '</html>', 'only the head is quoted');
	});

	test('a JSON reply that is no object throws too', async () => {
		const error = await assert_rejects(() =>
			cross_rpc_call(replying(500, 'null'), '/api/rpc', 'probe', {}, {})
		);
		assert.include(error.message, 'status 500');
	});
});
