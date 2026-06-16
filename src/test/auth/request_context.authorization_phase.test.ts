/**
 * Unit tests for `apply_authorization_phase`.
 *
 * Covers the four failure shapes the dispatcher's authorization phase
 * can return — both 400 reasons (`actor_required`, `actor_not_on_account`)
 * and both 500 reasons (`no_actors_on_account` for the
 * empty-actor-list invariant; `account_vanished` for the torn-read
 * race where `build_request_context` / `build_account_context` return
 * null after `resolve_acting_actor` succeeded).
 *
 * `apply_authorization_phase` is pure data — it takes `account_id`
 * directly and returns an `AuthorizationResult`:
 * `{ok: true, request_context: RequestContext | null} | {ok: false, status, body}`.
 * Public actions and the unauthenticated-optional axis both collapse to
 * `{ok: true, request_context: null}`; resolved actor / account-only
 * contexts set `request_context` non-null. The test-harness escape hatch
 * (`TEST_CONTEXT_PRESET_KEY`) lives at each transport's wrapper
 * (`create_fuz_authorization_handler`, `create_ws_authorization_middleware`,
 * the HTTP RPC dispatcher) — see `request_context.test_context_preset.test.ts`
 * for that coverage.
 *
 * The torn-read 500 is unreachable from an integration test that
 * deletes the `account` row — the `ON DELETE CASCADE` chain tears down
 * `api_token` / `auth_session` first, so bearer auth fails before the
 * dispatcher runs. Mocking `query_account_by_id` / `query_actor_by_id`
 * to return null is the only way to deterministically exercise the
 * branch. The companion `bearer_actor_deleted.db.test.ts` covers the
 * `no_actors_on_account` arm at the integration level.
 *
 * @module
 */

import {describe, test, assert, vi, afterEach} from 'vitest';

import {apply_authorization_phase} from '$lib/auth/request_context.ts';
import {
	query_account_by_id,
	query_actor_by_id,
	query_actors_by_account,
} from '$lib/auth/account_queries.ts';
import {query_role_grant_find_active_for_actor} from '$lib/auth/role_grant_queries.ts';
import {
	ERROR_ACTOR_REQUIRED,
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_NO_ACTORS_ON_ACCOUNT,
	ERROR_ACCOUNT_VANISHED,
} from '$lib/http/error_schemas.ts';
import {
	create_test_account,
	create_test_actor,
	create_test_role_grant,
} from '$lib/testing/entities.ts';
import type {QueryDeps} from '$lib/db/query_deps.ts';

const mock_deps: QueryDeps = {db: {} as any};

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_id: vi.fn(),
	query_actors_by_account: vi.fn(),
}));

vi.mock('$lib/auth/role_grant_queries.js', () => ({
	query_role_grant_find_active_for_actor: vi.fn(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

const ACCOUNT_ID = 'acct-1';
const ACTOR_ID = 'actor-1';
const SECOND_ACTOR_ID = 'actor-2';

const account = create_test_account({id: ACCOUNT_ID, username: 'alice'});
const actor = create_test_actor({id: ACTOR_ID, account_id: ACCOUNT_ID, name: 'alice'});
const second_actor = create_test_actor({
	id: SECOND_ACTOR_ID,
	account_id: ACCOUNT_ID,
	name: 'alice-pro',
});
const role_grants = [
	create_test_role_grant({id: 'role_grant-1', actor_id: ACTOR_ID, role: 'admin'}),
];

describe('apply_authorization_phase — short-circuit paths', () => {
	test('returns request_context: null when both axes are none (public — no resolution)', async () => {
		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'none', actor: 'none'},
			undefined,
		);

		assert.deepStrictEqual(result, {ok: true, request_context: null});
		assert.strictEqual(vi.mocked(query_actors_by_account).mock.calls.length, 0);
	});

	test('returns request_context: null when account_id is null (unauthenticated — downstream auth guard handles 401)', async () => {
		const result = await apply_authorization_phase(
			mock_deps,
			null,
			{account: 'required', actor: 'required'},
			undefined,
		);

		assert.deepStrictEqual(result, {ok: true, request_context: null});
		assert.strictEqual(vi.mocked(query_actors_by_account).mock.calls.length, 0);
	});
});

describe('apply_authorization_phase — needs_actor: false (account-grain)', () => {
	test('builds account-only context on success (actor: null, empty role_grants)', async () => {
		vi.mocked(query_account_by_id).mockResolvedValue(account);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'none'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: true,
			request_context: {account, actor: null, role_grants: []},
		});
	});

	test('returns 500 account_vanished when query_account_by_id returns null', async () => {
		vi.mocked(query_account_by_id).mockResolvedValue(undefined);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'none'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
	});
});

describe('apply_authorization_phase — needs_actor: true', () => {
	test('builds full context on single-actor success (no acting supplied)', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_account_by_id).mockResolvedValue(account);
		vi.mocked(query_actor_by_id).mockResolvedValue(actor);
		vi.mocked(query_role_grant_find_active_for_actor).mockResolvedValue(role_grants);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'required'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: true,
			request_context: {account, actor, role_grants},
		});
	});

	test('returns 500 no_actors_on_account when query_actors_by_account is empty', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([]);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'required'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 500,
			body: {error: ERROR_NO_ACTORS_ON_ACCOUNT},
		});
	});

	test('returns 400 actor_required with available list on multi-actor + no acting', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([actor, second_actor]);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'required'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 400,
			body: {
				error: ERROR_ACTOR_REQUIRED,
				available: [
					{id: ACTOR_ID, name: 'alice'},
					{id: SECOND_ACTOR_ID, name: 'alice-pro'},
				],
			},
		});
	});

	test('returns 400 actor_not_on_account when supplied acting does not match', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'required'},
			'actor-not-here',
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 400,
			body: {error: ERROR_ACTOR_NOT_ON_ACCOUNT},
		});
	});

	test('returns 500 account_vanished when query_account_by_id is null after resolve (torn read)', async () => {
		// `query_actors_by_account` succeeds — `resolve_acting_actor` returns
		// {ok: true}. `build_request_context`'s account lookup then returns
		// null (account row deleted between the two reads — production is a
		// concurrent-deletion race; here we simulate it directly).
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_account_by_id).mockResolvedValue(undefined);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'required'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
	});

	test('returns 500 account_vanished when query_actor_by_id is null after resolve (torn read)', async () => {
		// `query_actors_by_account` returned the actor; `query_account_by_id`
		// found the account; but `query_actor_by_id` returns null — the
		// actor row was deleted between enumeration and lookup.
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_account_by_id).mockResolvedValue(account);
		vi.mocked(query_actor_by_id).mockResolvedValue(undefined);

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'required'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
	});

	test('returns 500 account_vanished when actor.account_id mismatch (defense-in-depth branch)', async () => {
		// Defense-in-depth: `resolve_acting_actor` already verified the actor
		// belongs to the account, but `build_request_context` re-checks the
		// binding. The mismatch sub-branch fires when `actor.account_id`
		// flipped between the two reads — production-unreachable on paper,
		// but the docstring documents that it collapses into the torn-read
		// 500 shape rather than its own status code.
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_account_by_id).mockResolvedValue(account);
		vi.mocked(query_actor_by_id).mockResolvedValue({
			...actor,
			account_id: 'different-account' as typeof actor.account_id,
		});

		const result = await apply_authorization_phase(
			mock_deps,
			ACCOUNT_ID,
			{account: 'required', actor: 'required'},
			undefined,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
	});
});
