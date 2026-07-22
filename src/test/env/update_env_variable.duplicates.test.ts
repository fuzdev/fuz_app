import { test, describe, assert } from 'vitest';

import { update_env_variable } from '$lib/env/update_env_variable.ts';
import { create_mock_fs } from '$lib/testing/mock_fs.ts';

const duplicate_cases: Array<
	[label: string, initial: string, key: string, value: string, expected: string]
> = [
	[
		'updates LAST occurrence when key appears twice',
		'API_KEY="first_value"\nAPI_KEY="second_value"',
		'API_KEY',
		'new_value',
		'API_KEY="first_value"\nAPI_KEY="new_value"'
	],
	[
		'updates LAST occurrence when key appears three times',
		'KEY="first"\nKEY="second"\nKEY="third"',
		'KEY',
		'updated',
		'KEY="first"\nKEY="second"\nKEY="updated"'
	],
	[
		'matches dotenv behavior: last wins',
		'API_KEY=first_value\nAPI_KEY=second_value\nAPI_KEY=third_value',
		'API_KEY',
		'new_value',
		'API_KEY=first_value\nAPI_KEY=second_value\nAPI_KEY=new_value'
	],
	[
		'updates LAST occurrence with inline comments preserved',
		'KEY="first" # dev\nKEY="second" # prod',
		'KEY',
		'updated',
		'KEY="first" # dev\nKEY="updated" # prod'
	],
	[
		'updates LAST occurrence when duplicates have different quote styles',
		'KEY=unquoted_first\nKEY="quoted_second"',
		'KEY',
		'new',
		'KEY=unquoted_first\nKEY="new"'
	],
	[
		'updates LAST occurrence when separated by other keys',
		'API_KEY="first"\nOTHER_KEY="value"\nAPI_KEY="second"',
		'API_KEY',
		'new',
		'API_KEY="first"\nOTHER_KEY="value"\nAPI_KEY="new"'
	],
	[
		'updates LAST occurrence when separated by comments',
		'API_KEY="first"\n# Comment\nAPI_KEY="second"',
		'API_KEY',
		'new',
		'API_KEY="first"\n# Comment\nAPI_KEY="new"'
	],
	[
		'updates LAST occurrence when separated by empty lines',
		'API_KEY="first"\n\nAPI_KEY="second"',
		'API_KEY',
		'new',
		'API_KEY="first"\n\nAPI_KEY="new"'
	],
	[
		'handles keys that are substrings of each other',
		'KEY="value1"\nSECRET_KEY="value2"',
		'KEY',
		'new_value',
		'KEY="new_value"\nSECRET_KEY="value2"'
	],
	[
		'handles keys that are prefixes of each other',
		'API_KEY="value1"\nAPI_KEY_SECRET="value2"',
		'API_KEY',
		'new_value',
		'API_KEY="new_value"\nAPI_KEY_SECRET="value2"'
	],
	[
		'does not match keys in comments',
		'# API_KEY="commented"\nAPI_KEY="actual_value"',
		'API_KEY',
		'new_value',
		'# API_KEY="commented"\nAPI_KEY="new_value"'
	]
];

describe('update_env_variable - duplicate keys (LAST wins behavior)', () => {
	test.each(duplicate_cases)('%s', async (_label, initial, key, value, expected) => {
		const fs = create_mock_fs({ '/test/.env': initial });

		await update_env_variable(key, value, {
			env_file_path: '/test/.env',
			read_file: fs.read_file,
			write_file: fs.write_file
		});

		assert.strictEqual(fs.get_file('/test/.env'), expected);
	});
});
