/**
 * The case-exclusion hook registered at a file's top level, as a
 * `*.cross.test.ts` calling `describe_spine_cross_suites` with no wrapping
 * `describe` registers it — there the calling suite is the file, which a
 * top-level task names as its `file`, not its `suite`.
 *
 * @module
 */

import { assert, describe, test, TestRunner } from 'vitest';

import { register_spine_case_exclusions } from '#lib/testing/cross_backend/spine_suites.ts';

const REASON = 'the backend refuses this case by design';
const collector = TestRunner.getCurrentSuite();
const ran: Array<string> = [];

const start = collector.tasks.length;
describe('suite a', () => {
	test('excluded', () => {
		ran.push('excluded');
	});
});
test('top-level excluded', () => {
	ran.push('top-level excluded');
});
test('kept', () => {
	ran.push('kept');
});
const end = collector.tasks.length;

register_spine_case_exclusions(
	{ cell_crud: { 'suite a > excluded': REASON, 'top-level excluded': REASON } },
	[{ name: 'cell_crud', start, end }]
);

test('the excluded tests are skipped with their reason', (ctx) => {
	assert.deepStrictEqual(ran, ['kept']);
	const file = ctx.task.file;
	const top_level = file.tasks.find((t) => t.name === 'top-level excluded');
	assert.ok(top_level);
	assert.strictEqual(top_level.result?.state, 'skip');
	// the skip note is set at run time, untyped on `TaskResult`
	assert.include((top_level.result as { note?: string } | undefined)?.note ?? '', REASON);
	const suite_a = file.tasks.find((t) => t.name === 'suite a');
	assert.ok(suite_a?.type === 'suite');
	assert.strictEqual(suite_a.tasks[0]?.result?.state, 'skip');
});
