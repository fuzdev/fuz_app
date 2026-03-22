/**
 * Deno implementation of `RuntimeDeps`.
 *
 * Provides `create_deno_runtime(args)` — a factory returning a `RuntimeDeps`
 * backed by Deno APIs. Only imported by Deno entry points (compiled binaries
 * for tx, zzz, etc.).
 *
 * @module
 */

import type {RuntimeDeps, StatResult, CommandResult} from './deps.js';

// Deno API declarations — this module is only imported by Deno consumers.
// Module-scoped declarations don't pollute the global type namespace.
declare const Deno: {
	env: {
		get: (name: string) => string | undefined;
		set: (name: string, value: string) => void;
		toObject: () => Record<string, string>;
	};
	cwd: () => string;
	exit: (code: number) => never;
	stat: (path: string) => Promise<{isFile: boolean; isDirectory: boolean}>;
	mkdir: (path: string, options?: {recursive?: boolean}) => Promise<void>;
	readTextFile: (path: string) => Promise<string>;
	writeTextFile: (path: string, content: string) => Promise<void>;
	rename: (oldPath: string, newPath: string) => Promise<void>;
	remove: (path: string, options?: {recursive?: boolean}) => Promise<void>;
	Command: new (
		cmd: string,
		options: {
			args: Array<string>;
			stdout: 'piped' | 'inherit';
			stderr: 'piped' | 'inherit';
		},
	) => {
		output: () => Promise<{
			code: number;
			stdout: Uint8Array;
			stderr: Uint8Array;
		}>;
	};
	stdout: {write: (data: Uint8Array) => Promise<number>};
	stdin: {read: (buffer: Uint8Array) => Promise<number | null>};
};

/**
 * Create a runtime backed by Deno APIs.
 *
 * Returns an object satisfying all `*Deps` interfaces from `deps.ts`.
 * Pass to shared functions that accept `EnvDeps`, `FsReadDeps`, etc.
 *
 * @param args - CLI arguments (typically `Deno.args`)
 * @returns runtime implementation using Deno APIs
 */
export const create_deno_runtime = (args: ReadonlyArray<string>): RuntimeDeps => ({
	// === Environment ===
	env_get: (name) => Deno.env.get(name),
	env_set: (name, value) => Deno.env.set(name, value),
	env_all: () => Deno.env.toObject(),

	// === Process ===
	args,
	cwd: () => Deno.cwd(),
	exit: (code) => Deno.exit(code),

	// === Local File System ===
	stat: async (path): Promise<StatResult | null> => {
		try {
			const s = await Deno.stat(path);
			return {is_file: s.isFile, is_directory: s.isDirectory};
		} catch {
			return null;
		}
	},
	mkdir: (path, options) => Deno.mkdir(path, options),
	read_file: (path) => Deno.readTextFile(path),
	write_file: (path, content) => Deno.writeTextFile(path, content),
	rename: (old_path, new_path) => Deno.rename(old_path, new_path),
	remove: (path, options) => Deno.remove(path, options),

	// === Local Commands ===
	run_command: async (cmd, args): Promise<CommandResult> => {
		try {
			const proc = new Deno.Command(cmd, {
				args,
				stdout: 'piped',
				stderr: 'piped',
			});
			const result = await proc.output();
			return {
				success: result.code === 0,
				code: result.code,
				stdout: new TextDecoder().decode(result.stdout),
				stderr: new TextDecoder().decode(result.stderr),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				code: 1,
				stdout: '',
				stderr: `Failed to execute command: ${message}`,
			};
		}
	},
	run_command_inherit: async (cmd, args): Promise<number> => {
		const proc = new Deno.Command(cmd, {
			args,
			stdout: 'inherit',
			stderr: 'inherit',
		});
		const result = await proc.output();
		return result.code;
	},

	// === Terminal I/O ===
	stdout_write: (data) => Deno.stdout.write(data),
	stdin_read: (buffer) => Deno.stdin.read(buffer),

	// === Logging ===
	warn: (...args) => console.warn(...args),
});
