/**
 * Tests for the audit-log SSE route's admission — the credential and role
 * re-read between the route's gates and the stream's admission.
 *
 * A stream is authorized once. The route's gates run in the route-spec
 * pipeline, before the handler, so a revocation landing after them would
 * close nothing; the handler registers the stream pending, re-reads the
 * credential and the role, and only then admits it.
 *
 * Each case runs the real route (full middleware pipeline, real session
 * cookie, real database) and holds the request **at the credential re-read**
 * (`create_gated_db` — the second `auth_session` read of the request, the
 * first being the session middleware's) so something can happen in the
 * window. The control case stalls the same way and touches nothing. Two cases
 * close the server (`AppServer.close`): a stream requested after it is born
 * closed and skips the re-read, and a shutdown landing in the re-read ends the
 * stream after its connect comment even when the re-read then fails.
 *
 * @module
 */

import { assert, test } from 'vitest';

import { create_account_route_specs } from '$lib/auth/account_routes.ts';
import { create_audit_log_route_specs } from '$lib/auth/audit_log_routes.ts';
import { query_role_grant_revoke_role } from '$lib/auth/role_grant_queries.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { create_session_config } from '$lib/auth/session_cookie.ts';
import type { Db } from '$lib/db/db.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS
} from '$lib/http/error_schemas.ts';
import { prefix_route_specs } from '$lib/http/route_spec.ts';
import {
	AUDIT_LOG_CHANNEL,
	AUDIT_LOG_SSE_MAX_PER_SCOPE,
	type AuditLogSse
} from '$lib/realtime/sse_auth_guard.ts';
import { SSE_CONNECTED_COMMENT } from '$lib/realtime/sse_constants.ts';
import { require_audit_sse } from '$lib/server/app_server.ts';
import { create_test_app, type TestAccount, type TestApp } from '$lib/testing/app_server.ts';
import { install_audit_drift_guard } from '$lib/testing/audit_drift_guard.ts';
import { create_sse_frame_reader } from '$lib/testing/transports/sse_frame_reader.ts';

import { describe_db } from '../db_fixture.ts';
import { create_gated_db, is_session_read, type StalledQuery } from '../gated_db.ts';

const session_options = create_session_config('test_session');
const STREAM_PATH = '/api/admin/audit/stream';

interface Harness {
	test_app: TestApp;
	audit_sse: AuditLogSse;
	admin: TestAccount;
}

let admin_counter = 0;

/** The real audit stream route + the account routes, over a `Db` a test can stall. */
const create_harness = async (db: Db): Promise<Harness & { stall: () => StalledQuery }> => {
	const gated = create_gated_db(db);
	const test_app = await create_test_app({
		session_options,
		db: gated.db,
		app_options: { audit_log_sse: true },
		create_route_specs: (ctx) => [
			...prefix_route_specs('/api/account', [
				...create_account_route_specs(ctx.deps, {
					session_options,
					login_ip_rate_limiter: null,
					login_account_rate_limiter: null,
					login_fail_floor_ms: 0
				})
			]),
			...prefix_route_specs('/api/admin', [
				...create_audit_log_route_specs({ stream: ctx.audit_sse! })
			])
		]
	});
	const audit_sse = require_audit_sse(test_app.server);
	const admin = await test_app.create_account({
		username: `stream_admin_${admin_counter++}`,
		roles: [ROLE_ADMIN]
	});
	return {
		test_app,
		audit_sse,
		admin,
		// the request's first session read is the middleware's; the second is
		// the handler's re-read
		stall: () => gated.stall(is_session_read, { skip: 1 })
	};
};

/** Start a stream request and hold it at the credential re-read. */
const open_stalled = async (
	h: Harness & { stall: () => StalledQuery }
): Promise<{ response: Promise<Response>; stalled: StalledQuery }> => {
	const stalled = h.stall();
	const response = Promise.resolve(
		h.test_app.app.request(STREAM_PATH, { headers: h.admin.create_session_headers() })
	);
	await stalled.reached;
	assert.strictEqual(
		h.audit_sse.registry.pending_count,
		1,
		'the stream is registered pending before the re-read'
	);
	assert.strictEqual(h.audit_sse.registry.count, 0, 'and is not open yet');
	return { response, stalled };
};

describe_db('audit log stream admission', (get_db) => {
	install_audit_drift_guard();

	test('a stalled request no revocation touches opens the stream', async () => {
		const db = get_db();
		const h = await create_harness(db);

		const { response, stalled } = await open_stalled(h);
		// broadcast while the stream is still pending — it must not be queued
		h.audit_sse.registry.broadcast(AUDIT_LOG_CHANNEL, { method: 'while_pending', params: {} });
		stalled.release();
		const res = await response;

		assert.strictEqual(res.status, 200);
		assert.ok(res.headers.get('Content-Type')?.includes('text/event-stream'));
		assert.strictEqual(h.audit_sse.registry.count, 1, 'admitted');
		assert.strictEqual(h.audit_sse.registry.pending_count, 0);
		const sse = create_sse_frame_reader(res.body!.getReader());
		try {
			assert.strictEqual((await sse.read_frame()) + '\n\n', SSE_CONNECTED_COMMENT);
			h.audit_sse.registry.broadcast(AUDIT_LOG_CHANNEL, { method: 'after_admit', params: {} });
			assert.deepStrictEqual(
				JSON.parse((await sse.read_frame()).slice('data: '.length)),
				{ method: 'after_admit', params: {} },
				'the first data frame is the one sent after admission'
			);
		} finally {
			await sse.cancel();
		}
	});

	test('a session revoked during the request opens no stream — the re-read alone', async () => {
		const db = get_db();
		const h = await create_harness(db);

		const { response, stalled } = await open_stalled(h);
		// the row goes and *no* close is delivered — the shape of a revocation
		// whose close ran before the stream registered and found nothing
		await db.query(`DELETE FROM auth_session WHERE account_id = $1`, [h.admin.account.id]);
		stalled.release();
		const res = await response;

		assert.strictEqual(res.status, 401);
		assert.strictEqual((await res.json()).error, ERROR_AUTHENTICATION_REQUIRED);
		assert.ok(
			!res.headers.get('Content-Type')?.includes('text/event-stream'),
			'a refusal is a JSON error, not a stream'
		);
		assert.strictEqual(h.audit_sse.registry.count, 0, 'no stream opened on the dead session');
		assert.strictEqual(h.audit_sse.registry.pending_count, 0, 'the registration is removed');
	});

	test('a role revoked during the request opens no stream', async () => {
		const db = get_db();
		const h = await create_harness(db);

		const { response, stalled } = await open_stalled(h);
		// the grant goes and no close is delivered; the credential is still live
		await query_role_grant_revoke_role({ db }, h.admin.actor.id, ROLE_ADMIN, null);
		stalled.release();
		const res = await response;

		assert.strictEqual(res.status, 403);
		assert.deepStrictEqual(await res.json(), {
			error: ERROR_INSUFFICIENT_PERMISSIONS,
			required_roles: [ROLE_ADMIN]
		});
		assert.strictEqual(h.audit_sse.registry.count, 0);
		assert.strictEqual(h.audit_sse.registry.pending_count, 0);
	});

	test('a stream closed while pending ends after its connect comment', async () => {
		const db = get_db();
		const h = await create_harness(db);

		const { response, stalled } = await open_stalled(h);
		// a close reaches the registration while its session row is still there
		// — an account-wide close from another session's logout does exactly
		// this. The re-reads pass, so only admission can refuse.
		assert.strictEqual(
			h.audit_sse.registry.close_by_identity(h.admin.account.id),
			1,
			'the close finds the pending registration'
		);
		stalled.release();
		const res = await response;

		assert.strictEqual(res.status, 200);
		assert.ok(res.headers.get('Content-Type')?.includes('text/event-stream'));
		assert.strictEqual(
			await res.text(),
			SSE_CONNECTED_COMMENT,
			'the connect comment, then the end'
		);
		assert.strictEqual(h.audit_sse.registry.count, 0, 'never admitted');
		assert.strictEqual(h.audit_sse.registry.pending_count, 0);
	});

	test('a failing re-check opens no stream', async () => {
		const db = get_db();
		const h = await create_harness(db);

		const { response, stalled } = await open_stalled(h);
		stalled.fail(new Error('connection lost'));
		const res = await response;

		assert.strictEqual(res.status, 500);
		assert.strictEqual(h.audit_sse.registry.count, 0, 'no stream opened unchecked');
		assert.strictEqual(h.audit_sse.registry.pending_count, 0, 'the registration is removed');
	});

	test('a stream requested after the server closed ends after its connect comment, unread', async () => {
		const db = get_db();
		const h = await create_harness(db);
		await h.test_app.cleanup();
		assert.ok(h.audit_sse.registry.closing);

		// would hold the handler's re-read, were there one
		const stalled = h.stall();
		try {
			const response = Promise.resolve(
				h.test_app.app.request(STREAM_PATH, { headers: h.admin.create_session_headers() })
			);
			const res = await Promise.race([response, stalled.reached.then(() => null)]);
			assert.ok(res, 'a born-closed registration skips the re-read');

			assert.strictEqual(res.status, 200);
			assert.ok(res.headers.get('Content-Type')?.includes('text/event-stream'));
			assert.strictEqual(h.audit_sse.registry.count, 0, 'never admitted');
			assert.strictEqual(h.audit_sse.registry.pending_count, 0);
			assert.strictEqual(
				await res.text(),
				SSE_CONNECTED_COMMENT,
				'the connect comment, then the end'
			);
		} finally {
			stalled.release();
		}
	});

	test('a shutdown during the re-read ends the stream after its connect comment, even when the re-read fails', async () => {
		const db = get_db();
		const h = await create_harness(db);

		const { response, stalled } = await open_stalled(h);
		await h.test_app.cleanup();
		assert.strictEqual(h.audit_sse.registry.pending_count, 0, 'the close-all closed it pending');
		// the database closes under the re-read
		stalled.fail(new Error('database closed'));
		const res = await response;

		assert.strictEqual(res.status, 200, "the shutdown's answer, not a 500");
		assert.strictEqual(h.audit_sse.registry.count, 0, 'never admitted');
		assert.strictEqual(await res.text(), SSE_CONNECTED_COMMENT);
	});

	test('a logout during the request opens no stream', async () => {
		const db = get_db();
		const h = await create_harness(db);

		const { response, stalled } = await open_stalled(h);
		const logout = await h.test_app.app.request('/api/account/logout', {
			method: 'POST',
			headers: h.admin.create_session_headers()
		});
		assert.strictEqual(logout.status, 200);
		assert.strictEqual(
			h.audit_sse.registry.pending_count,
			0,
			"the logout's close reached the pending registration"
		);
		stalled.release();
		const res = await response;

		assert.strictEqual(res.status, 401);
		assert.strictEqual(h.audit_sse.registry.count, 0);
	});

	test('a client that leaves during the request opens no stream and evicts none', async () => {
		const db = get_db();
		const h = await create_harness(db);

		// the session at its stream cap: one more admission would evict the oldest
		const open_streams: Array<Response> = [];
		for (let i = 0; i < AUDIT_LOG_SSE_MAX_PER_SCOPE; i++) {
			open_streams.push(
				await h.test_app.app.request(STREAM_PATH, { headers: h.admin.create_session_headers() })
			);
		}
		assert.strictEqual(h.audit_sse.registry.count, AUDIT_LOG_SSE_MAX_PER_SCOPE);
		const oldest = create_sse_frame_reader(open_streams[0]!.body!.getReader());

		const stalled = h.stall();
		const client = new AbortController();
		const response = Promise.resolve(
			h.test_app.app.request(STREAM_PATH, {
				headers: h.admin.create_session_headers(),
				signal: client.signal
			})
		);
		await stalled.reached;
		client.abort();
		stalled.release();
		const res = await response;

		assert.strictEqual(res.status, 200);
		assert.strictEqual(
			await res.text(),
			SSE_CONNECTED_COMMENT,
			'the departed client gets a stream that is already over'
		);
		assert.strictEqual(h.audit_sse.registry.pending_count, 0, 'nothing left pending');
		assert.strictEqual(
			h.audit_sse.registry.count,
			AUDIT_LOG_SSE_MAX_PER_SCOPE,
			'the departed client holds no slot, and took none'
		);
		try {
			assert.strictEqual((await oldest.read_frame()) + '\n\n', SSE_CONNECTED_COMMENT);
			h.audit_sse.registry.broadcast(AUDIT_LOG_CHANNEL, { method: 'still_open', params: {} });
			assert.deepStrictEqual(
				JSON.parse((await oldest.read_frame()).slice('data: '.length)),
				{ method: 'still_open', params: {} },
				'the oldest stream was not evicted for it'
			);
		} finally {
			await oldest.cancel();
			for (const stream of open_streams.slice(1)) await stream.body?.cancel();
		}
	});
});
