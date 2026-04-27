/**
 * Mock `RuntimeDeps` for testing.
 *
 * Provides a fully controllable runtime implementation for unit tests.
 * Consumer projects can extend `MockRuntime` with project-specific helpers
 * (e.g. `setup_mock_tx_config`) that stay local.
 *
 * @module
 */

import type {RuntimeDeps, StatResult, CommandResult, RunCommandOptions} from './deps.js';

/* eslint-disable @typescript-eslint/require-await */

/**
 * Mock `RuntimeDeps` with observable state for assertions.
 */
export interface MockRuntime extends RuntimeDeps {
	/** Mock environment variables. */
	mock_env: Map<string, string>;
	/** Mock file system (path -> content). */
	mock_fs: Map<string, string>;
	/** Mock binary file system (path -> bytes). */
	mock_fs_bytes: Map<string, Uint8Array>;
	/** Mock directories that exist. */
	mock_dirs: Set<string>;
	/** Exit calls recorded (exit codes). */
	exit_calls: Array<number>;
	/** Commands executed. Captures `options` when passed so tests can assert cwd/timeout/signal. */
	command_calls: Array<{cmd: string; args: Array<string>; options?: RunCommandOptions}>;
	/** Commands executed with inherit. */
	command_inherit_calls: Array<{cmd: string; args: Array<string>}>;
	/** Stdout writes recorded. */
	stdout_writes: Array<string>;
	/** Mock command results (cmd -> result). */
	mock_command_results: Map<string, CommandResult>;
	/** Stdin buffer for input simulation. */
	stdin_buffer: Uint8Array | null;
	/** Fetch calls recorded. */
	fetch_calls: Array<{input: string | URL | Request; init?: RequestInit}>;
	/** Mock fetch responses (URL substring -> Response). */
	mock_fetch_responses: Map<string, Response>;
}

/**
 * Create a mock `RuntimeDeps` for testing.
 *
 * The mock `exit` records the code on `exit_calls` and throws `MockExitError`
 * (so the never-returning contract holds in tests). `fetch` throws `TypeError`
 * when no `mock_fetch_responses` pattern matches the request URL.
 *
 * @returns `MockRuntime` with controllable state
 *
 * @example
 * ```ts
 * const runtime = create_mock_runtime(['apply', 'tx.ts']);
 * runtime.mock_env.set('HOME', '/home/test');
 * runtime.mock_fs.set('/home/test/.app/config.json', '{}');
 *
 * await some_function(runtime);
 *
 * assert.strictEqual(runtime.command_calls.length, 1);
 * assert.deepStrictEqual(runtime.exit_calls, [0]);
 * ```
 */
export const create_mock_runtime = (args: Array<string> = []): MockRuntime => {
	const mock_env: Map<string, string> = new Map();
	const mock_fs: Map<string, string> = new Map();
	const mock_fs_bytes: Map<string, Uint8Array> = new Map();
	const mock_dirs: Set<string> = new Set();
	const exit_calls: Array<number> = [];
	const command_calls: Array<{cmd: string; args: Array<string>; options?: RunCommandOptions}> = [];
	const command_inherit_calls: Array<{cmd: string; args: Array<string>}> = [];
	const stdout_writes: Array<string> = [];
	const mock_command_results: Map<string, CommandResult> = new Map();
	const fetch_calls: Array<{input: string | URL | Request; init?: RequestInit}> = [];
	const mock_fetch_responses: Map<string, Response> = new Map();
	let stdin_buffer: Uint8Array | null = null;

	const runtime: MockRuntime = {
		args,
		mock_env,
		mock_fs,
		mock_fs_bytes,
		mock_dirs,
		exit_calls,
		command_calls,
		command_inherit_calls,
		stdout_writes,
		mock_command_results,
		fetch_calls,
		mock_fetch_responses,
		get stdin_buffer() {
			return stdin_buffer;
		},
		set stdin_buffer(value: Uint8Array | null) {
			stdin_buffer = value;
		},

		// === Environment ===
		env_get: (name) => mock_env.get(name),
		env_set: (name, value) => {
			mock_env.set(name, value);
		},
		env_all: () => Object.fromEntries(mock_env),

		// === Process ===
		cwd: () => '/mock/cwd',
		exit: (code) => {
			exit_calls.push(code);
			throw new MockExitError(code);
		},

		// === Local File System ===
		stat: async (path): Promise<StatResult | null> => {
			if (mock_fs.has(path) || mock_fs_bytes.has(path)) {
				return {is_file: true, is_directory: false};
			}
			if (mock_dirs.has(path)) {
				return {is_file: false, is_directory: true};
			}
			return null;
		},
		mkdir: async (path, options) => {
			if (options?.recursive) {
				const parts = path.split('/').filter(Boolean);
				let current = '';
				for (const part of parts) {
					current += '/' + part;
					mock_dirs.add(current);
				}
			} else {
				mock_dirs.add(path);
			}
		},
		read_text_file: async (path) => {
			const content = mock_fs.get(path);
			if (content !== undefined) return content;
			const bytes = mock_fs_bytes.get(path);
			if (bytes !== undefined) return new TextDecoder().decode(bytes);
			const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory: ${path}`);
			error.code = 'ENOENT';
			throw error;
		},
		read_file: async (path) => {
			const bytes = mock_fs_bytes.get(path);
			if (bytes !== undefined) return bytes;
			const content = mock_fs.get(path);
			if (content !== undefined) return new TextEncoder().encode(content);
			const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory: ${path}`);
			error.code = 'ENOENT';
			throw error;
		},
		read_text_from_offset: async (path, offset) => {
			let bytes: Uint8Array;
			const stored_bytes = mock_fs_bytes.get(path);
			if (stored_bytes !== undefined) {
				bytes = stored_bytes;
			} else {
				const content = mock_fs.get(path);
				if (content === undefined) {
					const error: NodeJS.ErrnoException = new Error(
						`ENOENT: no such file or directory: ${path}`,
					);
					error.code = 'ENOENT';
					throw error;
				}
				bytes = new TextEncoder().encode(content);
			}
			const file_size = bytes.length;
			const bytes_to_read = Math.max(0, file_size - offset);
			if (bytes_to_read === 0) return {content: '', bytes_read: 0, file_size};
			const slice = bytes.subarray(offset, offset + bytes_to_read);
			return {
				content: new TextDecoder().decode(slice),
				bytes_read: slice.length,
				file_size,
			};
		},
		readdir: async (path) => {
			const prefix = path.endsWith('/') ? path : path + '/';
			const seen: Set<string> = new Set();
			const collect = (key: string): void => {
				if (!key.startsWith(prefix)) return;
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf('/');
				seen.add(slash === -1 ? rest : rest.slice(0, slash));
			};
			for (const key of mock_fs.keys()) collect(key);
			for (const key of mock_fs_bytes.keys()) collect(key);
			for (const key of mock_dirs) collect(key);
			if (seen.size === 0 && !mock_dirs.has(path)) {
				const error: NodeJS.ErrnoException = new Error(
					`ENOENT: no such file or directory: ${path}`,
				);
				error.code = 'ENOENT';
				throw error;
			}
			return Array.from(seen).sort();
		},
		write_text_file: async (path, content) => {
			mock_fs.set(path, content);
		},
		write_file: async (path, data) => {
			mock_fs_bytes.set(path, data);
		},
		rename: async (old_path, new_path) => {
			const content = mock_fs.get(old_path);
			if (content !== undefined) {
				mock_fs.set(new_path, content);
				mock_fs.delete(old_path);
			}
			const bytes = mock_fs_bytes.get(old_path);
			if (bytes !== undefined) {
				mock_fs_bytes.set(new_path, bytes);
				mock_fs_bytes.delete(old_path);
			}
		},
		remove: async (path, options) => {
			mock_fs.delete(path);
			mock_fs_bytes.delete(path);
			mock_dirs.delete(path);
			if (options?.recursive) {
				const prefix = path.endsWith('/') ? path : path + '/';
				for (const key of mock_fs.keys()) {
					if (key.startsWith(prefix)) mock_fs.delete(key);
				}
				for (const key of mock_fs_bytes.keys()) {
					if (key.startsWith(prefix)) mock_fs_bytes.delete(key);
				}
				for (const key of mock_dirs) {
					if (key.startsWith(prefix)) mock_dirs.delete(key);
				}
			}
		},

		// === HTTP ===
		fetch: async (input, init) => {
			fetch_calls.push({input: input as string | URL | Request, init});
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			for (const [pattern, response] of mock_fetch_responses) {
				if (url.includes(pattern)) return response.clone();
			}
			throw new TypeError(`fetch failed (no mock for ${url})`);
		},

		// === Local Commands ===
		run_command: async (cmd, args, options) => {
			command_calls.push(options ? {cmd, args, options} : {cmd, args});

			const key = `${cmd} ${args.join(' ')}`;
			const mocked = mock_command_results.get(key);
			if (mocked) {
				if (options?.timeout_ms !== undefined && mocked.timed_out === undefined) {
					return {...mocked, timed_out: false};
				}
				return mocked;
			}

			const result: CommandResult = {success: true, code: 0, stdout: '', stderr: ''};
			if (options?.timeout_ms !== undefined) result.timed_out = false;
			return result;
		},
		run_command_inherit: async (cmd, args) => {
			command_inherit_calls.push({cmd, args});

			const key = `${cmd} ${args.join(' ')}`;
			const mocked = mock_command_results.get(key);
			if (mocked) return mocked.code;

			return 0;
		},

		// === Terminal I/O ===
		stdout_write: async (data) => {
			stdout_writes.push(new TextDecoder().decode(data));
			return data.length;
		},
		stdin_read: async (buffer) => {
			if (stdin_buffer === null) return null;
			const len = Math.min(buffer.length, stdin_buffer.length);
			buffer.set(stdin_buffer.subarray(0, len));
			stdin_buffer = null;
			return len;
		},

		// === Logging ===
		warn: (..._args: Array<unknown>) => {}, // eslint-disable-line @typescript-eslint/no-empty-function
	};

	return runtime;
};

/**
 * Reset a mock runtime to initial state.
 *
 * @mutates runtime - clears all mock state (env, fs, dirs, exit/command/stdout/fetch call records, mock results, stdin buffer)
 */
export const reset_mock_runtime = (runtime: MockRuntime): void => {
	runtime.mock_env.clear();
	runtime.mock_fs.clear();
	runtime.mock_fs_bytes.clear();
	runtime.mock_dirs.clear();
	runtime.exit_calls.length = 0;
	runtime.command_calls.length = 0;
	runtime.command_inherit_calls.length = 0;
	runtime.stdout_writes.length = 0;
	runtime.mock_command_results.clear();
	runtime.fetch_calls.length = 0;
	runtime.mock_fetch_responses.clear();
	runtime.stdin_buffer = null;
};

/**
 * Set stdin buffer for simulating user input.
 *
 * @param input - string to provide as stdin input
 * @mutates `runtime.stdin_buffer`
 */
export const set_mock_stdin = (runtime: MockRuntime, input: string): void => {
	runtime.stdin_buffer = new TextEncoder().encode(input);
};

/**
 * Error thrown when mock `runtime.exit()` is called.
 *
 * Tests can catch this to verify exit behavior.
 */
export class MockExitError extends Error {
	readonly code: number;

	constructor(code: number) {
		super(`exit(${code})`);
		this.name = 'MockExitError';
		this.code = code;
	}
}
