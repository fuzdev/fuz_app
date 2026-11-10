/**
 * Node.js implementation of `RuntimeDeps`.
 *
 * Backed by Node.js APIs. Used for running servers on Node and Bun (which
 * implements the `node:*` surface this module touches) and for tests (vitest
 * runs in Node).
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir, readFile, readdir, writeFile, rename, rm, open } from 'node:fs/promises';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import type { RuntimeDeps, StatResult } from './deps.ts';
import { load_secure_file_node } from './secure_file.ts';
import { assert_process_id } from './process_id.ts';

/**
 * Create a `RuntimeDeps` backed by Node.js APIs.
 *
 * @param args - CLI arguments (typically `process.argv.slice(2)`)
 * @returns `RuntimeDeps` implementation using Node.js runtime
 */
export const create_node_runtime = (
	args: ReadonlyArray<string> = process.argv.slice(2)
): RuntimeDeps => ({
	// === Environment ===
	env_get: (name) => process.env[name],
	env_set: (name, value) => {
		process.env[name] = value;
	},
	env_all: () => ({ ...process.env }) as Record<string, string>,

	// === Process ===
	args,
	cwd: () => process.cwd(),
	exit: (code) => process.exit(code),
	probe_process: (pid) => {
		assert_process_id(pid);
		try {
			process.kill(pid, 0);
			return 'running';
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ESRCH') return 'not_found';
			if (code === 'EPERM') return 'not_permitted';
			throw error;
		}
	},

	// === Local File System ===
	stat: async (path): Promise<StatResult | null> => {
		try {
			const s = await stat(path);
			return {
				is_file: s.isFile(),
				is_directory: s.isDirectory(),
				size: s.size,
				mtime_ms: s.mtimeMs
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
	read_secure_file: load_secure_file_node,
	// `Readable.toWeb` / `fromWeb` bridge Node streams to the web stream shape
	// the interface speaks. The casts cross Node's `stream/web` ReadableStream
	// and the global DOM `ReadableStream` (structurally identical here).
	read_file_stream: async (path) => {
		// `createReadStream` is lazy — a missing file surfaces as a stream `error`
		// event at consume time, not at the call. `stat` first so we honor the
		// interface's eager-throw contract (matching the mock).
		await stat(path);
		return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
	},
	write_file_stream: async (path, data) => {
		await pipeline(
			Readable.fromWeb(data as unknown as NodeWebReadableStream<Uint8Array>),
			createWriteStream(path)
		);
	},
	read_text_from_offset: async (path, offset) => {
		const s = await stat(path);
		const file_size = s.size;
		const bytes_to_read = Math.max(0, file_size - offset);
		if (bytes_to_read === 0) return { content: '', bytes_read: 0, file_size };
		const handle = await open(path, 'r');
		try {
			const buffer = Buffer.alloc(bytes_to_read);
			const { bytesRead } = await handle.read(buffer, 0, bytes_to_read, offset);
			return {
				content: buffer.toString('utf-8', 0, bytesRead),
				bytes_read: bytesRead,
				file_size
			};
		} finally {
			await handle.close();
		}
	},
	readdir: (path) => readdir(path),
	write_text_file: (path, content, options) =>
		writeFile(path, content, {
			encoding: 'utf-8',
			mode: options?.mode,
			flag: options?.exclusive ? 'wx' : 'w'
		}),
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
	}
});
