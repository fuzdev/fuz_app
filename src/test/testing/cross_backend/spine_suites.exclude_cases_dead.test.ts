/**
 * The closing check of `describe_spine_cross_suites`' case exclusions fails a
 * dead entry: one naming no test of its own suite — a renamed test, or a
 * path only another suite collected. The check is the last task the hook
 * registers; it is flagged `fails`, as `test.fails` would, so the run passes
 * only when the check throws.
 *
 * @module
 */

import { assert, describe, test, TestRunner } from 'vitest';

import { register_spine_case_exclusions } from '#lib/testing/cross_backend/spine_suites.ts';

const REASON = 'the backend refuses this case by design';
const CHECK_NAME = 'spine cross suites: every exclude_cases entry names a collected test';

/** Register two stand-in suites and the hook over `exclude_cases`, flagging its check `fails`. */
const register_with_dead_entry = (
	exclude_cases: Parameters<typeof register_spine_case_exclusions>[0]
): void => {
	const collector = TestRunner.getCurrentSuite();
	const start = collector.tasks.length;
	describe('suite a', () => {
		test('kept', () => {});
	});
	const middle = collector.tasks.length;
	describe('suite b', () => {
		test('only here', () => {});
	});
	const end = collector.tasks.length;
	register_spine_case_exclusions(exclude_cases, [
		{ name: 'cell_crud', start, end: middle },
		{ name: 'cell_relations', start: middle, end }
	]);
	const check = collector.tasks.at(-1);
	assert.ok(check?.type === 'test' && check.name === CHECK_NAME);
	check.fails = true;
};

describe('a renamed test', () => {
	register_with_dead_entry({ cell_crud: { 'suite a > renamed': REASON } });
});

describe("another suite's path", () => {
	register_with_dead_entry({ cell_crud: { 'suite b > only here': REASON } });
});
