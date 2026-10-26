/**
 * Tests for `describe_spine_cross_suites`' case exclusions — the hook that
 * skips an `exclude_cases` test at run time, and the check that fails an
 * entry no collected test has. The hook is driven over stand-in suites
 * registered here, with the ranges `describe_spine_cross_suites` would record.
 *
 * @module
 */

import { assert, describe, test, TestRunner, type RunnerTask } from 'vitest';

import {
	check_spine_case_exclusions,
	register_spine_case_exclusions,
	type SuiteName
} from '#lib/testing/cross_backend/spine_suites.ts';

const REASON = 'the backend refuses this case by design';

/** The note a skip carries — set at run time, untyped on `TaskResult`. */
const skip_note = (task: RunnerTask): string =>
	(task.result as { note?: string } | undefined)?.note ?? '';

/** The task at `path` below `root`, by name. */
const find_task = (root: RunnerTask, path: ReadonlyArray<string>): RunnerTask => {
	let task: RunnerTask = root;
	for (const name of path) {
		const next = task.type === 'suite' ? task.tasks.find((t) => t.name === name) : undefined;
		assert.ok(next, `no task '${name}' under '${task.name}'`);
		task = next;
	}
	return task;
};

describe('case exclusions over registered suites', () => {
	const collector = TestRunner.getCurrentSuite();
	const ran: Array<string> = [];

	const start = collector.tasks.length;
	describe('suite a', () => {
		describe('inner', () => {
			test('excluded leaf', () => {
				ran.push('a excluded');
			});
			test('kept', () => {
				ran.push('a kept');
			});
		});
	});
	const middle = collector.tasks.length;
	// the same top title and path in another suite: the entry is the first
	// suite's alone, so it matches by suite as well as by path
	describe('suite a', () => {
		describe('inner', () => {
			test('excluded leaf', () => {
				ran.push('b excluded');
			});
		});
	});
	const end = collector.tasks.length;

	register_spine_case_exclusions({ cell_crud: { 'suite a > inner > excluded leaf': REASON } }, [
		{ name: 'cell_crud', start, end: middle },
		{ name: 'cell_relations', start: middle, end }
	]);

	test('the excluded test is skipped with its reason, and only it', (ctx) => {
		assert.deepStrictEqual(ran, ['a kept', 'b excluded']);
		const root = ctx.task.suite!;
		const [first, second] = root.tasks.filter((t) => t.name === 'suite a');
		assert.ok(first && second);
		const excluded = find_task(first, ['inner', 'excluded leaf']);
		assert.strictEqual(excluded.result?.state, 'skip');
		assert.include(skip_note(excluded), REASON);
		assert.strictEqual(find_task(second, ['inner', 'excluded leaf']).result?.state, 'pass');
		// the closing check ran and passed: the entry names a collected test
		const check = find_task(root, [
			'spine cross suites: every exclude_cases entry names a collected test'
		]);
		assert.strictEqual(check.result?.state, 'pass');
	});
});

describe('check_spine_case_exclusions', () => {
	const collected: ReadonlyMap<SuiteName, ReadonlySet<string>> = new Map([
		['cell_crud', new Set(['cell CRUD parity > owner lifecycle', 'cell CRUD parity > anon'])],
		['cell_relations', new Set(['cell relations parity > grant lifecycle'])]
	]);

	test('entries naming collected tests of their suite pass', () => {
		check_spine_case_exclusions(
			{
				cell_crud: { 'cell CRUD parity > owner lifecycle': REASON },
				cell_relations: { 'cell relations parity > grant lifecycle': REASON }
			},
			collected
		);
	});

	test('an entry no collected test has fails, naming it', () => {
		assert.throws(
			() =>
				check_spine_case_exclusions(
					{ cell_crud: { 'cell CRUD parity > renamed': REASON } },
					collected
				),
			/cell_crud › cell CRUD parity > renamed/
		);
	});

	test("a leaf name alone, or another suite's path, is dead", () => {
		assert.throws(
			() => check_spine_case_exclusions({ cell_crud: { 'owner lifecycle': REASON } }, collected),
			/cell_crud › owner lifecycle/
		);
		assert.throws(
			() =>
				check_spine_case_exclusions(
					{ cell_relations: { 'cell CRUD parity > anon': REASON } },
					collected
				),
			/cell_relations › cell CRUD parity > anon/
		);
	});

	test('every dead entry is named, the live ones not', () => {
		assert.throws(
			() =>
				check_spine_case_exclusions(
					{
						cell_crud: { 'cell CRUD parity > anon': REASON, 'cell CRUD parity > gone': REASON },
						ready: { 'ready > gone': REASON }
					},
					collected
				),
			/^(?!.*parity > anon).*cell_crud › cell CRUD parity > gone; ready › ready > gone/
		);
	});
});
