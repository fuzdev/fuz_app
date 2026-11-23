import './assert_dev_env.ts';

/**
 * The per-test logged-error gate: every error a test logs — a
 * `Logger.prototype.error` call or a `console.error` — fails the test once it
 * ends, unless the test declared it. A test that provokes an error on purpose
 * says so with `expect_logged_error(pattern)`, which also asserts the error
 * appeared, so the noise becomes coverage; an error that is a side effect of
 * what a test or describe sets up, and not what it checks, is
 * `allow_logged_error(pattern, reason)`. The designed test-mode banners
 * (`LOGGED_ERROR_BANNERS`) are allowed everywhere.
 *
 * Wire it as a vitest `setupFiles` entry whose top level calls
 * `install_logged_error_gate()`:
 *
 * ```ts
 * // src/test/logged_error_gate.ts
 * import { install_logged_error_gate } from '@fuzdev/fuz_app/testing/logged_errors.ts';
 *
 * install_logged_error_gate();
 * ```
 *
 * A call counts whatever the logger's level: a `Logger` at `'off'` prints
 * nothing and is still a logged error, so a test's silent logger hides nothing
 * from the gate. A test that replaces `console.error` with a spy has claimed
 * the calls it swallows; a `Logger` call still reaches the gate first.
 *
 * Errors only — warnings are not gated. An error logged outside any test (a
 * `beforeAll` or `afterAll`, the file's top level) fails the file in its last
 * `afterAll`, allowed by any `allow_logged_error` the file declared at
 * collection. The check runs in the last of the test's `onTestFinished` hooks,
 * after its `afterEach` hooks and after a `create_test_app` app's close, so
 * what a shutdown logs counts. A test that already failed is left as it
 * failed. An error a test's work logs after the test has finished — a
 * background timer, an effect nothing awaited — lands on the next test or the
 * file. A concurrent test runs beside its siblings, so no buffer can say whose
 * error a log is: what it logs goes to the file's, checked in its last
 * `afterAll` against the file's allowances, and both `expect_logged_error` and
 * `allow_logged_error` throw in one — allow its errors on its `describe`, at
 * collection.
 *
 * @module
 */

import { inspect } from 'node:util';
import { afterAll, beforeEach, TestRunner, type RunnerTask } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { RATE_LIMITERS_DISABLED_BANNER } from '../rate_limiter.ts';
import {
	LOGIN_FAIL_FLOOR_DISABLED_BANNER,
	SIGNUP_FAIL_FLOOR_DISABLED_BANNER
} from '../auth/fail_floor.ts';

/** What a logged error is matched against: a substring, or a `RegExp` searched for. */
export type LoggedErrorPattern = string | RegExp;

/** A logged error the gate lets pass, and why. */
export interface LoggedErrorAllowance {
	readonly pattern: LoggedErrorPattern;
	/** Why the error is expected — required, and shown nowhere but the source. */
	readonly reason: string;
}

/**
 * The designed test-mode banners, allowed in every test: each is printed with
 * `console.error`, once per module instance, when a test-only mode is on, so a
 * production log that shows one is the alarm. In a test run they are the
 * mode working.
 */
export const LOGGED_ERROR_BANNERS: ReadonlyArray<LoggedErrorAllowance> = [
	{
		pattern: RATE_LIMITERS_DISABLED_BANNER,
		reason: "the banner of `rate_limiters: 'disabled_for_testing'`, the test default"
	},
	{
		pattern: LOGIN_FAIL_FLOOR_DISABLED_BANNER,
		reason: 'the banner of a login failure timing floor of 0, the test default'
	},
	{
		pattern: SIGNUP_FAIL_FLOOR_DISABLED_BANNER,
		reason: 'the banner of a signup failure timing floor of 0, the test default'
	}
];

/** Options for `install_logged_error_gate`. */
export interface InstallLoggedErrorGateOptions {
	/**
	 * Errors allowed in every test of every file, beside `LOGGED_ERROR_BANNERS`
	 * — a consumer's own designed banners. Each needs its reason.
	 */
	readonly allow?: ReadonlyArray<LoggedErrorAllowance>;
}

/** One logged error: where it came from and its text, the args joined. */
interface LoggedError {
	readonly source: 'logger' | 'console';
	readonly text: string;
}

/** An allowance declared at collection, scoped to its describe (`null` for the file). */
interface ScopedAllowance extends LoggedErrorAllowance {
	readonly suite: RunnerTask | null;
}

interface FileGateState {
	readonly global: ReadonlyArray<LoggedErrorAllowance>;
	readonly allowances: Array<ScopedAllowance>;
	/** Errors logged outside any test. */
	readonly outside: Array<LoggedError>;
}

interface ExpectedLoggedError {
	readonly pattern: LoggedErrorPattern;
}

interface TestGateState {
	readonly task: RunnerTask;
	readonly errors: Array<LoggedError>;
	readonly allowances: Array<LoggedErrorAllowance>;
	readonly expected: Array<ExpectedLoggedError>;
}

/**
 * The process-wide gate state. Held on `globalThis`, not in module scope: the
 * wrappers on `console.error` and `Logger.prototype` outlive a test file, and
 * under vitest's `isolate` each file evaluates this module anew, so the
 * wrappers reach the current file's state through this one object.
 */
interface GateState {
	file: FileGateState | null;
	test: TestGateState | null;
	/** Set while a wrapped `Logger` call runs, so its own `console.error` is not counted twice. */
	in_logger: boolean;
}

const GATE_STATE_KEY = Symbol.for('@fuzdev/fuz_app/testing/logged_errors');
/** Marks a function as the gate's wrapper, so it is installed once per object. */
const WRAPPED_KEY = Symbol.for('@fuzdev/fuz_app/testing/logged_errors/wrapped');

/** How much of an error's text a failure message shows. */
const REPORTED_TEXT_MAX_LENGTH = 600;

const format_logged_value = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (value instanceof Error) {
		const cause = value.cause === undefined ? '' : ` [cause: ${format_logged_value(value.cause)}]`;
		return `${value.name}: ${value.message}${cause}`;
	}
	return inspect(value, { depth: 4, breakLength: Infinity });
};

const format_logged_args = (args: ReadonlyArray<unknown>): string =>
	args.map(format_logged_value).join(' ');

const pattern_matches = (pattern: LoggedErrorPattern, text: string): boolean =>
	typeof pattern === 'string' ? text.includes(pattern) : text.search(pattern) !== -1;

const record_logged_error = (state: GateState, error: LoggedError): void => {
	if (state.file === null) return;
	(state.test?.errors ?? state.file.outside).push(error);
};

const wrap_error_method = (
	target: { error: (...args: Array<any>) => unknown },
	state: GateState,
	source: LoggedError['source'],
	format: (self: unknown, args: Array<unknown>) => string
): void => {
	const original = target.error;
	if ((original as unknown as Record<symbol, unknown>)[WRAPPED_KEY]) return;
	const wrapped = function (this: unknown, ...args: Array<unknown>): unknown {
		if (source === 'logger') {
			record_logged_error(state, { source, text: format(this, args) });
			const outer = state.in_logger;
			state.in_logger = true;
			try {
				return original.apply(this, args);
			} finally {
				state.in_logger = outer;
			}
		}
		if (!state.in_logger) record_logged_error(state, { source, text: format(this, args) });
		return original.apply(this, args);
	};
	(wrapped as unknown as Record<symbol, unknown>)[WRAPPED_KEY] = true;
	target.error = wrapped;
};

/** The gate state, creating it and wrapping `Logger.prototype.error` and `console.error` once. */
const get_gate_state = (): GateState => {
	const globals = globalThis as unknown as Record<symbol, GateState | undefined>;
	let state = globals[GATE_STATE_KEY];
	if (!state) {
		state = { file: null, test: null, in_logger: false };
		globals[GATE_STATE_KEY] = state;
	}
	// each its own check: under `isolate` a file may load a fresh `Logger`
	wrap_error_method(Logger.prototype, state, 'logger', (self, args) => {
		const label = (self as Logger).label;
		const text = format_logged_args(args);
		return label ? `[${label}] ${text}` : text;
	});
	wrap_error_method(console, state, 'console', (_self, args) => format_logged_args(args));
	return state;
};

/** The gate state if a setup file installed it, else `null`. */
const read_gate_state = (): GateState | null => {
	const state = (globalThis as unknown as Record<symbol, GateState | undefined>)[GATE_STATE_KEY];
	return state?.file ? state : null;
};

const validate_allowance = (allowance: LoggedErrorAllowance, label: string): void => {
	if (typeof allowance.reason !== 'string' || allowance.reason.trim() === '') {
		throw new Error(
			`${label}: an allowed logged error needs its reason (${String(allowance.pattern)})`
		);
	}
	if (allowance.pattern === '') {
		throw new Error(`${label}: an empty pattern would allow every logged error`);
	}
};

/** Whether `suite` is `task` or one of its ancestors. */
const task_is_within = (task: RunnerTask, suite: RunnerTask): boolean => {
	for (let t: RunnerTask | undefined = task; t; t = t.suite) {
		if (t === suite) return true;
	}
	return false;
};

const format_unexpected = (errors: ReadonlyArray<LoggedError>, where: string): string => {
	const lines = errors.map((e) => {
		const text =
			e.text.length > REPORTED_TEXT_MAX_LENGTH
				? `${e.text.slice(0, REPORTED_TEXT_MAX_LENGTH)}…`
				: e.text;
		return `  - (${e.source}) ${text}`;
	});
	return (
		`${where} logged ${errors.length === 1 ? 'an error' : 'errors'} it did not declare:\n` +
		`${lines.join('\n')}\n` +
		'Declare one the test provokes with `expect_logged_error(pattern)`, or one it ' +
		'tolerates with `allow_logged_error(pattern, reason)` (`testing/logged_errors.ts`).'
	);
};

const check_test = (file: FileGateState, test: TestGateState): void => {
	const allowed = (text: string): boolean =>
		file.global.some((a) => pattern_matches(a.pattern, text)) ||
		test.allowances.some((a) => pattern_matches(a.pattern, text)) ||
		file.allowances.some(
			(a) =>
				(a.suite === null || task_is_within(test.task, a.suite)) && pattern_matches(a.pattern, text)
		) ||
		test.expected.some((x) => pattern_matches(x.pattern, text));
	const missing = test.expected.filter(
		(x) => !test.errors.some((e) => pattern_matches(x.pattern, e.text))
	);
	const unexpected = test.errors.filter((e) => !allowed(e.text));
	const problems: Array<string> = [];
	if (missing.length > 0) {
		problems.push(
			`expected a logged error matching ${missing.map((x) => String(x.pattern)).join(', ')}, ` +
				`but ${test.errors.length === 0 ? 'none was logged' : `the test logged only:\n${test.errors.map((e) => `  - ${e.text.slice(0, REPORTED_TEXT_MAX_LENGTH)}`).join('\n')}`}`
		);
	}
	if (unexpected.length > 0) problems.push(format_unexpected(unexpected, 'the test'));
	if (problems.length > 0) throw new Error(problems.join('\n\n'));
};

/**
 * Install the gate for the current test file — call at the top level of a
 * vitest `setupFiles` module, which vitest runs ahead of each test file. Wraps
 * `Logger.prototype.error` and `console.error` once per process (each wrapper
 * calls the original), resets the file's state, and registers the file's
 * hooks: a `beforeEach` that starts the test's buffer and checks it in an
 * `onTestFinished` hook, and an `afterAll` that checks what was logged outside
 * any test.
 *
 * @param options - errors allowed in every test beside `LOGGED_ERROR_BANNERS`
 * @throws Error on an allowance without its reason
 */
export const install_logged_error_gate = (options: InstallLoggedErrorGateOptions = {}): void => {
	const global = [...LOGGED_ERROR_BANNERS, ...(options.allow ?? [])];
	for (const allowance of global) validate_allowance(allowance, 'install_logged_error_gate');
	const state = get_gate_state();
	const file: FileGateState = { global, allowances: [], outside: [] };
	state.file = file;
	state.test = null;
	beforeEach((ctx) => {
		// a concurrent test runs beside its siblings, so no buffer can tell whose
		// error a log is: what it logs goes to the file's, checked in `afterAll`
		if (ctx.task.concurrent) {
			state.test = null;
			return;
		}
		const test: TestGateState = { task: ctx.task, errors: [], allowances: [], expected: [] };
		state.test = test;
		// the first `onTestFinished` hook registered runs last: after the test's
		// own, so what a `create_test_app` close logs is the test's
		ctx.onTestFinished(({ task }) => {
			if (state.test === test) state.test = null;
			if (task.result?.state === 'fail') return;
			check_test(file, test);
		});
	});
	afterAll(() => {
		state.test = null;
		const unexpected = file.outside.filter(
			(e) =>
				!file.global.some((a) => pattern_matches(a.pattern, e.text)) &&
				!file.allowances.some((a) => pattern_matches(a.pattern, e.text))
		);
		file.outside.length = 0;
		if (unexpected.length > 0) {
			throw new Error(
				format_unexpected(unexpected, 'the file, outside any test or in a concurrent test,')
			);
		}
	});
};

/**
 * Declare that the running test logs an error matching `pattern`, and fail
 * the test when it ends unless one was logged: the error the test provokes is
 * asserted, not just tolerated. Every error the pattern matches is allowed.
 *
 * @param pattern - a substring of the error's text, or a `RegExp` searched for
 * @throws Error outside a test, in a concurrent test, or when no setup file installed the gate
 */
export const expect_logged_error = (pattern: LoggedErrorPattern): void => {
	const state = read_gate_state();
	if (!state) {
		throw new Error(
			'expect_logged_error needs the logged-error gate — install it in a setup file (`install_logged_error_gate`)'
		);
	}
	const current = TestRunner.getCurrentTest();
	if (current?.concurrent) {
		throw new Error(
			"expect_logged_error: a concurrent test's errors can't be attributed to it — allow them with `allow_logged_error` on its `describe`"
		);
	}
	if (!state.test || !current) {
		throw new Error('expect_logged_error must be called inside a test');
	}
	if (pattern === '') throw new Error('expect_logged_error: an empty pattern matches every error');
	state.test.expected.push({ pattern });
};

/**
 * Allow logged errors matching `pattern`, with the reason they are expected:
 * inside a test, for that test; at collection, for every test of the
 * enclosing `describe` (the whole file at its top level) and for what the
 * file logs outside its tests or in its concurrent tests. It throws in a
 * concurrent test, whose errors share the file's bucket with its siblings',
 * so an allowance made there would hide theirs. Unlike `expect_logged_error`
 * it asserts nothing. A no-op when no setup file installed the gate.
 *
 * @param pattern - a substring of the error's text, or a `RegExp` searched for
 * @param reason - why the error is expected; required
 * @throws Error on an empty reason or pattern, or in a concurrent test
 */
export const allow_logged_error = (pattern: LoggedErrorPattern, reason: string): void => {
	validate_allowance({ pattern, reason }, 'allow_logged_error');
	const state = read_gate_state();
	if (!state) return;
	const current = TestRunner.getCurrentTest();
	if (current?.concurrent) {
		// an allowance it added would reach the file's bucket, every sibling's
		// errors in it, so its errors are allowed where the scope is visible
		throw new Error(
			"allow_logged_error: a concurrent test's errors can't be attributed to it — allow them on its `describe`, at collection"
		);
	}
	if (state.test && current) {
		state.test.allowances.push({ pattern, reason });
		return;
	}
	state.file!.allowances.push({
		pattern,
		reason,
		suite: TestRunner.getCurrentSuite().suite ?? null
	});
};
