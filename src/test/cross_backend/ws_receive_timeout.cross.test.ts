/**
 * Cross-backend WebSocket receive-timeout gate for fuz_app's own spine.
 *
 * Runs against BOTH impls — the TS spine (Node + in-memory pglet) and the
 * Rust `testing_spine_stub` (real Postgres) — spawned by the dual-spawn
 * `global_setup_timing.ts` with the WS endpoints' receive timeout shortened.
 * An admitted socket that sends nothing more is closed with
 * `WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT` and its reason, no sooner than the
 * timeout after its last frame; one that sends a `heartbeat` every few hundred
 * ms stays open past twice the timeout.
 *
 * The close deadline is generous against a slow machine yet far under the
 * 60 s default (`DEFAULT_WS_RECEIVE_TIMEOUT`), so a backend that ignored the
 * shortened timeout fails here. The lower bound holds however slow the client
 * is: the clock starts before the socket opens, so before the server last
 * heard from it.
 *
 * Runs under the dedicated `cross_backend_timing` project: a shortened receive
 * timeout would close the standard suites' idle sockets mid-case.
 *
 * @module
 */

import { assert, describe, inject, test } from 'vitest';

import { heartbeat_action_spec } from '#lib/actions/heartbeat.ts';
import {
	WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT,
	WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON
} from '#lib/actions/transports.ts';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
	type ReconstructedBootstrappedBackendHandle
} from '#lib/testing/cross_backend/setup.ts';
import { open_session_ws } from '#lib/testing/cross_backend/ws_endpoint.ts';

import './cross_test_types.ts';

const ts = reconstruct_bootstrapped_handle(inject('timing_handle_a'));
const rust = reconstruct_bootstrapped_handle(inject('timing_handle_b'));
const receive_timeout_ms = inject('timing_ws_receive_timeout_ms');

/** How long a silent socket may stay open — generous, and far under the 60 s default. */
const SILENT_CLOSE_DEADLINE_MS = 10_000;

/** How often the chatty socket sends a `heartbeat` — well inside the receive timeout. */
const HEARTBEAT_EVERY_MS = 300;

/** How long the chatty socket must stay open — past twice the receive timeout. */
const CHATTY_OPEN_MS = 2 * receive_timeout_ms + 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const describe_ws_receive_timeout_tests = (
	handle: ReconstructedBootstrappedBackendHandle
): void => {
	const setup_test = default_cross_process_setup(handle);
	const target = { base_url: handle.config.base_url, ws_path: handle.config.ws_path };

	test('a silent socket closes with the heartbeat-timeout code and reason', async () => {
		const fixture = await setup_test();
		const started = performance.now();
		// admitted: the admission `heartbeat` is the socket's last frame
		const ws = await open_session_ws(target, fixture, { admitted: true });
		try {
			const closed = await ws.wait_for_close(SILENT_CLOSE_DEADLINE_MS);
			const elapsed = performance.now() - started;
			assert.ok(closed, `the silent socket was still open after ${SILENT_CLOSE_DEADLINE_MS} ms`);
			assert.deepStrictEqual(
				{ code: ws.close_code, reason: ws.close_reason },
				{
					code: WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT,
					reason: WS_CLOSE_SERVER_HEARTBEAT_TIMEOUT_REASON
				}
			);
			assert.ok(
				elapsed >= receive_timeout_ms,
				`closed after ${Math.round(elapsed)} ms, before the ${receive_timeout_ms} ms receive timeout`
			);
		} finally {
			await ws.close();
		}
	});

	test('a socket sending heartbeats stays open past twice the timeout', async () => {
		const fixture = await setup_test();
		const ws = await open_session_ws(target, fixture, { admitted: true });
		try {
			const started = performance.now();
			// sent on a fixed cadence, not after the previous answer, so a slow
			// round trip never stretches the gap between frames
			const responses: Array<Promise<unknown>> = [];
			for (let id = 1; HEARTBEAT_EVERY_MS * id < CHATTY_OPEN_MS; id++) {
				await sleep(started + HEARTBEAT_EVERY_MS * id - performance.now());
				assert.strictEqual(ws.close_code, null, `closed before heartbeat ${id}`);
				const response = ws.request(`heartbeat_${id}`, heartbeat_action_spec.method, {});
				// awaited below; handled now so an early failure is no unhandled rejection
				response.catch(() => {});
				responses.push(response);
			}
			await sleep(started + CHATTY_OPEN_MS - performance.now());
			assert.strictEqual(ws.close_code, null, 'the chatty socket stays open');
			await Promise.all(responses);
		} finally {
			await ws.close();
		}
	});
};

describe('TS spine (node)', () => {
	describe_ws_receive_timeout_tests(ts);
});

describe('Rust spine_stub', () => {
	describe_ws_receive_timeout_tests(rust);
});
