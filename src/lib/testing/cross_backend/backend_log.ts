import '../assert_dev_env.ts';

/**
 * A spawned backend's log, checked at teardown: `spawn_backend` tees the
 * child's stdout and stderr into `BackendLogConfig.path` and, once the child
 * has exited, fails the teardown on every error-level line no allowance
 * matches. The cross-process twin of the in-process logged-error gate
 * (`testing/logged_errors.ts`), at the grain of a whole run: what a backend
 * logs isn't attributed to the test that provoked it, so an allowance names
 * the error a suite provokes on purpose, with its reason.
 *
 * An error-level line is a fuz_util `Logger` error (`🞩error🞩`, how a TS
 * backend's errors print) or a `tracing` `ERROR` event (`<timestamp> ERROR`,
 * the Rust spine's default format), or a Rust panic's first line
 * (`thread '…' panicked at`), read with ANSI colors stripped. A bare
 * `console.error` carries no level marker and is not seen.
 *
 * @module
 */

import { StringDecoder } from 'node:string_decoder';

/**
 * An error line a backend may log, and why. The pattern is a substring, not
 * a `RegExp`: a config crosses to the test workers through vitest's
 * `provide`, which keeps plain data only.
 */
export interface BackendLogAllowance {
	readonly pattern: string;
	readonly reason: string;
}

/** Where a spawned backend's output goes, and the error lines it may log. */
export interface BackendLogConfig {
	/** The file the child's stdout and stderr are teed into, interleaved; rewritten per spawn. */
	readonly path: string;
	/** Error lines the backend may log — what its suites provoke on purpose, each with its reason. */
	readonly allow_errors: ReadonlyArray<BackendLogAllowance>;
}

/**
 * The error lines the shipped cross suites provoke on purpose, each with the
 * suite and why — every family builder allows them
 * (`make_default_ts_backend_config`, `make_default_rust_backend_config`).
 */
export const SPINE_CROSS_SUITE_BACKEND_ERRORS: ReadonlyArray<BackendLogAllowance> = [
	{
		// TS spine (`serve_fact.ts`)
		pattern: "addresses another fact's file; answering 404",
		reason:
			"`fact_serving`: a fact whose `external_url` names another fact's file answers the masked 404"
	},
	{
		// Rust spine (`fuz_fact_serving::serve`)
		pattern: 'serve_fact: rejecting an external_url that addresses another fact',
		reason:
			"`fact_serving`: a fact whose `external_url` names another fact's file answers the masked 404"
	}
];

/**
 * `config` with `allow` added to its log's allowances — for a setup that
 * provokes errors of its own (a probe before bootstrap). A config with no
 * `log` is returned as it is.
 *
 * @param config - the backend config
 * @param allow - the further error lines it may log
 */
export const with_backend_log_allowances = <T extends { readonly log?: BackendLogConfig }>(
	config: T,
	allow: ReadonlyArray<BackendLogAllowance>
): T =>
	config.log
		? { ...config, log: { ...config.log, allow_errors: [...config.log.allow_errors, ...allow] } }
		: config;

/** The marker fuz_util's `Logger` prints an error with. */
const LOGGER_ERROR_MARKER = '🞩error🞩';

/** A `tracing_subscriber` `fmt` event at `ERROR`: an RFC 3339 timestamp, then the level. */
const TRACING_ERROR_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+ERROR\s/;

/**
 * The Rust default panic hook's first line — a panic in a spawned task (a WS
 * session's) prints it to stderr with no `tracing` event; the router's own
 * panics are caught and logged at `ERROR`.
 */
const RUST_PANIC_LINE = /^thread '[^']*' panicked at /;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/**
 * Whether a backend output line is error-level (§module doc).
 *
 * @param line - one line, ANSI escapes stripped
 */
export const is_backend_error_line = (line: string): boolean =>
	line.startsWith(LOGGER_ERROR_MARKER) ||
	TRACING_ERROR_LINE.test(line) ||
	RUST_PANIC_LINE.test(line);

/**
 * The error-level lines of a backend's output that no allowance matches, in
 * order, ANSI escapes stripped.
 *
 * @param text - the backend's output
 * @param allow - the error lines it may log
 * @returns each unexpected error line
 */
export const find_unexpected_backend_errors = (
	text: string,
	allow: ReadonlyArray<BackendLogAllowance>
): Array<string> => {
	const unexpected: Array<string> = [];
	for (const raw of text.split('\n')) {
		const line = raw.replace(ANSI_ESCAPE, '').replace(/\r$/, '');
		if (!is_backend_error_line(line)) continue;
		if (!allow.some(({ pattern }) => line.includes(pattern))) unexpected.push(line);
	}
	return unexpected;
};

/** Whole lines of one output stream, from the chunks it arrives in. */
export interface LogLineSplitter {
	/** The lines `chunk` completes, each with its `\n`; a partial line waits for the next chunk. */
	readonly push: (chunk: Buffer) => string;
	/** What is left at the stream's end, as one line with its `\n`, or `''`. */
	readonly end: () => string;
}

/**
 * Create a `LogLineSplitter` — how `spawn_backend` writes a stream to the log
 * whole lines at a time, so stdout and stderr interleave without gluing one's
 * partial line onto the other's.
 */
export const create_log_line_splitter = (): LogLineSplitter => {
	let pending = '';
	// a chunk can end inside a multi-byte character — the `🞩` of a `Logger`
	// error line is four bytes — so decode across chunks, never per chunk
	const decoder = new StringDecoder('utf8');
	return {
		push: (chunk) => {
			const text = pending + decoder.write(chunk);
			const end = text.lastIndexOf('\n');
			if (end === -1) {
				pending = text;
				return '';
			}
			pending = text.slice(end + 1);
			return text.slice(0, end + 1);
		},
		end: () => {
			const rest = pending + decoder.end();
			pending = '';
			return rest === '' ? '' : `${rest}\n`;
		}
	};
};

/** How many unexpected lines a teardown failure lists. */
const REPORTED_LINES_MAX = 20;

/** How much of a line a teardown failure shows. */
const REPORTED_LINE_MAX_LENGTH = 400;

/**
 * The teardown failure naming a backend's unexpected error lines.
 *
 * @param name - the backend's name
 * @param path - its log file
 * @param lines - the unexpected lines (`find_unexpected_backend_errors`)
 */
export const format_unexpected_backend_errors = (
	name: string,
	path: string,
	lines: ReadonlyArray<string>
): string => {
	const shown = lines
		.slice(0, REPORTED_LINES_MAX)
		.map((l) =>
			l.length > REPORTED_LINE_MAX_LENGTH ? `  ${l.slice(0, REPORTED_LINE_MAX_LENGTH)}…` : `  ${l}`
		);
	const more =
		lines.length > REPORTED_LINES_MAX ? [`  … and ${lines.length - REPORTED_LINES_MAX} more`] : [];
	return (
		`spawn_backend(${name}): the backend logged ${lines.length === 1 ? 'an error' : 'errors'} no allowance names (${path}):\n` +
		[...shown, ...more].join('\n') +
		'\nAllow one a suite provokes on purpose in the config’s `log.allow_errors`, with its reason.'
	);
};
