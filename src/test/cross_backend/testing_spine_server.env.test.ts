/**
 * The TS spine binary's test-only env toggles parse the way the Rust
 * `testing_spine_stub` does — the same accepted set, so one harness env drives
 * both binaries to the same posture, and garbage refuses to boot on both.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	parse_action_rate_limit_max_attempts,
	parse_stringbool_env
} from './testing_spine_server.ts';

const NAME = 'FUZ_TEST_FLAG';

describe('parse_stringbool_env', () => {
	test('unset is false', () => {
		assert.strictEqual(parse_stringbool_env(NAME, undefined), false);
	});

	test('accepts the stringbool set, case-insensitively', () => {
		for (const raw of ['true', 'TRUE', '1', 'yes', 'on', 'y', 'enabled', 'Enabled']) {
			assert.strictEqual(parse_stringbool_env(NAME, raw), true, raw);
		}
		for (const raw of ['false', 'FALSE', '0', 'no', 'off', 'n', 'disabled', 'Disabled']) {
			assert.strictEqual(parse_stringbool_env(NAME, raw), false, raw);
		}
	});

	test('refuses anything else, untrimmed', () => {
		for (const raw of ['', 'maybe', ' true', 'true ', '2', 'tru']) {
			assert.throws(() => parse_stringbool_env(NAME, raw), NAME, JSON.stringify(raw));
		}
	});
});

describe('parse_action_rate_limit_max_attempts', () => {
	test('unset is undefined', () => {
		assert.strictEqual(parse_action_rate_limit_max_attempts(undefined, false), undefined);
		assert.strictEqual(parse_action_rate_limit_max_attempts(undefined, true), undefined);
	});

	test('accepts what a trimmed u32 parse accepts, above zero', () => {
		const cases: Array<[string, number]> = [
			['3', 3],
			[' 3 ', 3],
			['+3', 3],
			['003', 3],
			['4294967295', 4294967295]
		];
		for (const [raw, expected] of cases) {
			assert.strictEqual(parse_action_rate_limit_max_attempts(raw, true), expected, raw);
		}
	});

	test('refuses zero, signs, non-digits, and values above u32::MAX', () => {
		for (const raw of ['0', '-1', '', '+', '++3', 'three', '3.0', '1e3', '0x10', '4294967296']) {
			assert.throws(
				() => parse_action_rate_limit_max_attempts(raw, true),
				'expected a positive integer',
				JSON.stringify(raw)
			);
		}
	});

	test('refuses a cap without the enable flag', () => {
		assert.throws(() => parse_action_rate_limit_max_attempts('3', false), 'is set but');
	});
});
