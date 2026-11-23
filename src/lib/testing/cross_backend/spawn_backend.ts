import '../assert_dev_env.ts';

/**
 * Spawn a test backend binary, wait for it to come up, and return a
 * handle the test harness drives.
 *
 * Lifecycle:
 *
 * 1. Refuse when `config.base_url`'s port already accepts a TCP connection —
 *    another cross run or a stale backend holds it, and the health probe
 *    would otherwise drive that process instead of the one spawned here.
 * 2. Write the bootstrap token (`config.bootstrap.token`) to
 *    `config.bootstrap.token_path` so the binary picks it up at startup, and
 *    delete any `config.bootstrap.daemon_token_path` a previous run left, so
 *    step 5 can only read the token this binary writes.
 * 3. `child_process.spawn(...)` the binary with `detached: true` —
 *    creates a new process group so a `SIGTERM` to the negative PID
 *    tears down any descendants the binary spawned (PTYs, child
 *    workers). vitest worker death + `SIGINT` / `SIGTERM` / `SIGHUP`
 *    handlers also fire the group teardown so ports never strand.
 * 4. Poll `{base_url}{health_path}` until it returns 2xx or
 *    `startup_timeout_ms` elapses — each probe bounded by its own timeout, so
 *    a listener that accepts but never answers can't outlast the deadline.
 * 5. Read `config.bootstrap.daemon_token_path` to load the binary's
 *    deterministic daemon token; thread it onto `BackendHandle` so
 *    `_testing_reset` and other keeper-credential calls can authenticate.
 * 6. Log one line with the time from spawn to step 5 done, so a run shows
 *    what each backend costs to bring up.
 *
 * The child's stderr is kept as a bounded tail (`STDERR_TAIL_MAX_BYTES`):
 * a startup failure reports it with the exit code or signal, and an exit
 * after startup that teardown didn't cause is logged with it. With
 * `config.log`, its stdout and stderr are also teed into `config.log.path`,
 * and teardown fails on each error-level line there that no
 * `config.log.allow_errors` entry matches (`backend_log.ts`).
 *
 * Teardown holds the backend to a clean exit: a spine whose graceful
 * shutdown gave up on work still running, or threw, exits `1` (the TS core's
 * `start_testing_server`, the Rust spine's `StartupError::ShutdownGivenUp`),
 * and `teardown` rejects on anything but exit code `0` — naming the backend,
 * its exit code or signal, and its stderr tail — as it does for a backend
 * that exited during the run or had to be killed.
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
import { createWriteStream, type WriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname } from 'node:path';

import type { BackendConfig } from './backend_config.ts';
import {
	create_log_line_splitter,
	find_unexpected_backend_errors,
	format_unexpected_backend_errors
} from './backend_log.ts';

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
	 * SIGTERM the child's process group — even when the child itself has
	 * exited, so no descendant outlives it — and await the group's exit,
	 * escalating to SIGKILL after a grace window. Idempotent — later calls
	 * await the same exit. A descendant that left the group — spawned detached,
	 * or one that called `setsid` — is out of reach and survives teardown.
	 *
	 * Rejects unless the child exited `0` on the SIGTERM: an exit code other
	 * than `0` (a shutdown that gave up or failed), an exit by signal (the
	 * SIGKILL escalation among them), an exit before teardown (already
	 * logged when it happened), or a group still running when teardown gave
	 * up. The error names the backend and the exit, with the stderr tail. With
	 * `config.log`, it also rejects on the error lines of the log no allowance
	 * names, listing them. The group is torn down either way.
	 */
	readonly teardown: () => Promise<void>;
}

/** Number of ms between health-probe attempts. Tuned to be cheap on busy CI runners. */
const HEALTH_PROBE_INTERVAL_MS = 100;

/**
 * Upper bound on one health-probe request (ms), further capped by the time
 * left before `startup_timeout_ms`. A backend answers `/health` in
 * milliseconds once it listens; this only fires for a listener that accepts
 * and never responds.
 */
const HEALTH_PROBE_REQUEST_TIMEOUT_MS = 2_000;

/** How long the pre-spawn port check waits for a TCP connection (ms). */
const PORT_PROBE_TIMEOUT_MS = 1_000;

/**
 * How much of the child's stderr is kept (bytes) — the tail a startup failure
 * or an unexpected exit reports. Bounded so a backend that logs to stderr for
 * a whole suite doesn't grow the runner's memory with it.
 */
export const STDERR_TAIL_MAX_BYTES = 16 * 1024;

/**
 * Grace window after teardown's SIGTERM before escalating to SIGKILL on the
 * process group. A well-behaved backend exits within milliseconds; this only
 * fires for one that ignores SIGTERM or whose graceful shutdown never
 * completes (e.g. a runtime whose `server.stop()` promise never resolves), so
 * the await below can't strand the whole run forever.
 */
const TEARDOWN_SIGKILL_GRACE_MS = 3_000;

/** How long teardown waits for the child's stdio to end before reading its log (ms). */
const LOG_DRAIN_WAIT_MS = 1_000;

/** How often teardown checks whether the process group has exited (ms). */
const TEARDOWN_POLL_INTERVAL_MS = 20;

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
	exit_status: () => string | null
): Promise<void> => {
	const deadline = Date.now() + timeout_ms;
	let last_error: unknown;
	while (Date.now() < deadline) {
		const exited = exit_status();
		if (exited !== null) {
			throw new Error(
				`backend process ${exited} before becoming healthy${
					last_error
						? ` (last probe error: ${(last_error as Error).message ?? String(last_error)})`
						: ''
				}`
			);
		}
		try {
			const request_timeout_ms = Math.max(
				1,
				Math.min(HEALTH_PROBE_REQUEST_TIMEOUT_MS, deadline - Date.now())
			);
			const response = await fetch(url, { signal: AbortSignal.timeout(request_timeout_ms) });
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
 * Whether something accepts TCP connections at `base_url`'s host and port.
 * A refused connection, an unresolvable host or no answer within
 * `PORT_PROBE_TIMEOUT_MS` all read as free.
 *
 * @param base_url - an `http://` or `https://` URL; a missing port is the scheme's default
 */
export const is_port_accepting = (base_url: string): Promise<boolean> => {
	const url = new URL(base_url);
	const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
	// `URL` keeps an IPv6 literal's brackets, which `connect` doesn't take
	const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const settle = (accepting: boolean): void => {
			socket.destroy();
			resolve(accepting);
		};
		socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
		socket.once('connect', () => settle(true));
		socket.once('error', () => settle(false));
	});
};

/**
 * A byte-bounded tail of a stream's output: keeps the last `max_bytes`
 * written, dropping the oldest.
 */
export interface OutputTail {
	readonly push: (chunk: Buffer) => void;
	/** The kept bytes as UTF-8, prefixed with a marker when older output was dropped. */
	readonly text: () => string;
}

/**
 * Create an `OutputTail` keeping at most `max_bytes`.
 *
 * @param max_bytes - how many trailing bytes to keep
 */
export const create_output_tail = (max_bytes: number): OutputTail => {
	let chunks: Array<Buffer> = [];
	let size = 0;
	let dropped = false;
	return {
		push: (chunk) => {
			chunks.push(chunk);
			size += chunk.length;
			if (size <= max_bytes) return;
			dropped = true;
			const joined = Buffer.concat(chunks).subarray(size - max_bytes);
			chunks = [joined];
			size = joined.length;
		},
		text: () => {
			const text = Buffer.concat(chunks).toString('utf-8');
			return dropped ? `[earlier output dropped]\n${text}` : text;
		}
	};
};

/**
 * How teardown's wait on the process group ended: the group exited on the
 * SIGTERM, exited only after the SIGKILL escalation, or was still running
 * when the wait gave up.
 */
type GroupExitWait = 'exited' | 'killed' | 'gave_up';

/** `code=N` or `signal=SIG` for a child's exit, as `ChildProcess`'s `'exit'` reports it. */
const format_exit = (code: number | null, signal: NodeJS.Signals | null): string =>
	signal !== null ? `signal=${signal}` : `code=${code}`;

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
	// a closed terminal: without a handler the default action kills the process
	// before `'exit'` runs, and the detached backends would keep their ports
	process.on('SIGHUP', () => passthrough_signal('SIGHUP'));
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
					typeof parsed.token !== 'string'
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
 *
 * @throws Error when `config.base_url`'s port already accepts connections,
 *   before anything is spawned; when the child exits before it is healthy
 *   (with its exit code or signal and stderr tail); or when the health probe
 *   or the daemon-token read times out
 */
export const spawn_backend = async (config: BackendConfig): Promise<BackendHandle> => {
	if (config.start_command.length === 0) {
		throw new Error(`spawn_backend(${config.name}): start_command is empty`);
	}

	// a process already on the port would answer the health probe and every
	// request after it, so the run would drive it instead of this spawn
	if (await is_port_accepting(config.base_url)) {
		throw new Error(
			`spawn_backend(${config.name}): ${config.base_url} already accepts connections — ` +
				'another cross run or a stale backend?'
		);
	}

	// Write the bootstrap token file before spawn so the binary reads it
	// at boot.
	await mkdir(dirname(config.bootstrap.token_path), { recursive: true });
	await writeFile(config.bootstrap.token_path, config.bootstrap.token, { mode: 0o600 });
	// a token a previous run left would read as this binary's
	await rm(config.bootstrap.daemon_token_path, { force: true });

	install_process_handlers();

	// the log file, rewritten per spawn, opened before the child so no output is missed
	let log_stream: WriteStream | null = null;
	let log_write_error: Error | null = null;
	if (config.log) {
		await mkdir(dirname(config.log.path), { recursive: true });
		log_stream = createWriteStream(config.log.path, { flags: 'w' });
		// a failed open or write (a full disk) fails teardown, never the process
		log_stream.on('error', (error) => {
			log_write_error ??= error;
		});
	}
	// whole lines only, per stream (`create_log_line_splitter`)
	const log_line_writer = (): { write: (chunk: Buffer) => void; flush: () => void } => {
		const splitter = create_log_line_splitter();
		return {
			write: (chunk) => {
				if (!log_stream || log_stream.writableEnded || log_write_error) return;
				const lines = splitter.push(chunk);
				if (lines !== '') log_stream.write(lines);
			},
			flush: () => {
				const rest = splitter.end();
				if (log_stream && !log_stream.writableEnded && !log_write_error && rest !== '') {
					log_stream.write(rest);
				}
			}
		};
	};
	const stdout_log = log_line_writer();
	const stderr_log = log_line_writer();
	let log_stream_closing: Promise<void> | null = null;
	const log_stream_closed = (): Promise<void> =>
		(log_stream_closing ??= new Promise((resolve) => {
			if (!log_stream || log_stream.closed || log_stream.destroyed) {
				resolve();
				return;
			}
			stdout_log.flush();
			stderr_log.flush();
			// `'close'` follows a failed stream too, which never calls back `end`'s callback
			log_stream.once('close', () => resolve());
			log_stream.end();
		}));

	const [command, ...args] = config.start_command;
	const spawned_at = performance.now();
	const child = spawn(command!, args, {
		env: { ...process.env, ...config.env },
		// Own process group so SIGTERM to the negative PID tears down the
		// binary's descendants too — Hono workers, PTY children, etc.
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	// Keep a bounded stderr tail so a crash surfaces with context.
	const stderr_tail = create_output_tail(STDERR_TAIL_MAX_BYTES);
	// `'close'` follows the exit once the child's stdio has ended, so its last
	// output is in the log file before teardown reads it
	const child_closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
	child.stderr?.on('data', (chunk: Buffer) => {
		stderr_tail.push(chunk);
		stderr_log.write(chunk);
	});
	const format_stderr_tail = (): string => {
		const text = stderr_tail.text();
		return text.length > 0 ? `\nstderr:\n${text}` : '';
	};

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
	// long suite. The log file, when configured, is on disk, not in memory.
	child.stdout?.on('data', (chunk: Buffer) => {
		stdout_log.write(chunk);
	});

	// how the child ended: an exit, or a spawn that never produced a process
	// (a command that doesn't exist emits `'error'` and never `'exit'`)
	let exit_info:
		| { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
		| { kind: 'spawn_error'; message: string }
		| null = null;
	let started = false;
	let teardown_invoked = false;
	// an exit after startup that teardown didn't cause — a teardown failure
	let exited_during_run = false;

	// The child leads its own process group (`detached: true`), so its pid is
	// the group id; a descendant stays in the group after the child exits. Once
	// the group is seen empty it is never signalled again: its id is a pid the
	// kernel may hand to an unrelated process, whose new group a later
	// `kill(-pid)` would hit — say a backend that crashed mid-run, torn down
	// minutes later. One window stays open: a crash that left a descendant
	// running keeps the flag false, and if that descendant exits on its own,
	// the next signal goes out before its ESRCH sets the flag. Closing it needs
	// a pidfd, which Node lacks.
	let group_gone = false;
	const signal_group = (signal: NodeJS.Signals | 0): boolean => {
		if (child.pid === undefined || group_gone) return false;
		try {
			// Negative pid → process group.
			process.kill(-child.pid, signal);
			return true;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			// ESRCH: no process is left in the group; EPERM: one is, but not ours
			// to signal
			if (code === 'ESRCH') group_gone = true;
			return code === 'EPERM';
		}
	};

	child.on('exit', (code, signal) => {
		exit_info = { kind: 'exit', code, signal };
		// a crash that left no descendant marks the group gone now, before its
		// id can be reused
		signal_group(0);
		// a startup failure is reported by the throw below; an exit teardown
		// caused is expected
		if (started && !teardown_invoked) {
			exited_during_run = true;
			console.error(
				`spawn_backend(${config.name}): backend exited unexpectedly (${format_exit(code, signal)})` +
					format_stderr_tail()
			);
		}
	});
	child.on('error', (err) => {
		if (child.pid === undefined) {
			// never spawned — the health wait below reports it
			exit_info ??= { kind: 'spawn_error', message: err.message };
		} else {
			// Node emits `'error'` on a spawned child only from `child.kill()` or
			// `child.send()`, neither of which this module calls (it signals the
			// group through `process.kill`), so this branch is not expected to run;
			// it logs rather than recording an exit, since `'exit'` still follows
			console.error(`spawn_backend(${config.name}): ${err.message}`);
		}
	});

	const exit_status = (): string | null => {
		if (exit_info === null) return null;
		return exit_info.kind === 'spawn_error'
			? `failed to spawn (${exit_info.message})`
			: `exited (${format_exit(exit_info.code, exit_info.signal)})`;
	};

	/** Whether the child or any process left in its group is still running. */
	const is_group_running = (): boolean =>
		child.pid !== undefined && (exit_info === null || signal_group(0));

	const teardown_sync = (): void => {
		if (teardown_invoked) return;
		teardown_invoked = true;
		// the group, not just the child: a descendant outlives a child that has
		// already exited, and would hold the port or the database
		signal_group('SIGTERM');
	};

	/** Tear the group down, resolving how the wait ended; never rejects. */
	let stopped: Promise<GroupExitWait> | null = null;
	const stop = (): Promise<GroupExitWait> => {
		teardown_sync();
		live_teardowns.delete(teardown_sync);
		return (stopped ??= wait_for_group_exit());
	};

	/** Why the child's exit was not the clean one teardown requires, or `null`. */
	const describe_unclean_exit = (wait: GroupExitWait): string | null => {
		if (wait === 'gave_up') {
			return `teardown gave up with the process group still running ${TEARDOWN_SIGKILL_GRACE_MS}ms after SIGKILL`;
		}
		if (exit_info === null) return 'never exited';
		if (exit_info.kind === 'spawn_error') return `failed to spawn (${exit_info.message})`;
		const exit = format_exit(exit_info.code, exit_info.signal);
		if (exited_during_run) return `exited during the run (${exit}), before teardown`;
		const clean = exit_info.signal === null && exit_info.code === 0;
		// ahead of the clean check: a child that exited 0 can leave its group
		// running, and the SIGKILL that ended the group is still a failure
		if (wait === 'killed') {
			return clean
				? `exited (${exit}) at teardown, but its process group outlived it and was killed ` +
						`${TEARDOWN_SIGKILL_GRACE_MS}ms after SIGTERM — a descendant that did not exit on SIGTERM`
				: `exited (${exit}) at teardown — its shutdown did not finish within ` +
						`${TEARDOWN_SIGKILL_GRACE_MS}ms of SIGTERM, so its group was killed`;
		}
		if (clean) return null;
		if (exit_info.signal !== null) {
			return (
				`died by ${exit} at teardown — the process did not handle SIGTERM ` +
				'(a wrapper that dies by the signal, e.g. `gro run`)'
			);
		}
		return `exited (${exit}) at teardown, not code=0 — a shutdown that gave up on work still running or failed`;
	};

	let teardown_done: Promise<void> | null = null;
	/** The log's error lines no allowance names, as a failure message, or `null`. */
	const check_log = async (): Promise<string | null> => {
		if (!config.log) return null;
		// bounded: a descendant that left the group can hold the pipe open
		await Promise.race([child_closed, sleep(LOG_DRAIN_WAIT_MS)]);
		await log_stream_closed();
		if (log_write_error) {
			return `spawn_backend(${config.name}): its log ${config.log.path} failed to write: ${log_write_error.message}`;
		}
		const unexpected = find_unexpected_backend_errors(
			await readFile(config.log.path, 'utf-8'),
			config.log.allow_errors
		);
		return unexpected.length === 0
			? null
			: format_unexpected_backend_errors(config.name, config.log.path, unexpected);
	};

	const teardown = (): Promise<void> =>
		(teardown_done ??= stop().then(async (wait) => {
			const unclean = describe_unclean_exit(wait);
			const log_problem = await check_log();
			const problems = [
				...(unclean === null
					? []
					: [`spawn_backend(${config.name}): ${unclean}${format_stderr_tail()}`]),
				...(log_problem === null ? [] : [log_problem])
			];
			if (problems.length > 0) throw new Error(problems.join('\n\n'));
		}));

	// Wait for the child and every process left in its group to exit, so callers
	// can be sure the port is free. A backend that ignores SIGTERM — or whose
	// graceful shutdown wedges (e.g. a runtime whose `server.stop()` never
	// resolves) — would otherwise hold this wait forever and strand the run, so
	// escalate to SIGKILL on the process group after a grace window. SIGKILL is
	// uncatchable, so the group then exits. Defense-in-depth: the per-runtime
	// adapter shutdown is the primary fix; this guarantees teardown completes
	// regardless — bounded at a second grace window after the SIGKILL, which
	// only a process stuck in the kernel outlasts.
	const wait_for_group_exit = async (): Promise<GroupExitWait> => {
		const kill_at = Date.now() + TEARDOWN_SIGKILL_GRACE_MS;
		const give_up_at = kill_at + TEARDOWN_SIGKILL_GRACE_MS;
		let killed = false;
		while (is_group_running()) {
			const now = Date.now();
			if (now >= give_up_at) return 'gave_up';
			if (!killed && now >= kill_at) {
				killed = true;
				signal_group('SIGKILL');
			}
			await sleep(TEARDOWN_POLL_INTERVAL_MS);
		}
		return killed ? 'killed' : 'exited';
	};

	live_teardowns.add(teardown_sync);

	try {
		await wait_for_health(
			`${config.base_url}${config.health_path}`,
			config.startup_timeout_ms,
			exit_status
		);
		const daemon_token = await read_daemon_token(config.bootstrap.daemon_token_path);
		started = true;
		console.log(
			`spawn_backend(${config.name}): healthy in ${Math.round(performance.now() - spawned_at)}ms`
		);
		return { config, child, daemon_token, teardown };
	} catch (err) {
		// the startup failure is the report, whatever the exit
		await stop();
		await log_stream_closed();
		throw new Error(
			`spawn_backend(${config.name}) failed: ${(err as Error).message}${format_stderr_tail()}`
		);
	}
};
