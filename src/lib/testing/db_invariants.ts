import './assert_dev_env.ts';

/**
 * The per-test database invariant check — the hooks `create_test_app` and the
 * cross-process setup register, over the invariants and their statement in
 * `db_invariant_queries.ts`. In-process the check queries the test app's own
 * `Db` (`assert_db_invariants`); cross-process it reads the backend's
 * `_testing_db_invariants` backdoor (`assert_db_invariant_rows`).
 *
 * @module
 */

import { afterAll, onTestFinished, TestRunner, type RunnerTask } from 'vitest';

import type { QueryDeps } from '../db/query_deps.ts';
import {
	format_db_invariant_violations,
	query_db_invariant_violations,
	to_db_invariant_violations,
	validate_db_invariant_exclusions,
	type DbInvariantExclusions,
	type DbInvariantRow
} from './db_invariant_queries.ts';
import { close_after_error } from './close_after_error.ts';

/** The exclusion sets already logged, by label and set — the log's dedupe. */
const announced_db_invariant_exclusions = new Set<string>();

/**
 * Validate a setup's exclusions and log them, one line naming each with its
 * reason, so a run shows what it leaves unchecked. Validates on every call
 * and logs a label's set once per module instance, since a direct
 * `create_test_app` caller builds an app per test. Silent when there are none.
 *
 * @param exclude - the setup's exclusions
 * @param label - names the setup
 * @throws Error on an unknown invariant or an empty reason
 */
export const announce_db_invariant_exclusions = (
	exclude: DbInvariantExclusions | undefined,
	label: string
): void => {
	validate_db_invariant_exclusions(exclude, label);
	const entries = Object.entries(exclude ?? {});
	if (entries.length === 0) return;
	const key = JSON.stringify([label, entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
	if (announced_db_invariant_exclusions.has(key)) return;
	announced_db_invariant_exclusions.add(key);
	console.log(
		`[db invariants] ${label} excludes ${entries.map(([name, reason]) => `${name} (${reason})`).join('; ')}`
	);
};

/**
 * Throw when any row not excluded breaks an invariant — the check over rows
 * a backend's `_testing_db_invariants` answered.
 *
 * @param rows - every violating row
 * @param label - names the database in the message
 * @param exclude - invariants to skip, each with its reason
 * @throws Error listing every broken invariant and its rows
 */
export const assert_db_invariant_rows = (
	rows: ReadonlyArray<DbInvariantRow>,
	label: string,
	exclude?: DbInvariantExclusions
): void => {
	const violations = to_db_invariant_violations(rows, exclude);
	if (violations.length > 0) throw new Error(format_db_invariant_violations(violations, label));
};

/**
 * Throw when any invariant not excluded is broken.
 *
 * @param deps - the database to read
 * @param label - names the database in the message
 * @param exclude - invariants to skip, each with its reason
 * @throws Error listing every broken invariant and its rows
 */
export const assert_db_invariants = async (
	deps: QueryDeps,
	label: string,
	exclude?: DbInvariantExclusions
): Promise<void> => {
	const violations = await query_db_invariant_violations(deps, exclude);
	if (violations.length > 0) throw new Error(format_db_invariant_violations(violations, label));
};

/**
 * Run `check` when the current test finishes — the per-test hook the
 * cross-process setup registers from `setup_test()`, with `check` the
 * fixture's `assert_db_invariants`. `create_test_app` runs the same check in a
 * hook of its own, which closes the app after it (and so every
 * `default_in_process_setup` fixture).
 *
 * Runs after the test body and its `afterEach` hooks, before the next test's
 * setup resets the database. A test that already failed is left as it
 * failed: its state proves nothing more. Outside a test — an app or fixture built in
 * `beforeAll`, shared by a describe's tests — nothing is registered, and the
 * suite checks the fixture once its tests are done
 * (`check_db_invariants_after_all`).
 *
 * Under `describe.concurrent` the hook attaches to whichever test vitest
 * names current, and two tests' rows share one database, so a violation can
 * fail a sibling of the test that left it; the shipped concurrent suite
 * builds its fixture in `beforeAll` and is checked once after all its tests.
 *
 * @param check - throws on a violation
 * @returns whether a hook was registered — `false` outside a test
 */
export const register_db_invariants_check = (check: () => Promise<void>): boolean => {
	if (!TestRunner.getCurrentTest()) return false;
	onTestFinished(async ({ task }) => {
		if (task.result?.state === 'fail') return;
		await check();
	});
	return true;
};

/** Whether `task` or any task under it failed. */
const task_failed = (task: RunnerTask): boolean =>
	task.result?.state === 'fail' || (task.type === 'suite' && task.tasks.some(task_failed));

/**
 * Check a describe-scoped fixture's database now, unless a test of `suite`
 * failed or no fixture was built — the body of the suite-level check, for a
 * describe's own `afterAll` that runs it ahead of its cleanup (a
 * `create_test_app` app the describe closes, a database its factory closes):
 *
 * ```ts
 * afterAll(async ({}, suite) => {
 * 	try {
 * 		await check_db_invariants_after_suite(suite, test_app);
 * 	} catch (error) {
 * 		return close_after_error(() => test_app.cleanup(), error);
 * 	}
 * 	await test_app.cleanup();
 * });
 * ```
 *
 * Not `try`/`finally`: a cleanup that throws there replaces the violation.
 * `close_after_error` rethrows the violation, aggregated with a failing
 * cleanup's error.
 *
 * @param suite - the describe's task, the `afterAll` hook's second argument
 * @param fixture - the shared fixture or test app, `null` or `undefined` until built
 * @throws Error listing every broken invariant and its rows
 */
export const check_db_invariants_after_suite = async (
	suite: RunnerTask,
	fixture: { readonly assert_db_invariants: () => Promise<void> } | null | undefined
): Promise<void> => {
	if (!fixture || task_failed(suite)) return;
	await fixture.assert_db_invariants();
};

/**
 * Check a describe-scoped fixture's database once the describe's tests are
 * done — the suite-level twin of the per-test hook, for a fixture built in
 * `beforeAll` and shared by the describe (the per-describe round-trip and
 * exposure suites), or a `create_test_app` app built there, which registers
 * no per-test hook. Skipped when a test of the describe failed, or when no
 * fixture was built. Call inside the `describe`, at collection. It registers
 * an `afterAll` of its own, so it reads a fixture nothing closes in another
 * `afterAll`; a describe that closes its app or database there calls
 * `check_db_invariants_after_suite` in that hook, ahead of the close.
 *
 * @param get_fixture - the shared fixture, `null` or `undefined` until built
 */
export const check_db_invariants_after_all = (
	get_fixture: () => { readonly assert_db_invariants: () => Promise<void> } | null | undefined
): void => {
	// vitest requires the hook's context argument to be a destructuring pattern
	// eslint-disable-next-line no-empty-pattern
	afterAll(async ({}, suite) => {
		await check_db_invariants_after_suite(suite, get_fixture());
	});
};

/** A fixture the describe checks and then closes. */
export interface ClosableDbInvariantsFixture {
	readonly assert_db_invariants: () => Promise<void>;
	readonly close: () => Promise<void>;
}

/**
 * Check a describe-scoped fixture (`check_db_invariants_after_suite`), then
 * close it whatever the check found: a violation is thrown ahead of a failing
 * close (`close_after_error`). The body of
 * `check_db_invariants_and_close_after_all`'s hook.
 *
 * @param suite - the describe's task, the `afterAll` hook's second argument
 * @param fixture - the shared fixture, `null` or `undefined` until built
 * @throws Error the violation, the close's failure, or an `AggregateError` of both
 */
export const check_db_invariants_and_close = async (
	suite: RunnerTask,
	fixture: ClosableDbInvariantsFixture | null | undefined
): Promise<void> => {
	if (!fixture) return;
	try {
		await check_db_invariants_after_suite(suite, fixture);
	} catch (error) {
		return close_after_error(fixture.close, error);
	}
	await fixture.close();
};

/**
 * `check_db_invariants_after_all` for a fixture the describe also owns: one
 * `afterAll` running `check_db_invariants_and_close` — the shape for a
 * `setup_test()` fixture built in `beforeAll`, whose in-process `close` frees
 * its app and database. Call inside the `describe`, at collection.
 *
 * @param get_fixture - the shared fixture, `null` or `undefined` until built
 */
export const check_db_invariants_and_close_after_all = (
	get_fixture: () => ClosableDbInvariantsFixture | null | undefined
): void => {
	// vitest requires the hook's context argument to be a destructuring pattern
	// eslint-disable-next-line no-empty-pattern
	afterAll(async ({}, suite) => {
		await check_db_invariants_and_close(suite, get_fixture());
	});
};
