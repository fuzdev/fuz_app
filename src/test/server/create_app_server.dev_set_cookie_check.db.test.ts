/**
 * The DEV `Set-Cookie` check in an assembled server: a request carrying a
 * stale session cookie, answered by a `post_route_middleware` with a
 * `Response` of its own under `/api`, is logged — that answer carries no
 * clear — while the same answer to a valid or absent cookie, and an ordinary
 * route's answer to the stale one, are not. An accepted WebSocket upgrade
 * (`101`) is skipped by the check; that skip is pinned in
 * `http/dev_set_cookie_check.test.ts`, as an in-process request reaches no
 * runtime adapter to answer an upgrade.
 *
 * @module
 */

import { describe, test, assert, beforeAll } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { literal, loose_object } from '@fuzdev/fuz_schema/schema.ts';

import { create_session_config, create_session_cookie_value } from '#lib/auth/session_cookie.ts';
import { define_route } from '#lib/http/route_spec.ts';
import { route_ok } from '#lib/http/route_result.ts';
import { create_app_server, type AppServer } from '#lib/server/app_server.ts';
import type { AppBackend } from '#lib/server/app_backend.ts';
import { create_audit_emitter } from '#lib/auth/audit_emitter.ts';
import { create_loopback_app_server_options, stub_password_deps } from '#lib/testing/app_server.ts';
import { create_default_db_factory } from '#lib/testing/db.ts';
import { run_migrations } from '#lib/db/migrate.ts';
import { AUTH_MIGRATION_NS } from '#lib/auth/migrations.ts';
import { create_realtime_closer } from '#lib/actions/connection_closer.ts';
import { create_realtime_notification_sender } from '#lib/actions/notification_sender.ts';
import { create_test_keyring } from '../auth/session_test_helpers.ts';

const keyring = create_test_keyring('test-key-that-is-at-least-32-chars-long!!');
const session_options = create_session_config('test_session');
const STALE = 'test_session=stale.invalidsignature';

const factory = create_default_db_factory(async () => {});

describe('the DEV Set-Cookie check in create_app_server', () => {
	let server: AppServer;
	const errors: Array<string> = [];

	beforeAll(async () => {
		const db = await factory.create();
		const migration_results = await run_migrations(db, [AUTH_MIGRATION_NS]);
		const log = new Logger('test', { level: 'off' });
		log.error = (...args: Array<unknown>) => {
			if (String(args[0]).startsWith('Response without the expected first Set-Cookie')) {
				errors.push(String(args[0]));
			}
		};
		const backend: AppBackend = {
			db_type: 'pglet-memory',
			db_name: '(memory)',
			migration_results,
			close: async () => {},
			deps: {
				log,
				keyring,
				password: stub_password_deps,
				db,
				audit: create_audit_emitter({ db, log }),
				connection_closer: create_realtime_closer(),
				notification_sender: create_realtime_notification_sender()
			}
		};
		server = await create_app_server({
			backend,
			...create_loopback_app_server_options(),
			session_options,
			create_route_specs: () => [
				define_route({
					method: 'GET',
					path: '/api/ok',
					auth: { account: 'none', actor: 'none' },
					description: 'An ordinary route.',
					input: literal(null),
					output: loose_object({}),
					handler: () => route_ok({})
				})
			],
			post_route_middleware: [
				{
					name: 'own_response',
					path: '/api/own',
					handler: async () => new Response('built by hand')
				}
			]
		});
	});

	const request = async (path: string, cookie: string | null): Promise<Response> => {
		errors.length = 0;
		return server.app.request(path, {
			headers: { host: 'localhost', ...(cookie === null ? {} : { cookie }) }
		});
	};

	test('a hand-built answer to a stale cookie is logged', async () => {
		const res = await request('/api/own', STALE);
		assert.strictEqual(await res.text(), 'built by hand');
		assert.deepStrictEqual(res.headers.getSetCookie(), []);
		assert.deepStrictEqual(errors, [
			'Response without the expected first Set-Cookie: GET /api/own — it carries no Set-Cookie'
		]);
	});

	test('the same answer to a valid or an absent cookie is not', async () => {
		const valid = `test_session=${await create_session_cookie_value(keyring, 'a_token', session_options)}`;
		for (const cookie of [valid, null]) {
			await request('/api/own', cookie);
			assert.deepStrictEqual(errors, [], String(cookie));
		}
	});

	test("an ordinary route's answer to a stale cookie is not", async () => {
		const res = await request('/api/ok', STALE);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.getSetCookie().length, 1);
		assert.deepStrictEqual(errors, []);
	});
});
