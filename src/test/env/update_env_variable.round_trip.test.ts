/**
 * Round-trip tests: writes via `update_env_variable` then reads via
 * `parse_dotenv` and asserts the parsed value equals the original.
 * This pins the symmetry between the writer's quoting/escaping and the
 * reader's unescape behavior.
 *
 * @module
 */

import {test, describe, assert} from 'vitest';

import {update_env_variable} from '$lib/env/update_env_variable.ts';
import {parse_dotenv} from '$lib/env/dotenv.ts';
import {create_mock_fs} from '$lib/testing/mock_fs.ts';

const round_trip_cases: Array<[label: string, key: string, value: string]> = [
	['plain value', 'KEY', 'plain'],
	['JSON with double quotes only', 'JSON_KEY', '{"name":"test","nested":{"key":"value"}}'],
	['JSON with both quote characters', 'JSON_KEY', '{"msg":"it\'s here"}'],
	['Windows path with backslashes', 'PATH_KEY', 'C:\\Users\\Admin\\Documents'],
	['value with double quote and apostrophe', 'KEY', `has "quote" and 'apostrophe'`],
	['value with double quote only', 'KEY', 'has "quote" inside'],
	['value with apostrophe only', 'NAME', "O'Brien"],
	['value with literal backslash', 'KEY', 'a\\b'],
	['value with two backslashes', 'KEY', 'a\\\\b'],
	['value with backslash before quote (no apostrophe)', 'KEY', 'a\\"b'],
	['value with backslash + quote + apostrophe (forces escape branch)', 'KEY', `a\\"b'c`],
	['empty value', 'KEY', ''],
	['unicode value', 'KEY', '你好世界 🌍 Привет'],
	['value with newline', 'KEY', 'line1\nline2'],
	['value with CRLF', 'KEY', 'line1\r\nline2'],
	['value with quote and newline', 'KEY', 'has "q"\nnext'],
];

describe('update_env_variable + parse_dotenv round-trip', () => {
	test.each(round_trip_cases)('%s', async (_label, key, value) => {
		const fs = create_mock_fs({});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const written = fs.get_file('/test/.env');
		assert.ok(written !== undefined, 'file was written');

		const parsed = parse_dotenv(written);
		assert.strictEqual(parsed[key], value);
	});

	test('preserves a leading `export ` prefix when updating in place', async () => {
		const fs = create_mock_fs({'/test/.env': 'export KEY=old\n'});

		await update_env_variable('KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const written = fs.get_file('/test/.env')!;
		assert.strictEqual(written, 'export KEY=new\n');
		assert.deepStrictEqual(parse_dotenv(written), {KEY: 'new'});
	});

	test('round-trip when key already exists with quoted value', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="initial"'});

		const value = `mix of "quotes" and 'apostrophes' with \\backslash`;
		await update_env_variable('KEY', value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const parsed = parse_dotenv(fs.get_file('/test/.env')!);
		assert.strictEqual(parsed.KEY, value);
	});

	test('round-trip survives an inline comment in the original line', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="initial" # the api key'});

		await update_env_variable('KEY', 'new-value', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const written = fs.get_file('/test/.env');
		assert.strictEqual(written, 'KEY="new-value" # the api key');
		assert.strictEqual(parse_dotenv(written!).KEY, 'new-value');
	});

	test('round-trip: updating KEY=#comment preserves the comment with a space separator', async () => {
		// Parser treats `KEY=#original` as empty value + comment. The writer
		// should preserve the comment by emitting it with a leading space so
		// it doesn't merge with the new value, and the parser must round-trip
		// back to the new value.
		const fs = create_mock_fs({'/test/.env': 'KEY=#original'});

		await update_env_variable('KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const written = fs.get_file('/test/.env')!;
		assert.strictEqual(written, 'KEY=new #original');
		assert.strictEqual(parse_dotenv(written).KEY, 'new');
	});

	test('round-trip: updating KEY= # spaced comment preserves spacing through the comment', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY= # a note'});

		await update_env_variable('KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const written = fs.get_file('/test/.env')!;
		assert.strictEqual(parse_dotenv(written).KEY, 'new');
		// the comment is preserved (the writer already handled `\s+#` correctly;
		// this just pins it against regressions)
		assert.match(written, /# a note/);
	});

	test('round-trip preserves URL fragment when updating unquoted value', async () => {
		// hand-edited unquoted URL with a fragment — writer must not mistake `#frag`
		// as an inline comment to carry over onto the new value
		const fs = create_mock_fs({'/test/.env': 'URL=https://x.com#frag'});

		await update_env_variable('URL', 'https://y.com', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const written = fs.get_file('/test/.env')!;
		assert.strictEqual(written, 'URL=https://y.com');
		assert.strictEqual(parse_dotenv(written).URL, 'https://y.com');
	});

	test('round-trip preserves other keys', async () => {
		const fs = create_mock_fs({
			'/test/.env': 'OTHER="keep me"\nKEY="initial"\nLAST=unquoted_value',
		});

		await update_env_variable('KEY', 'has "q"', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const parsed = parse_dotenv(fs.get_file('/test/.env')!);
		assert.strictEqual(parsed.OTHER, 'keep me');
		assert.strictEqual(parsed.KEY, 'has "q"');
		assert.strictEqual(parsed.LAST, 'unquoted_value');
	});
});
