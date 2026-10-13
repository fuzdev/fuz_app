/**
 * The audit-log SSE stream's outbound bound, through the assembled app: a
 * subscriber that opens the stream and never reads it is ended once the
 * audit events sent to it pass `SSE_OUTBOUND_QUEUE_BYTES`, its registration is
 * removed, and the warning names its account.
 *
 * The bound's own rules are pinned over a bare stream in
 * `realtime/sse.test.ts`; this file pins that `create_app_server`'s audit
 * stream is held to it — the emitter's listener, the registry, and the route's
 * `account_id` all wired.
 *
 * @module
 */

import { test, assert } from 'vitest';
import { Logger, type LogConsole } from '@fuzdev/fuz_util/log.ts';
import { wait } from '@fuzdev/fuz_util/async.ts';

import { create_session_config } from '#lib/auth/session_cookie.ts';
import { create_audit_log_route_specs } from '#lib/auth/audit_log_routes.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { prefix_route_specs } from '#lib/http/route_spec.ts';
import { OUTBOUND_FRAME_OVERHEAD_BYTES } from '#lib/realtime/outbound_budget.ts';
import { SSE_OUTBOUND_QUEUE_BYTES } from '#lib/realtime/sse_constants.ts';
import { require_audit_sse } from '#lib/server/app_server.ts';
import { create_test_app } from '#lib/testing/app_server.ts';
import { install_audit_drift_guard } from '#lib/testing/audit_drift_guard.ts';

import { describe_db } from '../db_fixture.ts';

const session_options = create_session_config('test_session');
const STREAM_PATH = '/api/admin/audit/stream';

/** Poll until `predicate` holds, failing with `message` after two seconds. */
const until = async (predicate: () => boolean, message: string): Promise<void> => {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await wait(5);
	}
};

describe_db('audit log stream outbound overflow', (get_db) => {
	install_audit_drift_guard();

	test('a subscriber that never reads is ended once its unread events pass the budget', async () => {
		const warns: Array<Array<unknown>> = [];
		const recording_console: LogConsole = {
			error: () => {},
			warn: (...args: Array<unknown>) => {
				warns.push(args);
			},
			log: () => {}
		};
		// the route's own logger, recording at warn; the label is left off so a
		// recorded call is exactly the stream's arguments
		const log = new Logger(undefined, { level: 'warn', console: recording_console });
		const test_app = await create_test_app({
			session_options,
			db: get_db(),
			app_options: { audit_log_sse: true },
			create_route_specs: (ctx) =>
				prefix_route_specs('/api/admin', [
					...create_audit_log_route_specs({
						stream: { registry: require_audit_sse(ctx).registry, log }
					})
				])
		});
		try {
			const audit_sse = require_audit_sse(test_app.server);
			const admin = await test_app.create_account({
				username: 'stream_overflow_admin',
				roles: [ROLE_ADMIN]
			});
			const bystander = await test_app.create_account({
				username: 'stream_overflow_bystander',
				roles: [ROLE_ADMIN]
			});

			// the subscriber under test opens its stream and reads nothing
			const res = await test_app.app.request(STREAM_PATH, {
				headers: admin.create_session_headers()
			});
			assert.strictEqual(res.status, 200);
			// a second subscriber that keeps reading is the control
			const bystander_res = await test_app.app.request(STREAM_PATH, {
				headers: bystander.create_session_headers()
			});
			assert.strictEqual(bystander_res.status, 200);
			assert.strictEqual(audit_sse.registry.count, 2);
			let bystander_bytes = 0;
			const bystander_reader = bystander_res.body!.getReader();
			const bystander_done = (async () => {
				for (;;) {
					const { done, value } = await bystander_reader.read();
					if (done) return;
					bystander_bytes += value.byteLength;
				}
			})();

			// audit events through the backend's emitter: each row is written, then
			// fanned out to the stream by the listener `create_app_server` registered
			// small enough for every driver's index on `audit_log.metadata`: pglet
			// refuses a key past what one of its index pages holds
			const event_bytes = 2 * 1024;
			const events = Math.ceil(SSE_OUTBOUND_QUEUE_BYTES / event_bytes) + 2;
			const username = 'x'.repeat(event_bytes);
			for (let i = 0; i < events; i++) {
				await test_app.backend.deps.audit.emit_pool({
					event_type: 'login',
					outcome: 'failure',
					metadata: { username }
				});
			}

			// the unread stream is ended and its registration removed; the reader's stays
			await until(() => audit_sse.registry.count === 1, 'the unread stream is removed');
			assert.strictEqual(warns.length, 1, JSON.stringify(warns));
			// the logger puts its level prefix ahead of the call's own arguments
			const [message, detail] = warns[0]!.slice(-2) as [string, Record<string, unknown>];
			assert.strictEqual(message, 'sse: outbound queue overflow, ending the stream');
			assert.strictEqual(detail.account_id, admin.account.id);
			// the frame that did not fit: what waited plus it, each charged its
			// overhead, is past the budget
			const queued_bytes = detail.queued_bytes as number;
			const queued_frames = detail.queued_frames as number;
			const frame_bytes = detail.frame_bytes as number;
			assert.ok(frame_bytes > event_bytes, JSON.stringify(detail));
			assert.ok(
				queued_bytes + frame_bytes + (queued_frames + 1) * OUTBOUND_FRAME_OVERHEAD_BYTES >
					SSE_OUTBOUND_QUEUE_BYTES,
				JSON.stringify(detail)
			);
			assert.ok(
				queued_bytes + queued_frames * OUTBOUND_FRAME_OVERHEAD_BYTES <= SSE_OUTBOUND_QUEUE_BYTES,
				JSON.stringify(detail)
			);

			// the ended stream's body finishes instead of holding what was sent
			const reader = res.body!.getReader();
			let unread_bytes = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					unread_bytes += value.byteLength;
				}
			} catch {
				// an aborted body may reject its read instead of finishing
			}
			assert.ok(unread_bytes < SSE_OUTBOUND_QUEUE_BYTES, `read ${unread_bytes} bytes`);

			// the reader got every event and is still subscribed
			await until(
				() => bystander_bytes > events * event_bytes,
				'the reading subscriber receives every event'
			);
			await bystander_reader.cancel();
			await bystander_done;
			await until(() => audit_sse.registry.count === 0, 'the cancelled stream is removed');
		} finally {
			await test_app.cleanup();
		}
	});
});
