import {test, describe, assert} from 'vitest';

import {update_env_variable} from '$lib/env/update_env_variable.js';
import {create_mock_fs} from '$lib/testing/mock_fs.js';

const comment_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'preserves inline comment after quoted value',
		'API_KEY="old_value" # this is important',
		'API_KEY',
		'new_value',
		'API_KEY="new_value" # this is important',
	],
	[
		'preserves inline comment after unquoted value',
		'API_KEY=old_value # comment here',
		'API_KEY',
		'new_value',
		'API_KEY=new_value # comment here',
	],
	[
		'preserves inline comment with no space before hash',
		'API_KEY="old_value"# no space comment',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"# no space comment',
	],
	[
		'preserves inline comment with multiple spaces before hash',
		'API_KEY="old_value"   # spaced comment',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"   # spaced comment',
	],
	[
		'does not treat hash inside quoted value as comment',
		'API_KEY="value#with#hashes" # real comment',
		'API_KEY',
		'new_value',
		'API_KEY="new_value" # real comment',
	],
	[
		// Symmetric with parse_dotenv: `#` in an unquoted value is literal unless
		// whitespace precedes it. The old `#notacomment` suffix was part of the
		// value, not a preserved comment, so it does not carry onto the new value.
		'does not extract comment from unquoted value with no whitespace before #',
		'API_KEY=value#notacomment',
		'API_KEY',
		'new_value',
		'API_KEY=new_value',
	],
	[
		'handles empty inline comment',
		'API_KEY="old_value" #',
		'API_KEY',
		'new_value',
		'API_KEY="new_value" #',
	],
	[
		'preserves inline comment with special characters',
		'API_KEY="old" # TODO: update this! @important',
		'API_KEY',
		'new',
		'API_KEY="new" # TODO: update this! @important',
	],
	[
		'handles single quotes with inline comment',
		"API_KEY='old_value' # comment",
		'API_KEY',
		'new_value',
		'API_KEY="new_value" # comment',
	],
	[
		'does not add inline comment when original has none',
		'API_KEY="old_value"',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"',
	],
	[
		'preserves multiple hashes in comment',
		'API_KEY="old" # comment ## with ### hashes',
		'API_KEY',
		'new',
		'API_KEY="new" # comment ## with ### hashes',
	],
	[
		'preserves comment after escaped backslash at end of value',
		'API_KEY="test\\\\" # important comment',
		'API_KEY',
		'new',
		'API_KEY="new" # important comment',
	],
	[
		'preserves comment after single escaped backslash',
		'PATH="C:\\\\temp\\\\" # Windows path',
		'PATH',
		'D:\\\\new',
		// new value `D:\\new` (2 backslashes) escapes to `D:\\\\new` (4 backslashes) inside `"..."`
		'PATH="D:\\\\\\\\new" # Windows path',
	],
	[
		'handles escaped quote followed by more content (not a closing quote)',
		'MSG="Say \\"hello\\" please" # greeting',
		'MSG',
		'new message',
		'MSG="new message" # greeting',
	],
];

describe('update_env_variable - inline comment preservation', () => {
	test.each(comment_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({'/test/.env': initial});

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file,
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});
});
