/**
 * The Bun test-server adapter threads the endpoint's `max_message_bytes` into
 * `Bun.serve`'s `websocket.maxPayloadLength` at twice the limit — headroom so
 * a message just over the limit reaches the per-message check's 1009 (Bun
 * drops a socket past its own cap with 1006), while a grossly oversized one is
 * refused before Bun buffers it toward its 16 MiB default.
 *
 * @module
 */

import { afterAll, assert, beforeEach, test } from 'vitest';

import { DEFAULT_WS_MAX_MESSAGE_BYTES } from '$lib/actions/transports.ts';

interface ServeOptions {
	websocket?: { maxPayloadLength?: number };
}

// `@hono/bun` reads the `Bun` global at module scope, so the fake goes in
// before the adapter module loads
let calls: Array<ServeOptions> = [];
(globalThis as { Bun?: unknown }).Bun = {
	serve: (options: ServeOptions) => {
		calls.push(options);
		return { stop: () => undefined };
	}
};
const { create_bun_testing_adapter } =
	await import('$lib/testing/cross_backend/testing_server_bun.ts');

beforeEach(() => {
	calls = [];
});

afterAll(() => {
	delete (globalThis as { Bun?: unknown }).Bun;
});

const serve = (adapter: ReturnType<typeof create_bun_testing_adapter>) =>
	adapter.serve({ fetch: () => new Response(), port: 0, hostname: '127.0.0.1' });

test('maxPayloadLength is twice the prepared max_message_bytes', () => {
	const adapter = create_bun_testing_adapter();
	adapter.prepare_websocket({ max_message_bytes: 1000 });
	serve(adapter);
	assert.strictEqual(calls[0]?.websocket?.maxPayloadLength, 2000);
});

test('maxPayloadLength defaults to twice DEFAULT_WS_MAX_MESSAGE_BYTES', () => {
	const adapter = create_bun_testing_adapter();
	// an HTTP-only build never prepares — the default cap still applies
	serve(adapter);
	assert.strictEqual(calls[0]?.websocket?.maxPayloadLength, 2 * DEFAULT_WS_MAX_MESSAGE_BYTES);
});
