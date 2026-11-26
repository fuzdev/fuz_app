// @vitest-environment jsdom

/**
 * Tests for `testing/mock_websocket.ts`. `FrontendWebsocketClient` runs over it
 * in `src/test/actions/socket.svelte.test.ts`; this pins the install itself.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { install_mock_websocket, MockWebSocket } from '#lib/testing/mock_websocket.ts';

describe('install_mock_websocket', () => {
	test('records each socket constructed, and restore puts the original back', () => {
		const original = globalThis.WebSocket;
		const install = install_mock_websocket();
		try {
			assert.throws(() => install.last(), /no WebSocket constructed/);
			const ws = new WebSocket('ws://a.fuz.dev/ws');
			assert.ok(ws instanceof MockWebSocket);
			assert.strictEqual(install.last(), ws);
			assert.strictEqual(install.instances.length, 1);
			assert.strictEqual(WebSocket.OPEN, 1);
			install.throw_on_construct = true;
			assert.throws(() => new WebSocket('ws://a.fuz.dev/ws'), /construct failure/);
			assert.strictEqual(install.instances.length, 1);
		} finally {
			install.restore();
		}
		assert.strictEqual(globalThis.WebSocket, original);
	});

	test('each install records its own sockets', () => {
		const first = install_mock_websocket();
		assert.ok(new WebSocket('ws://a.fuz.dev/ws'));
		first.restore();
		const second = install_mock_websocket();
		try {
			assert.strictEqual(second.instances.length, 0);
		} finally {
			second.restore();
		}
	});
});

describe('MockWebSocket', () => {
	test('the test plays the server; close() fires no close event', () => {
		const ws = new MockWebSocket('ws://a.fuz.dev/ws');
		const events: Array<string> = [];
		const on_message = (e: MessageEvent) => events.push(`message ${e.data}`);
		ws.addEventListener('open', () => events.push('open'));
		ws.addEventListener('message', on_message);
		ws.addEventListener('close', (e: CloseEvent) => events.push(`close ${e.code} ${e.reason}`));
		ws.fire_open();
		assert.strictEqual(ws.readyState, MockWebSocket.OPEN);
		ws.send('hi');
		ws.fire_message('yo');
		ws.removeEventListener('message', on_message);
		ws.fire_message('unheard');
		ws.close(4000, 'bye');
		assert.strictEqual(ws.close_code, 4000);
		assert.strictEqual(ws.close_reason, 'bye');
		assert.strictEqual(ws.readyState, MockWebSocket.CLOSING, 'closing until the close event');
		ws.fire_close(4001, 'revoked');
		assert.strictEqual(ws.readyState, MockWebSocket.CLOSED);
		assert.deepEqual(ws.sent, ['hi']);
		assert.deepEqual(events, ['open', 'message yo', 'close 4001 revoked']);
	});

	test('close() without a reason records an empty one', () => {
		const ws = new MockWebSocket('ws://a.fuz.dev/ws');
		assert.strictEqual(ws.close_reason, null);
		ws.close();
		assert.strictEqual(ws.close_code, 1000);
		assert.strictEqual(ws.close_reason, '');
	});

	test('a close code a browser refuses throws InvalidAccessError and closes nothing', () => {
		for (const code of [1001, 1006, 2999, 5000]) {
			const ws = new MockWebSocket('ws://a.fuz.dev/ws');
			ws.fire_open();
			try {
				ws.close(code);
				assert.fail(`expected close(${code}) to throw`);
			} catch (error) {
				assert.ok(error instanceof DOMException, String(error));
				assert.strictEqual(error.name, 'InvalidAccessError');
			}
			assert.strictEqual(ws.readyState, MockWebSocket.OPEN);
			assert.strictEqual(ws.close_code, null);
		}
		for (const code of [1000, 3000, 4999]) {
			new MockWebSocket('ws://a.fuz.dev/ws').close(code);
		}
	});

	test('close_throws makes close throw', () => {
		const ws = new MockWebSocket('ws://a.fuz.dev/ws');
		ws.close_throws = true;
		assert.throws(() => ws.close(), /close failure/);
	});
});
