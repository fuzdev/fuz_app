/**
 * Tests for the `outbound_queue_bytes` option of a `ws_endpoints` entry: the
 * auto-created transport gets the default budget, an override reaches it, and
 * a budget that could never hold a frame fails assembly.
 *
 * Assembles over a stub backend — no database — and drives the mounted
 * transport directly. The budget's own rules are in
 * `actions/ws_outbound_writer.test.ts` and
 * `actions/transports_ws_backend.outbound.test.ts`.
 *
 * @module
 */

import { afterEach, assert, describe, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { create_uuid } from '#lib/primitive_schemas.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';
import {
	create_app_server,
	type AppServer,
	type AppServerOptions
} from '#lib/server/app_server.ts';
import { create_stub_app_backend, create_stub_app_deps } from '#lib/testing/stubs.ts';
import { create_loopback_app_server_options } from '#lib/testing/app_server.ts';
import { create_recording_audit_emitter } from '#lib/testing/audit_drift_guard.ts';
import { create_fake_ws, create_stub_upgrade } from '#lib/testing/ws_round_trip.ts';
import { protocol_actions } from '#lib/actions/protocol.ts';
import {
	BackendWebsocketTransport,
	DEFAULT_WS_OUTBOUND_QUEUE_BYTES
} from '#lib/actions/transports_ws_backend.ts';
import { WS_CLOSE_OUTBOUND_OVERFLOW } from '#lib/actions/transports.ts';
import type { WsEndpointSpec } from '#lib/actions/ws_endpoint_spec.ts';
import { OUTBOUND_FRAME_OVERHEAD_BYTES } from '#lib/realtime/outbound_budget.ts';

const log = new Logger('test', { level: 'off' });

// every server a test assembles is closed, whatever the test asserted
const servers: Array<AppServer> = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()));
});

const assemble = async (endpoint: Partial<WsEndpointSpec>): Promise<AppServer> => {
	const deps = create_stub_app_deps();
	// accepts the listener the WS auth guard registers
	deps.audit = create_recording_audit_emitter().emitter;
	const options: AppServerOptions = {
		...create_loopback_app_server_options(),
		backend: create_stub_app_backend({ deps }),
		session_options: create_session_config('test_session'),
		create_route_specs: () => [create_health_route_spec()],
		create_upgrade_websocket: () => create_stub_upgrade().upgradeWebSocket,
		ws_endpoints: [
			{ path: '/api/ws', actions: [...protocol_actions], receive_timeout: null, ...endpoint }
		]
	};
	const server = await create_app_server(options);
	servers.push(server);
	return server;
};

/**
 * How many `bytes`-long frames a fresh connection on `transport` takes in one
 * synchronous run before one closes it for an overflow.
 */
const frames_until_overflow = (transport: BackendWebsocketTransport, bytes: number): number => {
	const fake = create_fake_ws();
	const id = transport.add_connection(fake.ws, null, create_uuid());
	const frame = 'x'.repeat(bytes);
	let accepted = 0;
	while (transport.send_to(id, frame)) accepted++;
	assert.strictEqual(fake.closes[0]?.code, WS_CLOSE_OUTBOUND_OVERFLOW);
	return accepted;
};

describe('WsEndpointSpec.outbound_queue_bytes', () => {
	test('the auto-created transport applies the default budget', async () => {
		const server = await assemble({});
		const transport = server.ws_endpoints['/api/ws']!;
		const frame_bytes = 1024 * 1024 - OUTBOUND_FRAME_OVERHEAD_BYTES;
		// one frame straight through, then the default budget's worth waiting
		assert.strictEqual(
			frames_until_overflow(transport, frame_bytes),
			1 + DEFAULT_WS_OUTBOUND_QUEUE_BYTES / (1024 * 1024)
		);
	});

	test('an override reaches the transport the mount creates', async () => {
		const server = await assemble({
			outbound_queue_bytes: 3 * (10 + OUTBOUND_FRAME_OVERHEAD_BYTES)
		});
		// one frame straight through, then exactly three waiting
		assert.strictEqual(frames_until_overflow(server.ws_endpoints['/api/ws']!, 10), 4);
	});

	test('zero or a non-positive budget fails assembly', async () => {
		for (const bad of [0, -1, 0.5]) {
			await assert_rejects(
				() => assemble({ outbound_queue_bytes: bad }),
				/outbound_queue_bytes must be a positive integer/
			);
		}
	});

	test('a budget beside a supplied transport fails assembly', async () => {
		await assert_rejects(
			() =>
				assemble({
					transport: new BackendWebsocketTransport({ log }),
					outbound_queue_bytes: 1024
				}),
			/outbound_queue_bytes configures the transport created for \/api\/ws/
		);
	});
});
