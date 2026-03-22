/**
 * Node.js implementation of `RuntimeDeps`.
 *
 * Provides the same interface as `deno.ts` but backed by Node.js APIs.
 * Used for running servers in Node.js and for tests (vitest runs in Node).
 *
 * @module
 */

import {Buffer} from 'node:buffer';
import {spawn} from 'node:child_process';
import {stat, mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import process from 'node:process';

import type {RuntimeDeps, StatResult, CommandResult} from './deps.js';

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
			return {is_file: s.isFile(), is_directory: s.isDirectory()};
		} catch {
			return null;
		}
	},
	mkdir: async (path, options) => {
		await mkdir(path, options);
	},
	read_file: (path) => readFile(path, 'utf-8'),
	write_file: (path, content) => writeFile(path, content, 'utf-8'),
	rename: (old_path, new_path) => rename(old_path, new_path),
	remove: (path, options) => rm(path, options),

	// === Local Commands ===
	run_command: (cmd, args): Promise<CommandResult> => {
		return new Promise((resolve) => {
			const proc = spawn(cmd, args, {
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			const stdout_chunks: Array<Buffer> = [];
			const stderr_chunks: Array<Buffer> = [];

			proc.stdout.on('data', (chunk: Buffer) => stdout_chunks.push(chunk));
			proc.stderr.on('data', (chunk: Buffer) => stderr_chunks.push(chunk));

			proc.on('error', (error) => {
				resolve({
					success: false,
					code: 1,
					stdout: '',
					stderr: `Failed to execute command: ${error.message}`,
				});
			});

			proc.on('close', (code) => {
				resolve({
					success: code === 0,
					code: code ?? 1,
					stdout: Buffer.concat(stdout_chunks).toString('utf-8').trim(),
					stderr: Buffer.concat(stderr_chunks).toString('utf-8').trim(),
				});
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
