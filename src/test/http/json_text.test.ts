/**
 * Tests for json_text - JSON text read as the Rust spine's `serde_json` reads it.
 *
 * The boundaries are `serde_json`'s with `float_roundtrip`, measured.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	JSON_DEPTH_LIMIT,
	parse_json_text,
	read_json_body,
	type JsonBodyRequest
} from '#lib/http/json_text.ts';

// built from a char code so no tool or formatter decodes the escapes
const BS = String.fromCharCode(92);

const refuses = (text: string): void => {
	assert.throws(() => parse_json_text(text), SyntaxError, undefined, text.slice(0, 60));
};

const nested = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth);

describe('parse_json_text', () => {
	test('parses what JSON.parse parses', () => {
		assert.deepStrictEqual(parse_json_text('{"a":[1,"b",null,true]}'), { a: [1, 'b', null, true] });
		assert.strictEqual(parse_json_text('"x"'), 'x');
	});

	test('refuses what JSON.parse refuses', () => {
		refuses('not-json');
		refuses('');
	});

	describe('surrogates', () => {
		test('a lone high surrogate escape is refused', () => {
			refuses(`"${BS}ud800"`);
			refuses(`{"a":["${BS}uDBFF"]}`);
		});

		test('a lone low surrogate escape is refused', () => {
			refuses(`"${BS}udc00"`);
		});

		test('a high surrogate escape followed by a literal character is refused', () => {
			refuses(`"${BS}ud83d😀"`);
		});

		test('a lone surrogate escape in a key is refused', () => {
			refuses(`{"${BS}ud800":1}`);
			refuses(`{"a":{"${BS}udfff":1}}`);
		});

		test('an escaped pair and literal astral characters pass', () => {
			assert.strictEqual(parse_json_text(`"${BS}ud83d${BS}ude00"`), '😀');
			assert.strictEqual(parse_json_text('"😀"'), '😀');
			assert.deepStrictEqual(parse_json_text(`{"${BS}ud83d${BS}ude00":"x"}`), { '😀': 'x' });
		});

		test('an escaped backslash before u is no escape', () => {
			assert.strictEqual(parse_json_text(`"${BS}${BS}ud800"`), `${BS}ud800`);
		});
	});

	describe('numbers', () => {
		test('a number out of f64 range is refused', () => {
			refuses('1e400');
			refuses('-1e400');
			refuses('{"a":[1e309]}');
			refuses('1.7976931348623159e308');
			refuses('9'.repeat(309));
			refuses(`${'9'.repeat(210)}e99`);
		});

		test('the largest finite and an underflow pass', () => {
			assert.strictEqual(parse_json_text('1.7976931348623157e308'), Number.MAX_VALUE);
			// rounds down to MAX_VALUE in JS and in serde_json with `float_roundtrip`
			assert.strictEqual(parse_json_text('1.797693134862315807e308'), Number.MAX_VALUE);
			assert.strictEqual(parse_json_text('1e-400'), 0);
			assert.strictEqual(parse_json_text('1e100'), 1e100);
		});

		test('a long exponent inside a string is no number', () => {
			assert.strictEqual(parse_json_text('"1e400"'), '1e400');
		});
	});

	describe('depth', () => {
		test('nesting one short of the limit passes', () => {
			assert.doesNotThrow(() => parse_json_text(nested(JSON_DEPTH_LIMIT - 1)));
			assert.doesNotThrow(() =>
				parse_json_text(
					'{"a":'.repeat(JSON_DEPTH_LIMIT - 1) + '1' + '}'.repeat(JSON_DEPTH_LIMIT - 1)
				)
			);
		});

		test('nesting at the limit is refused', () => {
			refuses(nested(JSON_DEPTH_LIMIT));
			refuses(nested(JSON_DEPTH_LIMIT + 50));
			refuses('{"a":'.repeat(JSON_DEPTH_LIMIT) + '1' + '}'.repeat(JSON_DEPTH_LIMIT));
		});

		test('many brackets side by side are no depth', () => {
			const wide = `[${Array.from({ length: 500 }, () => '[]').join(',')}]`;
			assert.strictEqual((parse_json_text(wide) as Array<unknown>).length, 500);
		});

		test('brackets inside strings are no depth', () => {
			const text = JSON.stringify({ a: '['.repeat(500) });
			assert.doesNotThrow(() => parse_json_text(text));
		});
	});

	// `JSON.parse` keeps the last of two keys; serde refuses as it reads
	test('a refused value under a duplicated key is refused', () => {
		refuses(`{"a":"${BS}ud800","a":1}`);
		refuses('{"a":1e400,"a":1}');
		refuses(`{"a":${nested(JSON_DEPTH_LIMIT - 1)},"a":1}`);
		refuses(`{"a":{"${BS}ud800":1},"a":2}`);
	});

	test('the scan is linear: long digit runs cost no more than their length', () => {
		// 199 digits sit under the `Number` check, 200 take it: both near 1 MiB
		for (const digits of [199, 200]) {
			const run = `[${Array.from({ length: 5000 }, () => '9'.repeat(digits)).join(',')}]`;
			const start = performance.now();
			parse_json_text(run);
			// a quadratic prefilter took hundreds of milliseconds on this; the
			// bound is loose so a loaded machine doesn't fail it
			assert.isBelow(performance.now() - start, 250, `${digits} digits`);
		}
	});

	test('an own __proto__ key is read, not its prototype', () => {
		const value = parse_json_text('{"__proto__":{"x":1}}');
		assert.ok(Object.hasOwn(value as object, '__proto__'));
		refuses(`{"__proto__":{"x":"${BS}ud800"}}`);
		refuses('{"__proto__":{"x":1e400}}');
	});
});

describe('read_json_body', () => {
	const request = (text: string): JsonBodyRequest & { reads: number } => {
		const req = {
			raw: new Request('http://localhost/'),
			reads: 0,
			text: () => {
				req.reads++;
				return Promise.resolve(text);
			}
		};
		return req;
	};

	test('parses once per request', async () => {
		const req = request('{"a":1}');
		assert.deepStrictEqual(await read_json_body(req), { ok: true, value: { a: 1 } });
		assert.deepStrictEqual(await read_json_body(req), { ok: true, value: { a: 1 } });
		assert.strictEqual(req.reads, 1);
	});

	test('a refused body is ok: false', async () => {
		assert.deepStrictEqual(await read_json_body(request('{"a":1e400}')), { ok: false });
		assert.deepStrictEqual(await read_json_body(request('nope')), { ok: false });
	});

	test('a body that fails to read is ok: false', async () => {
		const req: JsonBodyRequest = {
			raw: new Request('http://localhost/'),
			text: () => Promise.reject(new Error('aborted'))
		};
		assert.deepStrictEqual(await read_json_body(req), { ok: false });
	});
});
