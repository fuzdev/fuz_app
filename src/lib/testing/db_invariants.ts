import './assert_dev_env.ts';

/**
 * The per-test database invariant check — the hooks the cross-process and
 * in-process setups register, over the invariants and their statement in
 * `db_invariant_queries.ts`. In-process the check queries the fixture's own
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

/**
 * Validate a setup's exclusions and log them, one line naming each with its
 * reason, so a run shows what it leaves unchecked. Silent when there are none.
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
 * cross-process and in-process setups register from `setup_test()`, with
 * `check` the fixture's `assert_db_invariants`.
 *
 * Runs after the test body and its `afterEach` hooks, before the next test's
 * setup resets the database. A test that already failed is left as it
 * failed: its state proves nothing more. Outside a test — a fixture built in
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
 * Check a describe-scoped fixture's database once the describe's tests are
 * done — the suite-level twin of the per-test hook, for a fixture built in
 * `beforeAll` and shared by the describe (the per-describe round-trip and
 * exposure suites). Skipped when a test of the describe failed, or when no
 * fixture was built. Call inside the `describe`, at collection.
 *
 * @param get_fixture - the shared fixture, `null` or `undefined` until built
 */
export const check_db_invariants_after_all = (
	get_fixture: () => { readonly assert_db_invariants: () => Promise<void> } | null | undefined
): void => {
	// vitest requires the hook's context argument to be a destructuring pattern
	// eslint-disable-next-line no-empty-pattern
	afterAll(async ({}, suite) => {
		const fixture = get_fixture();
		if (!fixture || task_failed(suite)) return;
		await fixture.assert_db_invariants();
	});
};
