/**
 * Tests for `install_unit_db_guard` — a unit test (this file, in the `unit`
 * project, whose setup installs the guard) can build the default factory but
 * not open a database through it.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	create_default_db_factory,
	install_unit_db_guard,
	set_default_db_factory
} from '#lib/testing/db.ts';

const init_schema = async (): Promise<void> => undefined;

describe('install_unit_db_guard', () => {
	test("the unit project's default factory refuses to open a database, naming the fix", async () => {
		const factory = create_default_db_factory(init_schema);
		assert.strictEqual(factory.name, 'unit-refused');
		await assert_rejects(() => factory.create(), /name the test file `\*\.db\.test\.ts`/);
	});

	test('installs over the builder in place and returns it', async () => {
		const previous = set_default_db_factory(null);
		try {
			assert.strictEqual(install_unit_db_guard(), null);
			await assert_rejects(() => create_default_db_factory(init_schema).create(), /db\.test\.ts/);
		} finally {
			set_default_db_factory(previous);
		}
	});
});
