/**
 * A clean shutdown finishes the request in flight: a TS spine binary stopped
 * while a request's body is still arriving answers that request once the rest
 * of the body lands, then exits `0`.
 *
 * Teardown's exit-`0` check can't see this on its own: a runtime adapter that
 * resets the connections still open (Bun's `server.stop(true)`) loses the
 * response and exits `0` all the same. So the request here is written over a
 * raw socket in two halves, with the SIGTERM between them.
 *
 * Runs under the TS spine projects alone (`TS_ONLY_CROSS_TESTS` in
 * `cross_backend_projects.ts`), spawning a spine of its own on the project's
 * runtime: stopping the project's shared backend would end every other file's
 * run.
 *
 * @module
 */

import { connect } from 'node:net';
import { assert, test } from 'vitest';

import { account_verify_action_spec } from '#lib/auth/account_action_specs.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { inject_backend_handle } from '#lib/testing/cross_backend/provided_context.ts';
import { spawn_backend } from '#lib/testing/cross_backend/spawn_backend.ts';
import {
	ts_spine_bun_backend_config,
	ts_spine_node_backend_config
} from '#lib/testing/cross_backend/ts_spine_backend_config.ts';

import { CROSS_PROJECT_RESOURCES } from './cross_backend_projects.ts';

/**
 * How long the first half of the request sits before the SIGTERM, and the
 * SIGTERM before the second half (ms): long enough for the server to have
 * accepted the request and to be into its shutdown, far short of the drain
 * bound.
 */
const HALF_BODY_WAIT_MS = 300;

/** How long the whole exchange may take before the test gives up (ms). */
const EXCHANGE_TIMEOUT_MS = 10_000;

const node = CROSS_PROJECT_RESOURCES.cross_backend_ts_node;
const bun = CROSS_PROJECT_RESOURCES.cross_backend_ts_bun;

/** The short-lived spine's config, by the project's backend name. */
const SHUTDOWN_CONFIGS: Record<string, () => BackendConfig> = {
	[node.node.name]: () =>
		ts_spine_node_backend_config({ name: node.shutdown.name, port: node.shutdown.port }),
	[bun.bun.name]: () =>
		ts_spine_bun_backend_config({ name: bun.shutdown.name, port: bun.shutdown.port })
};

const project_backend = inject_backend_handle().config.name;
const create_config = SHUTDOWN_CONFIGS[project_backend];
if (create_config === undefined) {
	throw new Error(
		`shutdown_in_flight.cross.test.ts: no shutdown spine for backend '${project_backend}'`
	);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('a SIGTERM mid-request answers the request, then exits 0', async () => {
	const config = create_config();
	const handle = await spawn_backend(config);
	// set by the socket's connect handler, which sends the SIGTERM
	const sigterm: { teardown: Promise<void> | null } = { teardown: null };
	try {
		const { hostname, port } = new URL(config.base_url);
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: account_verify_action_spec.method
		});
		const half = Math.floor(body.length / 2);
		const received = await new Promise<string>((resolve, reject) => {
			const socket = connect(Number(port), hostname);
			let data = '';
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`no end to the exchange in ${EXCHANGE_TIMEOUT_MS}ms`));
			}, EXCHANGE_TIMEOUT_MS);
			socket.setEncoding('latin1');
			socket.on('data', (chunk: string) => (data += chunk));
			// a reset ends the exchange like a close: what arrived is the answer
			socket.on('error', () => {});
			socket.on('close', () => {
				clearTimeout(timer);
				resolve(data);
			});
			socket.on('connect', () => {
				socket.write(
					`POST ${config.rpc_path} HTTP/1.1\r\n` +
						`Host: ${hostname}:${port}\r\n` +
						'Content-Type: application/json\r\n' +
						`Content-Length: ${body.length}\r\n` +
						'Connection: close\r\n\r\n' +
						body.slice(0, half)
				);
				void (async () => {
					await sleep(HALF_BODY_WAIT_MS);
					sigterm.teardown = handle.teardown();
					await sleep(HALF_BODY_WAIT_MS);
					socket.write(body.slice(half));
				})();
			});
		});
		const status_line = received.slice(0, received.indexOf('\r\n'));
		assert.strictEqual(
			status_line,
			'HTTP/1.1 401 Unauthorized',
			`the request in flight is answered (received ${JSON.stringify(received.slice(0, 200))})`
		);
		const response_body = JSON.parse(received.slice(received.indexOf('\r\n\r\n') + 4)) as {
			error?: { code?: number };
		};
		assert.strictEqual(response_body.error?.code, JSONRPC_ERROR_CODES.unauthenticated);
		assert.ok(sigterm.teardown, 'the SIGTERM was sent');
		// rejects unless the spine exited 0 on the SIGTERM
		await sigterm.teardown;
	} finally {
		await (sigterm.teardown ?? handle.teardown()).catch(() => {});
	}
});
