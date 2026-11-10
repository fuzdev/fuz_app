/**
 * Shared dependency interfaces for runtime operations.
 *
 * Small composable interfaces that functions accept for only the capabilities
 * they need. `create_node_runtime` (Node and Bun) and `create_mock_runtime`
 * satisfy all these interfaces via `RuntimeDeps`.
 *
 * Running a program is not a `RuntimeDeps` member: a helper that spawns takes
 * each program it runs as its own `Program` handle, or a `ProgramFactory`
 * that makes one, from the composition root, so no helper resolves a command
 * name against the ambient `PATH` and environment.
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
	 * `create_mock_runtime`); optional so loose test
	 * stubs that only assert `is_file` / `is_directory` don't have to supply it.
	 * Callers that need an exact size (e.g. a streaming upload's
	 * `Content-Length`) read it from a real runtime, where it is always present.
	 */
	size?: number;
	/**
	 * Last-modification time in epoch milliseconds, when the runtime reports it.
	 * Populated by `create_node_runtime`; `create_mock_runtime` omits it (so a
	 * mock-backed sweep treats every temp as unknown-age and never reaps).
	 * Optional so loose test stubs that only assert `is_file` / `is_directory`
	 * don't have to supply it. The orphan-temp sweep
	 * (`db/fact_disk_storage.ts`) reads it to age out stale `.tmp` spill files.
	 */
	mtime_ms?: number;
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
 * Options for `FsWriteDeps.write_text_file`.
 */
export interface WriteFileOptions {
	/**
	 * POSIX mode applied at creation (e.g. `0o600`). Creation-time only — an
	 * existing file keeps its mode (pair with `exclusive` when the mode must
	 * hold). No-op where modes don't apply (mock runtime, Windows).
	 */
	mode?: number;
	/**
	 * Fail if the path already exists (`O_EXCL`). Load-bearing for secret
	 * files: without it a crash-leftover temp file is reopened `O_TRUNC` and
	 * keeps its old (possibly permissive) mode, since `mode` only applies at
	 * creation.
	 */
	exclusive?: boolean;
}

/**
 * Hardened read for secret files (bootstrap tokens, keys) — the TS twin of
 * the Rust spine's `fuz_sys::secure_file::load_secure_file`.
 */
export interface FsSecureReadDeps {
	/**
	 * Read a small secret file with fail-loud checks: rejects symlinks,
	 * non-regular files (FIFO, device, directory — real runtimes only; the mock
	 * has no file types), any group/other-accessible mode (must be `0600`/`0400`; skipped where POSIX
	 * modes don't apply), and files over a 4 KiB cap. Permission checks run on
	 * the open descriptor where the platform allows, so the file can't be
	 * swapped between check and read. Throws on any refusal — a refused secret
	 * must never degrade to an empty read.
	 */
	read_secure_file: (path: string) => Promise<Uint8Array>;
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
	/** Create a directory. `mode` applies at creation (no-op where modes don't apply). */
	mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<void>;
	/** Write text to a file. See `WriteFileOptions` for `mode` / `exclusive`. */
	write_text_file: (path: string, content: string, options?: WriteFileOptions) => Promise<void>;
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
	remove: (path: string, options?: { recursive?: boolean }) => Promise<void>;
}

/**
 * How a program run ended: exited with a code, ended by a signal, or stopped
 * after a timeout or an abort (with the code or signal it then ended by, the
 * other `null`).
 *
 * The shape of `SpawnResult` in `@fuzdev/gro/spawn.ts`, declared here so a
 * gro program handle satisfies `Program` without fuz_app depending on gro.
 */
export type ProgramResult =
	| { readonly kind: 'exited'; readonly code: number }
	| { readonly kind: 'signaled'; readonly signal: string }
	| {
			readonly kind: 'timed_out' | 'aborted';
			readonly code: number | null;
			readonly signal: string | null;
	  };

/** A program run's result with its captured output, as UTF-8 text. */
export type ProgramOutput = ProgramResult & {
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * The capability to run one program, resolved and given its environment by
 * whoever made it: the helper that holds it can run that program with
 * arguments it chooses, and nothing else.
 *
 * A gro `SpawnProgram` (`spawn.program(name, options)` or `spawn.find`, from
 * `@fuzdev/gro/spawn.ts`) satisfies it, built at a composition root that
 * decides which binary runs and which environment it gets. A program is
 * missing when `spawn.find` returns `null`, so a helper takes `Program | null`,
 * or a `ProgramFactory`, where a missing tool is something to report rather
 * than a bug.
 */
export interface Program {
	/**
	 * Run the program with `args` (argv only, never a shell string), stdin
	 * closed, and capture its output. A non-zero exit is a result, not a throw;
	 * a program that can't start throws.
	 */
	out: (args: ReadonlyArray<string>) => Promise<ProgramOutput>;
}

/**
 * Make a `Program` whose environment gains `env`, or `null` when the program
 * isn't installed — for a helper that learns at run time what the program's
 * environment must carry (a password read from a URL), where a gro handle's
 * environment is fixed when it's made. At a gro task root:
 * `(env) => spawn.find('createdb', {pass_env: ['PG*'], env})`, where `env`'s
 * values win over the ones `pass_env` forwards.
 */
export type ProgramFactory = (env: Readonly<Record<string, string>>) => Program | null;

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
 * Whether a process exists, as signal 0 reports it: `'running'`, `'not_permitted'`
 * (it exists, but this process may not signal it — another user's, `EPERM`),
 * or `'not_found'` (`ESRCH`).
 */
export type ProcessProbe = 'running' | 'not_permitted' | 'not_found';

/**
 * Process liveness, with no program spawned.
 */
export interface ProcessProbeDeps {
	/**
	 * Probe the process `pid` names by sending it signal 0, which checks that
	 * it exists and may be signaled and delivers nothing.
	 *
	 * @throws RangeError when `pid` is not a positive integer within `pid_t`
	 * range — 0 and negative numbers name process groups, never one process
	 */
	probe_process: (pid: number) => ProcessProbe;
}

/**
 * Full runtime capabilities returned by `create_node_runtime` or `create_mock_runtime`.
 *
 * Extends all `*Deps` interfaces with additional app-level capabilities.
 * Functions should accept narrow `*Deps` interfaces, not this full type —
 * this type is for the wiring layer that creates and passes the runtime.
 */
export interface RuntimeDeps
	extends
		EnvDeps,
		FsReadDeps,
		FsSecureReadDeps,
		FsWriteDeps,
		FsStreamDeps,
		FsRemoveDeps,
		FetchDeps,
		TerminalDeps,
		ProcessDeps,
		ProcessProbeDeps,
		LogDeps {
	/** Get all environment variables. */
	env_all: () => Record<string, string>;
	/** CLI arguments passed to the program. */
	readonly args: ReadonlyArray<string>;
	/** Get current working directory. */
	cwd: () => string;
}
