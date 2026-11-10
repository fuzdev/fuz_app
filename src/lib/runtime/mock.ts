/**
 * Mock `RuntimeDeps` for testing.
 *
 * Provides a fully controllable runtime implementation for unit tests.
 * Consumer projects can extend `MockRuntime` with project-specific helpers
 * (e.g. `setup_mock_zap_config`) that stay local.
 *
 * @module
 */

import type {
	ProcessProbe,
	Program,
	ProgramFactory,
	ProgramOutput,
	RuntimeDeps,
	StatResult
} from './deps.ts';
import { assert_secure_mode, assert_secure_size } from './secure_file.ts';
import { assert_process_id } from './process_id.ts';

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
	/**
	 * Recorded POSIX modes (path -> mode), written by `write_text_file`'s
	 * `mode` option. A file with no recorded mode reads as `0o644` (the
	 * default-umask hazard) — so `read_secure_file` refuses it unless the
	 * writer asked for `0o600` explicitly, mirroring the real runtimes.
	 */
	mock_fs_modes: Map<string, number>;
	/** Mock directories that exist. */
	mock_dirs: Set<string>;
	/** Exit calls recorded (exit codes). */
	exit_calls: Array<number>;
	/**
	 * Processes `probe_process` finds (pid -> probe). A pid with no entry is
	 * `'not_found'`.
	 */
	mock_processes: Map<number, Exclude<ProcessProbe, 'not_found'>>;
	/** Stdout writes recorded. */
	stdout_writes: Array<string>;
	/** Stdin buffer for input simulation. */
	stdin_buffer: Uint8Array | null;
	/** Fetch calls recorded. */
	fetch_calls: Array<{ input: string | URL | Request; init?: RequestInit }>;
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
 * const runtime = create_mock_runtime(['apply', 'zap.ts']);
 * runtime.mock_env.set('HOME', '/home/test');
 * runtime.mock_fs.set('/home/test/.app/config.json', '{}');
 *
 * await some_function(runtime);
 *
 * assert.deepStrictEqual(runtime.exit_calls, [0]);
 * ```
 */
export const create_mock_runtime = (args: Array<string> = []): MockRuntime => {
	const mock_env: Map<string, string> = new Map();
	const mock_fs: Map<string, string> = new Map();
	const mock_fs_bytes: Map<string, Uint8Array> = new Map();
	const mock_fs_modes: Map<string, number> = new Map();
	const mock_dirs: Set<string> = new Set();
	const exit_calls: Array<number> = [];
	const mock_processes: Map<number, Exclude<ProcessProbe, 'not_found'>> = new Map();
	const stdout_writes: Array<string> = [];
	const fetch_calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
	const mock_fetch_responses: Map<string, Response> = new Map();
	let stdin_buffer: Uint8Array | null = null;

	const runtime: MockRuntime = {
		args,
		mock_env,
		mock_fs,
		mock_fs_bytes,
		mock_fs_modes,
		mock_dirs,
		exit_calls,
		mock_processes,
		stdout_writes,
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
		probe_process: (pid) => {
			assert_process_id(pid);
			return mock_processes.get(pid) ?? 'not_found';
		},

		// === Local File System ===
		stat: async (path): Promise<StatResult | null> => {
			const bytes = mock_fs_bytes.get(path);
			if (bytes !== undefined) {
				return { is_file: true, is_directory: false, size: bytes.length };
			}
			const text = mock_fs.get(path);
			if (text !== undefined) {
				return { is_file: true, is_directory: false, size: new TextEncoder().encode(text).length };
			}
			if (mock_dirs.has(path)) {
				return { is_file: false, is_directory: true, size: 0 };
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
		read_secure_file: async (path) => {
			let bytes = mock_fs_bytes.get(path);
			if (bytes === undefined) {
				const content = mock_fs.get(path);
				if (content !== undefined) bytes = new TextEncoder().encode(content);
			}
			if (bytes === undefined) {
				const error: NodeJS.ErrnoException = new Error(
					`ENOENT: no such file or directory: ${path}`
				);
				error.code = 'ENOENT';
				throw error;
			}
			// A file written without an explicit mode reads as 0o644 — the
			// default-umask hazard — so the secure read refuses it unless the
			// writer asked for 0600, mirroring the real runtimes (simulated
			// modes, so no platform gate).
			assert_secure_mode(path, mock_fs_modes.get(path) ?? 0o644);
			assert_secure_size(path, bytes.length);
			return bytes;
		},
		read_file_stream: async (path) => {
			let bytes = mock_fs_bytes.get(path);
			if (bytes === undefined) {
				const content = mock_fs.get(path);
				if (content !== undefined) bytes = new TextEncoder().encode(content);
			}
			if (bytes === undefined) {
				const error: NodeJS.ErrnoException = new Error(
					`ENOENT: no such file or directory: ${path}`
				);
				error.code = 'ENOENT';
				throw error;
			}
			// Single-chunk stream — the mock buffers in memory (fine for tests);
			// real runtimes stream incrementally.
			const data = bytes;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(data);
					controller.close();
				}
			});
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
						`ENOENT: no such file or directory: ${path}`
					);
					error.code = 'ENOENT';
					throw error;
				}
				bytes = new TextEncoder().encode(content);
			}
			const file_size = bytes.length;
			const bytes_to_read = Math.max(0, file_size - offset);
			if (bytes_to_read === 0) return { content: '', bytes_read: 0, file_size };
			const slice = bytes.subarray(offset, offset + bytes_to_read);
			return {
				content: new TextDecoder().decode(slice),
				bytes_read: slice.length,
				file_size
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
					`ENOENT: no such file or directory: ${path}`
				);
				error.code = 'ENOENT';
				throw error;
			}
			return Array.from(seen).sort();
		},
		write_text_file: async (path, content, options) => {
			if (options?.exclusive && (mock_fs.has(path) || mock_fs_bytes.has(path))) {
				const error: NodeJS.ErrnoException = new Error(`EEXIST: file already exists: ${path}`);
				error.code = 'EEXIST';
				throw error;
			}
			mock_fs.set(path, content);
			if (options?.mode !== undefined) mock_fs_modes.set(path, options.mode);
		},
		write_file: async (path, data) => {
			mock_fs_bytes.set(path, data);
		},
		write_file_stream: async (path, data) => {
			// Drain the stream into one buffer (the mock has no real disk;
			// real runtimes write incrementally with backpressure).
			const chunks: Array<Uint8Array> = [];
			let total = 0;
			const reader = data.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					chunks.push(value);
					total += value.length;
				}
			}
			const merged = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.length;
			}
			mock_fs_bytes.set(path, merged);
		},
		// The mock models no real disk, so durability is a no-op (mirrors how it
		// omits `mtime_ms`). The fact disk CAS sweep + fsync stay deps-based.
		fsync: async () => {},
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
			// the inode's mode travels with the rename (POSIX semantics)
			const mode = mock_fs_modes.get(old_path);
			if (mode !== undefined) {
				mock_fs_modes.set(new_path, mode);
				mock_fs_modes.delete(old_path);
			} else {
				mock_fs_modes.delete(new_path);
			}
		},
		remove: async (path, options) => {
			mock_fs.delete(path);
			mock_fs_bytes.delete(path);
			mock_fs_modes.delete(path);
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
			fetch_calls.push({ input, init });
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			for (const [pattern, response] of mock_fetch_responses) {
				if (url.includes(pattern)) return response.clone();
			}
			throw new TypeError(`fetch failed (no mock for ${url})`);
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
		warn: (..._args: Array<unknown>) => {}
	};

	return runtime;
};

/**
 * Reset a mock runtime to initial state.
 *
 * @mutates runtime - clears all mock state (env, fs, modes, dirs, processes, exit/stdout/fetch call records, fetch responses, stdin buffer)
 */
export const reset_mock_runtime = (runtime: MockRuntime): void => {
	runtime.mock_env.clear();
	runtime.mock_fs.clear();
	runtime.mock_fs_bytes.clear();
	runtime.mock_dirs.clear();
	runtime.exit_calls.length = 0;
	runtime.mock_fs_modes.clear();
	runtime.mock_processes.clear();
	runtime.stdout_writes.length = 0;
	runtime.fetch_calls.length = 0;
	runtime.mock_fetch_responses.clear();
	runtime.stdin_buffer = null;
};

/** A `Program` fake with its calls recorded for assertions. */
export interface MockProgram extends Program {
	/** The arguments of each call, in order. */
	readonly calls: Array<ReadonlyArray<string>>;
}

/**
 * Create a fake `Program` for testing a helper that runs one.
 *
 * Each call is recorded on `calls`, then answered by `respond`; with no
 * `respond`, every call exits 0 with empty output. `respond` may throw, as a
 * program that can't start does.
 *
 * @param respond - the output for a call's arguments
 * @returns the fake program
 *
 * @example
 * ```ts
 * const git = create_mock_program((args) =>
 * 	args[0] === 'status' ? mock_program_exit(0, '', 'clean') : mock_program_exit(1, 'unknown')
 * );
 * assert.strictEqual((await git.out(['status'])).stdout, 'clean');
 * assert.deepStrictEqual(git.calls, [['status']]);
 * ```
 */
export const create_mock_program = (
	respond: (args: ReadonlyArray<string>) => ProgramOutput | Promise<ProgramOutput> = () =>
		mock_program_exit(0)
): MockProgram => {
	const calls: Array<ReadonlyArray<string>> = [];
	return {
		calls,
		out: async (args) => {
			calls.push([...args]);
			return respond(args);
		}
	};
};

/** A `ProgramFactory` fake that hands out one program and records each environment asked for. */
export interface MockProgramFactory extends ProgramFactory {
	/** The `env` of each call, in order. */
	readonly envs: Array<Readonly<Record<string, string>>>;
	/** The program every call returns — `null` for one that isn't installed. */
	readonly program: MockProgram | null;
}

/**
 * Create a fake `ProgramFactory` for testing a helper that makes its program
 * with extra environment: every call records its `env` and returns `program`.
 *
 * @param program - the program to hand out, `null` for one that isn't installed
 * @returns the fake factory
 *
 * @example
 * ```ts
 * const createdb = create_mock_program_factory();
 * await create_database({createdb}, 'postgres://app:pw@localhost/app');
 * assert.deepStrictEqual(createdb.envs, [{PGPASSWORD: 'pw'}]);
 * assert.strictEqual(createdb.program?.calls.length, 1);
 * ```
 */
export const create_mock_program_factory = (
	program: MockProgram | null = create_mock_program()
): MockProgramFactory => {
	const envs: Array<Readonly<Record<string, string>>> = [];
	const factory = (env: Readonly<Record<string, string>>): Program | null => {
		envs.push({ ...env });
		return program;
	};
	return Object.assign(factory, { envs, program });
};

/**
 * A program output that exited with `code`.
 *
 * @param code - the exit code
 * @param stderr - what the program wrote to stderr
 * @param stdout - what the program wrote to stdout
 */
export const mock_program_exit = (code: number, stderr = '', stdout = ''): ProgramOutput => ({
	kind: 'exited',
	code,
	stdout,
	stderr
});

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
