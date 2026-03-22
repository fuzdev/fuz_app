/**
 * Tests for app settings queries.
 *
 * @module
 */

import {test, assert} from 'vitest';

import {
	query_app_settings_load,
	query_app_settings_update,
} from '$lib/auth/app_settings_queries.js';
import {query_create_account_with_actor} from '$lib/auth/account_queries.js';
import {create_pglite_factory, create_describe_db, AUTH_TRUNCATE_TABLES} from '$lib/testing/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import type {Db} from '$lib/db/db.js';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, AUTH_TRUNCATE_TABLES);

describe_db('app_settings_queries', (get_db) => {
	test('load returns default settings', async () => {
		const db = get_db();
		const deps = {db};
		const settings = await query_app_settings_load(deps);
		assert.strictEqual(settings.open_signup, false);
		assert.strictEqual(settings.updated_at, null);
		assert.strictEqual(settings.updated_by, null);
	});

	test('update toggles open_signup and tracks actor', async () => {
		const db = get_db();
		const deps = {db};

		// Create an account+actor to be the updater
		const {actor} = await query_create_account_with_actor(deps, {
			username: 'admin',
			password_hash: 'hash',
		});

		const updated = await query_app_settings_update(deps, true, actor.id);
		assert.strictEqual(updated.open_signup, true);
		assert.ok(updated.updated_at);
		assert.strictEqual(updated.updated_by, actor.id);

		// Verify load reflects the update
		const loaded = await query_app_settings_load(deps);
		assert.strictEqual(loaded.open_signup, true);
	});

	test('update can toggle back to false', async () => {
		const db = get_db();
		const deps = {db};

		const {actor} = await query_create_account_with_actor(deps, {
			username: 'admin',
			password_hash: 'hash',
		});

		await query_app_settings_update(deps, true, actor.id);
		const updated = await query_app_settings_update(deps, false, actor.id);
		assert.strictEqual(updated.open_signup, false);
	});
});
