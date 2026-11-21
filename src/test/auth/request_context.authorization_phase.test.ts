/**
 * Unit tests for `apply_authorization_phase`.
 *
 * Covers the failure shapes the dispatcher's authorization phase can return
 * — both 400 reasons (`actor_required`, `actor_not_on_account`), the 401
 * `authentication_required` of an account removed since its credential was
 * read, and the 500 `no_actors_on_account` (a live account listed no active
 * actor).
 *
 * `apply_authorization_phase` is pure data — it takes the account the
 * credential resolved and returns an `AuthorizationResult`:
 * `{ok: true, request_context: RequestContext | null} | {ok: false, status, body}`.
 * Public actions and the unauthenticated-optional axis both collapse to
 * `{ok: true, request_context: null}`; resolved actor / account-only
 * contexts set `request_context` non-null. The test-harness escape hatch
 * (`TEST_CONTEXT_PRESET_KEY`) lives at each transport's wrapper
 * (`run_authorization_phase`, which the route-spec handler and the WS upgrade
 * share, and the HTTP RPC dispatcher) — see `request_context.test_context_preset.test.ts`
 * for that coverage.
 *
 * The phase reads neither the account nor the acting actor a second time: the
 * account is the credential leg's row and the actor the row the account's actor
 * list returned, so an account removed after the leg is no torn read. The mocks
 * pin that `query_account_by_id` and `query_actor_by_id` are never called —
 * the account read comes only when the actor list is empty, to tell a removed
 * account from a live one.
 *
 * @module
 */

import { describe, test, assert, vi, afterEach } from 'vitest';

import { apply_authorization_phase, resolve_acting_actor } from '#lib/auth/request_context.ts';
import {
	query_account_by_id,
	query_actor_by_id,
	query_active_actors_by_account
} from '#lib/auth/account_queries.ts';
import { query_role_grant_find_active_for_actor } from '#lib/auth/role_grant_queries.ts';
import {
	ERROR_ACTOR_REQUIRED,
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_NO_ACTORS_ON_ACCOUNT,
	ERROR_AUTHENTICATION_REQUIRED
} from '#lib/http/error_schemas.ts';
import {
	create_test_account,
	create_test_actor,
	create_test_role_grant
} from '#lib/testing/entities.ts';
import type { QueryDeps } from '#lib/db/query_deps.ts';

const mock_deps: QueryDeps = { db: {} as any };

vi.mock('#lib/auth/account_queries.ts', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_id: vi.fn(),
	query_active_actors_by_account: vi.fn()
}));

vi.mock('#lib/auth/role_grant_queries.ts', () => ({
	query_role_grant_find_active_for_actor: vi.fn()
}));

afterEach(() => {
	vi.restoreAllMocks();
});

/** The phase builds on the rows it was handed and the actor list — it reads neither again. */
const assert_no_second_read = (): void => {
	assert.strictEqual(vi.mocked(query_account_by_id).mock.calls.length, 0, 'no account read');
	assert.strictEqual(vi.mocked(query_actor_by_id).mock.calls.length, 0, 'no actor read');
};

const ACCOUNT_ID = 'acct-1';
const ACTOR_ID = 'actor-1';
const SECOND_ACTOR_ID = 'actor-2';

const account = create_test_account({ id: ACCOUNT_ID, username: 'alice' });
const actor = create_test_actor({ id: ACTOR_ID, account_id: ACCOUNT_ID, name: 'alice' });
const second_actor = create_test_actor({
	id: SECOND_ACTOR_ID,
	account_id: ACCOUNT_ID,
	name: 'alice-pro'
});
const role_grants = [
	create_test_role_grant({ id: 'role_grant-1', actor_id: ACTOR_ID, role: 'admin' })
];

describe('apply_authorization_phase — short-circuit paths', () => {
	test('returns request_context: null when both axes are none (public — no resolution)', async () => {
		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'none', actor: 'none' },
			undefined
		);

		assert.deepStrictEqual(result, { ok: true, request_context: null });
		assert.strictEqual(vi.mocked(query_active_actors_by_account).mock.calls.length, 0);
	});

	test('returns request_context: null when the account is null (unauthenticated — downstream auth guard handles 401)', async () => {
		const result = await apply_authorization_phase(
			mock_deps,
			null,
			{ account: 'required', actor: 'required' },
			undefined
		);

		assert.deepStrictEqual(result, { ok: true, request_context: null });
		assert.strictEqual(vi.mocked(query_active_actors_by_account).mock.calls.length, 0);
	});
});

describe('apply_authorization_phase — needs_actor: false (account-grain)', () => {
	test('builds account-only context on the carried account (actor: null, empty role_grants)', async () => {
		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'required', actor: 'none' },
			undefined
		);

		assert.deepStrictEqual(result, {
			ok: true,
			request_context: { account, actor: null, role_grants: [] }
		});
		assert.strictEqual(result.ok && result.request_context?.account, account, 'the same row');
		assert_no_second_read();
	});
});

describe('apply_authorization_phase — needs_actor: true', () => {
	test('builds full context on single-actor success (no acting supplied)', async () => {
		vi.mocked(query_active_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_role_grant_find_active_for_actor).mockResolvedValue(role_grants);

		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'required', actor: 'required' },
			undefined
		);

		assert.deepStrictEqual(result, {
			ok: true,
			request_context: { account, actor, role_grants }
		});
		assert_no_second_read();
	});

	test('returns 500 no_actors_on_account when a live account lists no actors', async () => {
		vi.mocked(query_active_actors_by_account).mockResolvedValue([]);
		vi.mocked(query_account_by_id).mockResolvedValue(account);

		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'required', actor: 'required' },
			undefined
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 500,
			body: { error: ERROR_NO_ACTORS_ON_ACCOUNT }
		});
	});

	test('returns 401 authentication_required when the account lists no actors because it is gone', async () => {
		// removed since the credential leg read it, its actors with it
		vi.mocked(query_active_actors_by_account).mockResolvedValue([]);
		vi.mocked(query_account_by_id).mockResolvedValue(undefined);

		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'required', actor: 'required' },
			undefined
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 401,
			body: { error: ERROR_AUTHENTICATION_REQUIRED }
		});
	});

	test('returns 400 actor_required with available list on multi-actor + no acting', async () => {
		vi.mocked(query_active_actors_by_account).mockResolvedValue([actor, second_actor]);

		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'required', actor: 'required' },
			undefined
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 400,
			body: {
				error: ERROR_ACTOR_REQUIRED,
				available: [
					{ id: ACTOR_ID, name: 'alice' },
					{ id: SECOND_ACTOR_ID, name: 'alice-pro' }
				]
			}
		});
	});

	test('resolves over the active-actor query so a soft-deleted actor is never the acting actor', async () => {
		// `resolve_acting_actor` consults `query_active_actors_by_account`
		// (`deleted_at IS NULL`), not the unfiltered `query_actors_by_account`
		// the admin/snapshot handlers use. A tombstoned actor therefore never
		// reaches the resolver: here the filtered query returns only the
		// surviving `actor` (the soft-deleted sibling is excluded at the SQL
		// layer), so naming the tombstoned id as `acting` is `actor_not_on_account`.
		vi.mocked(query_active_actors_by_account).mockResolvedValue([actor]);

		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'required', actor: 'required' },
			SECOND_ACTOR_ID // the (now soft-deleted) sibling — absent from the active list
		);

		// The resolution result is computed from the active-filtered query's
		// output: the tombstoned sibling is absent from it, so naming its id as
		// `acting` is rejected. (If resolution read the unfiltered query, the
		// tombstoned actor would be present and resolve as `Resolved`.)
		assert.deepStrictEqual(result, {
			ok: false,
			status: 400,
			body: { error: ERROR_ACTOR_NOT_ON_ACCOUNT }
		});
	});

	test('returns 400 actor_not_on_account when supplied acting does not match', async () => {
		vi.mocked(query_active_actors_by_account).mockResolvedValue([actor]);

		const result = await apply_authorization_phase(
			mock_deps,
			account,
			{ account: 'required', actor: 'required' },
			'actor-not-here'
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 400,
			body: { error: ERROR_ACTOR_NOT_ON_ACCOUNT }
		});
	});

	test('resolve_acting_actor matches a supplied acting id whatever its case', async () => {
		vi.mocked(query_active_actors_by_account).mockResolvedValue([actor, second_actor]);
		const result = await resolve_acting_actor(mock_deps, ACCOUNT_ID, SECOND_ACTOR_ID.toUpperCase());
		assert.deepStrictEqual(result, { ok: true, actor: second_actor });
	});
});
