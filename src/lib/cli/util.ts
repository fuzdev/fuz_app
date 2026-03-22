/**
 * CLI utilities for colors, confirmation, and command delegation.
 *
 * For structured CLI logging, see `create_cli_logger` in `logger.ts`.
 *
 * @module
 */

import type {CommandDeps, CommandResult, TerminalDeps} from '../runtime/deps.js';

// TODO: `colors` duplicates the NO_COLOR detection Logger does internally.
// Long-term, converge with Logger's color system or expose a shared color helper.
const no_color =
	typeof process !== 'undefined' &&
	(process.env.NO_COLOR !== undefined || process.env.CLAUDECODE !== undefined);

export const colors = {
	green: no_color ? '' : '\x1b[32m',
	yellow: no_color ? '' : '\x1b[33m',
	blue: no_color ? '' : '\x1b[34m',
	red: no_color ? '' : '\x1b[31m',
	cyan: no_color ? '' : '\x1b[36m',
	dim: no_color ? '' : '\x1b[2m',
	bold: no_color ? '' : '\x1b[1m',
	reset: no_color ? '' : '\x1b[0m',
} as const;

/**
 * Run a local command and return the result.
 *
 * @param runtime - runtime with `run_command` capability
 * @param command - command to run
 * @param args - command arguments
 * @returns command result
 */
export const run_local = async (
	runtime: CommandDeps,
	command: string,
	args: Array<string>,
): Promise<CommandResult> => {
	return runtime.run_command(command, args);
};

/**
 * Prompt for yes/no confirmation.
 *
 * @param runtime - runtime with `stdout_write` and `stdin_read` capabilities
 * @param message - message to display
 * @returns `true` if user confirms, `false` otherwise
 */
export const confirm = async (runtime: TerminalDeps, message: string): Promise<boolean> => {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	await runtime.stdout_write(encoder.encode(`${message} [y/N] `));

	const buf = new Uint8Array(1024);
	const n = await runtime.stdin_read(buf);
	if (n === null) return false;

	const input = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
	return input === 'y' || input === 'yes';
};
