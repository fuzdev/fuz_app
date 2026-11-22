/**
 * Gated skips and `check_declared_skips`: `test_if` tags the skip it
 * registers, and the closing check holds the tagged skips under its suite to
 * the declared list — an undeclared skip, a declared one registered to run,
 * and one naming no test each fail. A failing check is flagged `fails`, as
 * `test.fails` would, so the run passes only when it throws.
 *
 * @module
 */

import { assert, describe, test, TestRunner } from 'vitest';

import { test_if } from '#lib/testing/cross_backend/capabilities.ts';
import {
	check_declared_skips,
	DECLARED_SKIPS_CHECK_NAME,
	find_declared_skip_problems,
	is_gated_skip
} from '#lib/testing/cross_backend/declared_skips.ts';

const REASON = 'the backend lacks it';

/** Register `check_declared_skips(expected)` and flag it `fails`. */
const check_failing = (expected: Record<string, string>): void => {
	check_declared_skips(expected);
	const check = TestRunner.getCurrentSuite().tasks.at(-1);
	assert.ok(check?.type === 'test' && check.name === DECLARED_SKIPS_CHECK_NAME);
	check.fails = true;
};

describe('find_declared_skip_problems', () => {
	test('a declared gated skip and a running test pass', () => {
		assert.deepEqual(
			find_declared_skip_problems({ 'a > skipped': REASON }, [
				{ path: 'a > skipped', gated_skip: true },
				{ path: 'a > runs', gated_skip: false }
			]),
			[]
		);
	});

	test('an undeclared skip, a declared skip that runs, and a dead entry each fail', () => {
		assert.deepEqual(
			find_declared_skip_problems({ 'a > runs': REASON, 'a > renamed': REASON }, [
				{ path: 'a > skipped', gated_skip: true },
				{ path: 'a > runs', gated_skip: false }
			]),
			[
				'undeclared skip: a > skipped',
				'declared skip registered to run (stale — remove its entry): a > runs',
				'declared skip names no collected test (a renamed or removed test, a path missing a describe title, or a test a nested check owns): a > renamed'
			]
		);
	});
});

describe('check_declared_skips reasons', () => {
	test('an entry with no reason throws at registration', () => {
		assert.throws(
			() => check_declared_skips({ 'a > b': ' ' }),
			/every declared skip needs a reason — a > b/
		);
	});
});

describe('test_if tags the skip it registers', () => {
	test_if(false, 'gated off', () => {});
	test_if(true, 'gated on', () => {});

	test('only the skipped case carries the tag', (ctx) => {
		const tasks = ctx.task.suite!.tasks;
		const off = tasks.find((t) => t.name === 'gated off');
		const on = tasks.find((t) => t.name === 'gated on');
		assert.ok(off && on);
		assert.strictEqual(off.mode, 'skip');
		assert.ok(is_gated_skip(off));
		assert.ok(!is_gated_skip(on));
		assert.ok(!is_gated_skip(ctx.task));
	});
});

describe('a declared skip passes', () => {
	describe('nested', () => {
		test_if(false, 'gated off', () => {});
	});
	test_if(true, 'gated on', () => {});
	check_declared_skips({ 'nested > gated off': REASON });
});

describe('a check at the end of its suite sees tests registered after it', () => {
	check_failing({});
	test_if(false, 'registered after the check', () => {});
});

describe('an undeclared skip fails', () => {
	test_if(false, 'gated off', () => {});
	check_failing({});
});

describe('a declared skip registered to run fails', () => {
	test_if(true, 'gated on', () => {});
	check_failing({ 'gated on': REASON });
});

describe('a declared skip naming no test fails', () => {
	test_if(false, 'gated off', () => {});
	check_failing({ 'gated off': REASON, renamed: REASON });
});

describe('a plain skip is not a gated skip', () => {
	test.skip('skipped by hand', () => {});
	check_declared_skips({});
});

describe('a nested check owns its subtree', () => {
	describe('inner', () => {
		test_if(false, 'gated off', () => {});
		check_declared_skips({ 'gated off': REASON });
	});
	// the outer check neither needs the inner skip declared nor sees it
	check_declared_skips({});
});

describe('an outer check cannot declare what a nested check owns', () => {
	describe('inner', () => {
		test_if(false, 'gated off', () => {});
		check_declared_skips({ 'gated off': REASON });
	});
	check_failing({ 'inner > gated off': REASON });
});
