/**
 * CLI logger wrapping `Logger` with semantic output methods.
 *
 * Why wrapper, not subclass: Logger has variadic `...args` methods, CLI adds
 * single-string semantic methods. Mixing calling conventions on one class is confusing.
 * Composition keeps both APIs clean.
 *
 * Why Logger prefixes for error/warn: Unifies error/warn visual style across CLI
 * and backend. CLI-specific methods (success/skip/step/header) add their own semantic
 * prefixes via `logger.info()`.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.js';

// TODO: inline ANSI codes duplicate what Logger does internally with `styleText`.
// Long-term, expose a color helper from Logger or converge with `st` from fuz_util/print.ts.

export interface CliLogger {
	/** Logs an error via Logger (gets Logger's error prefix). */
	error: (...args: Array<unknown>) => void;
	/** Logs a warning via Logger (gets Logger's warn prefix). */
	warn: (...args: Array<unknown>) => void;
	/** Logs info via Logger (gets Logger's label prefix). */
	info: (...args: Array<unknown>) => void;
	/** Logs debug via Logger (gets Logger's debug prefix). */
	debug: (...args: Array<unknown>) => void;
	/** Logs raw output via Logger (no prefix, no level filtering). */
	raw: (...args: Array<unknown>) => void;

	/** Logs a success message with `[done]` prefix at info level. */
	success: (msg: string) => void;
	/** Logs a skip message with `[skip]` prefix at info level. */
	skip: (msg: string) => void;
	/** Logs a step message with `==>` prefix at info level. */
	step: (msg: string) => void;
	/** Logs a header with `=== title ===` decoration at info level. */
	header: (title: string) => void;
	/** Logs a dimmed message at info level. */
	// TODO: `dim` maps to info level. If it should be debug (suppressed when level < debug),
	// change to `logger.debug()`. Current behavior matches old `log.dim` (always shows at info+).
	dim: (msg: string) => void;

	/** The underlying Logger instance. */
	logger: Logger;
}

/**
 * Creates a CLI logger wrapping a Logger with semantic output methods.
 *
 * @param logger - the Logger instance to wrap
 * @returns a `CliLogger` with CLI semantic methods mapped to Logger levels
 */
export const create_cli_logger = (logger: Logger): CliLogger => ({
	error: (...args) => logger.error(...args),
	warn: (...args) => logger.warn(...args),
	info: (...args) => logger.info(...args),
	debug: (...args) => logger.debug(...args),
	raw: (...args) => logger.raw(...args),

	success: (msg) => {
		const c = logger.colors;
		logger.info(c ? `\x1b[32m[done]\x1b[0m ${msg}` : `[done] ${msg}`);
	},
	skip: (msg) => {
		const c = logger.colors;
		logger.info(c ? `\x1b[33m[skip]\x1b[0m ${msg}` : `[skip] ${msg}`);
	},
	step: (msg) => {
		const c = logger.colors;
		logger.info(c ? `\n\x1b[36m==>\x1b[0m ${msg}` : `\n==> ${msg}`);
	},
	header: (title) => {
		const c = logger.colors;
		logger.info(c ? `\n\x1b[33m=== ${title} ===\x1b[0m\n` : `\n=== ${title} ===\n`);
	},
	dim: (msg) => {
		const c = logger.colors;
		logger.info(c ? `\x1b[2m${msg}\x1b[0m` : msg);
	},

	logger,
});
