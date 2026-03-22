/**
 * Tests for backend_db_routes — generic PostgreSQL table browser route specs.
 *
 * Uses pglite (in-memory) with auth tables for real schema/FK testing.
 *
 * @module
 */

import {describe, assert, test, beforeAll, afterAll, beforeEach} from 'vitest';
import {Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_db_route_specs, type ColumnInfo} from '$lib/http/db_routes.js';
import {apply_route_specs, type RouteSpec} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {REQUEST_CONTEXT_KEY, type RequestContext} from '$lib/auth/request_context.js';
import {CREDENTIAL_TYPE_KEY} from '$lib/hono_context.js';
import type {Db} from '$lib/db/db.js';
import {run_migrations} from '$lib/db/migrate.js';
import {AUTH_MIGRATION_NS} from '$lib/auth/migrations.js';
import {create_pglite_factory} from '$lib/testing/db.js';

const log = new Logger('test', {level: 'off'});

// Shared PGlite WASM instance via factory cache — avoids cold start overhead.
const factory = create_pglite_factory(async (db) => {
	await run_migrations(db, [AUTH_MIGRATION_NS]);
});

let db: Db;

/** Create a request context with keeper role. */
const keeper_ctx: RequestContext = {
	account: {
		id: 'acc_1',
		username: 'admin',
		password_hash: 'hash',
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		created_by: null,
		updated_by: null,
		email: null,
		email_verified: false,
	},
	actor: {
		id: 'act_1',
		account_id: 'acc_1',
		name: 'admin',
		created_at: new Date().toISOString(),
		updated_at: null,
		updated_by: null,
	},
	permits: [
		{
			id: 'perm_1',
			actor_id: 'act_1',
			role: 'keeper',
			created_at: new Date().toISOString(),
			expires_at: null,
			revoked_at: null,
			revoked_by: null,
			granted_by: null,
		},
	],
};

/** Create a test Hono app with keeper auth (daemon_token credential) and db route specs. */
const create_test_app = (specs: Array<RouteSpec>) => {
	const app = new Hono();
	app.use('/*', async (c, next) => {
		c.set(REQUEST_CONTEXT_KEY, keeper_ctx);
		c.set(CREDENTIAL_TYPE_KEY, 'daemon_token');
		await next();
	});
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return app;
};

beforeAll(async () => {
	db = await factory.create();
});

afterAll(async () => {
	await factory.close(db);
});

beforeEach(async () => {
	// clean up FK test tables from prior runs (isolate: false shares state)
	await db.query('DROP TABLE IF EXISTS fk_test_child, fk_test_parent CASCADE');
	await db.query('TRUNCATE api_token, auth_session, permit, actor, account CASCADE');
});

describe('route spec metadata', () => {
	test('creates 4 route specs', () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		assert.strictEqual(specs.length, 4);
	});

	test('all specs require keeper auth', () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		for (const spec of specs) {
			assert.deepStrictEqual(spec.auth, {type: 'keeper'});
		}
	});

	test('spec paths and methods are correct', () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		assert.strictEqual(specs[0]!.method, 'GET');
		assert.strictEqual(specs[0]!.path, '/health');
		assert.strictEqual(specs[1]!.method, 'GET');
		assert.strictEqual(specs[1]!.path, '/tables');
		assert.strictEqual(specs[2]!.method, 'GET');
		assert.strictEqual(specs[2]!.path, '/tables/:name');
		assert.strictEqual(specs[3]!.method, 'DELETE');
		assert.strictEqual(specs[3]!.path, '/tables/:name/rows/:id');
	});

	test('all specs have descriptions', () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		for (const spec of specs) {
			assert.ok(spec.description);
		}
	});
});

describe('GET /health handler', () => {
	test('returns connected true with table count', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/health');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.connected, true);
		assert.strictEqual(body.type, 'pglite-memory');
		assert.strictEqual(body.name, 'test');
		assert.ok(typeof body.table_count === 'number');
		assert.ok(body.table_count >= 5); // auth tables
	});

	test('includes extra_stats when provided', async () => {
		const specs = create_db_route_specs({
			db_type: 'pglite-memory',
			db_name: 'test',
			extra_stats: async () => ({custom_count: 42}),
		});
		const app = create_test_app(specs);
		const res = await app.request('/health');
		const body = await res.json();
		assert.strictEqual(body.custom_count, 42);
	});
});

describe('GET /tables handler', () => {
	test('lists public tables with row counts', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body.tables));
		const names = body.tables.map((t: {name: string}) => t.name);
		assert.ok(names.includes('account'));
		assert.ok(names.includes('actor'));
		assert.ok(names.includes('permit'));
		for (const table of body.tables) {
			assert.ok(typeof table.row_count === 'number');
		}
	});
});

describe('GET /tables/:name handler', () => {
	test('returns columns and empty rows for empty table', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables/account');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body.columns));
		assert.ok(body.columns.length > 0);
		const col = body.columns[0] as ColumnInfo;
		assert.ok('column_name' in col);
		assert.ok('data_type' in col);
		assert.ok('is_nullable' in col);
		assert.deepStrictEqual(body.rows, []);
		assert.strictEqual(body.total, 0);
		assert.strictEqual(body.offset, 0);
		assert.strictEqual(body.limit, 100);
	});

	test('returns rows with pagination', async () => {
		await db.query(`INSERT INTO account (username, password_hash) VALUES ('u1', 'h1')`);
		await db.query(`INSERT INTO account (username, password_hash) VALUES ('u2', 'h2')`);
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables/account?offset=0&limit=1');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.rows.length, 1);
		assert.strictEqual(body.total, 2);
		assert.strictEqual(body.offset, 0);
		assert.strictEqual(body.limit, 1);
	});

	test('detects primary key', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables/account');
		const body = await res.json();
		assert.strictEqual(body.primary_key, 'id');
	});

	test('invalid table name returns 400', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables/Robert%27;DROP%20TABLE');
		assert.strictEqual(res.status, 400);
	});

	test('nonexistent table returns 404', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables/nonexistent_table');
		assert.strictEqual(res.status, 404);
	});
});

describe('SQL injection resistance', () => {
	const sql_injection_payloads = [
		{name: 'UNION SELECT', value: 'account UNION SELECT'},
		{name: 'null byte', value: 'account%00'},
		{name: 'comment injection', value: 'account/**/'},
		{name: 'semicolon', value: 'account;DROP TABLE account'},
		{name: 'double dash comment', value: 'account--'},
		{name: 'single quote', value: "account'"},
		{name: 'schema qualified', value: 'pg_catalog.pg_user'},
		{name: 'backtick escape', value: 'account`'},
		{name: 'backslash', value: 'account\\'},
		{name: 'newline', value: 'account\n'},
	];

	for (const {name, value} of sql_injection_payloads) {
		test(`rejects ${name} in table name`, async () => {
			const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
			const app = create_test_app(specs);
			const res = await app.request(`/tables/${encodeURIComponent(value)}`);
			assert.strictEqual(res.status, 400, `${name} should be rejected`);
		});
	}

	test('rejects SQL injection in DELETE row id param', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		// The id param is passed via parameterized query ($1), so injection attempts
		// cannot execute arbitrary SQL. The UUID-typed id column rejects the non-UUID
		// string with a type error (500), or it could be 404/400 depending on handler.
		const res = await app.request(
			`/tables/account/rows/${encodeURIComponent("'; DROP TABLE account; --")}`,
			{method: 'DELETE'},
		);
		// Must not be 200 (injection success) — 400, 404, or 500 are all safe outcomes
		assert.ok(res.status !== 200, `injection must not succeed, got ${res.status}`);
	});
});

describe('DELETE /tables/:name/rows/:id handler', () => {
	test('deletes a row successfully', async () => {
		const result = await db.query<{id: string}>(
			`INSERT INTO account (username, password_hash) VALUES ('to_delete', 'hash') RETURNING id`,
		);
		const id = result[0]!.id;
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request(`/tables/account/rows/${id}`, {method: 'DELETE'});
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.success, true);
	});

	test('row not found returns 404', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables/account/rows/00000000-0000-0000-0000-000000000000', {
			method: 'DELETE',
		});
		assert.strictEqual(res.status, 404);
	});

	test('FK constraint returns 409 when child rows prevent deletion', async () => {
		// Auth tables use CASCADE, so create a custom table with RESTRICT FK
		// to exercise the 409 handler path
		await db.query(`CREATE TABLE IF NOT EXISTS fk_test_parent (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			name TEXT NOT NULL
		)`);
		await db.query(`CREATE TABLE IF NOT EXISTS fk_test_child (
			id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
			parent_id TEXT NOT NULL REFERENCES fk_test_parent(id) ON DELETE RESTRICT
		)`);
		const parent = await db.query<{id: string}>(
			`INSERT INTO fk_test_parent (name) VALUES ('parent') RETURNING id`,
		);
		const parent_id = parent[0]!.id;
		await db.query(`INSERT INTO fk_test_child (parent_id) VALUES ($1)`, [parent_id]);

		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request(`/tables/fk_test_parent/rows/${parent_id}`, {
			method: 'DELETE',
		});
		assert.strictEqual(res.status, 409);
		const body = await res.json();
		assert.strictEqual(body.error, 'foreign_key_violation');
		// Regression guard: PG detail/constraint must not leak to client (scrubbed 2026-03-19)
		assert.strictEqual(body.detail, undefined, 'PG detail must not leak to client');
		assert.strictEqual(body.constraint, undefined, 'PG constraint must not leak to client');
	});

	test('invalid table name returns 400', async () => {
		const specs = create_db_route_specs({db_type: 'pglite-memory', db_name: 'test'});
		const app = create_test_app(specs);
		const res = await app.request('/tables/bad--name/rows/1', {method: 'DELETE'});
		assert.strictEqual(res.status, 400);
	});
});
