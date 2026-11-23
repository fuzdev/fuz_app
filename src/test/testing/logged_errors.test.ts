/**
 * Tests for `testing/logged_errors.ts` — the logged-error gate this suite runs
 * under (`src/test/logged_error_gate.ts`). A refusal fails the test once it
 * ends, so each is a `test.fails`: it passes only when the gate failed it.
 *
 * @module
 */

import { beforeAll, describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	allow_logged_error,
	expect_logged_error,
	LOGGED_ERROR_BANNERS
} from '#lib/testing/logged_errors.ts';
import { RATE_LIMITERS_DISABLED_BANNER } from '#lib/rate_limiter.ts';

// silent: the gate counts a call whatever the level
const log = new Logger('gate_probe', { level: 'off' });

/** What `expect_logged_error` throws at collection, outside any test. */
const outside_test_error = ((): unknown => {
	try {
		expect_logged_error('outside');
		return null;
	} catch (error) {
		return error;
	}
})();

describe('an undeclared error', () => {
	test.fails('logged on a Logger at level off fails the test', () => {
		log.error('an undeclared error');
	});

	test.fails('written to console.error fails the test', () => {
		console.error('[gate_probe] an undeclared console error');
	});
});

describe('expect_logged_error', () => {
	test('passes when a matching error is logged', () => {
		expect_logged_error('an expected probe error');
		log.error('an expected probe error');
	});

	test('searches for a RegExp', () => {
		expect_logged_error(/probe error \d+/);
		log.error('probe error 42');
	});

	test("matches the logger's label and each arg, an Error as its name and message", () => {
		expect_logged_error('[gate_probe] failed: Error: inner');
		log.error('failed:', new Error('inner'));
	});

	test.fails('fails the test when nothing matching was logged', () => {
		expect_logged_error('never logged');
	});

	test.fails('allows only what it matches', () => {
		expect_logged_error('an expected probe error');
		log.error('an expected probe error');
		log.error('another error');
	});

	test('refuses an empty pattern', () => {
		assert.throws(() => expect_logged_error(''), /empty pattern/);
	});

	test('throws outside a test', () => {
		assert.match(String(outside_test_error), /inside a test/);
	});
});

describe('allow_logged_error', () => {
	test('in a test, allows that test', () => {
		allow_logged_error('a tolerated probe error', 'the test tolerates it');
		log.error('a tolerated probe error');
	});

	test('asserts nothing', () => {
		allow_logged_error('never logged', 'nothing is required of an allowance');
	});

	describe('at collection', () => {
		allow_logged_error('a describe-scoped probe error', 'the describe tolerates it');

		test('allows every test of the describe', () => {
			log.error('a describe-scoped probe error');
		});

		describe('nested', () => {
			test('and of the describes inside it', () => {
				log.error('a describe-scoped probe error');
			});
		});
	});

	test.fails('a describe allowance stops at its describe', () => {
		log.error('a describe-scoped probe error');
	});

	describe('outside a test', () => {
		allow_logged_error('a beforeAll probe error', 'the beforeAll logs it');
		beforeAll(() => {
			log.error('a beforeAll probe error');
		});

		test('allows what a hook logs', () => {
			assert.ok(true);
		});
	});

	test('refuses an empty reason', () => {
		assert.throws(() => allow_logged_error('x', ' '), /needs its reason/);
	});

	test('refuses an empty pattern', () => {
		assert.throws(() => allow_logged_error('', 'a reason'), /empty pattern/);
	});
});

/** The gate's state, as far as the concurrent cases read it. */
interface GateStateProbe {
	readonly file: { readonly outside: ReadonlyArray<{ readonly text: string }> };
}
const GATE_STATE_KEY = Symbol.for('@fuzdev/fuz_app/testing/logged_errors');

describe.concurrent('a concurrent test', () => {
	allow_logged_error('a concurrent probe error', 'the concurrent tests log it');

	test("can't expect an error, which no buffer can attribute to it", () => {
		assert.throws(() => expect_logged_error('a concurrent probe error'), /concurrent test/);
	});

	test('logs to the file, where a describe allowance covers it', async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		log.error('a concurrent probe error');
		// the file's bucket, not a sibling's buffer
		const state = (globalThis as unknown as Record<symbol, GateStateProbe>)[GATE_STATE_KEY]!;
		assert.ok(state.file.outside.some((e) => e.text.includes('a concurrent probe error')));
	});

	test("can't allow an error at run time, which would reach its siblings'", () => {
		assert.throws(
			() => allow_logged_error('a concurrent probe error', 'a reason'),
			/concurrent test/
		);
	});

	test('beside a sibling logging the same', async () => {
		log.error('a concurrent probe error');
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
});

describe('LOGGED_ERROR_BANNERS', () => {
	test('are allowed in every test', () => {
		log.error(RATE_LIMITERS_DISABLED_BANNER);
	});

	test('each has its reason', () => {
		for (const { pattern, reason } of LOGGED_ERROR_BANNERS) {
			assert.ok(reason.trim().length > 0, String(pattern));
		}
	});
});
