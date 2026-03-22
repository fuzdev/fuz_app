/**
 * Integration test verifying audit log entries persist when the request
 * transaction rolls back.
 *
 * `audit_log_fire_and_forget` writes to `background_db` (pool-level),
 * not the transaction-scoped `db`, so audit entries survive handler crashes.
 *
 * @module
 */

import {describe, test, assert, beforeAll, afterAll} from 'vitest';
import {z} from 'zod';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {create_test_app, type TestApp} from '$lib/testing/app_server.js';
import {create_session_config} from '$lib/auth/session_cookie.js';
import {audit_log_fire_and_forget, query_audit_log_list} from '$lib/auth/audit_log_queries.js';

const session_options = create_session_config('test_session');
const log = new Logger('test', {level: 'off'});

describe('audit log rollback resilience', () => {
	let test_app: TestApp;

	beforeAll(async () => {
		test_app = await create_test_app({
			session_options,
			create_route_specs: () => [
				{
					method: 'POST',
					path: '/api/poison',
					auth: {type: 'none'},
					description: 'Audit then crash — tests rollback resilience',
					input: z.null(),
					output: z.strictObject({ok: z.literal(true)}),
					handler: async (_c, route) => {
						void audit_log_fire_and_forget(
							route,
							{
								event_type: 'login',
								outcome: 'failure',
								ip: '127.0.0.1',
								metadata: {username: 'test', test: 'rollback_resilience'},
							},
							log,
							() => {},
						);
						throw new Error('deliberate handler crash');
					},
				},
			],
		});
	});

	afterAll(async () => {
		await test_app.cleanup();
	});

	test('audit entry persists despite transaction rollback', async () => {
		const res = await test_app.app.request('/api/poison', {
			method: 'POST',
			headers: {host: 'localhost', origin: 'http://localhost:5173'},
		});
		assert.strictEqual(res.status, 500);

		const events = await query_audit_log_list({db: test_app.backend.deps.db});
		const rollback_events = events.filter(
			(e) => (e.metadata as any)?.test === 'rollback_resilience',
		);
		assert.strictEqual(rollback_events.length, 1);
		assert.strictEqual(rollback_events[0]!.event_type, 'login');
		assert.strictEqual(rollback_events[0]!.outcome, 'failure');
	});
});
