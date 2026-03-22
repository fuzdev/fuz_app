/**
 * Integration tests for the admin grant/revoke endpoints.
 *
 * Verifies that `web_grantable` is enforced server-side on the grant handler,
 * so direct API calls cannot bypass UI-level filtering.
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
import {ERROR_ROLE_NOT_WEB_GRANTABLE, ERROR_PERMIT_NOT_FOUND} from '$lib/http/error_schemas.js';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});

// Mock module-level query functions used by admin_routes
const {
	mock_actor_by_account,
	mock_grant_permit,
	mock_revoke_permit,
	mock_permit_find_active_for_actor,
	mock_audit_log_fire_and_forget,
} = vi.hoisted(() => ({
	mock_actor_by_account: vi.fn(),
	mock_grant_permit: vi.fn(),
	mock_revoke_permit: vi.fn(),
	mock_permit_find_active_for_actor: vi.fn(() => Promise.resolve([])),
	mock_audit_log_fire_and_forget: vi.fn(),
}));

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_account: mock_actor_by_account,
	query_admin_account_list: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/auth/permit_queries.js', () => ({
	query_grant_permit: mock_grant_permit,
	query_revoke_permit: mock_revoke_permit,
	query_permit_find_active_for_actor: mock_permit_find_active_for_actor,
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

// --- Shared fixtures ---

const ADMIN_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_PERMIT_ID = '00000000-0000-4000-8000-000000000003';
const TARGET_ACCOUNT_ID = '00000000-0000-4000-8000-000000000010';
const TARGET_ACTOR_ID = '00000000-0000-4000-8000-000000000011';
const NEW_PERMIT_ID = '00000000-0000-4000-8000-000000000020';
const EXISTING_PERMIT_ID = '00000000-0000-4000-8000-000000000021';

const fake_account = {
	id: ADMIN_ACCOUNT_ID,
	username: 'admin',
	email: null,
	email_verified: false,
	password_hash: 'fake_hash',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: '2025-01-01T00:00:00.000Z',
	created_by: null,
	updated_by: null,
};

const fake_actor = {
	id: ADMIN_ACTOR_ID,
	account_id: ADMIN_ACCOUNT_ID,
	name: 'admin',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: null,
	updated_by: null,
};

const fake_ctx: RequestContext = {
	account: fake_account,
	actor: fake_actor,
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

const fake_permit = {
	id: NEW_PERMIT_ID,
	actor_id: TARGET_ACTOR_ID,
	role: 'admin',
	created_at: '2025-01-01T00:00:00.000Z',
	expires_at: null,
	revoked_at: null,
	revoked_by: null,
	granted_by: ADMIN_ACTOR_ID,
};

// --- Test app factory ---

interface AdminTestApp {
	app: Hono;
}

beforeEach(() => {
	mock_actor_by_account.mockReset();
	mock_grant_permit.mockReset();
	mock_revoke_permit.mockReset();
	mock_permit_find_active_for_actor.mockReset();
	mock_audit_log_fire_and_forget.mockReset();

	mock_actor_by_account.mockImplementation(() => Promise.resolve(target_actor));
	mock_grant_permit.mockImplementation(() => Promise.resolve(fake_permit));
	mock_revoke_permit.mockImplementation(() =>
		Promise.resolve({id: 'permit_existing', role: 'admin'}),
	);
	mock_permit_find_active_for_actor.mockImplementation(() => Promise.resolve([]));
});

const create_admin_test_app = (
	app_roles?: Record<string, {web_grantable?: boolean}>,
): AdminTestApp => {
	const roles = create_role_schema(app_roles ?? {});

	const db = create_stub_db();

	const route_specs = create_admin_account_route_specs({log, on_audit_event: () => {}}, {roles});

	const app = new Hono();

	// inject authenticated admin request context
	app.use('/*', async (c, next) => {
		c.set(REQUEST_CONTEXT_KEY, fake_ctx);
		await next();
	});

	apply_route_specs(app, route_specs, fuz_auth_guard_resolver, log, db);

	return {app};
};

const grant_request = (
	app: Hono,
	role: string,
	account_id = TARGET_ACCOUNT_ID,
): Response | Promise<Response> =>
	app.request(`/accounts/${account_id}/permits/grant`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({role}),
	});

const revoke_request = (
	app: Hono,
	permit_id = EXISTING_PERMIT_ID,
	account_id = TARGET_ACCOUNT_ID,
): Response | Promise<Response> =>
	app.request(`/accounts/${account_id}/permits/${permit_id}/revoke`, {
		method: 'POST',
	});

// --- Tests ---

afterEach(() => {
	vi.clearAllMocks();
});

describe('admin grant handler — web_grantable enforcement', () => {
	test('grants a web_grantable builtin role (admin)', async () => {
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'admin');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.ok, true);
		assert.strictEqual(body.permit.role, 'admin');
		assert.strictEqual(body.permit.id, NEW_PERMIT_ID);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 1);
		// verify grant input: (deps, {actor_id, role, granted_by})
		const input = mock_grant_permit.mock.calls[0]![1];
		assert.strictEqual(input.actor_id, TARGET_ACTOR_ID);
		assert.strictEqual(input.role, 'admin');
		assert.strictEqual(input.granted_by, ADMIN_ACTOR_ID);
	});

	test('rejects non-web_grantable builtin role (keeper) with 403', async () => {
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'keeper');
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
	});

	test('grants app-defined web_grantable role (teacher)', async () => {
		const {app} = create_admin_test_app({teacher: {}});

		const res = await grant_request(app, 'teacher');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.ok, true);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 1);
	});

	test('rejects app-defined non-web_grantable role with 403', async () => {
		const {app} = create_admin_test_app({bot: {web_grantable: false}});

		const res = await grant_request(app, 'bot');
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		assert.strictEqual(mock_grant_permit.mock.calls.length, 0);
	});

	test('403 response contains only error field', async () => {
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'keeper');
		const body = await res.json();
		assert.deepStrictEqual(Object.keys(body), ['error']);
	});

	test('unknown role rejected by Zod validation (400)', async () => {
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'nonexistent');
		assert.strictEqual(res.status, 400);
	});
});

describe('admin revoke handler — no regression', () => {
	test('revoke succeeds with correct response body and mock args', async () => {
		const {app} = create_admin_test_app();

		const res = await revoke_request(app);
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.ok, true);
		assert.strictEqual(body.revoked, true);
		assert.strictEqual(mock_revoke_permit.mock.calls.length, 1);
		// verify revoke was called with (deps, permit_id, target_actor_id, admin_actor_id)
		const call = mock_revoke_permit.mock.calls[0]!;
		assert.strictEqual(call[1], EXISTING_PERMIT_ID);
		assert.strictEqual(call[2], TARGET_ACTOR_ID);
		assert.strictEqual(call[3], ADMIN_ACTOR_ID);
	});

	test('revoke returns 404 for nonexistent or cross-account permit', async () => {
		const {app} = create_admin_test_app();
		mock_revoke_permit.mockResolvedValueOnce(null);

		const nonexistent_permit_id = '00000000-0000-4000-8000-000000000099';
		const res = await revoke_request(app, nonexistent_permit_id);
		assert.strictEqual(res.status, 404);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_PERMIT_NOT_FOUND);
	});
});

describe('admin revoke handler — IDOR protection', () => {
	test('revoke resolves target actor from account_id and passes as constraint', async () => {
		const {app} = create_admin_test_app();

		const res = await revoke_request(app, EXISTING_PERMIT_ID, TARGET_ACCOUNT_ID);
		assert.strictEqual(res.status, 200);

		// handler must call query_actor_by_account to resolve the target actor
		assert.strictEqual(mock_actor_by_account.mock.calls.length, 1);
		// first arg is deps, second is account_id
		assert.strictEqual(mock_actor_by_account.mock.calls[0]![1], TARGET_ACCOUNT_ID);

		// revoke must be called with target actor_id as the constraint (not the admin actor_id)
		// first arg is deps, then permit_id, then actor_id
		assert.strictEqual(mock_revoke_permit.mock.calls[0]![1], EXISTING_PERMIT_ID);
		assert.strictEqual(mock_revoke_permit.mock.calls[0]![2], TARGET_ACTOR_ID);
	});

	test('revoke returns 404 when permit does not belong to the target account', async () => {
		const {app} = create_admin_test_app();
		mock_revoke_permit.mockResolvedValueOnce(null); // DB found no match for (permit_id, actor_id)

		const other_permit_id = '00000000-0000-4000-8000-000000000098';
		const res = await revoke_request(app, other_permit_id, TARGET_ACCOUNT_ID);
		assert.strictEqual(res.status, 404);
	});

	test('allows revoking the last admin permit (no guard)', async () => {
		// fuz_app intentionally does not prevent revoking the last admin permit.
		// This documents the behavior — consumers must handle this if needed.
		const {app} = create_admin_test_app();
		mock_actor_by_account.mockResolvedValueOnce({
			id: TARGET_ACTOR_ID,
			account_id: TARGET_ACCOUNT_ID,
			name: 'last_admin',
			created_at: '2025-01-01T00:00:00.000Z',
			updated_at: null,
			updated_by: null,
		});
		const only_admin_permit_id = '00000000-0000-4000-8000-000000000030';
		mock_revoke_permit.mockResolvedValueOnce({id: only_admin_permit_id, role: 'admin'});

		const res = await revoke_request(app, only_admin_permit_id, TARGET_ACCOUNT_ID);
		assert.strictEqual(res.status, 200);
	});
});
