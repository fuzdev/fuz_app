/**
 * Node.js implementation of `RuntimeDeps`.
 *
 * Provides the same interface as `runtime/deno.ts` but backed by Node.js APIs.
 * Used for running servers in Node.js and for tests (vitest runs in Node).
 *
 * @module
 */

import {Buffer} from 'node:buffer';
import {spawn} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {stat, mkdir, readFile, readdir, writeFile, rename, rm, open} from 'node:fs/promises';
import process from 'node:process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {ReadableStream as NodeWebReadableStream} from 'node:stream/web';

import type {RuntimeDeps, StatResult, CommandResult} from './deps.ts';

/**
 * Create a `RuntimeDeps` backed by Node.js APIs.
 *
 * @param args - CLI arguments (typically `process.argv.slice(2)`)
 * @returns `RuntimeDeps` implementation using Node.js runtime
 */
export const create_node_runtime = (
	args: ReadonlyArray<string> = process.argv.slice(2),
): RuntimeDeps => ({
	// === Environment ===
	env_get: (name) => process.env[name],
	env_set: (name, value) => {
		process.env[name] = value;
	},
	env_all: () => ({...process.env}) as Record<string, string>,

	// === Process ===
	args,
	cwd: () => process.cwd(),
	exit: (code) => process.exit(code),

	// === Local File System ===
	stat: async (path): Promise<StatResult | null> => {
		try {
			const s = await stat(path);
			return {
				is_file: s.isFile(),
				is_directory: s.isDirectory(),
				size: s.size,
				mtime_ms: s.mtimeMs,
			};
		} catch {
			return null;
		}
	},
	mkdir: async (path, options) => {
		await mkdir(path, options);
	},
	read_text_file: (path) => readFile(path, 'utf-8'),
	read_file: (path) => readFile(path).then((buf) => new Uint8Array(buf)),
	// `Readable.toWeb` / `fromWeb` bridge Node streams to the web stream shape
	// the interface speaks. The casts cross Node's `stream/web` ReadableStream
	// and the global DOM `ReadableStream` (structurally identical here).
	read_file_stream: async (path) => {
		// `createReadStream` is lazy — a missing file surfaces as a stream `error`
		// event at consume time, not at the call. `stat` first so we honor the
		// interface's eager-throw contract (matching Deno/mock).
		await stat(path);
		return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
	},
	write_file_stream: async (path, data) => {
		await pipeline(
			Readable.fromWeb(data as unknown as NodeWebReadableStream<Uint8Array>),
			createWriteStream(path),
		);
	},
	read_text_from_offset: async (path, offset) => {
		const s = await stat(path);
		const file_size = s.size;
		const bytes_to_read = Math.max(0, file_size - offset);
		if (bytes_to_read === 0) return {content: '', bytes_read: 0, file_size};
		const handle = await open(path, 'r');
		try {
			const buffer = Buffer.alloc(bytes_to_read);
			const {bytesRead} = await handle.read(buffer, 0, bytes_to_read, offset);
			return {
				content: buffer.toString('utf-8', 0, bytesRead),
				bytes_read: bytesRead,
				file_size,
			};
		} finally {
			await handle.close();
		}
	},
	readdir: (path) => readdir(path),
	write_text_file: (path, content) => writeFile(path, content, 'utf-8'),
	write_file: (path, data) => writeFile(path, data),
	rename: (old_path, new_path) => rename(old_path, new_path),
	fsync: async (path) => {
		// fsync flushes the inode's dirty pages regardless of the fd's open mode,
		// so a read handle is enough (and needs no write permission).
		const handle = await open(path, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
	remove: (path, options) => rm(path, options),

	// === HTTP ===
	fetch: globalThis.fetch,

	// === Local Commands ===
	run_command: (cmd, args, options): Promise<CommandResult> => {
		return new Promise((resolve) => {
			const proc = spawn(cmd, args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				cwd: options?.cwd,
			});

			const stdout_chunks: Array<Buffer> = [];
			const stderr_chunks: Array<Buffer> = [];
			let timed_out = false;
			let done = false;

			const finish = (result: CommandResult) => {
				if (done) return;
				done = true;
				if (timer !== null) clearTimeout(timer);
				if (options?.signal) options.signal.removeEventListener('abort', on_abort);
				resolve(result);
			};

			const on_abort = () => {
				proc.kill();
			};

			const timer =
				options?.timeout_ms !== undefined
					? setTimeout(() => {
							timed_out = true;
							proc.kill();
						}, options.timeout_ms)
					: null;

			if (options?.signal) {
				if (options.signal.aborted) proc.kill();
				else options.signal.addEventListener('abort', on_abort, {once: true});
			}

			proc.stdout.on('data', (chunk: Buffer) => stdout_chunks.push(chunk));
			proc.stderr.on('data', (chunk: Buffer) => stderr_chunks.push(chunk));

			proc.on('error', (error) => {
				finish({
					success: false,
					code: 1,
					stdout: '',
					stderr: `Failed to execute command: ${error.message}`,
				});
			});

			proc.on('close', (code) => {
				const result: CommandResult = {
					success: code === 0 && !timed_out,
					code: code ?? 1,
					stdout: Buffer.concat(stdout_chunks).toString('utf-8').trim(),
					stderr: Buffer.concat(stderr_chunks).toString('utf-8').trim(),
				};
				if (options?.timeout_ms !== undefined) result.timed_out = timed_out;
				finish(result);
			});
		});
	},

	run_command_inherit: (cmd, args): Promise<number> => {
		return new Promise((resolve) => {
			const proc = spawn(cmd, args, {
				stdio: 'inherit',
			});

			proc.on('error', () => resolve(1));
			proc.on('close', (code) => resolve(code ?? 1));
		});
	},

	// === Terminal I/O ===
	stdout_write: async (data) => {
		return new Promise((resolve, reject) => {
			process.stdout.write(data, (err) => {
				if (err) reject(err);
				else resolve(data.length);
			});
		});
	},

	// === Logging ===
	warn: (...args) => console.warn(...args),

	stdin_read: async (buffer) => {
		// TODO: Implement proper stdin reading for interactive prompts in Node
		return new Promise((resolve) => {
			const onData = (chunk: Buffer) => {
				const bytes = Math.min(chunk.length, buffer.length);
				chunk.copy(buffer, 0, 0, bytes);
				process.stdin.off('data', onData);
				process.stdin.pause();
				resolve(bytes);
			};

			const onEnd = () => {
				process.stdin.off('data', onData);
				process.stdin.off('end', onEnd);
				resolve(null);
			};

			process.stdin.resume();
			process.stdin.once('data', onData);
			process.stdin.once('end', onEnd);
		});
	},
});
