/**
 * Tests for `FrontendWebsocketTransport` — verifies the thin-adapter
 * refactor: delegation to `WebsocketRpcConnection.request` (with explicit
 * id, signal, queue=false), envelope translation around `Promise<R>` and
 * `ThrownJsonrpcError`, fail-fast when the connection isn't ready, and
 * inbound dispatch limited to server-pushed requests/notifications.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {
	FrontendWebsocketTransport,
	type WebsocketRpcConnection,
} from '$lib/actions/transports_ws.js';
import {JSONRPC_ERROR_CODES, ThrownJsonrpcError} from '$lib/http/jsonrpc_errors.js';
import type {JsonrpcRequest, JsonrpcNotification, JsonrpcRequestId} from '$lib/http/jsonrpc.js';

interface RequestCall {
	method: string;
	params: unknown;
	options?: {signal?: AbortSignal; queue?: boolean; id?: JsonrpcRequestId};
}

const create_fake_connection = (
	options: {
		connected?: boolean;
		request_impl?: (call: RequestCall) => Promise<unknown>;
	} = {},
) => {
	const connected = options.connected ?? true;
	const request_calls: Array<RequestCall> = [];
	const sent_messages: Array<object> = [];
	let message_handler: ((event: MessageEvent) => void) | null = null;

	const connection: WebsocketRpcConnection = {
		send: (data: object) => {
			sent_messages.push(data);
			return true;
		},
		get connected() {
			return connected;
		},
		add_message_handler: (handler) => {
			message_handler = handler;
			return () => {
				if (message_handler === handler) message_handler = null;
			};
		},
		add_error_handler: () => () => {},
		request: async (method, params, request_options) => {
			const call: RequestCall = {method, params, options: request_options};
			request_calls.push(call);
			if (options.request_impl) return options.request_impl(call);
			return null;
		},
	};

	return {
		connection,
		request_calls,
		sent_messages,
		fire_message: (data: unknown) => {
			message_handler?.({data: JSON.stringify(data)} as MessageEvent);
		},
	};
};

describe('FrontendWebsocketTransport', () => {
	test('request delegates to connection.request with peer id, signal, queue=false', async () => {
		const fake = create_fake_connection({
			request_impl: async () => ({pong: true}),
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const controller = new AbortController();
		const message: JsonrpcRequest = {
			jsonrpc: '2.0',
			id: 'peer-uuid-123',
			method: 'ping',
			params: {x: 1},
		};
		const response = await transport.send(message, {signal: controller.signal});

		assert.strictEqual(fake.request_calls.length, 1);
		const call = fake.request_calls[0]!;
		assert.strictEqual(call.method, 'ping');
		assert.deepStrictEqual(call.params, {x: 1});
		assert.strictEqual(call.options?.id, 'peer-uuid-123');
		assert.strictEqual(call.options?.signal, controller.signal);
		assert.strictEqual(call.options?.queue, false);

		assert.deepStrictEqual(response, {
			jsonrpc: '2.0',
			id: 'peer-uuid-123',
			result: {pong: true},
		});
	});

	test('queue=true forwards to connection.request and bypasses the disconnected fail-fast', async () => {
		const fake = create_fake_connection({
			connected: false,
			request_impl: async () => ({pong: true}),
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 7, method: 'ping', params: {}};
		const response = await transport.send(message, {queue: true});

		assert.strictEqual(fake.request_calls.length, 1);
		assert.strictEqual(fake.request_calls[0]!.options?.queue, true);
		assert.deepStrictEqual(response, {jsonrpc: '2.0', id: 7, result: {pong: true}});
	});

	test('queue=true forwards through to connection.request while connected', async () => {
		const fake = create_fake_connection({
			request_impl: async () => ({pong: true}),
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 9, method: 'ping', params: {}};
		const response = await transport.send(message, {queue: true});

		assert.strictEqual(fake.request_calls.length, 1);
		assert.strictEqual(fake.request_calls[0]!.options?.queue, true);
		assert.deepStrictEqual(response, {jsonrpc: '2.0', id: 9, result: {pong: true}});
	});

	test('queue=false preserves service_unavailable thrown by connection.request', async () => {
		// The request-side fail-fast used to live on the transport; it now lives
		// on the connection (FrontendWebsocketClient.request throws
		// service_unavailable when disconnected + queue=false). This test proves
		// the transport delegates and preserves the code verbatim instead of
		// short-circuiting at the transport boundary.
		const fake = create_fake_connection({
			connected: false,
			request_impl: async () => {
				throw new ThrownJsonrpcError(
					JSONRPC_ERROR_CODES.service_unavailable,
					'[socket] not connected (method=ping)',
				);
			},
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 8, method: 'ping', params: {}};
		const response = await transport.send(message, {queue: false});

		assert.ok('error' in response);
		const err = (response as {error: {code: number; message: string}}).error;
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.service_unavailable);
		assert.match(err.message, /not connected/i);
		// Transport delegated to the connection — request_calls was incremented
		// before the throw landed in the catch block.
		assert.strictEqual(fake.request_calls.length, 1);
	});

	test('request wraps ThrownJsonrpcError into JsonrpcErrorResponse envelope', async () => {
		const fake = create_fake_connection({
			request_impl: async () => {
				throw new ThrownJsonrpcError(-32602, 'invalid params', {field: 'x'});
			},
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 1, method: 'echo', params: {}};
		const response = await transport.send(message);

		assert.deepStrictEqual(response, {
			jsonrpc: '2.0',
			id: 1,
			error: {code: -32602, message: 'invalid params', data: {field: 'x'}},
		});
	});

	test('request wraps unknown errors into internal_error envelope', async () => {
		const fake = create_fake_connection({
			request_impl: async () => {
				throw new Error('boom');
			},
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 2, method: 'echo', params: {}};
		const response = await transport.send(message);

		assert.ok('error' in response, 'expected error envelope');
		assert.strictEqual(response.id, 2);
		assert.match((response as {error: {message: string}}).error.message, /boom/);
	});

	test('default queue (false) preserves service_unavailable from connection.request', async () => {
		const fake = create_fake_connection({
			connected: false,
			request_impl: async () => {
				throw new ThrownJsonrpcError(
					JSONRPC_ERROR_CODES.service_unavailable,
					'[socket] not connected (method=ping)',
				);
			},
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 3, method: 'ping', params: {}};
		const response = await transport.send(message);

		assert.ok('error' in response, 'expected error envelope');
		const err = (response as {error: {code: number; message: string}}).error;
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.service_unavailable);
		assert.match(err.message, /not connected/i);
	});

	test('queue_overflow from connection.request flows through transport catch-block', async () => {
		// Another client-side code the transport can't invent — the connection
		// decides when to reject with queue_overflow. Transport preserves the
		// code verbatim so the caller can distinguish "buffer full" from
		// "service down" in the envelope they observe.
		const fake = create_fake_connection({
			connected: false,
			request_impl: async () => {
				throw new ThrownJsonrpcError(
					JSONRPC_ERROR_CODES.queue_overflow,
					'[socket] request queue overflow (method=ping, max=100)',
				);
			},
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 4, method: 'ping', params: {}};
		const response = await transport.send(message, {queue: true});

		assert.ok('error' in response);
		const err = (response as {error: {code: number; message: string}}).error;
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.queue_overflow);
		assert.match(err.message, /queue overflow/);
	});

	test('request_cancelled from connection.request flows through transport catch-block', async () => {
		const fake = create_fake_connection({
			request_impl: (call) =>
				new Promise((_, reject) => {
					call.options?.signal?.addEventListener('abort', () => {
						reject(
							new ThrownJsonrpcError(
								JSONRPC_ERROR_CODES.request_cancelled,
								'[socket] request aborted (method=long_running)',
							),
						);
					});
				}),
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const controller = new AbortController();
		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 5, method: 'long_running', params: {}};
		const send_promise = transport.send(message, {signal: controller.signal});

		await Promise.resolve();
		controller.abort();

		const response = await send_promise;
		assert.ok('error' in response);
		const err = (response as {error: {code: number; message: string}}).error;
		assert.strictEqual(err.code, JSONRPC_ERROR_CODES.request_cancelled);
		assert.match(err.message, /aborted/i);
	});

	test('mid-flight abort rejects connection.request and produces an error envelope', async () => {
		const fake = create_fake_connection({
			request_impl: (call) =>
				new Promise((_, reject) => {
					call.options?.signal?.addEventListener('abort', () => {
						reject(new Error('request aborted'));
					});
				}),
		});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const controller = new AbortController();
		const message: JsonrpcRequest = {jsonrpc: '2.0', id: 42, method: 'long_running', params: {}};
		const send_promise = transport.send(message, {signal: controller.signal});

		// Let send() clear the is_ready guard and register the signal listener
		// inside the fake's request_impl before we abort.
		await Promise.resolve();
		controller.abort();

		const response = await send_promise;
		assert.ok('error' in response, 'expected error envelope');
		assert.strictEqual(response.id, 42);
		assert.match((response as {error: {message: string}}).error.message, /aborted/i);
	});

	test('queue=true does not bypass fail-fast for notifications when disconnected', async () => {
		const fake = create_fake_connection({connected: false});
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const notification: JsonrpcNotification = {
			jsonrpc: '2.0',
			method: 'progress',
			params: {pct: 10},
		};
		const response = await transport.send(notification, {queue: true});

		assert.ok(response && 'error' in response, 'expected service_unavailable envelope');
		assert.match((response as {error: {message: string}}).error.message, /not connected/i);
		assert.strictEqual(fake.sent_messages.length, 0, 'notification must not be silently dropped');
		assert.strictEqual(fake.request_calls.length, 0);
	});

	test('queue=true notification while connected still uses connection.send', async () => {
		const fake = create_fake_connection();
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const notification: JsonrpcNotification = {
			jsonrpc: '2.0',
			method: 'progress',
			params: {pct: 50},
		};
		const response = await transport.send(notification, {queue: true});

		assert.isNull(response);
		assert.strictEqual(fake.request_calls.length, 0, 'notifications never hit connection.request');
		assert.deepStrictEqual(fake.sent_messages, [notification]);
	});

	test('notification path uses connection.send, not connection.request', async () => {
		const fake = create_fake_connection();
		const transport = new FrontendWebsocketTransport(fake.connection, async () => null);

		const notification: JsonrpcNotification = {
			jsonrpc: '2.0',
			method: 'cancel',
			params: {request_id: 1},
		};
		const response = await transport.send(notification);

		assert.isNull(response);
		assert.strictEqual(fake.request_calls.length, 0);
		assert.deepStrictEqual(fake.sent_messages, [notification]);
	});

	test('inbound dispatch routes server-pushed requests/notifications only', async () => {
		const received: Array<unknown> = [];
		const fake = create_fake_connection();
		const transport = new FrontendWebsocketTransport(fake.connection, async (data) => {
			received.push(data);
			return null;
		});

		// Inbound notification — should be received.
		fake.fire_message({jsonrpc: '2.0', method: 'progress', params: {pct: 50}});
		// Inbound request — should be received.
		fake.fire_message({jsonrpc: '2.0', id: 99, method: 'server_request', params: {}});
		// Response to a request we sent — should be IGNORED (client owns it).
		fake.fire_message({jsonrpc: '2.0', id: 1, result: {ok: true}});
		// Error response — also ignored.
		fake.fire_message({jsonrpc: '2.0', id: 2, error: {code: -32603, message: 'oops'}});

		// Microtask drain.
		await Promise.resolve();
		await Promise.resolve();

		assert.strictEqual(received.length, 2);
		transport.dispose();
	});
});
