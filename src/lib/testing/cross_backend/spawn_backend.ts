import '../assert_dev_env.ts';

/**
 * Spawn a test backend binary, wait for it to come up, and return a
 * handle the test harness drives.
 *
 * Lifecycle:
 *
 * 1. Write the bootstrap token (`config.bootstrap.token`) to
 *    `config.bootstrap.token_path` so the binary picks it up at startup.
 * 2. `child_process.spawn(...)` the binary with `detached: true` —
 *    creates a new process group so a `SIGTERM` to the negative PID
 *    tears down any descendants the binary spawned (PTYs, child
 *    workers). vitest worker death + Ctrl+C handlers also fire the
 *    group teardown so ports never strand.
 * 3. Poll `{base_url}{health_path}` until it returns 2xx or
 *    `startup_timeout_ms` elapses.
 * 4. Read `config.bootstrap.daemon_token_path` to load the binary's
 *    deterministic daemon token; thread it onto `BackendHandle` so
 *    `_testing_reset` and other keeper-credential calls can authenticate.
 *
 * Bootstrapping (`POST /api/account/bootstrap`) is a separate concern —
 * the caller composes `bootstrap()` from `testing/transports/bootstrap.ts`
 * against a `FetchTransport` built around `handle.config.base_url`.
 * Splitting the two keeps `spawn_backend` consumer-agnostic — fuz_app
 * knows nothing about specific binary contents.
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { BackendConfig } from './backend_config.ts';

/* eslint-disable @typescript-eslint/no-base-to-string */

/** Handle returned by `spawn_backend` — passed to per-test setup helpers. */
export interface BackendHandle {
	/** The config used to spawn this backend. Carried for diagnostic + downstream access. */
	readonly config: BackendConfig;
	/** Child process reference — exposed for diagnostic logging only. */
	readonly child: ChildProcess;
	/**
	 * Deterministic daemon token captured from
	 * `config.bootstrap.daemon_token_path` after the binary booted.
	 * `default_cross_process_setup` builds keeper-daemon-token headers
	 * from this for `_testing_reset` calls.
	 */
	readonly daemon_token: string;
	/**
	 * SIGTERM the child's process group, drain stderr, await exit. Idempotent —
	 * calls after the first are no-ops.
	 */
	readonly teardown: () => Promise<void>;
}

/** Number of ms between health-probe attempts. Tuned to be cheap on busy CI runners. */
const HEALTH_PROBE_INTERVAL_MS = 100;

/**
 * Grace window after teardown's SIGTERM before escalating to SIGKILL on the
 * process group. A well-behaved backend exits within milliseconds; this only
 * fires for one that ignores SIGTERM or whose graceful shutdown never
 * completes (e.g. a runtime whose `server.stop()` promise never resolves), so
 * the await below can't strand the whole run forever.
 */
const TEARDOWN_SIGKILL_GRACE_MS = 3_000;

/**
 * Sleep helper for the probe loop. Resolves after `ms`.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `url` until it returns a 2xx response or `timeout_ms` elapses.
 * Network errors during the wait window are expected (binary not yet
 * listening) — they reset the loop, not throw.
 */
const wait_for_health = async (
	url: string,
	timeout_ms: number,
	is_alive: () => boolean
): Promise<void> => {
	const deadline = Date.now() + timeout_ms;
	let last_error: unknown;
	while (Date.now() < deadline) {
		if (!is_alive()) {
			throw new Error(
				`backend process exited before becoming healthy${
					last_error
						? ` (last probe error: ${(last_error as Error).message ?? String(last_error)})`
						: ''
				}`
			);
		}
		try {
			const response = await fetch(url);
			if (response.ok) {
				// Drain the body so the connection can be released back to
				// the agent pool — unconsumed bodies keep the socket open.
				await response.arrayBuffer().catch(() => undefined);
				return;
			}
			last_error = new Error(`status=${response.status}`);
		} catch (err) {
			last_error = err;
		}
		await sleep(HEALTH_PROBE_INTERVAL_MS);
	}
	throw new Error(
		`health probe to ${url} timed out after ${timeout_ms}ms (last error: ${
			last_error ? ((last_error as Error).message ?? String(last_error)) : 'none'
		})`
	);
};

/**
 * Process-level cleanup registry — every `spawn_backend` registers its
 * teardown here so vitest worker death or interactive Ctrl+C kills the
 * binaries before they strand ports.
 */
const live_teardowns: Set<() => void> = new Set();
let process_handlers_installed = false;

const install_process_handlers = (): void => {
	if (process_handlers_installed) return;
	process_handlers_installed = true;
	const fire_all = (): void => {
		for (const t of live_teardowns) {
			try {
				t();
			} catch {
				// Swallow — exit-time best-effort cleanup, errors here go nowhere.
			}
		}
		live_teardowns.clear();
	};
	process.on('exit', fire_all);
	// Re-emit signals after handling so the default behaviour (process exit)
	// still applies once we've torn down children.
	const passthrough_signal = (signal: NodeJS.Signals): void => {
		fire_all();
		// Restore default and re-raise so the process exits with the right code.
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	};
	process.on('SIGINT', () => passthrough_signal('SIGINT'));
	process.on('SIGTERM', () => passthrough_signal('SIGTERM'));
};

/**
 * Read the daemon token file. The file is `{"token": "<value>"}` JSON —
 * single canonical shape across every consumer's test binary.
 *
 * Retries briefly to cover the race between the binary becoming
 * health-probe-ready and writing the token file (some binaries write
 * the file inside a startup task that fires shortly after the readiness
 * signal). Bounded by `attempt_count` so a binary that never writes the
 * file surfaces as a clean error rather than hanging.
 *
 * @throws Error if the file never becomes readable within the retry
 *   window, or if the parsed contents don't match `{token: string}`.
 */
const read_daemon_token = async (path: string): Promise<string> => {
	const attempt_count = 50; // 50 × 20ms = 1s window
	const attempt_interval_ms = 20;
	let last_error: unknown;
	for (let i = 0; i < attempt_count; i++) {
		try {
			const raw = (await readFile(path, 'utf-8')).trim();
			if (raw.length > 0) {
				const parsed = JSON.parse(raw) as unknown;
				if (
					typeof parsed !== 'object' ||
					parsed === null ||
					!('token' in parsed) ||
					typeof (parsed as { token: unknown }).token !== 'string'
				) {
					throw new Error(`expected {token: string}, got ${raw}`);
				}
				return (parsed as { token: string }).token;
			}
		} catch (err) {
			last_error = err;
		}
		await sleep(attempt_interval_ms);
	}
	throw new Error(
		`daemon token file ${path} never became readable as {token: string} (last error: ${
			last_error ? ((last_error as Error).message ?? String(last_error)) : 'none'
		})`
	);
};

/**
 * Spawn `config.start_command` and return a handle once the binary is
 * health-probe-ready and the daemon-token file is readable.
 *
 * Errors at any stage SIGTERM the child group before rethrowing — the
 * caller never sees a half-started backend.
 */
export const spawn_backend = async (config: BackendConfig): Promise<BackendHandle> => {
	if (config.start_command.length === 0) {
		throw new Error(`spawn_backend(${config.name}): start_command is empty`);
	}

	// Write the bootstrap token file before spawn so the binary reads it
	// at boot.
	await mkdir(dirname(config.bootstrap.token_path), { recursive: true });
	await writeFile(config.bootstrap.token_path, config.bootstrap.token, { mode: 0o600 });

	install_process_handlers();

	const [command, ...args] = config.start_command;
	const child = spawn(command!, args, {
		env: { ...process.env, ...config.env },
		// Own process group so SIGTERM to the negative PID tears down the
		// binary's descendants too — Hono workers, PTY children, etc.
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	// Buffer stderr so a startup-time crash surfaces with context.
	const stderr_chunks: Array<Buffer> = [];
	child.stderr?.on('data', (chunk: Buffer) => {
		stderr_chunks.push(chunk);
	});

	// Drain stdout — discard, but the read is mandatory. `stdio: 'pipe'`
	// leaves the stream paused until something consumes it; an unread
	// pipe fills its OS buffer (~64KB pipe / ~208KB AF_UNIX socketpair on
	// Linux) and the child's next blocking write to stdout parks in the
	// kernel. A backend that logs synchronously to stdout (the default
	// `tracing_subscriber::fmt()` writer) then wedges its whole async
	// runtime: the writing worker holds stdout's lock while parked, every
	// other worker that logs blocks behind it, and even lock-free routes
	// like `/health` (which the request-tracing layer logs) hang. The
	// failure is volume- and time-dependent — it only surfaces after a
	// long run pumps more than a buffer's worth of `info` logs through one
	// long-lived binary — so it hides in short/isolated runs. We discard
	// rather than buffer (unlike stderr): stdout carries high-volume
	// operational logging whose unbounded retention would leak across a
	// long suite.
	child.stdout?.on('data', () => {});

	let exit_info: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	child.on('exit', (code, signal) => {
		exit_info = { code, signal };
	});

	const is_alive = (): boolean => exit_info === null;

	let teardown_invoked = false;
	const teardown_sync = (): void => {
		if (teardown_invoked) return;
		teardown_invoked = true;
		if (child.pid !== undefined && exit_info === null) {
			try {
				// Negative pid → process group.
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				// Already dead; ignore.
			}
		}
	};

	const teardown = async (): Promise<void> => {
		teardown_sync();
		live_teardowns.delete(teardown_sync);
		if (exit_info !== null) return;
		// Wait for the child to actually exit so callers can be sure the port
		// is free. A backend that ignores SIGTERM — or whose graceful shutdown
		// wedges (e.g. a runtime whose `server.stop()` never resolves) — would
		// otherwise hang this await forever and strand the run, so escalate to
		// SIGKILL on the process group after a grace window. SIGKILL is
		// uncatchable, so the child then exits and the `'exit'` listener
		// resolves. Defense-in-depth: the per-runtime adapter shutdown is the
		// primary fix; this guarantees teardown completes regardless.
		await new Promise<void>((resolve) => {
			const kill_timer = setTimeout(() => {
				if (child.pid !== undefined && exit_info === null) {
					try {
						// Negative pid → process group.
						process.kill(-child.pid, 'SIGKILL');
					} catch {
						// Already dead; ignore.
					}
				}
			}, TEARDOWN_SIGKILL_GRACE_MS);
			child.once('exit', () => {
				clearTimeout(kill_timer);
				resolve();
			});
		});
	};

	live_teardowns.add(teardown_sync);

	try {
		await wait_for_health(
			`${config.base_url}${config.health_path}`,
			config.startup_timeout_ms,
			is_alive
		);
		const daemon_token = await read_daemon_token(config.bootstrap.daemon_token_path);
		return { config, child, daemon_token, teardown };
	} catch (err) {
		await teardown();
		const stderr_dump = Buffer.concat(stderr_chunks).toString('utf-8');
		const stderr_tail = stderr_dump.length > 0 ? `\nstderr:\n${stderr_dump}` : '';
		throw new Error(
			`spawn_backend(${config.name}) failed: ${(err as Error).message}${stderr_tail}`
		);
	}
};
