/**
 * Tests for the common route spec factories (health check, readiness, server
 * status).
 *
 * Creates test Hono apps from route specs and exercises both metadata
 * and HTTP behavior for authenticated and unauthenticated requests.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	create_health_route_spec,
	create_ready_route_spec,
	create_server_status_route_spec
} from '#lib/http/common_routes.ts';
import { ERROR_DB_UNREACHABLE, ERROR_SCHEMA_DRIFT } from '#lib/http/error_schemas.ts';
import { Db, type DbClient } from '#lib/db/db.ts';
import { apply_route_specs } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { REQUEST_CONTEXT_KEY, type RequestContext } from '#lib/auth/request_context.ts';
import {
	RESOLVED_AUTH_KEY,
	TEST_CONTEXT_PRESET,
	TEST_CONTEXT_PRESET_KEY
} from '#lib/hono_context.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { create_test_context } from '#lib/testing/entities.ts';

const log = new Logger('test', { level: 'off' });
const db = create_stub_db();

/** Create a test request context for an authenticated user (no role_grants). */
const create_test_ctx = (): RequestContext => create_test_context([]);

/** Create a test Hono app with route specs and optional auth context. */
const create_test_app = (
	specs: Parameters<typeof apply_route_specs>[1],
	auth_ctx?: RequestContext
): Hono => {
	const app = new Hono();
	if (auth_ctx) {
		app.use('/*', async (c, next) => {
			(c as any).set(
				RESOLVED_AUTH_KEY,
				create_test_resolved_auth({ credential_type: 'session', account_id: auth_ctx.account.id })
			);
			(c as any).set(REQUEST_CONTEXT_KEY, auth_ctx);
			(c as any).set(TEST_CONTEXT_PRESET_KEY, TEST_CONTEXT_PRESET);
			await next();
		});
	}
	apply_route_specs(app, specs, fuz_auth_guard_resolver, log, db);
	return app;
};

describe('health route spec metadata', () => {
	test('method is GET, path is /health, auth is none', () => {
		const spec = create_health_route_spec();
		assert.strictEqual(spec.method, 'GET');
		assert.strictEqual(spec.path, '/health');
		assert.deepStrictEqual(spec.auth, { account: 'none', actor: 'none' });
		assert.strictEqual(spec.description, 'Health check');
	});
});

describe('health route handler', () => {
	test('returns {status: ok}', async () => {
		const spec = create_health_route_spec();
		const app = create_test_app([spec]);
		const res = await app.request('/health');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.status, 'ok');
		assert.deepStrictEqual(Object.keys(body), ['status']);
	});

	test('responds 200 regardless of auth headers', async () => {
		const spec = create_health_route_spec();
		const app = create_test_app([spec]);

		// With cookie header
		const res_cookie = await app.request('/health', {
			headers: { cookie: 'test_session=some_value' }
		});
		assert.strictEqual(res_cookie.status, 200);

		// With bearer header
		const res_bearer = await app.request('/health', {
			headers: { authorization: 'Bearer some_token' }
		});
		assert.strictEqual(res_bearer.status, 200);

		// With both
		const res_both = await app.request('/health', {
			headers: { cookie: 'test_session=some_value', authorization: 'Bearer some_token' }
		});
		assert.strictEqual(res_both.status, 200);
	});
});

describe('ready route handler', () => {
	const expected = { schema_version: ['name', 'sequence'] };

	/** A db whose column query answers `rows`, or throws when given none. */
	const create_ready_db = (rows?: Array<{ table_name: string; column_name: string }>): Db => {
		const client: DbClient = {
			query: async <T>() => {
				if (!rows) throw new Error('connection refused');
				return { rows: rows as Array<T> };
			}
		};
		const db: Db = new Db({ client, transaction: async (fn) => fn(db) });
		return db;
	};

	const request_ready = async (db: Db): Promise<{ status: number; body: unknown }> => {
		const app = new Hono();
		apply_route_specs(
			app,
			[create_ready_route_spec({ expected })],
			fuz_auth_guard_resolver,
			log,
			db
		);
		const res = await app.request('/ready');
		return { status: res.status, body: await res.json() };
	};

	test('answers 200 {ready: true} when every expected column is live', async () => {
		const db = create_ready_db([
			{ table_name: 'schema_version', column_name: 'name' },
			{ table_name: 'schema_version', column_name: 'sequence' }
		]);
		assert.deepStrictEqual(await request_ready(db), { status: 200, body: { ready: true } });
	});

	test('answers 503 schema_drift when a column is missing', async () => {
		const db = create_ready_db([{ table_name: 'schema_version', column_name: 'name' }]);
		assert.deepStrictEqual(await request_ready(db), {
			status: 503,
			body: { error: ERROR_SCHEMA_DRIFT }
		});
	});

	test('answers 503 schema_drift when a table is missing', async () => {
		assert.deepStrictEqual(await request_ready(create_ready_db([])), {
			status: 503,
			body: { error: ERROR_SCHEMA_DRIFT }
		});
	});

	test('answers 503 db_unreachable when the column query throws', async () => {
		assert.deepStrictEqual(await request_ready(create_ready_db()), {
			status: 503,
			body: { error: ERROR_DB_UNREACHABLE }
		});
	});

	test('the two codes are distinct', () => {
		assert.strictEqual(ERROR_SCHEMA_DRIFT, 'schema_drift');
		assert.strictEqual(ERROR_DB_UNREACHABLE, 'db_unreachable');
	});
});

describe('server status route spec metadata', () => {
	test('method is GET, path is /api/server/status, auth is authenticated', () => {
		const spec = create_server_status_route_spec({
			version: '1.0.0',
			get_uptime_ms: () => 5000
		});
		assert.strictEqual(spec.method, 'GET');
		assert.strictEqual(spec.path, '/api/server/status');
		assert.deepStrictEqual(spec.auth, { account: 'required', actor: 'none' });
		assert.strictEqual(spec.description, 'Server version and uptime');
	});
});

describe('server status route handler', () => {
	test('returns version and uptime_ms', async () => {
		const spec = create_server_status_route_spec({
			version: '2.5.1',
			get_uptime_ms: () => 12345
		});
		const ctx = create_test_ctx();
		const app = create_test_app([spec], ctx);
		const res = await app.request('/api/server/status');
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.version, '2.5.1');
		assert.strictEqual(body.uptime_ms, 12345);
	});

	test('calls get_uptime_ms on each request', async () => {
		let call_count = 0;
		const spec = create_server_status_route_spec({
			version: '1.0.0',
			get_uptime_ms: () => {
				call_count++;
				return call_count * 1000;
			}
		});
		const ctx = create_test_ctx();
		const app = create_test_app([spec], ctx);

		const res1 = await app.request('/api/server/status');
		const body1 = await res1.json();
		assert.strictEqual(body1.uptime_ms, 1000);

		const res2 = await app.request('/api/server/status');
		const body2 = await res2.json();
		assert.strictEqual(body2.uptime_ms, 2000);
	});
});
