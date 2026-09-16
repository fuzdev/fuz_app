/**
 * Tests for transports.ts — Transport interface and Transports registry.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { Transports, WS_CLOSE_SESSION_REVOKED, type Transport } from '$lib/actions/transports.ts';

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

describe('Transports', () => {
	test('starts with no transport', () => {
		const transports = new Transports();
		assert.isNull(transports.get_current_transport());
		assert.isNull(transports.get_transport());
	});

	test('register sets current transport', () => {
		const transports = new Transports();
		const t = create_mock_transport('http');
		transports.register_transport(t);

		assert.strictEqual(transports.get_current_transport(), t);
		assert.strictEqual(transports.get_current_transport_name(), 'http');
	});

	test('get_transport returns ready transport', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http'));

		assert.ok(transports.get_transport());
	});

	test('get_transport returns null when not ready', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http', false));

		assert.isNull(transports.get_transport());
	});

	test('fallback to other ready transport', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('ws', false));
		transports.register_transport(create_mock_transport('http', true));

		const t = transports.get_transport();
		assert.ok(t);
		assert.strictEqual(t.transport_name, 'http');
	});

	test('no fallback when disabled', () => {
		const transports = new Transports();
		transports.allow_fallback = false;
		transports.register_transport(create_mock_transport('ws', false));
		transports.register_transport(create_mock_transport('http', true));

		// Current transport is ws (first registered), which is not ready
		assert.isNull(transports.get_transport());
	});

	test('set_current_transport switches active transport', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http'));
		transports.register_transport(create_mock_transport('ws'));

		transports.set_current_transport('ws');
		assert.strictEqual(transports.get_current_transport_name(), 'ws');
	});

	test('set_current_transport throws for unregistered name', () => {
		const transports = new Transports();
		assert.throws(() => transports.set_current_transport('unknown'), /not registered/);
	});

	test('get_transport_by_name returns specific transport', () => {
		const transports = new Transports();
		const http = create_mock_transport('http');
		transports.register_transport(http);

		assert.strictEqual(transports.get_transport_by_name('http'), http);
		assert.isNull(transports.get_transport_by_name('ws'));
	});

	test('is_ready returns null with no transport', () => {
		const transports = new Transports();
		assert.isNull(transports.is_ready());
	});

	test('is_ready reflects current transport state', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http', true));
		assert.ok(transports.is_ready());
	});

	test('get_transport prefers specified transport name', () => {
		const transports = new Transports();
		transports.register_transport(create_mock_transport('http'));
		transports.register_transport(create_mock_transport('ws'));

		const t = transports.get_transport('ws');
		assert.ok(t);
		assert.strictEqual(t.transport_name, 'ws');
	});
});
