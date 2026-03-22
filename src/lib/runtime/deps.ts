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
}

/**
 * Result of executing a command.
 */
export interface CommandResult {
	success: boolean;
	code: number;
	stdout: string;
	stderr: string;
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
 * File system read operations.
 */
export interface FsReadDeps {
	/** Get file/directory stats, or null if path doesn't exist. */
	stat: (path: string) => Promise<StatResult | null>;
	/** Read a file as text. */
	read_file: (path: string) => Promise<string>;
}

/**
 * File system write operations.
 */
export interface FsWriteDeps {
	/** Create a directory. */
	mkdir: (path: string, options?: {recursive?: boolean}) => Promise<void>;
	/** Write text to a file. */
	write_file: (path: string, content: string) => Promise<void>;
	/** Rename (move) a file. */
	rename: (old_path: string, new_path: string) => Promise<void>;
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
	/** Run a command and return the result. */
	run_command: (cmd: string, args: Array<string>) => Promise<CommandResult>;
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
		FsRemoveDeps,
		CommandDeps,
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
