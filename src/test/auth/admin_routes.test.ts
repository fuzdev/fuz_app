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
import {
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
	ERROR_PERMIT_NOT_FOUND,
} from '$lib/http/error_schemas.js';
import {ERROR_OFFER_SELF_TARGET} from '$lib/auth/permit_offer_actions.js';
import {PermitOfferSelfTargetError} from '$lib/auth/permit_offer_queries.js';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {create_stub_db} from '$lib/testing/stubs.js';

const log = new Logger('test', {level: 'off'});

// Mock module-level query functions used by admin_routes
const {
	mock_account_by_id,
	mock_actor_by_account,
	mock_permit_offer_create,
	mock_revoke_permit,
	mock_permit_find_active_role_for_actor,
	mock_permit_find_active_for_actor,
	mock_audit_log_fire_and_forget,
} = vi.hoisted(() => ({
	mock_account_by_id: vi.fn(),
	mock_actor_by_account: vi.fn(),
	mock_permit_offer_create: vi.fn(),
	mock_revoke_permit: vi.fn(),
	mock_permit_find_active_role_for_actor: vi.fn(),
	mock_permit_find_active_for_actor: vi.fn(() => Promise.resolve([])),
	mock_audit_log_fire_and_forget: vi.fn(),
}));

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: mock_account_by_id,
	query_actor_by_account: mock_actor_by_account,
	query_admin_account_list: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/auth/permit_queries.js', () => ({
	query_revoke_permit: mock_revoke_permit,
	query_permit_find_active_role_for_actor: mock_permit_find_active_role_for_actor,
	query_permit_find_active_for_actor: mock_permit_find_active_for_actor,
}));

vi.mock('$lib/auth/permit_offer_queries.js', async () => {
	const actual = await vi.importActual<typeof import('$lib/auth/permit_offer_queries.js')>(
		'$lib/auth/permit_offer_queries.js',
	);
	return {
		...actual,
		query_permit_offer_create: mock_permit_offer_create,
	};
});

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
const NEW_OFFER_ID = '00000000-0000-4000-8000-000000000020';
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
			scope_id: null,
			created_at: '2025-01-01T00:00:00.000Z',
			expires_at: null,
			revoked_at: null,
			revoked_by: null,
			revoked_reason: null,
			granted_by: null,
			source_offer_id: null,
		},
	],
};

const target_account = {
	id: TARGET_ACCOUNT_ID,
	username: 'target',
	email: null,
	email_verified: false,
	password_hash: 'fake_hash',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: '2025-01-01T00:00:00.000Z',
	created_by: null,
	updated_by: null,
};

const target_actor = {
	id: TARGET_ACTOR_ID,
	account_id: TARGET_ACCOUNT_ID,
	name: 'target',
	created_at: '2025-01-01T00:00:00.000Z',
	updated_at: null,
	updated_by: null,
};

const make_fake_offer = (role: string) => ({
	id: NEW_OFFER_ID,
	from_actor_id: ADMIN_ACTOR_ID,
	to_account_id: TARGET_ACCOUNT_ID,
	role,
	scope_id: null,
	message: null,
	created_at: '2025-01-01T00:00:00.000Z',
	expires_at: '2025-02-01T00:00:00.000Z',
	accepted_at: null,
	declined_at: null,
	decline_reason: null,
	retracted_at: null,
	superseded_at: null,
	resulting_permit_id: null,
});

// --- Test app factory ---

interface AdminTestApp {
	app: Hono;
}

beforeEach(() => {
	mock_account_by_id.mockReset();
	mock_actor_by_account.mockReset();
	mock_permit_offer_create.mockReset();
	mock_revoke_permit.mockReset();
	mock_permit_find_active_role_for_actor.mockReset();
	mock_permit_find_active_for_actor.mockReset();
	mock_audit_log_fire_and_forget.mockReset();

	mock_account_by_id.mockImplementation(() => Promise.resolve(target_account));
	mock_actor_by_account.mockImplementation(() => Promise.resolve(target_actor));
	mock_permit_offer_create.mockImplementation((_deps, input: {role: string}) =>
		Promise.resolve(make_fake_offer(input.role)),
	);
	mock_revoke_permit.mockImplementation(() =>
		Promise.resolve({
			id: 'permit_existing',
			role: 'admin',
			scope_id: null,
			superseded_offers: [],
		}),
	);
	// default: permit exists with web_grantable role (admin)
	mock_permit_find_active_role_for_actor.mockImplementation(() => Promise.resolve({role: 'admin'}));
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
	test('offers a web_grantable builtin role (admin)', async () => {
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'admin');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.ok, true);
		assert.strictEqual(body.offer.role, 'admin');
		assert.strictEqual(body.offer.id, NEW_OFFER_ID);
		assert.strictEqual(body.offer.from_actor_id, ADMIN_ACTOR_ID);
		assert.strictEqual(body.offer.to_account_id, TARGET_ACCOUNT_ID);
		assert.strictEqual(body.offer.accepted_at, null);
		assert.strictEqual(mock_permit_offer_create.mock.calls.length, 1);
		// verify offer input: (deps, {from_actor_id, to_account_id, role, scope_id, message, expires_at})
		const input = mock_permit_offer_create.mock.calls[0]![1];
		assert.strictEqual(input.from_actor_id, ADMIN_ACTOR_ID);
		assert.strictEqual(input.to_account_id, TARGET_ACCOUNT_ID);
		assert.strictEqual(input.role, 'admin');
		assert.strictEqual(input.scope_id, null);
		assert.strictEqual(input.message, null);
		assert.ok(input.expires_at instanceof Date);
	});

	test('rejects non-web_grantable builtin role (keeper) with 403', async () => {
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'keeper');
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		assert.strictEqual(mock_permit_offer_create.mock.calls.length, 0);
	});

	test('offers app-defined web_grantable role (teacher)', async () => {
		const {app} = create_admin_test_app({teacher: {}});

		const res = await grant_request(app, 'teacher');
		assert.strictEqual(res.status, 200);

		const body = await res.json();
		assert.strictEqual(body.ok, true);
		assert.strictEqual(body.offer.role, 'teacher');
		assert.strictEqual(mock_permit_offer_create.mock.calls.length, 1);
	});

	test('rejects app-defined non-web_grantable role with 403', async () => {
		const {app} = create_admin_test_app({bot: {web_grantable: false}});

		const res = await grant_request(app, 'bot');
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		assert.strictEqual(mock_permit_offer_create.mock.calls.length, 0);
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

	test('nonexistent account returns 404 before the offer insert runs', async () => {
		mock_account_by_id.mockResolvedValueOnce(null);
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'admin');
		assert.strictEqual(res.status, 404);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ACCOUNT_NOT_FOUND);
		assert.strictEqual(mock_permit_offer_create.mock.calls.length, 0);
	});

	test('self-offer (grantor targets own account) returns 400 offer_self_target + emits failure audit', async () => {
		mock_permit_offer_create.mockImplementationOnce(() => {
			throw new PermitOfferSelfTargetError();
		});
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'admin');
		assert.strictEqual(res.status, 400);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_OFFER_SELF_TARGET);

		// Symmetric with the web_grantable denial emit — detectability for
		// "admin probed self-grant". No offer_id: no row was written.
		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 1);
		const input = mock_audit_log_fire_and_forget.mock.calls[0]![1];
		assert.strictEqual(input.event_type, 'permit_offer_create');
		assert.strictEqual(input.outcome, 'failure');
		assert.strictEqual(input.actor_id, ADMIN_ACTOR_ID);
		assert.strictEqual(input.target_account_id, TARGET_ACCOUNT_ID);
		assert.deepStrictEqual(input.metadata, {
			role: 'admin',
			scope_id: null,
			to_account_id: TARGET_ACCOUNT_ID,
		});
	});

	test('failed offer (non-web_grantable) emits permit_offer_create audit event with outcome=failure', async () => {
		const {app} = create_admin_test_app();

		const res = await grant_request(app, 'keeper');
		assert.strictEqual(res.status, 403);

		// one audit event, tagged as failure, no offer_id since no offer was created
		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 1);
		const input = mock_audit_log_fire_and_forget.mock.calls[0]![1];
		assert.strictEqual(input.event_type, 'permit_offer_create');
		assert.strictEqual(input.outcome, 'failure');
		assert.strictEqual(input.actor_id, ADMIN_ACTOR_ID);
		assert.strictEqual(input.target_account_id, TARGET_ACCOUNT_ID);
		assert.deepStrictEqual(input.metadata, {
			role: 'keeper',
			scope_id: null,
			to_account_id: TARGET_ACCOUNT_ID,
		});
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
		// active-role lookup returns null → 404 before UPDATE
		mock_permit_find_active_role_for_actor.mockResolvedValueOnce(null);
		const {app} = create_admin_test_app();

		const nonexistent_permit_id = '00000000-0000-4000-8000-000000000099';
		const res = await revoke_request(app, nonexistent_permit_id);
		assert.strictEqual(res.status, 404);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_PERMIT_NOT_FOUND);
		// UPDATE must not run when the permit isn't found
		assert.strictEqual(mock_revoke_permit.mock.calls.length, 0);
	});

	test('rejects revoking a non-web_grantable role (keeper) with 403', async () => {
		mock_permit_find_active_role_for_actor.mockResolvedValueOnce({role: 'keeper'});
		const {app} = create_admin_test_app();

		const keeper_permit_id = '00000000-0000-4000-8000-000000000040';
		const res = await revoke_request(app, keeper_permit_id);
		assert.strictEqual(res.status, 403);

		const body = await res.json();
		assert.strictEqual(body.error, ERROR_ROLE_NOT_WEB_GRANTABLE);
		// UPDATE must not run — permit remains active
		assert.strictEqual(mock_revoke_permit.mock.calls.length, 0);
	});

	test('failed revoke (non-web_grantable) emits permit_revoke audit event with outcome=failure', async () => {
		mock_permit_find_active_role_for_actor.mockResolvedValueOnce({role: 'keeper'});
		const {app} = create_admin_test_app();

		const keeper_permit_id = '00000000-0000-4000-8000-000000000040';
		const res = await revoke_request(app, keeper_permit_id);
		assert.strictEqual(res.status, 403);

		assert.strictEqual(mock_audit_log_fire_and_forget.mock.calls.length, 1);
		const input = mock_audit_log_fire_and_forget.mock.calls[0]![1];
		assert.strictEqual(input.event_type, 'permit_revoke');
		assert.strictEqual(input.outcome, 'failure');
		assert.strictEqual(input.actor_id, ADMIN_ACTOR_ID);
		assert.strictEqual(input.target_account_id, TARGET_ACCOUNT_ID);
		assert.deepStrictEqual(input.metadata, {role: 'keeper', permit_id: keeper_permit_id});
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
		// Active-role lookup constrains on (permit_id, target_actor_id); a cross-account
		// permit returns null → 404 before UPDATE runs.
		mock_permit_find_active_role_for_actor.mockResolvedValueOnce(null);
		const {app} = create_admin_test_app();

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
		mock_revoke_permit.mockResolvedValueOnce({
			id: only_admin_permit_id,
			role: 'admin',
			scope_id: null,
			superseded_offers: [],
		});

		const res = await revoke_request(app, only_admin_permit_id, TARGET_ACCOUNT_ID);
		assert.strictEqual(res.status, 200);
	});
});
