/**
 * Tests for `spawn_backend`'s guards — the refusal of a port something already
 * holds, the stale daemon-token delete, the per-request health-probe timeout,
 * and the exit reporting — driven by tiny `node -e` children standing in for a
 * backend, never a real spine binary.
 *
 * @module
 */

import { afterEach, assert, describe, test, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	create_output_tail,
	is_port_accepting,
	spawn_backend
} from '#lib/testing/cross_backend/spawn_backend.ts';
import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';
import { in_process_capabilities } from '#lib/testing/cross_backend/capabilities.ts';

/**
 * A stand-in backend: `MODE` picks its behavior, `PORT` its port,
 * `TOKEN_PATH` where it writes its daemon token.
 *
 * - `exit_early` — writes a stderr marker and exits 3 without listening
 * - `silent` — accepts TCP connections and never answers
 * - `healthy_late_token` — answers every request 200, writes the token 300 ms after listening
 * - `healthy_then_exit` — answers 200, writes the token, then exits 7 with a stderr marker
 * - `orphan_grandchild` — spawns a long-lived grandchild, left in the child's process group,
 *   and exits 5 without listening once the grandchild is ready: the grandchild writes its pid
 *   to `GRANDCHILD_PID_PATH`, and on SIGTERM writes `GRANDCHILD_SIGTERM_PATH` and exits
 */

/** The grandchild `orphan_grandchild` leaves behind — its SIGTERM handler is set before it reports its pid. */
const GRANDCHILD = [
	"const fs = require('node:fs');",
	"process.on('SIGTERM', () => { fs.writeFileSync(process.env.GRANDCHILD_SIGTERM_PATH, ''); process.exit(0); });",
	'fs.writeFileSync(process.env.GRANDCHILD_PID_PATH, String(process.pid));',
	'setInterval(() => {}, 1000);'
].join(' ');
const STAND_IN = `
const GRANDCHILD = ${JSON.stringify(GRANDCHILD)};
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const child_process = require('node:child_process');
const {MODE, PORT, TOKEN_PATH, GRANDCHILD_PID_PATH} = process.env;
const write_token = (token) => fs.writeFileSync(TOKEN_PATH, JSON.stringify({token}));
if (MODE === 'exit_early') {
	process.stderr.write('early-exit-marker');
	process.exit(3);
} else if (MODE === 'orphan_grandchild') {
	child_process.spawn(process.execPath, ['-e', GRANDCHILD], { stdio: 'ignore' });
	// exit only once the grandchild can hear a SIGTERM
	const tick = new Int32Array(new SharedArrayBuffer(4));
	while (!fs.existsSync(GRANDCHILD_PID_PATH)) Atomics.wait(tick, 0, 0, 10);
	process.exit(5);
} else if (MODE === 'silent') {
	net.createServer(() => {}).listen(Number(PORT), '127.0.0.1');
} else {
	const server = http.createServer((req, res) => res.end('ok'));
	server.listen(Number(PORT), '127.0.0.1', () => {
		if (MODE === 'healthy_late_token') {
			setTimeout(() => write_token('fresh_token'), 300);
		} else {
			write_token('fresh_token');
			setTimeout(() => {
				process.stderr.write('late-exit-marker');
				process.exit(7);
			}, 300);
		}
	});
}
`;

let scratch_dirs: Array<string> = [];
let servers: Array<Server> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const server of servers) await new Promise((resolve) => server.close(resolve));
	servers = [];
	for (const dir of scratch_dirs) await rm(dir, { recursive: true, force: true });
	scratch_dirs = [];
});

/** Listen on an ephemeral loopback port; the server stays open until the test ends. */
const listen = async (): Promise<number> => {
	const server = createServer((socket) => socket.end());
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as { port: number }).port;
};

/** A loopback port nothing listens on — bound once to learn it, then released. */
const free_port = async (): Promise<number> => {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
};

const make_config = async (
	port: number,
	mode: string,
	overrides?: Partial<BackendConfig>
): Promise<BackendConfig> => {
	const root = await mkdtemp(join(tmpdir(), 'spawn_backend_test_'));
	scratch_dirs.push(root);
	const daemon_token_path = join(root, 'run', 'daemon_token');
	await mkdir(join(root, 'run'), { recursive: true });
	return {
		name: `stand_in_${mode}`,
		start_command: [process.execPath, '-e', STAND_IN],
		base_url: `http://127.0.0.1:${port}`,
		rpc_path: '/api/rpc',
		ws_path: '/api/ws',
		health_path: '/health',
		bootstrap_path: '/api/account/bootstrap',
		cookie_name: 'test_session',
		startup_timeout_ms: 5_000,
		env: {
			MODE: mode,
			PORT: String(port),
			TOKEN_PATH: daemon_token_path,
			GRANDCHILD_PID_PATH: join(root, 'grandchild_pid'),
			GRANDCHILD_SIGTERM_PATH: join(root, 'grandchild_sigterm')
		},
		bootstrap: {
			token_path: join(root, 'bootstrap_token'),
			token: 'bootstrap_token_value',
			username: 'keeper',
			password: 'keeper_password',
			daemon_token_path
		},
		capabilities: in_process_capabilities,
		...overrides
	};
};

/** Whether `pid` names a running process (signal 0 probes without signalling). */
const is_process_running = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof Error);
		return err;
	}
	assert.fail('expected a rejection');
};

describe('is_port_accepting', () => {
	test('reads a listening port as accepting and a released one as free', async () => {
		const port = await listen();
		assert.ok(await is_port_accepting(`http://127.0.0.1:${port}`));
		assert.ok(!(await is_port_accepting(`http://127.0.0.1:${await free_port()}`)));
	});
});

describe('create_output_tail', () => {
	test('keeps everything under the cap', () => {
		const tail = create_output_tail(16);
		tail.push(Buffer.from('abc'));
		tail.push(Buffer.from('def'));
		assert.strictEqual(tail.text(), 'abcdef');
	});

	test('keeps only the last max_bytes and marks the drop', () => {
		const tail = create_output_tail(4);
		tail.push(Buffer.from('abcdef'));
		tail.push(Buffer.from('gh'));
		assert.strictEqual(tail.text(), '[earlier output dropped]\nefgh');
	});
});

describe('spawn_backend', () => {
	test('refuses a port that already accepts connections, before spawning or writing anything', async () => {
		const port = await listen();
		const config = await make_config(port, 'healthy_late_token');
		const error = await rejection(spawn_backend(config));
		assert.include(error.message, `${config.base_url} already accepts connections`);
		assert.include(error.message, 'another cross run or a stale backend?');
		assert.ok(!existsSync(config.bootstrap.token_path), 'the bootstrap token was not written');
	});

	test('reports the exit code and stderr tail of a child that exits before it is healthy, once', async () => {
		const error_log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const config = await make_config(await free_port(), 'exit_early');
		const error = await rejection(spawn_backend(config));
		assert.include(error.message, 'exited (code=3) before becoming healthy');
		assert.include(error.message, 'early-exit-marker');
		// the rejection is the report; the after-startup exit log stays silent
		assert.strictEqual(error_log.mock.calls.length, 0);
	});

	test('a listener that accepts and never answers fails at the startup deadline', async () => {
		// a deadline under one probe's own timeout, so the probe must be cut to
		// the time left
		const config = await make_config(await free_port(), 'silent', { startup_timeout_ms: 300 });
		const started_at = Date.now();
		const error = await rejection(spawn_backend(config));
		const elapsed = Date.now() - started_at;
		assert.include(error.message, 'timed out after 300ms');
		assert.ok(elapsed < 1_500, `took ${elapsed}ms`);
	});

	test("teardown takes the child's process group, a grandchild outliving the child included", async () => {
		const config = await make_config(await free_port(), 'orphan_grandchild');
		const pid_path = config.env.GRANDCHILD_PID_PATH!;
		const read_grandchild_pid = async (): Promise<number | null> => {
			try {
				return Number(await readFile(pid_path, 'utf-8'));
			} catch {
				return null;
			}
		};
		try {
			const error = await rejection(spawn_backend(config));
			assert.include(error.message, 'exited (code=5) before becoming healthy');
			const grandchild_pid = await read_grandchild_pid();
			assert.ok(grandchild_pid !== null && grandchild_pid > 0, 'the child spawned a grandchild');
			assert.ok(!is_process_running(grandchild_pid), 'the grandchild was torn down with the group');
			// by teardown's SIGTERM, not only the SIGKILL escalation
			assert.ok(existsSync(config.env.GRANDCHILD_SIGTERM_PATH!), 'the grandchild received SIGTERM');
		} finally {
			// never leave the grandchild running, whatever the assertions found
			const grandchild_pid = await read_grandchild_pid();
			if (grandchild_pid !== null && is_process_running(grandchild_pid)) {
				process.kill(grandchild_pid, 'SIGKILL');
			}
		}
	});

	test('a crashed backend whose group is empty is never signalled again', async () => {
		const config = await make_config(await free_port(), 'healthy_then_exit');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const handle = await spawn_backend(config);
		await new Promise((resolve) => handle.child.once('exit', resolve));
		// the group's id is a pid the kernel may reuse by now
		const kill = vi.spyOn(process, 'kill');
		await handle.teardown();
		const group_signals = kill.mock.calls.filter(([pid]) => pid === -handle.child.pid!);
		assert.deepStrictEqual(group_signals, []);
	});

	test('a command that does not exist fails startup at once, naming it, and tears down at once', async () => {
		const command = join(tmpdir(), 'spawn_backend_test_no_such_command');
		const config = await make_config(await free_port(), 'exit_early', {
			start_command: [command]
		});
		const started_at = Date.now();
		const error = await rejection(spawn_backend(config));
		const elapsed = Date.now() - started_at;
		assert.include(error.message, 'failed to spawn');
		assert.include(error.message, command);
		// the health wait's next probe, and a teardown with nothing to wait for
		assert.ok(elapsed < 1_000, `took ${elapsed}ms`);
	});

	test("deletes a previous run's daemon token, so only the spawned binary's is read", async () => {
		const config = await make_config(await free_port(), 'healthy_late_token');
		await writeFile(config.bootstrap.daemon_token_path, JSON.stringify({ token: 'stale_token' }));
		const handle = await spawn_backend(config);
		try {
			assert.strictEqual(handle.daemon_token, 'fresh_token');
		} finally {
			await handle.teardown();
		}
	});

	test('logs an exit after startup that teardown did not cause, and not one it did', async () => {
		const error_log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const config = await make_config(await free_port(), 'healthy_then_exit');
		const handle = await spawn_backend(config);
		await new Promise((resolve) => handle.child.once('exit', resolve));
		await handle.teardown();
		assert.strictEqual(error_log.mock.calls.length, 1);
		const message = String(error_log.mock.calls[0]![0]);
		assert.include(message, 'backend exited unexpectedly (code=7)');
		assert.include(message, 'late-exit-marker');

		error_log.mockClear();
		const quiet = await spawn_backend(await make_config(await free_port(), 'healthy_late_token'));
		await quiet.teardown();
		assert.strictEqual(error_log.mock.calls.length, 0, 'a teardown exit is not logged');
	});
});
