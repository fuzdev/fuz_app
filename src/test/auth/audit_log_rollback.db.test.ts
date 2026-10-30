/**
 * Integration tests for where an audit row is written relative to the
 * request transaction.
 *
 * A failure row is written on the pool the bound emitter closes over, so it
 * survives the rollback of a handler that throws. A success row emitted inside
 * the request transaction is written in it, so it commits or rolls back with
 * the change it reports, and its listener fan-out runs only after the commit.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';

import { create_test_app, type TestApp } from '#lib/testing/app_server.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';
import { query_audit_log_list } from '#lib/auth/audit_log_queries.ts';
import { get_audit_write_failures } from '#lib/auth/audit_emitter.ts';
import type { AuditLogEvent } from '#lib/auth/audit_log_schema.ts';
import type { Uuid } from '#lib/primitive_schemas.ts';
import type { RouteHandler, RouteSpec } from '#lib/http/route_spec.ts';

const session_options = create_session_config('test_session');

/** What each probe route saw, in order, so a test can read the interleaving. */
const timeline: Array<string> = [];

describe('audit rows and the request transaction', () => {
	install_audit_drift_guard();

	let test_app: TestApp;

	const post = async (path: string): Promise<Response> =>
		test_app.app.request(path, {
			method: 'POST',
			headers: create_test_request_headers({ 'content-type': 'application/json' })
		});

	const rows_marked = async (marker: string): Promise<Array<AuditLogEvent>> =>
		(await query_audit_log_list({ db: test_app.backend.deps.db })).filter(
			(e) => (e.metadata as { test?: unknown } | null)?.test === marker
		);

	const probe_rows = async (marker: string): Promise<number> =>
		(
			await test_app.backend.deps.db.query<{ marker: string }>(
				'SELECT marker FROM audit_tx_probe WHERE marker = $1',
				[marker]
			)
		).length;

	beforeAll(async () => {
		const route = (path: string, handler: RouteHandler): RouteSpec => ({
			method: 'POST',
			path,
			auth: { account: 'none', actor: 'none' },
			description: `audit transaction probe ${path}`,
			input: z.null(),
			output: z.strictObject({ ok: z.literal(true) }),
			handler
		});
		test_app = await create_test_app({
			session_options,
			create_route_specs: (ctx) => [
				route('/api/failure_then_crash', async (_c, r) => {
					await ctx.deps.audit.emit(r, {
						event_type: 'login',
						outcome: 'failure',
						ip: '127.0.0.1',
						metadata: { username: 'test', test: 'failure_survives' }
					});
					throw new Error('deliberate handler crash');
				}),
				route('/api/success_then_crash', async (_c, r) => {
					await ctx.deps.audit.emit(r, {
						event_type: 'login',
						metadata: { username: 'probe', test: 'success_rolls_back' }
					});
					timeline.push('handler threw');
					throw new Error('deliberate handler crash');
				}),
				route('/api/success_commits', async (c, r) => {
					await r.db.query('INSERT INTO audit_tx_probe (marker) VALUES ($1)', ['committed']);
					await ctx.deps.audit.emit(r, {
						event_type: 'login',
						metadata: { username: 'probe', test: 'success_commits' }
					});
					timeline.push('handler returned');
					return c.json({ ok: true });
				}),
				route('/api/audit_insert_fails', async (c, r) => {
					await r.db.query('INSERT INTO audit_tx_probe (marker) VALUES ($1)', ['unaudited']);
					// an account id that isn't a uuid — the in-transaction INSERT fails
					await ctx.deps.audit.emit(r, {
						event_type: 'login',
						account_id: 'not-a-uuid' as Uuid,
						metadata: { username: 'probe', test: 'audit_insert_fails' }
					});
					return c.json({ ok: true });
				})
			]
		});
		await test_app.backend.deps.db.query('CREATE TABLE audit_tx_probe (marker TEXT NOT NULL)');
		test_app.backend.deps.audit.add_listener((event) => {
			const marker = (event.metadata as { test?: unknown } | null)?.test;
			if (typeof marker === 'string') timeline.push(`announced ${marker}`);
		});
	});

	afterAll(async () => {
		await test_app.cleanup();
	});

	test('a failure row persists despite the transaction rollback', async () => {
		const res = await post('/api/failure_then_crash');
		assert.strictEqual(res.status, 500);

		const rows = await rows_marked('failure_survives');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.event_type, 'login');
		assert.strictEqual(rows[0]!.outcome, 'failure');
	});

	test('a success row rolls back with its transaction and is never announced', async () => {
		timeline.length = 0;
		const res = await post('/api/success_then_crash');
		assert.strictEqual(res.status, 500);

		assert.deepStrictEqual(await rows_marked('success_rolls_back'), [], 'no orphan row');
		assert.deepStrictEqual(timeline, ['handler threw'], 'nothing was announced');
	});

	test('a success row commits with the change and is announced after the commit', async () => {
		timeline.length = 0;
		const res = await post('/api/success_commits');
		assert.strictEqual(res.status, 200);

		assert.strictEqual(await probe_rows('committed'), 1);
		const rows = await rows_marked('success_commits');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.outcome, 'success');
		assert.deepStrictEqual(
			timeline,
			['handler returned', 'announced success_commits'],
			'the fan-out ran after the handler returned and its transaction committed'
		);
	});

	test('a failed in-transaction audit INSERT fails the request and rolls the change back', async () => {
		const res = await post('/api/audit_insert_fails');
		assert.strictEqual(res.status, 500);

		assert.strictEqual(await probe_rows('unaudited'), 0, 'the change rolled back with its row');
		assert.deepStrictEqual(await rows_marked('audit_insert_fails'), []);
		assert.strictEqual(
			get_audit_write_failures(),
			0,
			'an in-transaction failure fails the request; it is not a lost pool write'
		);
	});
});
