import {test, describe, assert} from 'vitest';

import {update_env_variable} from '$lib/env/update_env_variable.js';
import {create_mock_fs} from '$lib/testing/mock_fs.js';

const quote_detection_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'does not add quotes when original value contains quotes but assignment does not',
		"NAME=O'Brien",
		'NAME',
		'Smith',
		'NAME=Smith',
	],
	[
		'handles value with internal quotes when quoted',
		'NAME="O\'Brien"',
		'NAME',
		'Smith',
		'NAME="Smith"',
	],
	[
		'handles single quote style',
		"API_KEY='old_value'",
		'API_KEY',
		'new_value',
		'API_KEY="new_value"',
	],
	[
		'handles escaped quotes in value',
		'API_KEY="value with \\" escaped quotes"',
		'API_KEY',
		'new',
		'API_KEY="new"',
	],
	[
		'handles escaped quote at end of value',
		'API_KEY="test\\\\"',
		'API_KEY',
		'new',
		'API_KEY="new"',
	],
	[
		'handles multiple escaped quotes in sequence',
		'API_KEY="test\\\\\\"value"',
		'API_KEY',
		'new',
		'API_KEY="new"',
	],
	[
		'handles escaped quote with inline comment',
		'API_KEY="test\\" quote" # comment',
		'API_KEY',
		'new',
		'API_KEY="new" # comment',
	],
];

describe('update_env_variable - quote detection edge cases', () => {
	test.each(quote_detection_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});
});

describe('update_env_variable - special values', () => {
	test('handles empty value', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', '', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY=""');
	});

	test('handles value with equals sign', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', 'value=with=equals', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="value=with=equals"');
	});

	test('handles value with newlines', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', 'value\nwith\nnewlines', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// newlines are escaped as `\n` literal so the line stays a single assignment
		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="value\\nwith\\nnewlines"');
	});

	test('escapes carriage returns', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="old"'});

		await update_env_variable('KEY', 'a\rb\r\nc', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'KEY="a\\rb\\r\\nc"');
	});

	test('forces double-quoted (with escapes) when value has both " and a newline', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="old"'});

		// has `"` but also has a newline — single-quoted would split the line in two
		await update_env_variable('KEY', 'has "q"\nand newline', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'KEY="has \\"q\\"\\nand newline"');
	});

	test('handles value with backslashes (Windows paths)', async () => {
		const fs = create_mock_fs({'/test/.env': 'PATH_KEY="old_path"'});

		await update_env_variable('PATH_KEY', 'C:\\Users\\Admin\\Documents', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// backslashes are escaped inside `"..."` so parse_dotenv round-trips
		assert.strictEqual(fs.get_file('/test/.env'), 'PATH_KEY="C:\\\\Users\\\\Admin\\\\Documents"');
	});

	test('handles value with unicode characters', async () => {
		const fs = create_mock_fs({'/test/.env': 'UNICODE_KEY="old"'});

		const unicode_value = '你好世界 🌍 Привет мир';
		await update_env_variable('UNICODE_KEY', unicode_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `UNICODE_KEY="${unicode_value}"`);
	});

	test('handles very long values', async () => {
		const fs = create_mock_fs({'/test/.env': 'LONG_KEY="short"'});

		const long_value = 'x'.repeat(10000);
		await update_env_variable('LONG_KEY', long_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `LONG_KEY="${long_value}"`);
	});

	test('handles value with JSON content', async () => {
		const fs = create_mock_fs({'/test/.env': 'JSON_KEY="old"'});

		const json_value = '{"name":"test","nested":{"key":"value"},"array":[1,2,3]}';
		await update_env_variable('JSON_KEY', json_value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// JSON contains `"` so the value is written with single-quote wrapping
		// to keep the line a parseable single-key assignment.
		assert.strictEqual(fs.get_file('/test/.env'), `JSON_KEY='${json_value}'`);
	});

	test('handles value with special characters', async () => {
		const fs = create_mock_fs({'/test/.env': 'API_KEY="old_value"'});

		await update_env_variable('API_KEY', 'value!@#$%^&*()_+-=[]{}|;:,.<>?', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'API_KEY="value!@#$%^&*()_+-=[]{}|;:,.<>?"');
	});
});

const whitespace_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'handles key with spaces around equals sign',
		'API_KEY = "old_value"',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"',
	],
	[
		'handles key with leading whitespace in file',
		'  LEADING_SPACE="old_value"',
		'LEADING_SPACE',
		'new_value',
		'LEADING_SPACE="new_value"',
	],
	[
		'handles key with trailing whitespace before equals',
		'TRAILING_SPACE  ="old_value"',
		'TRAILING_SPACE',
		'new_value',
		'TRAILING_SPACE="new_value"',
	],
];

describe('update_env_variable - whitespace handling', () => {
	test.each(whitespace_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});

	test('preserves exact original formatting for non-matching lines', async () => {
		const fs = create_mock_fs({
			'/test/.env': '  INDENT_KEY  =  "spaced"  \nTARGET_KEY="old"\n\t\tTAB_KEY\t=\t"tabbed"\t',
		});

		await update_env_variable('TARGET_KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		const result = fs.get_file('/test/.env');
		assert.strictEqual(
			result,
			'  INDENT_KEY  =  "spaced"  \nTARGET_KEY="new"\n\t\tTAB_KEY\t=\t"tabbed"\t',
		);

		const lines = result?.split('\n') || [];
		assert.strictEqual(lines[0], '  INDENT_KEY  =  "spaced"  ');
		assert.strictEqual(lines[2], '\t\tTAB_KEY\t=\t"tabbed"\t');
	});
});

const special_key_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'handles key with underscores and numbers',
		'API_KEY_123="old_value"',
		'API_KEY_123',
		'new_value',
		'API_KEY_123="new_value"',
	],
	[
		'handles key with dots (regex special char)',
		'NORMAL_KEY="value1"\nSPECIAL.KEY="value2"',
		'SPECIAL.KEY',
		'new_value',
		'NORMAL_KEY="value1"\nSPECIAL.KEY="new_value"',
	],
	[
		'handles empty key name',
		'VALID_KEY="value"',
		'',
		'empty_key_value',
		'VALID_KEY="value"\n="empty_key_value"',
	],
];

describe('update_env_variable - special keys', () => {
	test.each(special_key_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});
});

const file_variation_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'handles file with only comments',
		'# Comment 1\n# Comment 2',
		'NEW_KEY',
		'new_value',
		'# Comment 1\n# Comment 2\nNEW_KEY="new_value"',
	],
	[
		// trailing-newline state preserved; blank lines preserved; no extra blank inserted
		'handles file with only empty lines',
		'\n\n\n',
		'NEW_KEY',
		'new_value',
		'\n\n\nNEW_KEY="new_value"\n',
	],
];

// Thorough coverage for the "no blank line inserted + trailing-newline state preserved"
// contract on append. Each row runs through both update (same key) and append (new key)
// paths implicitly via the `key` column — rows where the key already exists exercise
// the update path; rows where it doesn't exercise append.
const append_trailing_newline_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'append: single-newline-only file keeps its blank line, adds trailing newline',
		'\n',
		'NEW',
		'v',
		'\nNEW="v"\n',
	],
	[
		'append: comments-only file with trailing newline gains key before EOF, trailing preserved',
		'# c1\n# c2\n',
		'NEW',
		'v',
		'# c1\n# c2\nNEW="v"\n',
	],
	[
		'append: preserves internal blank lines',
		'A="1"\n\nB="2"\n',
		'C',
		'3',
		'A="1"\n\nB="2"\nC="3"\n',
	],
	[
		'append: multiple trailing newlines keep one blank gap before new key',
		'A="1"\n\n',
		'NEW',
		'v',
		'A="1"\n\nNEW="v"\n',
	],
	[
		'append: multi-key file with trailing newline — no blank line inserted',
		'A="1"\nB="2"\nC="3"\n',
		'D',
		'4',
		'A="1"\nB="2"\nC="3"\nD="4"\n',
	],
	[
		'append: multi-key file without trailing newline stays without trailing newline',
		'A="1"\nB="2"\nC="3"',
		'D',
		'4',
		'A="1"\nB="2"\nC="3"\nD="4"',
	],
];

const update_trailing_newline_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'update: first key in multi-key trailing-newline file',
		'A="old"\nB="b"\nC="c"\n',
		'A',
		'new',
		'A="new"\nB="b"\nC="c"\n',
	],
	[
		'update: last key in multi-key trailing-newline file',
		'A="a"\nB="b"\nC="old"\n',
		'C',
		'new',
		'A="a"\nB="b"\nC="new"\n',
	],
	[
		'update: middle key preserves surrounding blank lines',
		'A="a"\n\nMID="old"\n\nZ="z"\n',
		'MID',
		'new',
		'A="a"\n\nMID="new"\n\nZ="z"\n',
	],
	[
		'update: duplicate keys — last-wins, other occurrences untouched, trailing \\n kept',
		'K=first\nK=second\n',
		'K',
		'third',
		'K=first\nK=third\n',
	],
];

describe('update_env_variable - quoting of values with embedded quotes', () => {
	test('uses single quotes when value contains a double quote', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="old"'});

		await update_env_variable('KEY', 'has "q" inside', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `KEY='has "q" inside'`);
	});

	test('keeps double quotes when value contains a single quote only', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="old"'});

		await update_env_variable('KEY', "O'Brien", {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `KEY="O'Brien"`);
	});

	test('escapes " and \\ when value contains both quote characters', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="old"'});

		await update_env_variable('KEY', `it's "quoted"`, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), `KEY="it's \\"quoted\\""`);
	});

	test('uses single quotes for a new key when value contains a double quote', async () => {
		const fs = create_mock_fs({});

		await update_env_variable('NEW_KEY', 'with "quote"', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		// new files end with `\n`
		assert.strictEqual(fs.get_file('/test/.env'), `NEW_KEY='with "quote"'\n`);
	});
});

// Pins current CRLF behavior: `content.split('\n')` strips the trailing `\r`
// from each line and rejoins with `\n`, so the modified line loses its `\r`
// while unmodified lines keep theirs. Not ideal but documented here so a
// future change is intentional.
describe('update_env_variable - CRLF line endings (current behavior)', () => {
	test('drops the \\r from the modified line and preserves it on others', async () => {
		const fs = create_mock_fs({'/test/.env': 'KEY="old"\r\nOTHER="keep"\r\n'});

		await update_env_variable('KEY', 'new', {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), 'KEY="new"\nOTHER="keep"\r\n');
	});
});

describe('update_env_variable - file variations', () => {
	test.each(file_variation_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});

	test.each(append_trailing_newline_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});

	test.each(update_trailing_newline_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});

	test('verifies path is resolved to absolute', async () => {
		let resolved_path: string | undefined;

		await update_env_variable('KEY', 'value', {
			env_file_path: './relative/.env',
			read_file: async () => '',
			write_file: async (path, _content, _encoding) => {
				resolved_path = path;
			},
		});

		assert.ok(resolved_path);
		assert.ok(resolved_path.startsWith('/'));
		assert.ok(resolved_path.endsWith('relative/.env'));
	});
});
