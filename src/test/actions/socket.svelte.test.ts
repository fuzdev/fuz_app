// @vitest-environment jsdom

/**
 * Tests for `FrontendWebsocketClient` — reactive WebSocket client with
 * auto-reconnect and session-revocation handling.
 *
 * Replaces `globalThis.WebSocket` with `MockWebSocket` to drive events
 * programmatically; uses fake timers for reconnect-backoff assertions.
 *
 * @module
 */

import {describe, test, assert, vi, beforeEach, afterEach} from 'vitest';

vi.mock('esm-env', () => ({BROWSER: true, DEV: true, NODE: true}));

import {
	FrontendWebsocketClient,
	DEFAULT_CLOSE_CODE,
	DEFAULT_RECONNECT_DELAY,
	DEFAULT_RECONNECT_DELAY_MAX,
	DEFAULT_BACKOFF_FACTOR,
} from '$lib/actions/socket.svelte.js';
import {WS_CLOSE_SESSION_REVOKED} from '$lib/actions/transports.js';

// --- mock WebSocket ---

type Listener = (event: any) => void;

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: Array<MockWebSocket> = [];
	static throw_on_construct = false;

	url: string;
	readyState: number = MockWebSocket.CONNECTING;
	sent: Array<string> = [];
	close_code: number | null = null;
	throw_on_close = false;

	#listeners: Map<string, Set<Listener>> = new Map();

	constructor(url: string) {
		if (MockWebSocket.throw_on_construct) {
			throw new Error('mock construct failure');
		}
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: Listener): void {
		if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
		this.#listeners.get(type)!.add(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, event: any): void {
		const handlers = this.#listeners.get(type);
		if (!handlers) return;
		for (const handler of handlers) handler(event);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code: number = DEFAULT_CLOSE_CODE): void {
		if (this.throw_on_close) throw new Error('mock close failure');
		this.close_code = code;
		this.readyState = MockWebSocket.CLOSED;
	}

	fire_open(): void {
		this.readyState = MockWebSocket.OPEN;
		this.dispatch('open', new Event('open'));
	}

	fire_close(code: number = DEFAULT_CLOSE_CODE): void {
		this.readyState = MockWebSocket.CLOSED;
		// CloseEvent isn't consistent across environments — pass a duck-typed object.
		this.dispatch('close', {code, reason: '', wasClean: code === DEFAULT_CLOSE_CODE});
	}

	fire_error(): void {
		this.dispatch('error', new Event('error'));
	}

	fire_message(data: string): void {
		this.dispatch('message', {data} as MessageEvent);
	}
}

const last_ws = (): MockWebSocket => {
	const ws = MockWebSocket.instances.at(-1);
	if (!ws) throw new Error('no WebSocket constructed');
	return ws;
};

let original_ws: typeof globalThis.WebSocket;

beforeEach(() => {
	MockWebSocket.instances = [];
	MockWebSocket.throw_on_construct = false;
	original_ws = globalThis.WebSocket;
	globalThis.WebSocket = MockWebSocket as unknown as typeof globalThis.WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = original_ws;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const TEST_URL = 'ws://localhost:1234/ws';

describe('constants', () => {
	test('default values', () => {
		assert.strictEqual(DEFAULT_CLOSE_CODE, 1000);
		assert.strictEqual(DEFAULT_RECONNECT_DELAY, 1000);
		assert.strictEqual(DEFAULT_RECONNECT_DELAY_MAX, 10000);
		assert.strictEqual(DEFAULT_BACKOFF_FACTOR, 1.5);
	});
});

describe('constructor', () => {
	test('initial state with defaults', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		assert.strictEqual(client.url, TEST_URL);
		assert.strictEqual(client.status, 'initial');
		assert.strictEqual(client.connected, false);
		assert.isNull(client.ws);
		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);
		assert.isNull(client.last_connect_time);
	});

	test('does not open socket on construction', () => {
		new FrontendWebsocketClient(TEST_URL);
		assert.strictEqual(MockWebSocket.instances.length, 0);
	});
});

describe('connect', () => {
	test('opens a WebSocket with the provided URL', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();

		assert.strictEqual(MockWebSocket.instances.length, 1);
		assert.strictEqual(last_ws().url, TEST_URL);
		assert.strictEqual(client.status, 'connecting');
		assert.strictEqual(client.ws, last_ws() as unknown as WebSocket);
	});

	test('status transitions to connected on open event', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		assert.strictEqual(client.status, 'connected');
		assert.strictEqual(client.connected, true);
		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);
		assert.ok(typeof client.last_connect_time === 'number');
	});

	test('tears down prior socket on reconnect-via-connect without closing it', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		const first = last_ws();
		const removeSpy = vi.spyOn(first, 'removeEventListener');

		client.connect();
		assert.strictEqual(MockWebSocket.instances.length, 2);
		assert.notStrictEqual(last_ws(), first);
		// #teardown without close_code only detaches listeners — old socket is GC'd, not closed
		assert.isNull(first.close_code);
		assert.ok(removeSpy.mock.calls.length >= 4, 'should remove open/close/error/message listeners');

		// messages on the old socket no longer reach the client
		const handler = vi.fn();
		client.add_message_handler(handler);
		first.fire_message('stale');
		assert.strictEqual(handler.mock.calls.length, 0);
	});

	test('constructor failure transitions to closed and schedules reconnect', () => {
		vi.useFakeTimers();
		MockWebSocket.throw_on_construct = true;
		const log = {error: vi.fn()} as any;
		const client = new FrontendWebsocketClient(TEST_URL, {log});

		client.connect();

		// ws is null, status flips past 'closed' into 'reconnecting' via #schedule_reconnect
		assert.isNull(client.ws);
		assert.strictEqual(client.status, 'reconnecting');
		assert.strictEqual(client.reconnect_count, 1);
		assert.strictEqual(log.error.mock.calls.length, 1);
	});
});

describe('disconnect', () => {
	test('closes socket with default close code and sets status', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		const ws = last_ws();

		client.disconnect();

		assert.strictEqual(ws.close_code, DEFAULT_CLOSE_CODE);
		assert.strictEqual(client.status, 'closed');
		assert.isNull(client.ws);
	});

	test('passes custom close code through', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		const ws = last_ws();

		client.disconnect(4000);
		assert.strictEqual(ws.close_code, 4000);
	});

	test('cancels pending reconnect', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006); // abnormal close -> schedules reconnect
		assert.strictEqual(client.status, 'reconnecting');

		client.disconnect();
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);

		// no new socket opened after disconnect
		assert.strictEqual(MockWebSocket.instances.length, 1);
		assert.strictEqual(client.status, 'closed');
	});

	test('safe when no socket open', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		assert.doesNotThrow(() => client.disconnect());
		assert.strictEqual(client.status, 'closed');
	});
});

describe('send', () => {
	test('returns false when not connected', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		assert.strictEqual(client.send({hello: 'world'}), false);

		client.connect(); // status 'connecting', not 'connected'
		assert.strictEqual(client.send({hello: 'world'}), false);
	});

	test('serializes and forwards payload when connected', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const result = client.send({jsonrpc: '2.0', method: 'ping'});
		assert.strictEqual(result, true);
		assert.deepStrictEqual(last_ws().sent, [JSON.stringify({jsonrpc: '2.0', method: 'ping'})]);
	});

	test('returns false and logs when underlying send throws', () => {
		const log = {error: vi.fn()} as any;
		const client = new FrontendWebsocketClient(TEST_URL, {log});
		client.connect();
		last_ws().fire_open();

		vi.spyOn(last_ws(), 'send').mockImplementation(() => {
			throw new Error('boom');
		});

		const result = client.send({x: 1});
		assert.strictEqual(result, false);
		assert.strictEqual(log.error.mock.calls.length, 1);
	});
});

describe('message handlers', () => {
	test('add_message_handler receives parsed events', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();

		const received: Array<string> = [];
		client.add_message_handler((event) => received.push(event.data as string));

		last_ws().fire_message('hello');
		last_ws().fire_message('world');

		assert.deepStrictEqual(received, ['hello', 'world']);
	});

	test('unsubscribe stops delivery', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();

		const received: Array<string> = [];
		const off = client.add_message_handler((event) => received.push(event.data as string));

		last_ws().fire_message('first');
		off();
		last_ws().fire_message('second');

		assert.deepStrictEqual(received, ['first']);
	});

	test('multiple handlers all fire', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();

		const a = vi.fn();
		const b = vi.fn();
		client.add_message_handler(a);
		client.add_message_handler(b);

		last_ws().fire_message('x');
		assert.strictEqual(a.mock.calls.length, 1);
		assert.strictEqual(b.mock.calls.length, 1);
	});
});

describe('error handlers', () => {
	test('add_error_handler receives error events', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();

		const handler = vi.fn();
		client.add_error_handler(handler);

		last_ws().fire_error();
		assert.strictEqual(handler.mock.calls.length, 1);
	});

	test('unsubscribe stops delivery', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();

		const handler = vi.fn();
		const off = client.add_error_handler(handler);

		last_ws().fire_error();
		off();
		last_ws().fire_error();

		assert.strictEqual(handler.mock.calls.length, 1);
	});

	test('logs error when a logger is provided', () => {
		const log = {error: vi.fn()} as any;
		const client = new FrontendWebsocketClient(TEST_URL, {log});
		client.connect();

		last_ws().fire_error();
		assert.strictEqual(log.error.mock.calls.length, 1);
	});
});

describe('auto-reconnect', () => {
	test('abnormal close schedules reconnect with base delay', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006);

		assert.strictEqual(client.status, 'reconnecting');
		assert.strictEqual(client.reconnect_count, 1);
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		assert.strictEqual(MockWebSocket.instances.length, 2);
		assert.strictEqual(client.status, 'connecting');
	});

	test('exponential backoff increments delay', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		last_ws().fire_close(1006);
		// delay = 1000 * 1.5^1 = 1500
		assert.strictEqual(client.current_reconnect_delay, 1500);

		vi.advanceTimersByTime(1500);
		last_ws().fire_close(1006);
		// delay = round(1000 * 1.5^2) = 2250
		assert.strictEqual(client.current_reconnect_delay, 2250);
	});

	test('caps at reconnect_delay_max', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			reconnect_delay: 1000,
			reconnect_delay_max: 3000,
			backoff_factor: 10,
		});
		client.connect();

		last_ws().fire_close(1006);
		assert.strictEqual(client.current_reconnect_delay, 1000);
		vi.advanceTimersByTime(1000);

		last_ws().fire_close(1006);
		// 1000 * 10^1 = 10000, capped at 3000
		assert.strictEqual(client.current_reconnect_delay, 3000);
	});

	test('successful reconnect resets the counter', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.reconnect_count, 1);

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		last_ws().fire_open();

		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);
		assert.strictEqual(client.status, 'connected');
	});

	test('auto_reconnect:false skips reconnect scheduling', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {auto_reconnect: false});
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006);

		assert.strictEqual(client.status, 'closed');
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(MockWebSocket.instances.length, 1);
	});
});

describe('session revocation', () => {
	test('WS_CLOSE_SESSION_REVOKED prevents reconnect permanently', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.status, 'closed');
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(MockWebSocket.instances.length, 1);
	});

	test('subsequent connect() is a no-op after revocation', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);

		client.connect();
		assert.strictEqual(MockWebSocket.instances.length, 1);
		assert.strictEqual(client.status, 'closed');
	});
});

describe('connected derived property', () => {
	test('reflects status === connected', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		assert.strictEqual(client.connected, false);

		client.connect();
		assert.strictEqual(client.connected, false);

		last_ws().fire_open();
		assert.strictEqual(client.connected, true);

		client.disconnect();
		assert.strictEqual(client.connected, false);
	});
});
