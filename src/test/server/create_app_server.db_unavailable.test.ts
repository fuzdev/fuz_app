/**
 * Tests for a failed database read in `create_app_server`'s credential walk —
 * the assembled app, not a bare handler, so the `onError` registration is what
 * answers.
 *
 * The session leg's lookup throws, the throw escapes every route catch, and the
 * app's error handler answers: the flat 503 for a failed pool checkout,
 * Hono's default 500 for a failed query. Either way the walk ends there — the
 * bearer leg behind it never queries.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import { create_session_config, create_session_cookie_value } from '#lib/auth/session_cookie.ts';
import { generate_api_token } from '#lib/auth/api_token.ts';
import { Db } from '#lib/db/db.ts';
import { DbCheckoutError } from '#lib/db/db_checkout_error.ts';
import { create_health_route_spec } from '#lib/http/common_routes.ts';
import { create_app_server } from '#lib/server/app_server.ts';
import { create_stub_app_backend, create_stub_app_deps } from '#lib/testing/stubs.ts';
import { create_loopback_app_server_options } from '#lib/testing/app_server.ts';

import { create_test_keyring } from '../auth/session_test_helpers.ts';

const session_options = create_session_config('test_session');

/** A `Db` whose every statement throws `create_error()`, recording the statement first. */
const create_failing_db = (create_error: () => Error): { db: Db; statements: Array<string> } => {
	const statements: Array<string> = [];
	const db: Db = new Db({
		client: {
			query: async (text: string) => {
				statements.push(text);
				throw create_error();
			}
		},
		transaction: async (fn) => fn(db)
	});
	return { db, statements };
};

/** Send a signed session cookie plus a bearer to an assembled app whose database fails. */
const request_with_failing_db = async (
	create_error: () => Error
): Promise<{
	status: number;
	content_type: string | null;
	body: string;
	statements: Array<string>;
}> => {
	const keyring = create_test_keyring();
	const { db, statements } = create_failing_db(create_error);
	const deps = { ...create_stub_app_deps(), keyring, db };
	const server = await create_app_server({
		...create_loopback_app_server_options(),
		backend: create_stub_app_backend({ deps }),
		session_options,
		create_route_specs: () => [create_health_route_spec()],
		rate_limiters: 'disabled_for_testing'
	});
	try {
		const cookie = await create_session_cookie_value(keyring, 'session-token', session_options);
		const res = await server.app.request('/api/anything', {
			headers: {
				Cookie: `${session_options.cookie_name}=${cookie}`,
				Authorization: `Bearer ${generate_api_token().token}`
			}
		});
		return {
			status: res.status,
			content_type: res.headers.get('content-type'),
			body: await res.text(),
			statements
		};
	} finally {
		await server.close();
	}
};

describe('create_app_server — a failed credential read', () => {
	test('a failed pool checkout answers the flat 503 and ends the walk', async () => {
		const reply = await request_with_failing_db(
			() => new DbCheckoutError({ cause: new Error('timeout exceeded') })
		);
		assert.strictEqual(reply.status, 503);
		assert.strictEqual(reply.content_type, 'application/json');
		assert.strictEqual(reply.body, '{"error":"service_unavailable"}');
		assert.strictEqual(reply.statements.length, 1, 'only the session lookup ran');
		assert.notInclude(reply.statements[0], 'api_token', 'the bearer leg never queried');
	});

	test('a failed query answers Hono default 500 and ends the walk', async () => {
		const original = console.error;
		console.error = () => {};
		try {
			const reply = await request_with_failing_db(
				() => new Error('relation "auth_session" does not exist')
			);
			assert.strictEqual(reply.status, 500);
			assert.strictEqual(reply.content_type, 'text/plain; charset=UTF-8');
			assert.strictEqual(reply.body, 'Internal Server Error');
			assert.strictEqual(reply.statements.length, 1, 'only the session lookup ran');
			assert.notInclude(reply.statements[0], 'api_token', 'the bearer leg never queried');
		} finally {
			console.error = original;
		}
	});
});
