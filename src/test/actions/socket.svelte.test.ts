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
	close_throws = false;

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
		if (this.close_throws) throw new Error('mock close failure');
		this.close_code = code;
		this.readyState = MockWebSocket.CLOSED;
	}

	fire_open(): void {
		this.readyState = MockWebSocket.OPEN;
		this.dispatch('open', new Event('open'));
	}

	fire_close(code: number = DEFAULT_CLOSE_CODE, reason: string = ''): void {
		this.readyState = MockWebSocket.CLOSED;
		// CloseEvent isn't consistent across environments — pass a duck-typed object.
		this.dispatch('close', {code, reason, wasClean: code === DEFAULT_CLOSE_CODE});
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
		assert.strictEqual(client.revoked, false);
		assert.isNull(client.ws);
		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);
		assert.isNull(client.last_connect_time);
		assert.isNull(client.last_close_time);
		assert.isNull(client.last_close_code);
		assert.isNull(client.last_close_reason);
	});

	test('reconnect: true uses defaults (same as omitting)', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: true});
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);
	});

	test('does not open socket on construction', () => {
		// eslint-disable-next-line no-new
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

	test('closes prior socket on reconnect-via-connect', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		const first = last_ws();
		const removeSpy = vi.spyOn(first, 'removeEventListener');

		client.connect();
		assert.strictEqual(MockWebSocket.instances.length, 2);
		assert.notStrictEqual(last_ws(), first);
		// prior live socket is closed with normal-closure to prevent a leak
		assert.strictEqual(first.close_code, DEFAULT_CLOSE_CODE);
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
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);
		assert.strictEqual(log.error.mock.calls.length, 1);

		// recover on next timer tick
		MockWebSocket.throw_on_construct = false;
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		assert.strictEqual(MockWebSocket.instances.length, 1);
		assert.strictEqual(client.status, 'connecting');
	});

	test('repeated construct failures grow the backoff', () => {
		vi.useFakeTimers();
		MockWebSocket.throw_on_construct = true;
		const log = {error: vi.fn()} as any;
		const client = new FrontendWebsocketClient(TEST_URL, {log});

		// attempt 1
		client.connect();
		assert.strictEqual(client.reconnect_count, 1);
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);

		// attempt 2 — the scheduled timer fires, construct throws again, next backoff
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		assert.strictEqual(client.reconnect_count, 2);
		assert.strictEqual(
			client.current_reconnect_delay,
			Math.round(DEFAULT_RECONNECT_DELAY * DEFAULT_BACKOFF_FACTOR),
		);

		// attempt 3 — advance by the current delay (not the base), count bumps again
		vi.advanceTimersByTime(client.current_reconnect_delay);
		assert.strictEqual(client.reconnect_count, 3);
		assert.strictEqual(
			client.current_reconnect_delay,
			Math.round(DEFAULT_RECONNECT_DELAY * DEFAULT_BACKOFF_FACTOR ** 2),
		);

		// still no sockets constructed (all throws)
		assert.strictEqual(MockWebSocket.instances.length, 0);
		assert.strictEqual(log.error.mock.calls.length, 3);
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

	test('closes a still-CONNECTING socket', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		assert.strictEqual(last_ws().readyState, MockWebSocket.CONNECTING);
		const ws = last_ws();

		client.disconnect();
		assert.strictEqual(ws.close_code, DEFAULT_CLOSE_CODE);
	});

	test('is idempotent', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		client.disconnect();
		assert.doesNotThrow(() => client.disconnect());
		assert.strictEqual(client.status, 'closed');
	});

	test('is a no-op after a server-initiated close', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		const ws = last_ws();
		ws.fire_open();
		// server-fire path nulls client.ws without calling ws.close()
		ws.fire_close(1006);
		assert.isNull(ws.close_code);

		// subsequent disconnect has no ws to act on; must stay a safe no-op
		client.disconnect();
		assert.isNull(ws.close_code);
	});

	test('logs and swallows errors thrown by underlying close()', () => {
		const log = {error: vi.fn()} as any;
		const client = new FrontendWebsocketClient(TEST_URL, {log});
		client.connect();
		last_ws().fire_open();
		last_ws().close_throws = true;

		assert.doesNotThrow(() => client.disconnect());
		assert.strictEqual(log.error.mock.calls.length, 1);
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

	test('returns false after disconnect', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		client.disconnect();

		assert.strictEqual(client.send({x: 1}), false);
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

	test('error alone does not change status or schedule reconnect', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		last_ws().fire_error();
		// per source comment: browsers fire `close` after error; reconnect lives there
		assert.strictEqual(client.status, 'connected');
		assert.strictEqual(client.reconnect_count, 0);
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(MockWebSocket.instances.length, 1);
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

	test('caps at reconnect delay_max', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			reconnect: {delay: 1000, delay_max: 3000, factor: 10},
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

	test('reconnect:false skips reconnect scheduling', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: false});
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006);

		assert.strictEqual(client.status, 'closed');
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(MockWebSocket.instances.length, 1);
	});

	test('reconnect config overrides individual fields', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: {delay: 500}});
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.current_reconnect_delay, 500);
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

	test('revocation during reconnect loop cancels it', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');

		// advance past the backoff so the scheduled reconnect fires a new socket,
		// then the server rejects it with the session-revoked close code
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.status, 'closed');

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(MockWebSocket.instances.length, 2);
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

describe('revoked getter', () => {
	test('false initially, true after revocation close', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		assert.strictEqual(client.revoked, false);

		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.revoked, true);
	});

	test('distinguishes user-initiated disconnect from revocation', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		client.disconnect();

		assert.strictEqual(client.status, 'closed');
		assert.strictEqual(client.revoked, false);
	});
});

describe('manual connect while reconnect is pending', () => {
	test('cancels the pending timer and opens immediately', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');

		// Manual connect while timer is pending should cancel it, not race.
		client.connect();
		assert.strictEqual(MockWebSocket.instances.length, 2);

		// Advance past where the original timer would have fired — no third socket.
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(MockWebSocket.instances.length, 2);
	});
});

describe('Symbol.dispose', () => {
	test('is equivalent to disconnect() for `using` support', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		const ws = last_ws();

		client[Symbol.dispose]();

		assert.strictEqual(ws.close_code, DEFAULT_CLOSE_CODE);
		assert.strictEqual(client.status, 'closed');
	});
});

describe('closed socket reference', () => {
	test('ws is nulled when server fires close', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		assert.ok(client.ws);

		last_ws().fire_close(1006);
		assert.isNull(client.ws);
	});
});

describe('close metadata', () => {
	test('server close populates last_close_time/code/reason', () => {
		const before = Date.now();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006, 'connection lost');

		assert.ok((client.last_close_time ?? 0) >= before);
		assert.strictEqual(client.last_close_code, 1006);
		assert.strictEqual(client.last_close_reason, 'connection lost');
	});

	test('revocation populates last_close_*', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED, 'session revoked');

		assert.strictEqual(client.last_close_code, WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.last_close_reason, 'session revoked');
		assert.strictEqual(client.revoked, true);
	});

	test('user disconnect populates last_close_* with given code', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		client.disconnect(4000);

		assert.strictEqual(client.last_close_code, 4000);
		assert.strictEqual(client.last_close_reason, '');
		assert.ok(client.last_close_time !== null);
	});

	test('disconnect with no active socket leaves prior metadata intact', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006, 'network');
		const prior_time = client.last_close_time;

		client.disconnect();
		assert.strictEqual(client.last_close_code, 1006);
		assert.strictEqual(client.last_close_reason, 'network');
		assert.strictEqual(client.last_close_time, prior_time);
	});

	test('force-reconnect via connect() records the prior close', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		client.connect(); // tears down the live socket with DEFAULT_CLOSE_CODE
		assert.strictEqual(client.last_close_code, DEFAULT_CLOSE_CODE);
		assert.strictEqual(client.last_close_reason, '');
	});
});

describe('counter resets', () => {
	test('disconnect resets reconnect_count and current_reconnect_delay', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.reconnect_count, 1);
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);

		client.disconnect();
		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);
	});

	test('revocation resets reconnect_count and current_reconnect_delay', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006);
		assert.ok(client.reconnect_count > 0);

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);
	});
});

describe('handler fault isolation', () => {
	test('message handler throw does not block subsequent handlers', () => {
		const log = {error: vi.fn()} as any;
		const client = new FrontendWebsocketClient(TEST_URL, {log});
		client.connect();

		const second = vi.fn();
		client.add_message_handler(() => {
			throw new Error('first throws');
		});
		client.add_message_handler(second);

		last_ws().fire_message('x');
		assert.strictEqual(second.mock.calls.length, 1);
		assert.strictEqual(log.error.mock.calls.length, 1);
	});

	test('error handler throw does not block subsequent handlers', () => {
		const log = {error: vi.fn()} as any;
		const client = new FrontendWebsocketClient(TEST_URL, {log});
		client.connect();

		const second = vi.fn();
		client.add_error_handler(() => {
			throw new Error('first throws');
		});
		client.add_error_handler(second);

		last_ws().fire_error();
		assert.strictEqual(second.mock.calls.length, 1);
		// 1 for the websocket error itself + 1 for the thrown handler
		assert.strictEqual(log.error.mock.calls.length, 2);
	});
});

describe('set_reconnect', () => {
	test('shorter new delay cuts in-flight wait short', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: {delay: 5000}});
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.current_reconnect_delay, 5000);

		// 1 second in, user drops the policy to 500ms.
		vi.advanceTimersByTime(1000);
		client.set_reconnect({delay: 500});

		// Displayed delay reflects the new target (monotonically shortened).
		assert.strictEqual(client.current_reconnect_delay, 500);

		// Advancing by the new target fires reconnect; original 4000ms-left schedule is gone.
		vi.advanceTimersByTime(500);
		assert.strictEqual(MockWebSocket.instances.length, 2);
	});

	test('longer new delay does not extend in-flight wait', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: {delay: 1000}});
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.current_reconnect_delay, 1000);

		// Raise the floor mid-wait — the in-flight timer stays on its original schedule.
		client.set_reconnect({delay: 30000});
		assert.strictEqual(client.current_reconnect_delay, 1000);

		vi.advanceTimersByTime(1000);
		assert.strictEqual(MockWebSocket.instances.length, 2);
	});

	test('new target already past elapsed reconnects immediately', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: {delay: 10000}});
		client.connect();
		last_ws().fire_close(1006);

		// 8s elapsed of a 10s wait; new policy would only wait 5s → already past due.
		vi.advanceTimersByTime(8000);
		client.set_reconnect({delay: 5000});

		// Reconnect fires on next tick.
		vi.advanceTimersByTime(0);
		assert.strictEqual(MockWebSocket.instances.length, 2);
	});

	test('policy change with no pending timer only affects future schedules', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		client.set_reconnect({delay: 250});

		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');
		assert.strictEqual(client.current_reconnect_delay, 250);
	});

	test('turning reconnect off during a pending wait cancels the timer', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');

		client.set_reconnect(false);
		assert.strictEqual(client.status, 'closed');
		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(MockWebSocket.instances.length, 1);
	});

	test('turning reconnect on after off does not synthesize a reconnect', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: false});
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'closed');

		client.set_reconnect(true);

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY_MAX * 2);
		assert.strictEqual(client.status, 'closed');
		assert.strictEqual(MockWebSocket.instances.length, 1);
	});

	test('null/true restore defaults (missing fields = defaults, not keep-current)', () => {
		const client = new FrontendWebsocketClient(TEST_URL, {
			reconnect: {delay: 500, delay_max: 2000, factor: 3},
		});
		client.set_reconnect(null);

		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);
	});

	test('factor change takes effect on subsequent backoff steps', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.current_reconnect_delay, DEFAULT_RECONNECT_DELAY);

		client.set_reconnect({factor: 4});
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);

		last_ws().fire_close(1006);
		// Uses new delay defaults (1000) and new factor (4): 1000 * 4^1 = 4000.
		assert.strictEqual(client.current_reconnect_delay, 4000);
	});

	test('revoked client ignores set_reconnect for scheduling side effects', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.revoked, true);

		// Should not re-enable reconnects or open new sockets.
		client.set_reconnect({delay: 100});
		vi.advanceTimersByTime(1000);
		assert.strictEqual(MockWebSocket.instances.length, 1);
	});
});

describe('full lifecycle', () => {
	test('connect → close → reconnect → open → disconnect', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		const messages: Array<string> = [];
		client.add_message_handler((e) => messages.push(e.data as string));

		// initial connection
		client.connect();
		last_ws().fire_open();
		assert.strictEqual(client.status, 'connected');
		assert.strictEqual(client.send({hi: 1}), true);

		// message survives across the handler map
		last_ws().fire_message('one');

		// unexpected close triggers reconnect
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');

		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		assert.strictEqual(MockWebSocket.instances.length, 2);

		// new socket opens; counter resets; message handler still wired
		last_ws().fire_open();
		last_ws().fire_message('two');
		assert.strictEqual(client.reconnect_count, 0);

		client.disconnect();
		assert.strictEqual(client.status, 'closed');
		assert.deepStrictEqual(messages, ['one', 'two']);
	});
});
