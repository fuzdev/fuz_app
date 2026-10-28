/**
 * The TS spine binary's test-only env toggles parse the way the Rust
 * `testing_spine_stub` does — the same accepted set, so one harness env drives
 * both binaries to the same posture, and garbage refuses to boot on both.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { WS_RECEIVE_TIMEOUT_MAX } from '#lib/actions/register_action_ws.ts';
import { SSE_KEEP_ALIVE_INTERVAL_MS_MAX } from '#lib/realtime/sse_constants.ts';

import {
	parse_action_rate_limit_max_attempts,
	parse_stringbool_env,
	parse_timing_ms_env
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

describe('parse_timing_ms_env', () => {
	const MS_NAME = 'FUZ_TEST_TIMING_MS';
	/** The Rust stub's one cap on both timing vars (`SSE_KEEP_ALIVE_INTERVAL_MAX`). */
	const RUST_MS_MAX = 2_147_483_647;

	test('both knobs cap at the Rust stub cap', () => {
		assert.strictEqual(SSE_KEEP_ALIVE_INTERVAL_MS_MAX, RUST_MS_MAX);
		assert.strictEqual(WS_RECEIVE_TIMEOUT_MAX, RUST_MS_MAX);
	});

	test('unset is undefined', () => {
		assert.strictEqual(parse_timing_ms_env(MS_NAME, undefined, RUST_MS_MAX), undefined);
	});

	test('accepts what an ASCII-trimmed u32 parse accepts, from 1 to 2³¹ − 1', () => {
		const cases: Array<[string, number]> = [
			['200', 200],
			[' 200 ', 200],
			['\t\n\f\r200\r\n', 200],
			['+200', 200],
			['0200', 200],
			['1', 1],
			['2147483647', 2147483647]
		];
		for (const [raw, expected] of cases) {
			assert.strictEqual(parse_timing_ms_env(MS_NAME, raw, RUST_MS_MAX), expected, raw);
		}
	});

	test('refuses zero, signs, non-digits, non-ASCII whitespace, and values above 2³¹ − 1', () => {
		for (const raw of [
			'0',
			'-1',
			'',
			'+',
			'fast',
			'1.5',
			'1e3',
			'0x10',
			'2147483648',
			// whitespace one language's `trim` strips and the other's keeps
			'\uFEFF200',
			'200\u0085',
			'\u00A0200',
			'\v200'
		]) {
			assert.throws(
				() => parse_timing_ms_env(MS_NAME, raw, RUST_MS_MAX),
				`${MS_NAME}: expected a positive integer of ms`,
				JSON.stringify(raw)
			);
		}
	});

	test('caps at the given max', () => {
		assert.strictEqual(parse_timing_ms_env(MS_NAME, '500', 500), 500);
		assert.throws(() => parse_timing_ms_env(MS_NAME, '501', 500), 'up to 500');
	});
});
