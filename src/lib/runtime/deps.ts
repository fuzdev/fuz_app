/**
 * Shared dependency interfaces for runtime operations.
 *
 * Small composable interfaces that functions accept for only the capabilities
 * they need. Both Deno and Node implementations satisfy all these interfaces
 * via `RuntimeDeps`.
 *
 * @module
 */

/**
 * Result of a stat operation.
 */
export interface StatResult {
	is_file: boolean;
	is_directory: boolean;
	/**
	 * Byte length of a regular file. Meaningful only when `is_file` is true; for
	 * directories it is runtime-defined (real OS `stat` reports the directory
	 * entry's on-disk size, not 0 — only `create_mock_runtime` reports 0).
	 * Populated by every runtime factory (`create_node_runtime` /
	 * `create_deno_runtime` / `create_mock_runtime`); optional so loose test
	 * stubs that only assert `is_file` / `is_directory` don't have to supply it.
	 * Callers that need an exact size (e.g. a streaming upload's
	 * `Content-Length`) read it from a real runtime, where it is always present.
	 */
	size?: number;
	/**
	 * Last-modification time in epoch milliseconds, when the runtime reports it.
	 * Populated by `create_node_runtime` / `create_deno_runtime`;
	 * `create_mock_runtime` omits it (so a mock-backed sweep treats every temp as
	 * unknown-age and never reaps). Optional so loose test stubs that only assert
	 * `is_file` / `is_directory` don't have to supply it. The orphan-temp sweep
	 * (`db/fact_disk_storage.ts`) reads it to age out stale `.tmp` spill files.
	 */
	mtime_ms?: number;
}

/**
 * Result of executing a command.
 *
 * `timed_out` is present only when `timeout_ms` was passed in `RunCommandOptions`
 * and the process was killed after exceeding the timeout. Callers that pass
 * `timeout_ms` should check this flag to distinguish timeout from exit-code failure.
 */
export interface CommandResult {
	success: boolean;
	code: number;
	stdout: string;
	stderr: string;
	timed_out?: boolean;
}

/**
 * Options for `run_command`.
 */
export interface RunCommandOptions {
	/** Working directory for the child process. */
	cwd?: string;
	/** AbortSignal to terminate the child process. */
	signal?: AbortSignal;
	/** Kill the process and return `timed_out: true` after this many milliseconds. */
	timeout_ms?: number;
}

/**
 * Environment variable access.
 */
export interface EnvDeps {
	/** Get an environment variable value. */
	env_get: (name: string) => string | undefined;
	/** Set an environment variable. */
	env_set: (name: string, value: string) => void;
}

/**
 * Result of reading text from a byte offset.
 */
export interface ReadTextFromOffsetResult {
	/** Decoded text content read from the offset. */
	content: string;
	/** Number of bytes actually read. */
	bytes_read: number;
	/** Total file size at the time of the read (for truncation detection). */
	file_size: number;
}

/**
 * File system read operations.
 */
export interface FsReadDeps {
	/** Get file/directory stats, or null if path doesn't exist. */
	stat: (path: string) => Promise<StatResult | null>;
	/** Read a file as text. Throws if the file does not exist. */
	read_text_file: (path: string) => Promise<string>;
	/** Read a file as bytes. Throws if the file does not exist. */
	read_file: (path: string) => Promise<Uint8Array>;
	/**
	 * Read text starting from a byte offset. Throws if the file does not exist.
	 *
	 * Returns `content`, `bytes_read`, and `file_size` so callers can detect
	 * truncation (when `file_size < offset`) and tail incrementally without
	 * re-reading the whole file.
	 */
	read_text_from_offset: (path: string, offset: number) => Promise<ReadTextFromOffsetResult>;
	/** List directory entries (names, not full paths). Throws if the directory does not exist. */
	readdir: (path: string) => Promise<Array<string>>;
}

/**
 * File system write operations.
 */
export interface FsWriteDeps {
	/** Create a directory. */
	mkdir: (path: string, options?: {recursive?: boolean}) => Promise<void>;
	/** Write text to a file. */
	write_text_file: (path: string, content: string) => Promise<void>;
	/** Write bytes to a file. */
	write_file: (path: string, data: Uint8Array) => Promise<void>;
	/** Rename (move) a file. */
	rename: (old_path: string, new_path: string) => Promise<void>;
	/**
	 * Flush a file's data to stable storage (fsync). Call on a temp file after
	 * writing it and *before* `rename`-ing it into place when the renamed path is
	 * later served without re-verification — otherwise a host crash after the
	 * rename can surface a torn/zero file as authentic content. The fact disk CAS
	 * (`db/fact_disk_storage.ts`) is the one such path; it twins the Rust
	 * `fuz_fact` §fsync posture (data-sync before rename; the parent-dir fsync
	 * stays deliberately waived — a lost dirent is regenerable under content
	 * addressing). Real runtimes open the path, fsync, and close;
	 * `create_mock_runtime` no-ops (it models no durability).
	 */
	fsync: (path: string) => Promise<void>;
}

/**
 * Streaming file I/O — read a file as a byte stream, or write a byte stream to
 * a file, both bounded in memory (peak ≈ one chunk, not the whole file).
 *
 * Kept separate from `FsReadDeps` / `FsWriteDeps` so the whole-buffer
 * `read_file` / `write_file` consumers and their partial test stubs are
 * unaffected; only the full runtime factories implement these. Used for
 * GB-scale artifact transfer (the `fuzf file get` / `put` path) where buffering
 * the whole file would OOM the client.
 */
export interface FsStreamDeps {
	/**
	 * Open a file as a `ReadableStream` of its bytes — read incrementally, so
	 * peak memory is one chunk rather than the whole file. Throws if the file
	 * does not exist. Use as a streaming upload body or for an incremental hash
	 * pass over a large file.
	 */
	read_file_stream: (path: string) => Promise<ReadableStream<Uint8Array>>;
	/**
	 * Write a `ReadableStream` of bytes to a file, consuming it with
	 * backpressure (peak memory is one chunk). Creates or truncates `path`.
	 * Throws on any I/O error; a partially-written file may remain, so callers
	 * needing atomicity write to a temp path then `rename`.
	 */
	write_file_stream: (path: string, data: ReadableStream<Uint8Array>) => Promise<void>;
}

/**
 * File system remove operations.
 */
export interface FsRemoveDeps {
	/** Remove a file or directory. */
	remove: (path: string, options?: {recursive?: boolean}) => Promise<void>;
}

/**
 * Command execution.
 */
export interface CommandDeps {
	/**
	 * Run a command and return the result. Never throws — failures surface as
	 * `success: false`.
	 *
	 * `options.cwd` sets the child's working directory. `options.signal` aborts
	 * the child when the signal fires. `options.timeout_ms` kills the child
	 * after the given duration and returns `timed_out: true` on the result.
	 */
	run_command: (
		cmd: string,
		args: Array<string>,
		options?: RunCommandOptions,
	) => Promise<CommandResult>;
}

/**
 * HTTP fetch capability.
 */
export interface FetchDeps {
	/** Fetch a URL. Same signature as the global `fetch`. */
	fetch: typeof globalThis.fetch;
}

/**
 * Warning/diagnostic output.
 */
export interface LogDeps {
	/** Log a warning message. */
	warn: (...args: Array<unknown>) => void;
}

/**
 * Terminal I/O operations.
 */
export interface TerminalDeps {
	/** Write bytes to stdout. */
	stdout_write: (data: Uint8Array) => Promise<number>;
	/** Read bytes from stdin, or null on EOF. */
	stdin_read: (buffer: Uint8Array) => Promise<number | null>;
}

/**
 * Process lifecycle.
 */
export interface ProcessDeps {
	/** Exit the process with a code. */
	exit: (code: number) => never;
}

/**
 * Full runtime capabilities returned by `create_deno_runtime` or `create_node_runtime`.
 *
 * Extends all `*Deps` interfaces with additional app-level capabilities.
 * Functions should accept narrow `*Deps` interfaces, not this full type —
 * this type is for the wiring layer that creates and passes the runtime.
 */
export interface RuntimeDeps
	extends
		EnvDeps,
		FsReadDeps,
		FsWriteDeps,
		FsStreamDeps,
		FsRemoveDeps,
		CommandDeps,
		FetchDeps,
		TerminalDeps,
		ProcessDeps,
		LogDeps {
	/** Get all environment variables. */
	env_all: () => Record<string, string>;
	/** CLI arguments passed to the program. */
	readonly args: ReadonlyArray<string>;
	/** Get current working directory. */
	cwd: () => string;
	/** Run a command with inherited stdout/stderr (output goes directly to terminal). */
	run_command_inherit: (cmd: string, args: Array<string>) => Promise<number>;
}
