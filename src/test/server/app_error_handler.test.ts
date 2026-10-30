/**
 * Tests for the assembled app's `onError` — a failed pool checkout escaping
 * middleware answers the flat 503, anything else Hono's default answer.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_app_error_handler } from '#lib/server/app_error_handler.ts';
import { DbCheckoutError } from '#lib/db/db_checkout_error.ts';

const log = new Logger('test', { level: 'off' });

/** An app whose one middleware throws `err`, answered by `on_error`. */
const create_app = (err: Error, on_error: boolean): Hono => {
	const app = new Hono();
	if (on_error) app.onError(create_app_error_handler(log));
	app.use('*', () => {
		throw err;
	});
	app.get('/x', (c) => c.text('unreachable'));
	return app;
};

const answer = async (
	app: Hono
): Promise<{ status: number; content_type: string | null; body: string }> => {
	const res = await app.request('/x');
	return {
		status: res.status,
		content_type: res.headers.get('content-type'),
		body: await res.text()
	};
};

describe('create_app_error_handler', () => {
	test('a failed pool checkout answers the flat 503', async () => {
		const reply = await answer(
			create_app(new DbCheckoutError({ cause: new Error('timeout exceeded') }), true)
		);
		assert.deepStrictEqual(reply, {
			status: 503,
			content_type: 'application/json',
			body: '{"error":"service_unavailable"}'
		});
	});

	test('any other throw answers exactly what Hono default answers', async () => {
		for (const err of [
			new Error('relation "auth_session" does not exist'),
			new HTTPException(418, { message: 'teapot' })
		]) {
			const original = console.error;
			console.error = () => {};
			try {
				const ours = await answer(create_app(err, true));
				const hono_default = await answer(create_app(err, false));
				assert.deepStrictEqual(ours, hono_default, err.message);
			} finally {
				console.error = original;
			}
		}
		const reply = await answer(create_app(new Error('x'), true));
		assert.deepStrictEqual(reply, {
			status: 500,
			content_type: 'text/plain; charset=UTF-8',
			body: 'Internal Server Error'
		});
	});
});
