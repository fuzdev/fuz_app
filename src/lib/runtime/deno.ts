/**
 * Deno implementation of `RuntimeDeps`.
 *
 * Provides `create_deno_runtime(args)` — a factory returning a `RuntimeDeps`
 * backed by Deno APIs. Only imported by Deno entry points (compiled binaries
 * for tx, zzz, etc.).
 *
 * @module
 */

import {to_error_message} from '@fuzdev/fuz_util/error.ts';

import type {RuntimeDeps, StatResult, CommandResult} from './deps.ts';

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
	stat: (
		path: string,
	) => Promise<{isFile: boolean; isDirectory: boolean; size: number; mtime: Date | null}>;
	mkdir: (path: string, options?: {recursive?: boolean}) => Promise<void>;
	readTextFile: (path: string) => Promise<string>;
	readFile: (path: string) => Promise<Uint8Array>;
	readDir: (path: string) => AsyncIterable<{name: string}>;
	open: (
		path: string,
		options?: {read?: boolean; write?: boolean; create?: boolean; truncate?: boolean},
	) => Promise<{
		read: (buf: Uint8Array) => Promise<number | null>;
		seek: (offset: number, whence: number) => Promise<number>;
		sync: () => Promise<void>;
		close: () => void;
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	}>;
	SeekMode: {Start: number};
	writeTextFile: (path: string, content: string) => Promise<void>;
	writeFile: (path: string, data: Uint8Array) => Promise<void>;
	rename: (oldPath: string, newPath: string) => Promise<void>;
	remove: (path: string, options?: {recursive?: boolean}) => Promise<void>;
	Command: new (
		cmd: string,
		options: {
			args: Array<string>;
			cwd?: string;
			signal?: AbortSignal;
			stdout: 'piped' | 'inherit';
			stderr: 'piped' | 'inherit';
		},
	) => {
		spawn: () => {
			status: Promise<{code: number; success: boolean}>;
			stdout: ReadableStream<Uint8Array>;
			stderr: ReadableStream<Uint8Array>;
			kill: (signal?: string) => void;
		};
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
 * Returns an object satisfying all `*Deps` interfaces from `runtime/deps.ts`.
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
			return {
				is_file: s.isFile,
				is_directory: s.isDirectory,
				size: s.size,
				mtime_ms: s.mtime?.getTime(),
			};
		} catch {
			return null;
		}
	},
	mkdir: (path, options) => Deno.mkdir(path, options),
	read_text_file: (path) => Deno.readTextFile(path),
	read_file: (path) => Deno.readFile(path),
	read_file_stream: async (path) => (await Deno.open(path, {read: true})).readable,
	write_file_stream: async (path, data) => {
		const file = await Deno.open(path, {write: true, create: true, truncate: true});
		// `pipeTo` closes the writable (and so the underlying file) on completion
		// and aborts it on error — no manual `close()` needed.
		await data.pipeTo(file.writable);
	},
	read_text_from_offset: async (path, offset) => {
		const s = await Deno.stat(path);
		const file_size = s.size;
		const bytes_to_read = Math.max(0, file_size - offset);
		if (bytes_to_read === 0) return {content: '', bytes_read: 0, file_size};
		const handle = await Deno.open(path, {read: true});
		try {
			await handle.seek(offset, Deno.SeekMode.Start);
			const buffer = new Uint8Array(bytes_to_read);
			const bytes_read = (await handle.read(buffer)) ?? 0;
			return {
				content: new TextDecoder().decode(buffer.subarray(0, bytes_read)),
				bytes_read,
				file_size,
			};
		} finally {
			handle.close();
		}
	},
	readdir: async (path) => {
		const names: Array<string> = [];
		for await (const entry of Deno.readDir(path)) names.push(entry.name);
		return names;
	},
	write_text_file: (path, content) => Deno.writeTextFile(path, content),
	write_file: (path, data) => Deno.writeFile(path, data),
	rename: (old_path, new_path) => Deno.rename(old_path, new_path),
	fsync: async (path) => {
		const file = await Deno.open(path, {read: true});
		try {
			await file.sync();
		} finally {
			file.close();
		}
	},
	remove: (path, options) => Deno.remove(path, options),

	// === HTTP ===
	fetch: globalThis.fetch,

	// === Local Commands ===
	run_command: async (cmd, args, options): Promise<CommandResult> => {
		try {
			const controller = options?.timeout_ms !== undefined ? new AbortController() : null;
			const signal =
				controller && options?.signal
					? AbortSignal.any([controller.signal, options.signal])
					: (controller?.signal ?? options?.signal);
			const timer =
				controller && options?.timeout_ms !== undefined
					? setTimeout(() => controller.abort(), options.timeout_ms)
					: null;
			let timed_out = false;
			if (controller) {
				controller.signal.addEventListener(
					'abort',
					() => {
						if (options?.signal?.aborted) return;
						timed_out = true;
					},
					{once: true},
				);
			}
			try {
				const proc = new Deno.Command(cmd, {
					args,
					cwd: options?.cwd,
					signal,
					stdout: 'piped',
					stderr: 'piped',
				});
				const result = await proc.output();
				const base: CommandResult = {
					success: result.code === 0 && !timed_out,
					code: result.code,
					stdout: new TextDecoder().decode(result.stdout),
					stderr: new TextDecoder().decode(result.stderr),
				};
				if (options?.timeout_ms !== undefined) base.timed_out = timed_out;
				return base;
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
		} catch (error) {
			const message = to_error_message(error);
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
