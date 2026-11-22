/**
 * `AppServer.close` waits for the effects still in flight before the
 * database closes: a production server answers a request without waiting for
 * its `pending_effects` (a failure audit row, the session touch), so one a
 * request just started would otherwise be cut off by the closing pool. The
 * wait is bounded (`shutdown_drain_timeout_ms`), and what it gives up on is
 * logged — twin of the Rust spine's shutdown audit drain.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';
import { Logger, type LogConsole } from '@fuzdev/fuz_util/log.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { prefix_route_specs } from '#lib/http/route_spec.ts';
import {
	DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
	drain_effects_on_shutdown
} from '#lib/server/app_server.ts';
import { create_test_app } from '#lib/testing/test_app.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';

import { describe_db } from '../auth_db_default.ts';
import { create_gated_db, is_audit_insert, type StalledQuery } from '../gated_db.ts';

const session_options = create_session_config('test_session');

describe_db('AppServer.close drains the effects in flight', (get_db) => {
	test('close waits for a failure row a request left in flight, then the row is there', async () => {
		const gated = create_gated_db(get_db());
		const test_app = await create_test_app({
			session_options,
			db: gated.db,
			app_options: { await_pending_effects: false },
			create_route_specs: (ctx) =>
				prefix_route_specs(
					'/api/account',
					create_account_route_specs(ctx.deps, {
						session_options,
						login_ip_rate_limiter: null,
						login_account_rate_limiter: null,
						login_fail_floor_ms: 0
					})
				)
		});
		let released = false;
		let stalled: StalledQuery | undefined;
		try {
			// the login's failure row is a pool write no response waits for
			stalled = gated.stall(is_audit_insert);
			const res = await test_app.app.request('/api/account/login', {
				method: 'POST',
				headers: create_test_request_headers({ 'content-type': 'application/json' }),
				body: JSON.stringify({ username: 'nobody', password: 'wrong-password-123' })
			});
			assert.strictEqual(res.status, 401, 'answered with the row still unwritten');
			await stalled.reached;

			let closed = false;
			const closing = test_app.cleanup().then(() => {
				closed = true;
			});
			await wait(20);
			assert.ok(!closed, 'close returned with an audit row still being written');

			stalled.release();
			released = true;
			await closing;
			const rows = await get_db().query<{ outcome: string }>(
				"SELECT outcome FROM audit_log WHERE event_type = 'login'"
			);
			assert.deepStrictEqual(
				rows.map((r) => r.outcome),
				['failure']
			);
		} finally {
			// a failed assertion leaves the write held — release it first, or the
			// fallback close waits on it until its bound
			stalled?.release();
			if (!released) await test_app.cleanup();
		}
	});

	test('close waits for a token-usage write a request left in flight, then it landed', async () => {
		const gated = create_gated_db(get_db());
		const test_app = await create_test_app({
			session_options,
			db: gated.db,
			app_options: { await_pending_effects: false },
			create_route_specs: (ctx) =>
				prefix_route_specs(
					'/api/account',
					create_account_route_specs(ctx.deps, {
						session_options,
						login_ip_rate_limiter: null,
						login_account_rate_limiter: null,
						login_fail_floor_ms: 0
					})
				)
		});
		let released = false;
		let stalled: StalledQuery | undefined;
		try {
			// the bearer leg's usage UPDATE is an eager write with no audit row,
			// so only the server's own flush tracking can hold close for it
			const read_last_used = () =>
				get_db().query<{ last_used_at: unknown }>(
					'SELECT last_used_at FROM api_token WHERE account_id = $1',
					[test_app.backend.account.id]
				);
			const before = await read_last_used();
			assert.ok(before.length > 0, 'the keeper holds a token');
			assert.ok(
				before.every((r) => r.last_used_at === null),
				'no use recorded before the request'
			);
			stalled = gated.stall((sql) => sql.startsWith('UPDATE api_token SET last_used_at'));
			const res = await test_app.app.request('/api/account/status', {
				headers: test_app.create_bearer_headers()
			});
			assert.strictEqual(res.status, 200, 'answered with the usage write still held');
			await stalled.reached;

			let closed = false;
			const closing = test_app.cleanup().then(() => {
				closed = true;
			});
			await wait(20);
			assert.ok(!closed, 'close returned with a request flush still running');

			stalled.release();
			released = true;
			await closing;
			assert.ok(
				(await read_last_used()).some((r) => r.last_used_at !== null),
				'the usage write landed before the close returned'
			);
		} finally {
			// a failed assertion leaves the write held — release it first, or the
			// fallback close waits on it until its bound
			stalled?.release();
			if (!released) await test_app.cleanup();
		}
	});
});

describe('drain_effects_on_shutdown', () => {
	const capture_log = (): { log: Logger; errors: Array<string> } => {
		const errors: Array<string> = [];
		const console_capture = {
			error: (...args: Array<unknown>) => errors.push(args.map(String).join(' ')),
			warn: () => {},
			log: () => {},
			info: () => {},
			debug: () => {}
		} as unknown as LogConsole;
		return { log: new Logger('test', { level: 'error', console: console_capture }), errors };
	};

	test('gives up at its bound, logging what it gave up on', async () => {
		const { log, errors } = capture_log();
		const never = create_deferred<void>();
		const flushes = new Set([never.promise]);
		const audit = { drain_inflight: () => never.promise, inflight_count: () => 2 };

		const given_up = await drain_effects_on_shutdown(flushes, audit, 20, log);

		// counted apart: a flush's own audit writes are in both
		assert.deepStrictEqual(given_up, { request_flushes: 1, audit_writes: 2 });
		assert.strictEqual(errors.length, 1);
		assert.include(errors[0], '1 request flush(es), 2 audit row write(s)');
	});

	test('waits for the flushes, then the audit writes, and gives up on nothing', async () => {
		const { log, errors } = capture_log();
		const order: Array<string> = [];
		const flush = wait(5).then(() => {
			order.push('flush');
		});
		const flushes = new Set([flush]);
		void flush.then(() => flushes.delete(flush));
		const audit = {
			drain_inflight: async () => {
				order.push('audit');
			},
			inflight_count: () => 0
		};

		assert.deepStrictEqual(await drain_effects_on_shutdown(flushes, audit, 1000, log), {
			request_flushes: 0,
			audit_writes: 0
		});
		assert.deepStrictEqual(order, ['flush', 'audit']);
		assert.deepStrictEqual(errors, []);
	});

	test('the default bound is the Rust spine drain timeout', () => {
		assert.strictEqual(DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS, 10_000);
	});
});
