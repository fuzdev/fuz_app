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

import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {
	FrontendWebsocketClient,
	DEFAULT_CLOSE_CODE,
	DEFAULT_RECONNECT_DELAY,
	DEFAULT_RECONNECT_DELAY_MAX,
	DEFAULT_BACKOFF_FACTOR,
	DEFAULT_HEARTBEAT_INTERVAL,
	DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT,
	DEFAULT_QUEUE_MAX_SIZE,
	socket_status_to_async_status,
} from '$lib/actions/socket.svelte.js';
import {
	WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT,
	WS_CLOSE_SESSION_REVOKED,
} from '$lib/actions/transports.js';
import {CANCEL_METHOD} from '$lib/actions/cancel.js';
import {HEARTBEAT_METHOD} from '$lib/actions/heartbeat.js';

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
		assert.instanceOf(client.last_send_error, Error);
		assert.strictEqual(client.last_send_error.message, 'boom');
	});

	test('returns false after disconnect', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();
		client.disconnect();

		assert.strictEqual(client.send({x: 1}), false);
	});
});

describe('last_send_error', () => {
	test('is null initially and on successful sends', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		assert.isNull(client.last_send_error);

		client.connect();
		last_ws().fire_open();
		assert.strictEqual(client.send({x: 1}), true);
		assert.isNull(client.last_send_error);
	});

	test('resets to null on next successful send after a throw', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const send_spy = vi.spyOn(last_ws(), 'send').mockImplementationOnce(() => {
			throw new Error('transient');
		});
		assert.strictEqual(client.send({x: 1}), false);
		assert.strictEqual(client.last_send_error?.message, 'transient');

		// next call falls through to the unmocked impl, which succeeds
		assert.strictEqual(client.send({x: 2}), true);
		assert.isNull(client.last_send_error);
		assert.strictEqual(send_spy.mock.calls.length, 2);
	});

	test('wraps non-Error throws in an Error', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		vi.spyOn(last_ws(), 'send').mockImplementation(() => {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw 'plain string';
		});

		assert.strictEqual(client.send({x: 1}), false);
		assert.instanceOf(client.last_send_error, Error);
		assert.strictEqual(client.last_send_error.message, 'plain string');
	});

	test('is not touched when send short-circuits on not-connected', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		vi.spyOn(last_ws(), 'send').mockImplementation(() => {
			throw new Error('boom');
		});
		assert.strictEqual(client.send({x: 1}), false);
		assert.strictEqual(client.last_send_error?.message, 'boom');

		// disconnect so send() short-circuits on !connected — field must stay.
		client.disconnect();
		assert.strictEqual(client.send({x: 2}), false);
		assert.strictEqual(client.last_send_error?.message, 'boom');
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

// --- request() ---

const make_response = (id: number, result: unknown): string =>
	JSON.stringify({jsonrpc: '2.0', id, result});

const make_error_response = (id: number, code: number, message: string, data?: unknown): string =>
	JSON.stringify({jsonrpc: '2.0', id, error: {code, message, data}});

describe('request()', () => {
	test('sends a JSON-RPC request frame and resolves on matching response', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const promise = client.request<{value: string}>('echo', {value: 'hi'});

		assert.strictEqual(last_ws().sent.length, 1);
		const frame = JSON.parse(last_ws().sent[0]!);
		assert.strictEqual(frame.jsonrpc, '2.0');
		assert.strictEqual(frame.id, 1);
		assert.strictEqual(frame.method, 'echo');
		assert.deepStrictEqual(frame.params, {value: 'hi'});

		last_ws().fire_message(make_response(1, {value: 'echoed'}));
		assert.deepStrictEqual(await promise, {value: 'echoed'});
	});

	test('default params to {} when omitted', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const promise = client.request('ping');
		const frame = JSON.parse(last_ws().sent[0]!);
		assert.deepStrictEqual(frame.params, {});

		last_ws().fire_message(make_response(1, null));
		await promise;
	});

	test('rejects on matching error frame with code and message', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const promise = client.request('echo', {value: 'x'});
		last_ws().fire_message(make_error_response(1, -32602, 'invalid params'));

		const err = await assert_rejects(() => promise, /invalid params/);
		assert.match(err.message, /-32602/);
		assert.match(err.message, /echo/);
	});

	test('monotonic ids across concurrent requests', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		void client.request('a');
		void client.request('b');
		void client.request('c');

		const ids = last_ws().sent.map((s) => JSON.parse(s).id);
		assert.deepStrictEqual(ids, [1, 2, 3]);
	});

	test('intercepted responses do NOT fan out to message handlers', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const handler = vi.fn();
		client.add_message_handler(handler);

		void client.request('echo', {});
		last_ws().fire_message(make_response(1, {ok: true}));

		assert.strictEqual(handler.mock.calls.length, 0);
	});

	test('notifications (no id) still fan out to message handlers', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const handler = vi.fn();
		client.add_message_handler(handler);

		last_ws().fire_message(JSON.stringify({jsonrpc: '2.0', method: 'progress', params: {n: 1}}));
		assert.strictEqual(handler.mock.calls.length, 1);
	});

	test('response frames for unknown ids fall through to message handlers', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const handler = vi.fn();
		client.add_message_handler(handler);

		// no pending request; response frame is not ours
		last_ws().fire_message(make_response(999, {stray: true}));
		assert.strictEqual(handler.mock.calls.length, 1);
	});

	test('pre-aborted signal rejects immediately without sending', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const controller = new AbortController();
		controller.abort();
		const promise = client.request('echo', {}, {signal: controller.signal});

		await assert_rejects(() => promise, /aborted/);
		assert.strictEqual(last_ws().sent.length, 0);
	});

	test('post-send abort rejects and removes from pending', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const controller = new AbortController();
		const promise = client.request('echo', {}, {signal: controller.signal});
		assert.strictEqual(last_ws().sent.length, 1);

		controller.abort();
		await assert_rejects(() => promise, /aborted/);

		// late response arrives — no crash; no duplicate dispatch
		const handler = vi.fn();
		client.add_message_handler(handler);
		last_ws().fire_message(make_response(1, 'late'));
		// the aborted request was removed from pending, so this falls through to handlers
		assert.strictEqual(handler.mock.calls.length, 1);
	});

	test('rejects pending on socket close (abnormal)', async () => {
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: false});
		client.connect();
		last_ws().fire_open();

		const promise = client.request('echo', {});
		last_ws().fire_close(1006);

		await assert_rejects(() => promise, /connection closed/);
	});

	test('rejects pending on session revocation with revoked-reason', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const promise = client.request('echo', {});
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);

		await assert_rejects(() => promise, /session revoked/);
	});

	test('rejects immediately when called after revocation', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);
		assert.strictEqual(client.revoked, true);

		await assert_rejects(() => client.request('echo'), /session revoked/);
	});

	test('queue: false rejects immediately when disconnected', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		// never connected
		await assert_rejects(() => client.request('echo', {}, {queue: false}), /not connected/);
	});

	test('rejects pending when user-initiated disconnect', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const promise = client.request('echo', {});
		client.disconnect();

		// teardown rejects pending with "socket torn down"
		await assert_rejects(() => promise, /socket torn down/);
	});

	test('resolves concurrent requests correctly when responses arrive out of order', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const p1 = client.request<string>('a');
		const p2 = client.request<string>('b');
		const p3 = client.request<string>('c');

		// respond in reverse order
		last_ws().fire_message(make_response(3, 'C'));
		last_ws().fire_message(make_response(1, 'A'));
		last_ws().fire_message(make_response(2, 'B'));

		assert.deepStrictEqual(await Promise.all([p1, p2, p3]), ['A', 'B', 'C']);
	});

	test('send failure mid-flight with queue on — requeues for later flush', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		// Force a one-shot send failure on the connected socket.
		const send_spy = vi.spyOn(last_ws(), 'send').mockImplementationOnce(() => {
			throw new Error('transient');
		});

		const p = client.request<string>('echo', {value: 'x'});

		// first attempt failed; no frame landed on the wire yet
		assert.strictEqual(send_spy.mock.calls.length, 1);
		assert.strictEqual(last_ws().sent.length, 0);

		// Trigger a flush by simulating an open event on the same socket —
		// queued request re-sends via the (now unmocked) real send path.
		last_ws().fire_open();
		assert.strictEqual(last_ws().sent.length, 1);
		const sent = JSON.parse(last_ws().sent[0]!);
		assert.strictEqual(sent.method, 'echo');

		last_ws().fire_message(make_response(sent.id, 'ok'));
		assert.strictEqual(await p, 'ok');
	});

	test('send failure mid-flight with queue: false — rejects immediately', async () => {
		const client = new FrontendWebsocketClient(TEST_URL, {queue: false});
		client.connect();
		last_ws().fire_open();

		vi.spyOn(last_ws(), 'send').mockImplementationOnce(() => {
			throw new Error('transient');
		});

		await assert_rejects(() => client.request('echo', {}, {queue: false}), /send failed/);
	});
});

// --- request() signal → cancel notification ---

describe('request() signal → cancel notification', () => {
	test('aborting a sent request emits a cancel notification for that id', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const controller = new AbortController();
		const promise = client.request('echo', {value: 'x'}, {signal: controller.signal});
		assert.strictEqual(last_ws().sent.length, 1);
		const req_frame = JSON.parse(last_ws().sent[0]!);
		assert.strictEqual(req_frame.method, 'echo');

		controller.abort();
		await assert_rejects(() => promise, /aborted/);

		// Request frame + cancel notification.
		assert.strictEqual(last_ws().sent.length, 2);
		const cancel_frame = JSON.parse(last_ws().sent[1]!);
		assert.strictEqual(cancel_frame.jsonrpc, '2.0');
		assert.strictEqual(cancel_frame.method, CANCEL_METHOD);
		assert.deepStrictEqual(cancel_frame.params, {request_id: req_frame.id});
		assert.strictEqual('id' in cancel_frame, false);
	});

	test('pre-aborted signal does not send a cancel (nothing was sent)', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const controller = new AbortController();
		controller.abort();
		await assert_rejects(() => client.request('echo', {}, {signal: controller.signal}), /aborted/);

		// No frames — not the request, not a cancel.
		assert.strictEqual(last_ws().sent.length, 0);
	});

	test('aborting a queued-but-never-sent request does not emit a cancel', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		// Never connected → the request sits in the durable queue.
		const controller = new AbortController();
		const promise = client.request('echo', {}, {signal: controller.signal});

		controller.abort();
		await assert_rejects(() => promise, /aborted/);

		// Connect — nothing to flush, and critically no stray cancel frame.
		client.connect();
		last_ws().fire_open();
		assert.strictEqual(last_ws().sent.length, 0);
	});

	test('cancel is suppressed if the response arrived first (race)', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const controller = new AbortController();
		const promise = client.request('echo', {value: 'x'}, {signal: controller.signal});
		const req_frame = JSON.parse(last_ws().sent[0]!);

		// Response arrives first — pending map cleared, signal listener detached.
		last_ws().fire_message(make_response(req_frame.id, {value: 'echoed'}));
		assert.deepStrictEqual(await promise, {value: 'echoed'});

		// Late abort must not fire a cancel frame for a settled request.
		controller.abort();
		assert.strictEqual(last_ws().sent.length, 1);
	});

	test('cancel is dropped when socket is disconnected (server cleans up on close)', async () => {
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: false});
		client.connect();
		last_ws().fire_open();

		const controller = new AbortController();
		const promise = client.request('echo', {}, {signal: controller.signal});
		assert.strictEqual(last_ws().sent.length, 1);

		// Close the socket. `#handle_close` rejects the pending request with a
		// connection-closed error — the abort closure no longer has a pending
		// entry to delete, so no cancel frame fires.
		last_ws().fire_close(1006);
		await assert_rejects(() => promise, /connection closed/);

		controller.abort();
		// Still just the one request frame on the wire — no late cancel.
		assert.strictEqual(last_ws().sent.length, 1);
	});

	test('aborting one of many in-flight requests cancels only its id', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		const c1 = new AbortController();
		const p1 = client.request('a', {}, {signal: c1.signal});
		void client.request('b', {});
		void client.request('c', {});

		assert.strictEqual(last_ws().sent.length, 3);
		const id_a = JSON.parse(last_ws().sent[0]!).id;

		c1.abort();
		await assert_rejects(() => p1, /aborted/);

		assert.strictEqual(last_ws().sent.length, 4);
		const cancel_frame = JSON.parse(last_ws().sent[3]!);
		assert.strictEqual(cancel_frame.method, CANCEL_METHOD);
		assert.deepStrictEqual(cancel_frame.params, {request_id: id_a});
	});
});

// --- durable queue ---

describe('durable queue', () => {
	test('queues while disconnected and flushes in order on reopen', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		const p1 = client.request<string>('a', {});
		const p2 = client.request<string>('b', {});

		// nothing sent yet — no socket constructed
		assert.strictEqual(MockWebSocket.instances.length, 0);

		client.connect();
		last_ws().fire_open();

		// flush happened in open handler, in FIFO order
		assert.strictEqual(last_ws().sent.length, 2);
		const ids = last_ws().sent.map((s) => JSON.parse(s));
		assert.strictEqual(ids[0].method, 'a');
		assert.strictEqual(ids[1].method, 'b');

		last_ws().fire_message(make_response(ids[0].id, 'A'));
		last_ws().fire_message(make_response(ids[1].id, 'B'));
		assert.strictEqual(await p1, 'A');
		assert.strictEqual(await p2, 'B');
	});

	test('overflow rejects the new call with a queue_overflow-shaped error', async () => {
		const client = new FrontendWebsocketClient(TEST_URL, {queue: {max_size: 2}});
		const p1 = client.request('a', {});
		const p2 = client.request('b', {});
		const p3 = client.request('c', {});

		await assert_rejects(() => p3, /queue overflow.*max=2/);

		// the first two are still pending (not rejected)
		let p1_done = false;
		let p2_done = false;
		void p1.finally(() => (p1_done = true));
		void p2.finally(() => (p2_done = true));
		await Promise.resolve();
		assert.strictEqual(p1_done, false);
		assert.strictEqual(p2_done, false);
	});

	test('DEFAULT_QUEUE_MAX_SIZE bound used by default', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		// fill the queue to the default bound; the next call rejects.
		const in_flight: Array<Promise<unknown>> = [];
		for (let i = 0; i < DEFAULT_QUEUE_MAX_SIZE; i++) {
			in_flight.push(client.request(`m${i}`, {}).catch(() => undefined));
		}
		await assert_rejects(() => client.request('overflow', {}), /queue overflow/);
		// cleanup — reject the rest by disconnect so vitest doesn't flag unhandled rejections
		client.disconnect();
		await Promise.all(in_flight);
	});

	test('queue: false disables queuing — rejects rather than buffers', async () => {
		const client = new FrontendWebsocketClient(TEST_URL, {queue: false});
		await assert_rejects(() => client.request('a', {}), /not connected/);

		client.connect();
		last_ws().fire_open();
		// no stray buffered frames fire on open
		assert.strictEqual(last_ws().sent.length, 0);
	});

	test('aborted queued requests skip send on flush', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		const controller = new AbortController();
		const aborted_p = client.request('a', {}, {signal: controller.signal});
		const kept_p = client.request<string>('b', {});

		controller.abort();
		await assert_rejects(() => aborted_p, /aborted/);

		client.connect();
		last_ws().fire_open();

		// only `b` survived the flush
		assert.strictEqual(last_ws().sent.length, 1);
		const sent = JSON.parse(last_ws().sent[0]!);
		assert.strictEqual(sent.method, 'b');

		last_ws().fire_message(make_response(sent.id, 'B'));
		assert.strictEqual(await kept_p, 'B');
	});

	test('session revocation drains the queue', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		const p = client.request('a', {});
		client.connect();
		last_ws().fire_close(WS_CLOSE_SESSION_REVOKED);

		await assert_rejects(() => p, /session revoked/);
		assert.strictEqual(client.revoked, true);
	});

	test('disconnect drains the queue with client-disconnected reason', async () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		const p = client.request('a', {});
		client.disconnect();

		await assert_rejects(() => p, /client disconnected/);
	});

	test('raw send() is never queued — drops on disconnect', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		// not connected
		assert.strictEqual(client.send({hi: 'queue-me-please'}), false);

		client.connect();
		last_ws().fire_open();
		// no buffered frame was replayed
		assert.strictEqual(last_ws().sent.length, 0);
	});

	test('queue survives abnormal close and flushes on reconnected socket', async () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL);
		client.connect();
		last_ws().fire_open();

		// Abnormal close drops pending + schedules reconnect. Queue stays empty.
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');

		// User issues a request mid-reconnect — queued because not connected.
		const p = client.request<string>('delayed', {});
		assert.strictEqual(MockWebSocket.instances.length, 1);

		// Reconnect fires; second socket opens and the queued request lands.
		vi.advanceTimersByTime(DEFAULT_RECONNECT_DELAY);
		assert.strictEqual(MockWebSocket.instances.length, 2);
		last_ws().fire_open();
		assert.strictEqual(last_ws().sent.length, 1);
		const frame = JSON.parse(last_ws().sent[0]!);
		assert.strictEqual(frame.method, 'delayed');

		last_ws().fire_message(make_response(frame.id, 'ok'));
		assert.strictEqual(await p, 'ok');
	});
});

// --- client heartbeat ---

describe('client heartbeat', () => {
	test('idle past interval emits a heartbeat request (queue: false)', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 100, receive_timeout: 10_000},
		});
		client.connect();
		last_ws().fire_open();

		// no activity; advance past interval
		vi.advanceTimersByTime(150);

		// One heartbeat frame sent on the wire.
		assert.strictEqual(last_ws().sent.length, 1);
		const frame = JSON.parse(last_ws().sent[0]!);
		assert.strictEqual(frame.method, HEARTBEAT_METHOD);
		assert.deepStrictEqual(frame.params, {});
	});

	test('outgoing send resets the idle window — no heartbeat emitted', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 100, receive_timeout: 10_000},
		});
		client.connect();
		last_ws().fire_open();

		// send chatter just before a tick; advance past the original interval
		vi.advanceTimersByTime(40);
		client.send({some: 'data'});
		vi.advanceTimersByTime(60); // total 100 — would have ticked without the send

		// Only the chatter frame is on the wire — no heartbeat yet.
		assert.strictEqual(last_ws().sent.length, 1);
		assert.deepStrictEqual(JSON.parse(last_ws().sent[0]!), {some: 'data'});
	});

	test('incoming message resets the receive-silence timer', () => {
		vi.useFakeTimers();
		// tick runs at max(100, interval/2). interval=400 → tick=200, which
		// means the receive-silence check runs every 200ms. Setting
		// receive_timeout=200 keeps the close threshold one tick wide so we
		// can observe an activity reset between ticks.
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 400, receive_timeout: 200},
		});
		client.connect();
		last_ws().fire_open();

		// Just before the first tick at t=200, server sends something.
		vi.advanceTimersByTime(150);
		last_ws().fire_message('{"jsonrpc":"2.0","method":"note","params":{}}');
		// First tick fires at t=200; with last_receive=150 silence=50 < 200.
		vi.advanceTimersByTime(100);
		assert.isNull(last_ws().close_code);
		// Would have closed at t=200 without the reset — tick at t=200 would
		// have seen silence=200. Advance another tick to confirm still no close.
		vi.advanceTimersByTime(100);
		assert.isNull(last_ws().close_code);
	});

	test('receive silence past receive_timeout closes with 4002', () => {
		vi.useFakeTimers();
		// interval=400 → tick=200; receive_timeout=200 means the first tick
		// after open fires the close.
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 400, receive_timeout: 200},
			reconnect: false,
		});
		client.connect();
		last_ws().fire_open();
		const ws = last_ws();

		vi.advanceTimersByTime(250);

		assert.strictEqual(ws.close_code, WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT);
	});

	test('heartbeat: false disables the timer (no close, no ping)', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {heartbeat: false});
		client.connect();
		last_ws().fire_open();

		vi.advanceTimersByTime(DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT * 2);

		assert.strictEqual(last_ws().sent.length, 0);
		assert.isNull(last_ws().close_code);
	});

	test('disconnect cancels the heartbeat timer', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 100, receive_timeout: 1000},
		});
		client.connect();
		last_ws().fire_open();

		client.disconnect();
		vi.advanceTimersByTime(500);

		// no stray heartbeat request sent after disconnect
		assert.strictEqual(last_ws().sent.length, 0);
	});

	test('default interval and receive_timeout values are wired', () => {
		// Smoke-test the defaults without running the whole interval.
		assert.strictEqual(DEFAULT_HEARTBEAT_INTERVAL, 30_000);
		assert.strictEqual(DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT, 60_000);
	});
});

describe('set_heartbeat', () => {
	test('interval change takes effect mid-connection', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 10_000, receive_timeout: 30_000},
		});
		client.connect();
		last_ws().fire_open();

		// Tighten interval mid-connection; the new timer fires well before the
		// old 10s interval would have.
		client.set_heartbeat({interval: 200, receive_timeout: 5000});
		vi.advanceTimersByTime(250);

		assert.strictEqual(last_ws().sent.length, 1);
		const frame = JSON.parse(last_ws().sent[0]!);
		assert.strictEqual(frame.method, HEARTBEAT_METHOD);
	});

	test('disable while connected stops the timer without closing', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 100, receive_timeout: 10_000},
		});
		client.connect();
		last_ws().fire_open();

		client.set_heartbeat(false);
		vi.advanceTimersByTime(500);

		assert.strictEqual(last_ws().sent.length, 0);
		assert.isNull(last_ws().close_code);
		assert.strictEqual(client.status, 'connected');
	});

	test('re-enable while connected restarts the timer', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {heartbeat: false});
		client.connect();
		last_ws().fire_open();

		// Previously off — turning on starts a live heartbeat now.
		client.set_heartbeat({interval: 100, receive_timeout: 10_000});
		vi.advanceTimersByTime(150);

		assert.strictEqual(last_ws().sent.length, 1);
		assert.strictEqual(JSON.parse(last_ws().sent[0]!).method, HEARTBEAT_METHOD);
	});

	test('receive-silence uses the new receive_timeout', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 60_000, receive_timeout: 60_000},
			reconnect: false,
		});
		client.connect();
		last_ws().fire_open();

		// Tighten to a window that fires on the next tick.
		client.set_heartbeat({interval: 400, receive_timeout: 200});
		vi.advanceTimersByTime(250);

		assert.strictEqual(last_ws().close_code, WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT);
	});

	test('null/true restore defaults (missing fields = defaults, not keep-current)', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {
			heartbeat: {interval: 100, receive_timeout: 1000},
		});
		client.connect();
		last_ws().fire_open();

		client.set_heartbeat(null);
		// Defaults restored: interval 30s → no frame emitted after 150ms.
		vi.advanceTimersByTime(150);
		assert.strictEqual(last_ws().sent.length, 0);
	});

	test('change while disconnected just stashes policy for next connect', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {heartbeat: false});

		client.set_heartbeat({interval: 100, receive_timeout: 10_000});

		client.connect();
		last_ws().fire_open();
		vi.advanceTimersByTime(150);

		assert.strictEqual(last_ws().sent.length, 1);
		assert.strictEqual(JSON.parse(last_ws().sent[0]!).method, HEARTBEAT_METHOD);
	});
});

describe('cancel_reconnect', () => {
	test('cancels a pending reconnect and transitions to closed', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: {delay: 5000}});
		client.connect();
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');
		assert.strictEqual(client.reconnect_count, 1);

		client.cancel_reconnect();
		assert.strictEqual(client.status, 'closed');
		assert.strictEqual(client.reconnect_count, 0);
		assert.strictEqual(client.current_reconnect_delay, 0);

		// No new socket opens even after the original delay would have elapsed.
		vi.advanceTimersByTime(10_000);
		assert.strictEqual(MockWebSocket.instances.length, 1);
	});

	test('does not disable auto-reconnect for future closes', () => {
		vi.useFakeTimers();
		const client = new FrontendWebsocketClient(TEST_URL, {reconnect: {delay: 100}});
		client.connect();
		last_ws().fire_close(1006);
		client.cancel_reconnect();
		assert.strictEqual(client.status, 'closed');

		// Reopen manually — next unexpected close should still schedule a reconnect.
		client.connect();
		last_ws().fire_open();
		last_ws().fire_close(1006);
		assert.strictEqual(client.status, 'reconnecting');
	});

	test('no-op when no reconnect is pending', () => {
		const client = new FrontendWebsocketClient(TEST_URL);
		// Never connected; status is 'initial'.
		client.cancel_reconnect();
		assert.strictEqual(client.status, 'initial');
	});
});

describe('socket_status_to_async_status', () => {
	test('maps connection states onto the 4-way AsyncStatus', () => {
		assert.strictEqual(socket_status_to_async_status('initial', false), 'initial');
		assert.strictEqual(socket_status_to_async_status('connecting', false), 'pending');
		assert.strictEqual(socket_status_to_async_status('connected', false), 'success');
		assert.strictEqual(socket_status_to_async_status('reconnecting', false), 'failure');
	});

	test('splits closed by revoked — clean close reads as initial, revoked as failure', () => {
		assert.strictEqual(socket_status_to_async_status('closed', false), 'initial');
		assert.strictEqual(socket_status_to_async_status('closed', true), 'failure');
	});

	test('revoked only affects the closed branch — pending/success ignore it', () => {
		// Real clients shouldn't ever land here (revoked implies closed) but
		// the adapter is pure; assert it doesn't lie about the active states.
		assert.strictEqual(socket_status_to_async_status('connecting', true), 'pending');
		assert.strictEqual(socket_status_to_async_status('connected', true), 'success');
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
