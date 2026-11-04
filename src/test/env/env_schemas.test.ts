/**
 * Tests for env/env_schemas.ts — `env_integer` and `EnvStringbool`, the
 * twins of the Rust spine's env readers.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import { env_integer, EnvStringbool } from '#lib/env/env_schemas.ts';

describe('env_integer', () => {
	const Any = env_integer();

	test('accepts decimal digits, trimmed, one leading + and leading zeros included', () => {
		for (const [value, expected] of [
			['0', 0],
			['80', 80],
			['+80', 80],
			[' +80 ', 80],
			['+0', 0],
			[' 250 ', 250],
			['\t250\n', 250],
			['00080', 80],
			[String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]
		] as const) {
			const result = parse(Any, value);
			assert.ok(result.ok, JSON.stringify(value));
			assert.strictEqual(result.value, expected, JSON.stringify(value));
		}
	});

	test('refuses what the Rust twin refuses', () => {
		for (const value of [
			'',
			' ',
			'+',
			'++80',
			'-80',
			'+-80',
			'+ 80',
			'5e3',
			'0x1F90',
			'1.5',
			'-1',
			'-0',
			'1_000',
			'1,000',
			'80a',
			'٣',
			'Infinity',
			'NaN'
		]) {
			assert.isFalse(parse(Any, value).ok, JSON.stringify(value));
		}
	});

	test('trims Unicode White_Space, the set Rust trims, not String.prototype.trim', () => {
		// U+0085 is White_Space, which `trim` keeps; U+FEFF is not, which `trim` strips
		for (const value of ['\u008580', '80\u0085', '\u00A080\u3000', '\u2028+80\u2029']) {
			const result = parse(Any, value);
			assert.ok(result.ok, JSON.stringify(value));
			assert.strictEqual(result.value, 80, JSON.stringify(value));
		}
		for (const value of ['\uFEFF80', '80\uFEFF', '\u180E80', '\u200B80']) {
			assert.isFalse(parse(Any, value).ok, JSON.stringify(value));
		}
	});

	test('trims exactly the White_Space code points', () => {
		for (let c = 0; c <= 0xffff; c++) {
			const ch = String.fromCharCode(c);
			if (/\d|\+/.test(ch) || (c >= 0xd800 && c <= 0xdfff)) continue;
			const white = /^\p{White_Space}$/u.test(ch);
			const label = 'U+' + c.toString(16).toUpperCase().padStart(4, '0');
			assert.strictEqual(parse(Any, ch + '1').ok, white, label);
			assert.strictEqual(parse(Any, '1' + ch).ok, white, label);
		}
	});

	test('refuses a value that is not a string', () => {
		for (const value of [80, undefined, null, true]) {
			assert.isFalse(parse(Any, value).ok, String(value));
		}
	});

	test('refuses an integer past the safe range', () => {
		assert.isFalse(parse(Any, String(Number.MAX_SAFE_INTEGER + 1)).ok);
		assert.isFalse(parse(Any, '9'.repeat(400)).ok);
	});

	test('bounds by min and max, inclusive', () => {
		const Port = env_integer({ min: 1, max: 65535 });
		assert.ok(parse(Port, '1').ok);
		assert.ok(parse(Port, '65535').ok);
		assert.isFalse(parse(Port, '0').ok);
		assert.isFalse(parse(Port, '65536').ok);
	});

	test('a malformed value names what was expected', () => {
		const result = parse(Any, '5e3');
		assert.ok(!result.ok);
		assert.strictEqual(result.issues[0]!.expected, 'decimal digits');
	});
});

describe('EnvStringbool', () => {
	test('reads the truthy and falsy words, case-insensitively', () => {
		for (const [values, expected] of [
			[['true', '1', 'yes', 'on', 'y', 'enabled'], true],
			[['false', '0', 'no', 'off', 'n', 'disabled'], false]
		] as const) {
			for (const value of values) {
				for (const spelling of [
					value,
					value.toUpperCase(),
					value[0]!.toUpperCase() + value.slice(1)
				]) {
					const result = parse(EnvStringbool, spelling);
					assert.ok(result.ok, spelling);
					assert.strictEqual(result.value, expected, spelling);
				}
			}
		}
	});

	test('refuses anything else, untrimmed and blank values included', () => {
		for (const value of [
			'',
			' ',
			' true',
			'true ',
			'maybe',
			'2',
			'tru',
			'yess',
			'constructor',
			'toString'
		]) {
			assert.isFalse(parse(EnvStringbool, value).ok, JSON.stringify(value));
		}
	});

	test('refuses a value that is not a string', () => {
		for (const value of [true, false, 1, 0, undefined, null]) {
			assert.isFalse(parse(EnvStringbool, value).ok, String(value));
		}
	});
});
