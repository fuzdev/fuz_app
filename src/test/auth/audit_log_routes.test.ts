/**
 * Tests for the audit-log SSE route handler's bookkeeping that need no
 * database: the pending registration it makes is released on every path that
 * does not admit it. The admission cases against a real database are in
 * `audit_log_routes.admission.db.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_audit_log_route_specs } from '#lib/auth/audit_log_routes.ts';
import { ROLE_ADMIN } from '#lib/auth/role_schema.ts';
import { create_test_resolved_auth } from '#lib/testing/resolved_auth.ts';
import type { RouteContext } from '#lib/http/route_spec.ts';
import { create_audit_log_sse } from '#lib/realtime/audit_log_sse.ts';
import { create_test_context } from '#lib/testing/entities.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';

const log = new Logger('test', { level: 'off' });

describe('audit log stream handler', () => {
	test('a throw while building the response releases the pending registration', async () => {
		const audit_sse = create_audit_log_sse({ log, connection_closer: null });
		const [spec] = create_audit_log_route_specs({ stream: audit_sse });
		assert.ok(spec);
		// A pre-baked context (so the re-reads are skipped) whose `open_sse`
		// throws, as building the stream's response would.
		const request_context = create_test_context([{ role: ROLE_ADMIN }]);
		const route = {
			auth: request_context,
			credential: create_test_resolved_auth({
				credential_type: 'session',
				account: request_context.account
			}),
			has_test_context_preset: true,
			db: create_stub_db(),
			pending_effects: [],
			post_commit_effects: [],
			open_sse: () => {
				throw new Error('no stream');
			}
		} as unknown as RouteContext;

		await assert_rejects(async () => {
			await spec.handler(route);
		});

		assert.strictEqual(audit_sse.registry.pending_count, 0, 'no pending entry is left behind');
		assert.strictEqual(audit_sse.registry.count, 0);
	});
});
