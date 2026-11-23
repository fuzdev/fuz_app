/**
 * `AppServer.close` waits for the effects still in flight before the
 * database closes: a production server answers a request without waiting for
 * its `pending_effects` (a failure audit row, the session touch), so one a
 * request just started would otherwise be cut off by the closing pool. The
 * wait is bounded (`shutdown_drain_timeout_ms`), and what it gives up on is
 * logged — twin of the Rust spine's shutdown audit drain. A WS message's
 * flush, which runs after its reply, is held the same way:
 * `create_app_server_ws_endpoints.dispatch.db.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { create_deferred, wait } from '@fuzdev/fuz_util/async.ts';
import { Logger, type LogConsole } from '@fuzdev/fuz_util/log.ts';

import { create_account_route_specs } from '#lib/auth/account_routes.ts';
import { prefix_route_specs } from '#lib/http/route_spec.ts';
import { create_request_tracker } from '#lib/http/pending_effects.ts';
import {
	DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
	drain_effects_on_shutdown,
	shutdown_gave_up
} from '#lib/server/shutdown_drain.ts';
import { create_test_app } from '#lib/testing/test_app.ts';
import { create_test_request_headers } from '#lib/testing/test_origin.ts';

import { describe_db } from '../auth_db_default.ts';
import { create_gated_db, is_audit_insert, type StalledQuery } from '../gated_db.ts';
import { expect_logged_error } from '#lib/testing/logged_errors.ts';

const session_cookie_name = 'test_session';

describe_db('AppServer.close drains the effects in flight', (get_db) => {
	test('close waits for a failure row a request left in flight, then the row is there', async () => {
		const gated = create_gated_db(get_db());
		const test_app = await create_test_app({
			session_cookie_name,
			db: gated.db,
			app_options: { await_pending_effects: false },
			create_route_specs: (ctx) =>
				prefix_route_specs(
					'/api/account',
					create_account_route_specs(ctx.deps, {
						session_cookie_name,
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
			session_cookie_name,
			db: gated.db,
			app_options: { await_pending_effects: false },
			create_route_specs: (ctx) =>
				prefix_route_specs(
					'/api/account',
					create_account_route_specs(ctx.deps, {
						session_cookie_name,
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
		expect_logged_error('create_app_server: shutdown gave up after');
		const { log, errors } = capture_log();
		const never = create_deferred<void>();
		const flushes = create_request_tracker();
		flushes.accept()!.finish(never.promise);
		const audit = { drain_inflight: () => never.promise, inflight_count: () => 2 };

		const given_up = await drain_effects_on_shutdown(flushes, audit, [], 20, log);

		// counted apart: a flush's own audit writes are in both
		assert.deepStrictEqual(given_up, { requests: 1, audit_writes: 2, upkeep: 0 });
		assert.strictEqual(errors.length, 1);
		assert.include(
			errors[0],
			'1 request(s) (handler, effect flush, or WS open), 2 audit row write(s), 0 upkeep task(s)'
		);
	});

	test('waits for the flushes, then the audit writes, and gives up on nothing', async () => {
		const { log, errors } = capture_log();
		const order: Array<string> = [];
		const flush = wait(5).then(() => {
			order.push('flush');
		});
		const flushes = create_request_tracker();
		flushes.accept()!.finish(flush);
		const audit = {
			drain_inflight: async () => {
				order.push('audit');
			},
			inflight_count: () => 0
		};

		assert.deepStrictEqual(await drain_effects_on_shutdown(flushes, audit, [], 1000, log), {
			requests: 0,
			audit_writes: 0,
			upkeep: 0
		});
		assert.deepStrictEqual(order, ['flush', 'audit']);
		assert.deepStrictEqual(errors, []);
	});

	test('a flush tracked while draining is waited for too', async () => {
		const { log, errors } = capture_log();
		const flushes = create_request_tracker();
		const order: Array<string> = [];
		const first = wait(5).then(() => {
			order.push('first');
			// a later flush starts before the first settles — a WS message
			// answered during the drain
			flushes.accept()!.finish(
				wait(5).then(() => {
					order.push('second');
				})
			);
		});
		flushes.accept()!.finish(first);
		const audit = { drain_inflight: async () => {}, inflight_count: () => 0 };

		assert.deepStrictEqual(await drain_effects_on_shutdown(flushes, audit, [], 1000, log), {
			requests: 0,
			audit_writes: 0,
			upkeep: 0
		});
		assert.deepStrictEqual(order, ['first', 'second']);
		assert.strictEqual(flushes.inflight_count(), 0);
		assert.deepStrictEqual(errors, []);
	});

	test('loops until both are empty: a flush tracked while the audit writes drain is waited for', async () => {
		const { log, errors } = capture_log();
		const flushes = create_request_tracker();
		const order: Array<string> = [];
		let audit_passes = 0;
		const audit = {
			drain_inflight: async () => {
				audit_passes++;
				if (audit_passes === 1) {
					// a WS message answered while the audit writes drain
					flushes.accept()!.finish(
						wait(5).then(() => {
							order.push('late flush');
						})
					);
				}
			},
			inflight_count: () => 0
		};

		assert.deepStrictEqual(await drain_effects_on_shutdown(flushes, audit, [], 1000, log), {
			requests: 0,
			audit_writes: 0,
			upkeep: 0
		});
		assert.deepStrictEqual(order, ['late flush']);
		assert.strictEqual(audit_passes, 2);
		assert.deepStrictEqual(errors, []);
	});

	test('one bound for the upkeep and the drain: a stop still pending is counted', async () => {
		expect_logged_error('create_app_server: shutdown gave up after');
		const { log, errors } = capture_log();
		const never = create_deferred<void>();
		const flushes = create_request_tracker();
		const audit = { drain_inflight: async () => {}, inflight_count: () => 0 };
		const started_at = Date.now();

		const given_up = await drain_effects_on_shutdown(
			flushes,
			audit,
			[Promise.resolve(), never.promise],
			20,
			log
		);

		assert.deepStrictEqual(given_up, { requests: 0, audit_writes: 0, upkeep: 1 });
		assert.ok(shutdown_gave_up(given_up));
		assert.ok(Date.now() - started_at < 1_000, 'returned at the bound');
		assert.strictEqual(errors.length, 1);
		assert.include(errors[0], '1 upkeep task(s)');
	});

	test('waits for the upkeep before the requests, so a flush a pass started is drained', async () => {
		const { log, errors } = capture_log();
		const flushes = create_request_tracker();
		const order: Array<string> = [];
		const stopped = wait(5).then(() => {
			order.push('upkeep');
			// a pass's last step tracked work after the drain began
			flushes.accept()!.finish(
				wait(5).then(() => {
					order.push('flush');
				})
			);
		});
		const audit = { drain_inflight: async () => {}, inflight_count: () => 0 };

		const given_up = await drain_effects_on_shutdown(flushes, audit, [stopped], 1000, log);

		assert.deepStrictEqual(given_up, { requests: 0, audit_writes: 0, upkeep: 0 });
		assert.ok(!shutdown_gave_up(given_up));
		assert.deepStrictEqual(order, ['upkeep', 'flush']);
		assert.deepStrictEqual(errors, []);
	});

	test('a tracked flush that rejects is removed, not left to wedge the drain', async () => {
		const flushes = create_request_tracker();
		const rejected = Promise.reject(new Error('contract slip'));
		flushes.accept()!.finish(rejected);
		await rejected.catch(() => {});
		await flushes.drain_inflight();
		assert.strictEqual(flushes.inflight_count(), 0);
	});

	test('the default bound is the Rust spine drain timeout', () => {
		assert.strictEqual(DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS, 10_000);
	});
});
