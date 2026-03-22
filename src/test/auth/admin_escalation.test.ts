/**
 * Tests for admin route role escalation prevention.
 *
 * Verifies that the admin grant endpoint prevents granting keeper role,
 * non-web-grantable app roles, and unknown roles — even when the caller
 * has admin permissions. Complements `admin_routes.test.ts` with
 * escalation-focused scenarios and stronger response body assertions.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach, beforeEach} from 'vitest';
import {Hono} from 'hono';

import {REQUEST_CONTEXT_KEY, type RequestContext} from '$lib/auth/request_context.js';
import {create_admin_account_route_specs} from '$lib/auth/admin_routes.js';
import {apply_route_specs} from '$lib/http/route_spec.js';
import {fuz_auth_guard_resolver} from '$lib/auth/route_guards.js';
import {create_role_schema} from '$lib/auth/role_schema.js';
import {ERROR_ROLE_NOT_WEB_GRANTABLE} from '$lib/http/error_schemas.js';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});

// Mock query functions
const {mock_actor_by_account, mock_grant_permit, mock_audit_log_fire_and_forget} = vi.hoisted(
	() => ({
		mock_actor_by_account: vi.fn(),
		mock_grant_permit: vi.fn(),
		mock_audit_log_fire_and_forget: vi.fn(),
	}),
);

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_account: mock_actor_by_account,
	query_admin_account_list: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/auth/permit_queries.js', () => ({
	query_grant_permit: mock_grant_permit,
	query_revoke_permit: vi.fn(() => Promise.resolve(null)),
	query_permit_find_active_for_actor: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/auth/audit_log_queries.js', () => ({
	audit_log_fire_and_forget: mock_audit_log_fire_and_forget,
}));

vi.mock('$lib/auth/session_queries.js', () => ({
	query_session_revoke_all_for_account: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('$lib/auth/api_token_queries.js', () => ({
	query_revoke_all_api_tokens_for_account: vi.fn(() => Promise.resolve(0)),
}));

const ADMIN_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_PERMIT_ID = '00000000-0000-4000-8000-000000000003';
const TARGET_ACCOUNT_ID = '00000000-0000-4000-8000-000000000010';
const TARGET_ACTOR_ID = '00000000-0000-4000-8000-000000000011';

const admin_ctx: RequestContext = {
	account: {
		id: ADMIN_ACCOUNT_ID,
		username: 'admin',
		email: null,
		email_verified: false,
		password_hash: 'fake_hash',
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: '2025-01-01T00:00:00.000Z',
		created_by: null,
		updated_by: null,
	},
	actor: {
		id: ADMIN_ACTOR_ID,
		account_id: ADMIN_ACCOUNT_ID,
		name: 'admin',
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: null,
		updated_by: null,
	},
	permits: [
		{
			id: ADMIN_PERMIT_ID,
			actor_id: ADMIN_ACTOR_ID,
			role: 'admin',
			created_at: '2025-01-01T00:00:00.000Z',
			expires_at: null,
			revoked_at: null,
			revoked_by: null,
			granted_by: null,
		},
	],
};

const target_actor = {
	id: TARGET_ACTOR_ID,
	account_id: TARGET_ACCOUNT_ID,
	name: 'target',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: null,
	updated_by: null,
};

beforeEach(() => {
	mock_actor_by_account.mockReset();
	mock_grant_permit.mockReset();
	mock_audit_log_fire_and_forget.mockReset();
	mock_actor_by_account.mockImplementation(() => Promise.resolve(target_actor));
	mock_grant_permit.mockImplementation(() =>
		Promise.resolve({
			id: 'new-permit',
			actor_id: TARGET_ACTOR_ID,
			role: 'admin',
			created_at: '2025-01-01T00:00:00.000Z',
			expires_at: null,
			revoked_at: null,
			revoked_by: null,
			granted_by: ADMIN_ACTOR_ID,
		}),
	);
});

afterEach(() => {
	vi.clearAllMocks();
});

const create_app = (app_roles?: Record<string, {web_grantable?: boolean}>): Hono => {
	const roles = create_role_schema(app_roles ?? {});
	const db = create_stub_db();
	const route_specs = create_admin_account_route_specs({log, on_audit_event: () => {}}, {roles});
	const app = new Hono();
	app.use('/*', async (c, next) => {
		c.set(REQUEST_CONTEXT_KEY, admin_ctx);
		await next();
	});
	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);
	return app;
};

const grant = async (app: Hono, role: string, account_id = TARGET_ACCOUNT_ID): Promise<Response> =>
	app.request(`/accounts/${account_id}/permits/grant`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({role}),
	});

describe('admin grant — keeper escalation prevention', () => {
	test('admin cannot grant keeper role — returns 403 with correct error', async () => {
		const app = create_app();

		const res = await grant(app, 'keeper');
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		// grant query must not have been called
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
		// no audit log for blocked grant
		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 0);
	});

	test('admin cannot grant keeper even to themselves', async () => {
		const app = create_app();

		const res = await grant(app, 'keeper', ADMIN_ACCOUNT_ID);
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
	});
});

describe('admin grant — app-defined non-web-grantable roles', () => {
	test('rejects non-web-grantable app role with 403', async () => {
		const app = create_app({bot: {web_grantable: false}});

		const res = await grant(app, 'bot');
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
	});

	test('allows web-grantable app role', async () => {
		const app = create_app({teacher: {web_grantable: true}});

		const res = await grant(app, 'teacher');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.ok, true);
		assert.ok(body.permit);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 1);
	});

	test('allows app role with default web_grantable (true by default)', async () => {
		const app = create_app({editor: {}});

		const res = await grant(app, 'editor');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.ok, true);
	});
});

describe('admin grant — unknown role rejection', () => {
	test('unknown role returns 400 from Zod validation', async () => {
		const app = create_app();

		const res = await grant(app, 'superadmin');
		assert.strictEqual(res.status, 400);

		// should not reach the handler
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
		assert.strictEqual(mock_actor_by_account.mock.calls.length, 0);
	});

	test('role with invalid characters returns 400', async () => {
		const app = create_app();

		const res = await grant(app, 'Admin');
		assert.strictEqual(res.status, 400);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
	});

	test('empty role returns 400', async () => {
		const app = create_app();

		const res = await grant(app, '');
		assert.strictEqual(res.status, 400);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
	});
});

describe('admin grant — verifies grant was called with correct args', () => {
	test('grant passes correct actor_id and granted_by', async () => {
		const app = create_app();

		const res = await grant(app, 'admin');
		assert.strictEqual(res.status, 200);

		assert.strictEqual(mock_grant_permit.mock.calls.length, 1);
		const call_args = mock_grant_permit.mock.calls[0]!;
		// second arg is the grant input
		const input = call_args[1];
		assert.strictEqual(input.actor_id, TARGET_ACTOR_ID);
		assert.strictEqual(input.role, 'admin');
		assert.strictEqual(input.granted_by, ADMIN_ACTOR_ID);
	});

	test('grant triggers audit log with correct event_type and metadata', async () => {
		const app = create_app();

		await grant(app, 'admin');

		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 1);
		const audit_input = mock_audit_log_fire_and_forget.mock.calls[0]![1];
		assert.strictEqual(audit_input.event_type, 'permit_grant');
		assert.strictEqual(audit_input.actor_id, ADMIN_ACTOR_ID);
		assert.strictEqual(audit_input.account_id, ADMIN_ACCOUNT_ID);
		assert.strictEqual(audit_input.target_account_id, TARGET_ACCOUNT_ID);
		assert.strictEqual(audit_input.metadata.role, 'admin');
	});
});
