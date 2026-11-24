/**
 * Tests for `create_dual_spawn_global_setup` — the options it refuses before
 * any database opens or backend spawns.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { create_dual_spawn_global_setup } from '#lib/testing/cross_backend/create_dual_spawn_global_setup.ts';
import type { BackendConfig } from '#lib/testing/cross_backend/backend_config.ts';

const unused_config = (): BackendConfig => {
	throw new Error('not built in these tests');
};

describe('create_dual_spawn_global_setup', () => {
	test('both sides naming one database throws at construction', () => {
		assert.throws(
			() =>
				create_dual_spawn_global_setup({
					configs: { a: unused_config, b: unused_config },
					databases: {
						a: { name: 'parity', pglet_server: null },
						b: { name: 'parity', pglet_server: null }
					}
				}),
			/both sides name the database 'parity'/
		);
	});

	test('distinct names, or one side alone, are accepted', () => {
		create_dual_spawn_global_setup({
			configs: { a: unused_config, b: unused_config },
			databases: { a: { name: 'one', pglet_server: null }, b: { name: 'two', pglet_server: null } }
		});
		create_dual_spawn_global_setup({
			configs: { a: unused_config, b: unused_config },
			databases: { b: { name: 'one', pglet_server: null } }
		});
	});
});
