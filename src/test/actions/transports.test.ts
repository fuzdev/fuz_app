/**
 * Tests for transports.ts — Transport interface and Transports registry.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	DEFAULT_WS_MAX_MESSAGE_BYTES,
	Transports,
	WS_CLOSE_CONNECTION_LIMIT,
	WS_CLOSE_GOING_AWAY,
	WS_CLOSE_SESSION_REVOKED,
	utf8_length_over,
	type Transport
} from '#lib/actions/transports.ts';
import { DEFAULT_MAX_BODY_SIZE } from '#lib/server/app_server.ts';

const create_mock_transport = (name: string, ready = true): Transport => ({
	transport_name: name,
	send: async () => null as any,
	is_ready: () => ready
});

describe('WS_CLOSE_SESSION_REVOKED', () => {
	test('is 4001', () => {
		assert.strictEqual(WS_CLOSE_SESSION_REVOKED, 4001);
	});
});

describe('WS_CLOSE_CONNECTION_LIMIT', () => {
	// the Rust spine's `WS_CLOSE_CONNECTION_LIMIT` — a client reads one code from either backend
	test('is 4004', () => {
		assert.strictEqual(WS_CLOSE_CONNECTION_LIMIT, 4004);
	});
});

describe('WS_CLOSE_GOING_AWAY', () => {
	// the frontend client reconnects on it; 4001 would leave it revoked
	test('is 1001', () => {
		assert.strictEqual(WS_CLOSE_GOING_AWAY, 1001);
	});
});

describe('Transports', () => {
	test('starts with no transport', () => {
		const transports = new Transports();
		assert.isNull(transports.get_transport());
	});

	test('get_transport returns a ready transport', () => {
		const transports = new Transports();
		const t = create_mock_transport('http');
		transports.register_transport(t);
		assert.strictEqual(transports.get_transport(), t);
	});

	test('get_transport returns null when none is ready', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http', false));
		assert.isNull(transports.get_transport());
	});

	test('falls back from a not-ready default to another ready transport', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('ws', false));
		transports.register_transport(create_mock_transport('http', true));
		assert.strictEqual(transports.get_transport()?.transport_name, 'http');
	});

	test('prefers the named transport', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http'));
		transports.register_transport(create_mock_transport('ws'));
		assert.strictEqual(transports.get_transport('ws')?.transport_name, 'ws');
	});

	test('falls back from a not-ready named transport to the ready default', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http'));
		transports.register_transport(create_mock_transport('ws', false));
		assert.strictEqual(transports.get_transport('ws')?.transport_name, 'http');
	});

	describe('queue', () => {
		const queueing = (name: string, ready: boolean): Transport => ({
			...create_mock_transport(name, ready),
			queues: true
		});

		test('a queued request takes a not-ready named transport that queues', () => {
			const transports = new Transports();
			transports.register_transport(create_mock_transport('http'));
			transports.register_transport(queueing('ws', false));
			assert.strictEqual(transports.get_transport('ws', { queue: true })?.transport_name, 'ws');
			// without `queue` the call falls back to the ready one
			assert.strictEqual(transports.get_transport('ws')?.transport_name, 'http');
		});

		test('a transport that does not queue is never chosen while not ready', () => {
			const transports = new Transports();
			transports.register_transport(create_mock_transport('http'));
			transports.register_transport(create_mock_transport('ws', false));
			assert.strictEqual(transports.get_transport('ws', { queue: true })?.transport_name, 'http');
		});

		test('with no name, the queue rule applies to the default', () => {
			const transports = new Transports();
			transports.register_transport(queueing('ws', false));
			transports.register_transport(create_mock_transport('http'));
			assert.strictEqual(
				transports.get_transport(undefined, { queue: true })?.transport_name,
				'ws'
			);
			assert.strictEqual(transports.get_transport()?.transport_name, 'http');
		});
	});
});

describe('DEFAULT_WS_MAX_MESSAGE_BYTES', () => {
	test('equals the default HTTP body cap', () => {
		assert.strictEqual(DEFAULT_WS_MAX_MESSAGE_BYTES, DEFAULT_MAX_BODY_SIZE);
	});
});

describe('utf8_length_over', () => {
	test('returns null within the cap and the byte length over it', () => {
		assert.isNull(utf8_length_over('abc', 3));
		assert.strictEqual(utf8_length_over('abcd', 3), 4);
		assert.isNull(utf8_length_over('', 0));
	});

	test('measures UTF-8 bytes, not UTF-16 length', () => {
		assert.isNull(utf8_length_over('€€', 6));
		assert.strictEqual(utf8_length_over('€€', 5), 6);
		assert.strictEqual(utf8_length_over('😀', 3), 4);
		assert.isNull(utf8_length_over('😀', 4));
	});
});
