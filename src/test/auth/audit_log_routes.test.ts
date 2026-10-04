/**
 * Tests for the audit-log SSE route handler's bookkeeping that need no
 * database: the pending registration it makes is released on every path that
 * does not admit it. The admission cases against a real database are in
 * `audit_log_routes.admission.db.test.ts`.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import type { Context } from 'hono';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { create_audit_log_route_specs } from '$lib/auth/audit_log_routes.ts';
import { AUTH_SESSION_TOKEN_HASH_KEY, REQUEST_CONTEXT_KEY } from '$lib/auth/request_context.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { TEST_CONTEXT_PRESET_KEY } from '$lib/hono_context.ts';
import type { RouteContext } from '$lib/http/route_spec.ts';
import { create_audit_log_sse } from '$lib/realtime/sse_auth_guard.ts';
import { create_test_request_context } from '$lib/testing/auth_apps.ts';
import { create_stub_db } from '$lib/testing/stubs.ts';

const log = new Logger('test', { level: 'off' });

describe('audit log stream handler', () => {
	test('a throw while building the response releases the pending registration', async () => {
		const audit_sse = create_audit_log_sse({ log });
		const [spec] = create_audit_log_route_specs({ stream: audit_sse });
		assert.ok(spec);
		// A pre-baked context (so the re-reads are skipped) with nothing but
		// `get` — `create_sse_response` reaches for the request and throws.
		const vars: Record<string, unknown> = {
			[REQUEST_CONTEXT_KEY]: create_test_request_context(ROLE_ADMIN),
			[AUTH_SESSION_TOKEN_HASH_KEY]: 'session_hash',
			[TEST_CONTEXT_PRESET_KEY]: true
		};
		const c = { get: (key: string) => vars[key] } as unknown as Context;
		const route = {
			db: create_stub_db(),
			pending_effects: [],
			post_commit_effects: []
		} as unknown as RouteContext;

		await assert_rejects(async () => {
			await spec.handler(c, route);
		});

		assert.strictEqual(audit_sse.registry.pending_count, 0, 'no pending entry is left behind');
		assert.strictEqual(audit_sse.registry.count, 0);
	});
});
