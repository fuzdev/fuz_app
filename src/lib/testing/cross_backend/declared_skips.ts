import '../assert_dev_env.ts';

/**
 * Gated skips, and the check that holds them to a declared list.
 *
 * A cross suite skips a case when the backend lacks what the case needs —
 * `test_if(capabilities.X, ...)`, or a suite `describe_spine_cross_suites`
 * leaves out. Each such skip is registered by `test_skip_gated`, which tags
 * the test it registers (`TaskMeta.fuz_gated_skip`). The tag is set at
 * registration, so a `-t` filter or an `.only`, which skip tests later, never
 * changes which tests carry it.
 *
 * `check_declared_skips(expected)` registers a closing test that reads every
 * test under the suite it is called in and holds the tagged ones to
 * `expected`, a test name path (describe titles and test name below that
 * suite, joined with `' > '`) to the reason it skips here: an undeclared
 * skip fails, as does an entry whose test was registered to run (stale) or
 * that names no test at all. A skip the backend didn't mean — a capability
 * flipped by mistake, a suite gating on a new flag — then fails the run
 * rather than passing as one more skipped test.
 *
 * @module
 */

import { assert, test, type RunnerTask } from 'vitest';

declare module 'vitest' {
	interface TaskMeta {
		/**
		 * Set on a test registered skipped because the backend lacks what it
		 * gates on (`test_skip_gated`) — the skips `check_declared_skips`
		 * holds to a declared list.
		 */
		fuz_gated_skip?: true;
	}
}

/** The name of the test `check_declared_skips` registers. */
export const DECLARED_SKIPS_CHECK_NAME = 'every gated skip is declared';

/**
 * Register `fn` as a skipped test, tagged as a gated skip — the skip a backend
 * owes a declaration for (`check_declared_skips`). `test_if` registers its
 * skipped cases through it.
 *
 * @param name - the test name
 * @param fn - the test body, never run
 */
export const test_skip_gated = (name: string, fn: () => void | Promise<void>): void => {
	test.skip(name, { meta: { fuz_gated_skip: true } }, fn);
};

/**
 * Whether `task` was registered by `test_skip_gated`.
 *
 * @param task - a collected task
 */
export const is_gated_skip = (task: { readonly meta?: object }): boolean =>
	(task.meta as { fuz_gated_skip?: unknown } | undefined)?.fuz_gated_skip === true;

/** A collected test, by its name path, and whether it is a gated skip. */
export interface CollectedTest {
	readonly path: string;
	readonly gated_skip: boolean;
}

/**
 * Hold the collected tests' gated skips to `expected` — the pure half of
 * `check_declared_skips`.
 *
 * @param expected - test name path to the reason it skips
 * @param tests - every collected test under the checked suite
 * @returns one line per problem: an undeclared skip, a declared skip
 *   registered to run, or a declared path naming no test
 */
export const find_declared_skip_problems = (
	expected: Readonly<Record<string, string>>,
	tests: Iterable<CollectedTest>
): Array<string> => {
	const gated: Set<string> = new Set();
	const running: Set<string> = new Set();
	for (const t of tests) (t.gated_skip ? gated : running).add(t.path);
	const problems: Array<string> = [];
	for (const path of gated) {
		if (!(path in expected)) problems.push(`undeclared skip: ${path}`);
	}
	for (const path of Object.keys(expected)) {
		if (gated.has(path)) continue;
		problems.push(
			running.has(path)
				? `declared skip registered to run (stale — remove its entry): ${path}`
				: `declared skip names no collected test (a renamed or removed test, a path missing a describe title, or a test a nested check owns): ${path}`
		);
	}
	return problems;
};

/**
 * Validate `expected`'s reasons.
 *
 * @param expected - test name path to the reason it skips
 * @param label - who passed it, for the error
 * @throws Error - naming every entry with an empty reason
 */
export const assert_declared_skip_reasons = (
	expected: Readonly<Record<string, string>>,
	label: string
): void => {
	const missing = Object.entries(expected)
		.filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
		.map(([path]) => path);
	if (missing.length > 0) {
		throw new Error(`${label}: every declared skip needs a reason — ${missing.join('; ')}`);
	}
};

/** Whether `suite` holds a check of its own — a direct test named `DECLARED_SKIPS_CHECK_NAME`. */
const has_own_check = (suite: RunnerTask): boolean =>
	suite.type === 'suite' &&
	suite.tasks.some((t) => t.type === 'test' && t.name === DECLARED_SKIPS_CHECK_NAME);

/**
 * Every test under `task`, as name paths starting with `prefix` — the check
 * itself left out, and nothing below a suite with a check of its own, which
 * owns its subtree.
 */
const collect_tests = (
	task: RunnerTask,
	prefix: Array<string>,
	self: RunnerTask,
	out: Array<CollectedTest>
): void => {
	if (task === self) return;
	const path = [...prefix, task.name];
	if (task.type === 'suite') {
		if (has_own_check(task)) return;
		for (const child of task.tasks) collect_tests(child, path, self, out);
	} else {
		out.push({ path: path.join(' > '), gated_skip: is_gated_skip(task) });
	}
};

/**
 * Register a closing test that holds every gated skip under the current suite
 * (the enclosing `describe`, or the file) to `expected` — see the module doc.
 * A nested suite with a check of its own owns its subtree: this check
 * neither collects nor needs declared what sits below it.
 * The paths are read from the collected tree when the test runs, so tests
 * registered after the call count, and a filtered run checks the same paths
 * as a whole one.
 *
 * @param expected - test name path below the current suite to the reason it
 *   skips on this backend; `{}` when nothing may skip
 * @throws Error - at collection, on an entry with no reason
 */
export const check_declared_skips = (expected: Readonly<Record<string, string>>): void => {
	assert_declared_skip_reasons(expected, 'check_declared_skips');
	test(DECLARED_SKIPS_CHECK_NAME, (ctx) => {
		// a task at a file's top level has no `suite`, only its `file`
		const root: RunnerTask = ctx.task.suite ?? ctx.task.file;
		assert.strictEqual(root.type, 'suite', 'check_declared_skips: no enclosing suite');
		const tests: Array<CollectedTest> = [];
		for (const child of root.tasks) collect_tests(child, [], ctx.task, tests);
		assert.deepEqual(find_declared_skip_problems(expected, tests), [], 'gated skips');
	});
};
