/**
 * The RPC dispatcher's answer to a failed pool checkout, and to a throw in its
 * authorization phase.
 *
 * A failed checkout (`DbCheckoutError`) is the database unavailable: the
 * JSON-RPC envelope with `service_unavailable` (-32007), message
 * `database unavailable`, no `data`, HTTP 503 — in the authorization phase and
 * in the handler's dispatch alike, the Rust dispatcher's answer. Any other
 * throw in the authorization phase is the envelope's `internal_error` (-32603,
 * 500), never the REST catch's flat body.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import { apply_route_specs } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { RESOLVED_AUTH_KEY } from '#lib/hono_context.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';
import { Db } from '#lib/db/db.ts';
import { DbCheckoutError } from '#lib/db/db_checkout_error.ts';
import { create_uuid } from '#lib/primitive_schemas.ts';

const log = new Logger('test', { level: 'off' });

const checkout_error = (): DbCheckoutError =>
	new DbCheckoutError({ cause: new Error('timeout exceeded when trying to connect') });

/** A `Db` whose every query and transaction fails with `fail()`. */
const create_failing_db = (fail: () => Error): Db =>
	new Db({
		client: { query: () => Promise.reject(fail()) },
		transaction: () => Promise.reject(fail())
	});

const spec = (
	method: string,
	auth: RequestResponseActionSpec['auth']
): RequestResponseActionSpec => ({
	method,
	kind: 'request_response',
	initiator: 'frontend',
	auth,
	side_effects: true,
	input: z.void(),
	output: z.strictObject({ ok: z.literal(true) }),
	async: true,
	description: method
});

const create_app = (db: Db): Hono => {
	const app = new Hono();
	app.use('/*', async (c, next) => {
		// a resolved session, and no preset context — the authorization phase runs
		(c as any).set(
			RESOLVED_AUTH_KEY,
			create_test_resolved_auth({ credential_type: 'session', account_id: create_uuid() })
		);
		await next();
	});
	const route_specs = create_rpc_endpoint({
		path: '/api/rpc',
		actions: [
			{
				spec: spec('authed_thing', { account: 'required', actor: 'none' }),
				handler: () => ({ ok: true })
			},
			{
				spec: spec('public_thing', { account: 'none', actor: 'none' }),
				handler: () => ({ ok: true })
			}
		],
		log,
		action_ip_rate_limiter: null,
		action_account_rate_limiter: null
	});
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);
	return app;
};

const call = async (app: Hono, method: string): Promise<{ status: number; body: unknown }> => {
	const res = await app.request('/api/rpc', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 7, method })
	});
	return { status: res.status, body: await res.json() };
};

const UNAVAILABLE = {
	jsonrpc: '2.0',
	id: 7,
	error: { code: -32007, message: 'database unavailable' }
};

describe('perform_action — a failed pool checkout', () => {
	test('in the authorization phase answers the 503 envelope', async () => {
		const { status, body } = await call(
			create_app(create_failing_db(checkout_error)),
			'authed_thing'
		);
		assert.strictEqual(status, 503);
		assert.deepStrictEqual(body, UNAVAILABLE);
	});

	test('in the dispatch answers the 503 envelope', async () => {
		const { status, body } = await call(
			create_app(create_failing_db(checkout_error)),
			'public_thing'
		);
		assert.strictEqual(status, 503);
		assert.deepStrictEqual(body, UNAVAILABLE);
	});

	test('any other throw in the authorization phase answers the envelope, not a flat REST body', async () => {
		const { status, body } = await call(
			create_app(create_failing_db(() => new Error('relation "actor" does not exist'))),
			'authed_thing'
		);
		assert.strictEqual(status, 500);
		const { error } = body as { jsonrpc: string; id: number; error: { code: number } };
		assert.strictEqual((body as { jsonrpc: string }).jsonrpc, '2.0');
		assert.strictEqual((body as { id: number }).id, 7);
		assert.strictEqual(error.code, -32603);
	});
});
