/**
 * Tests for env/dotenv.ts — dotenv file parsing and loading.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';

import {parse_dotenv, load_env_file} from '$lib/env/dotenv.ts';

describe('parse_dotenv', () => {
	test('parses key=value pairs', () => {
		const result = parse_dotenv('FOO=bar\nBAZ=qux');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('skips comments', () => {
		const result = parse_dotenv('# comment\nFOO=bar');
		assert.deepStrictEqual(result, {FOO: 'bar'});
	});

	test('skips empty lines', () => {
		const result = parse_dotenv('\nFOO=bar\n\nBAZ=qux\n');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('removes double quotes', () => {
		const result = parse_dotenv('FOO="bar baz"');
		assert.deepStrictEqual(result, {FOO: 'bar baz'});
	});

	test('removes single quotes', () => {
		const result = parse_dotenv("FOO='bar baz'");
		assert.deepStrictEqual(result, {FOO: 'bar baz'});
	});

	test('handles values with equals signs', () => {
		const result = parse_dotenv('URL=postgres://host:5432/db?sslmode=require');
		assert.deepStrictEqual(result, {URL: 'postgres://host:5432/db?sslmode=require'});
	});

	test('handles empty values', () => {
		const result = parse_dotenv('FOO=');
		assert.deepStrictEqual(result, {FOO: ''});
	});

	test('skips lines without equals', () => {
		const result = parse_dotenv('no_equals_here\nFOO=bar');
		assert.deepStrictEqual(result, {FOO: 'bar'});
	});

	test('handles \\r\\n line endings', () => {
		const result = parse_dotenv('FOO=bar\r\nBAZ=qux\r\n');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('last value wins for duplicate keys', () => {
		const result = parse_dotenv('FOO=first\nFOO=second');
		assert.deepStrictEqual(result, {FOO: 'second'});
	});

	test('mismatched quotes are not stripped', () => {
		const result = parse_dotenv('FOO="bar\'');
		assert.deepStrictEqual(result, {FOO: '"bar\''});
	});

	test('single quote character is preserved as literal', () => {
		assert.deepStrictEqual(parse_dotenv('FOO="'), {FOO: '"'});
		assert.deepStrictEqual(parse_dotenv("FOO='"), {FOO: "'"});
	});

	test('double-quoted plain value is unchanged', () => {
		assert.deepStrictEqual(parse_dotenv('FOO="plain"'), {FOO: 'plain'});
	});

	test('double-quoted value unescapes \\" to "', () => {
		// on disk: FOO="has \"q\""
		assert.deepStrictEqual(parse_dotenv('FOO="has \\"q\\""'), {FOO: 'has "q"'});
	});

	test('double-quoted value unescapes \\\\ to \\', () => {
		// on disk: FOO="C:\\path"  (4 chars inside the quotes: C, :, \, \, p, a, t, h)
		assert.deepStrictEqual(parse_dotenv('FOO="C:\\\\path"'), {FOO: 'C:\\path'});
	});

	test('escaped backslash followed by escaped quote decodes to backslash + quote', () => {
		// inside the quotes: 4 chars [\, \, \, "]  — well-formed, what the writer produces for input [\, "]
		// single-pass: \\ → \, then \" → " ⇒ result is 2 chars [\, "]
		const BS = '\\';
		const Q = '"';
		const inner = BS + BS + BS + Q;
		assert.deepStrictEqual(parse_dotenv(`FOO="${inner}"`), {FOO: BS + Q});
	});

	test('single-quoted value is taken literally with no escape processing', () => {
		// on disk: FOO='has "q"'  — single quotes do not unescape
		assert.deepStrictEqual(parse_dotenv('FOO=\'has "q"\''), {FOO: 'has "q"'});
	});

	test('single-quoted value preserves literal backslashes', () => {
		// on disk: FOO='C:\\path'  — single-quoted, no unescape
		assert.deepStrictEqual(parse_dotenv("FOO='C:\\\\path'"), {FOO: 'C:\\\\path'});
	});

	test('unquoted value preserves literal backslashes', () => {
		assert.deepStrictEqual(parse_dotenv('FOO=C:\\\\path'), {FOO: 'C:\\\\path'});
	});

	test('double-quoted value leaves unrecognized escapes literal', () => {
		// \t inside "..." is not unescaped — backslash + t stay as two characters.
		assert.deepStrictEqual(parse_dotenv('FOO="tab\\there"'), {FOO: 'tab\\there'});
	});

	test('double-quoted value unescapes \\n to newline', () => {
		assert.deepStrictEqual(parse_dotenv('FOO="line1\\nline2"'), {FOO: 'line1\nline2'});
	});

	test('double-quoted value unescapes \\r to carriage return', () => {
		assert.deepStrictEqual(parse_dotenv('FOO="a\\rb"'), {FOO: 'a\rb'});
	});

	test('strips inline comment after closing double quote', () => {
		assert.deepStrictEqual(parse_dotenv('FOO="hello" # important'), {FOO: 'hello'});
	});

	test('strips inline comment after closing single quote', () => {
		assert.deepStrictEqual(parse_dotenv("FOO='hello' # important"), {FOO: 'hello'});
	});

	test('strips inline comment with no space before hash (after closing quote)', () => {
		assert.deepStrictEqual(parse_dotenv('FOO="hello"#tight'), {FOO: 'hello'});
	});

	test('preserves unquoted value with # (URL fragment, no whitespace)', () => {
		// no whitespace before `#` — fragment is part of the value
		assert.deepStrictEqual(parse_dotenv('URL=https://example.com#frag'), {
			URL: 'https://example.com#frag',
		});
	});

	test('strips trailing comment from unquoted value with whitespace before #', () => {
		assert.deepStrictEqual(parse_dotenv('KEY=value # comment'), {KEY: 'value'});
	});

	test('strips trailing tab-preceded comment from unquoted value', () => {
		assert.deepStrictEqual(parse_dotenv('KEY=value\t# comment'), {KEY: 'value'});
	});

	test('unquoted value loses trailing whitespace before the stripped comment', () => {
		// `KEY=value   # c` — the intra-value whitespace before `#` is consumed
		// as the comment boundary, so the parsed value is `value`
		assert.deepStrictEqual(parse_dotenv('KEY=value   # c'), {KEY: 'value'});
	});

	test('unquoted value starting with # is empty (comment-only)', () => {
		// `KEY=#c` — no value, `#c` is a comment. Matches dotenv ecosystem.
		assert.deepStrictEqual(parse_dotenv('KEY=#c'), {KEY: ''});
	});

	test('unquoted value with only space then # is empty', () => {
		assert.deepStrictEqual(parse_dotenv('KEY= # c'), {KEY: ''});
	});

	test('unquoted value that is only `#` (no trailing comment text) is empty', () => {
		assert.deepStrictEqual(parse_dotenv('KEY=#'), {KEY: ''});
	});

	test('leading-# rule does not affect quoted values containing #', () => {
		// `#` inside `"..."` stays literal; comment detection only applies
		// to unquoted values.
		assert.deepStrictEqual(parse_dotenv('KEY="#still-a-value"'), {KEY: '#still-a-value'});
	});

	test('leaves quoted value raw if non-comment junk follows the closing quote', () => {
		// not a clean assignment — leave the whole right-hand side untouched
		assert.deepStrictEqual(parse_dotenv('FOO="hello" extra'), {FOO: '"hello" extra'});
	});

	test('does not crash on dangling backslash inside double quotes', () => {
		// inside the quotes: 4 chars [f, o, o, \]  — trailing backslash with no escape partner.
		// Parser leaves the value raw because the closing `"` is consumed as the escape target.
		const BS = '\\';
		const inner = 'foo' + BS;
		// the trailing `"` gets consumed as `\"` so there's no closing quote, value stays raw
		assert.deepStrictEqual(parse_dotenv(`FOO="${inner}"`), {FOO: `"${inner}"`});
	});
});

describe('load_env_file', () => {
	test('loads and parses a file', async () => {
		const runtime = {
			read_text_file: (_path: string) => Promise.resolve('FOO=bar\nBAZ=qux'),
		};
		const result = await load_env_file(runtime, '/some/path');
		assert.deepStrictEqual(result, {FOO: 'bar', BAZ: 'qux'});
	});

	test('returns empty record for empty file', async () => {
		const runtime = {
			read_text_file: (_path: string) => Promise.resolve(''),
		};
		const result = await load_env_file(runtime, '/empty');
		assert.deepStrictEqual(result, {});
	});

	test('returns null on missing file (Node ENOENT)', async () => {
		const err: any = new Error('not found');
		err.code = 'ENOENT';
		const runtime = {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			read_text_file: (_path: string): Promise<string> => Promise.reject(err),
		};
		const result = await load_env_file(runtime, '/missing');
		assert.strictEqual(result, null);
	});

	test('returns null on missing file (Deno NotFound)', async () => {
		class NotFound extends Error {
			override name = 'NotFound';
		}
		const runtime = {
			read_text_file: (_path: string): Promise<string> => Promise.reject(new NotFound()),
		};
		const result = await load_env_file(runtime, '/missing');
		assert.strictEqual(result, null);
	});

	test('rethrows non-not-found errors (e.g. permission denied)', async () => {
		const err: any = new Error('permission denied');
		err.code = 'EACCES';
		const runtime = {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
			read_text_file: (_path: string): Promise<string> => Promise.reject(err),
		};
		let thrown: unknown;
		try {
			await load_env_file(runtime, '/denied');
		} catch (e) {
			thrown = e;
		}
		assert.instanceOf(thrown, Error);
		assert.match(thrown.message, /permission denied/);
	});
});
