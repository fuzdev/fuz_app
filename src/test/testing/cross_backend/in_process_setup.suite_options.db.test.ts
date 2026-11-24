/**
 * `default_in_process_suite_options` hands `audit_factory`,
 * `migration_namespaces` and `get_db` to the setup it builds: the factory
 * builds the test backend's emitter, the namespaces are migrated in its
 * database, and `get_db`'s database, read per test, is the one it runs on.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { SESSION_COOKIE_NAME } from '#lib/auth/session_cookie.ts';
import { CELL_MIGRATION_NS } from '#lib/db/cell_ddl.ts';
import type { Db } from '#lib/db/db.ts';
import { default_audit_factory, type AuditFactory } from '#lib/server/app_backend.ts';
import { default_in_process_suite_options } from '#lib/testing/cross_backend/in_process_setup.ts';
import {
	create_spine_route_specs,
	spine_rpc_endpoints
} from '#lib/testing/cross_backend/default_spine_surface.ts';

import { describe_db } from '../../auth_db_default.ts';

/** An audit factory that records each database it builds an emitter over. */
const create_recording_audit_factory = (): { audit_factory: AuditFactory; dbs: Array<Db> } => {
	const dbs: Array<Db> = [];
	const audit_factory: AuditFactory = (params) => {
		dbs.push(params.db);
		return default_audit_factory(params);
	};
	return { audit_factory, dbs };
};

const query_has_cell_table = async (db: Db): Promise<boolean> => {
	const [row] = await db.query<{ found: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cell'
		) AS found`
	);
	return row!.found;
};

describe('default_in_process_suite_options pass-throughs', () => {
	test('audit_factory builds the backend emitter and migration_namespaces are migrated', async () => {
		const { audit_factory, dbs } = create_recording_audit_factory();
		const { setup_test } = default_in_process_suite_options({
			session_cookie_name: SESSION_COOKIE_NAME,
			create_route_specs: create_spine_route_specs,
			rpc_endpoints: spine_rpc_endpoints,
			audit_factory,
			migration_namespaces: [CELL_MIGRATION_NS]
		});
		await setup_test();
		assert.strictEqual(dbs.length, 1, 'the factory built the one backend emitter');
		assert.ok(await query_has_cell_table(dbs[0]!), 'the cell namespace was migrated');
	});

	test('without migration_namespaces the database is auth-only', async () => {
		const { audit_factory, dbs } = create_recording_audit_factory();
		const { setup_test } = default_in_process_suite_options({
			session_cookie_name: SESSION_COOKIE_NAME,
			create_route_specs: create_spine_route_specs,
			rpc_endpoints: spine_rpc_endpoints,
			audit_factory
		});
		await setup_test();
		assert.strictEqual(dbs.length, 1);
		assert.ok(!(await query_has_cell_table(dbs[0]!)), 'no cell table without the namespace');
	});
});

describe_db('default_in_process_suite_options get_db', (get_db) => {
	// built while the describe body runs, before `describe_db` has a database:
	// `get_db` must be read per test, not here
	const recording = create_recording_audit_factory();
	const { setup_test } = default_in_process_suite_options({
		session_cookie_name: SESSION_COOKIE_NAME,
		create_route_specs: create_spine_route_specs,
		rpc_endpoints: spine_rpc_endpoints,
		audit_factory: recording.audit_factory,
		get_db
	});

	test('the app runs on the database get_db returns', async () => {
		recording.dbs.length = 0;
		// the in-memory drivers share one instance, so identity can't tell the
		// databases apart: a marker table can, since the fallback factory
		// resets the schema it would have handed out
		const db = get_db();
		await db.query('CREATE TABLE suite_options_marker (id int)');
		try {
			await setup_test();
			assert.strictEqual(recording.dbs.length, 1);
			const [row] = await recording.dbs[0]!.query<{ found: boolean }>(
				`SELECT EXISTS (
					SELECT 1 FROM information_schema.tables
					WHERE table_schema = 'public' AND table_name = 'suite_options_marker'
				) AS found`
			);
			assert.ok(row!.found, 'the backend got the describe_db database');
		} finally {
			await db.query('DROP TABLE IF EXISTS suite_options_marker');
		}
	});

	test('get_db with migration_namespaces is refused', async () => {
		const { setup_test: refused } = default_in_process_suite_options({
			session_cookie_name: SESSION_COOKIE_NAME,
			create_route_specs: create_spine_route_specs,
			rpc_endpoints: spine_rpc_endpoints,
			migration_namespaces: [CELL_MIGRATION_NS],
			get_db
		});
		await assert_rejects(() => refused(), /not both/);
	});
});
