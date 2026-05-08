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
import type {Context} from 'hono';

import {apply_authorization_phase, REQUEST_CONTEXT_KEY} from '$lib/auth/request_context.js';
import {
	query_account_by_id,
	query_actor_by_id,
	query_actors_by_account,
} from '$lib/auth/account_queries.js';
import {query_permit_find_active_for_actor} from '$lib/auth/permit_queries.js';
import {ACCOUNT_ID_KEY, TEST_CONTEXT_PRESET_KEY} from '$lib/hono_context.js';
import {
	ERROR_ACTOR_REQUIRED,
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_NO_ACTORS_ON_ACCOUNT,
	ERROR_ACCOUNT_VANISHED,
} from '$lib/http/error_schemas.js';
import {create_test_account, create_test_actor, create_test_permit} from '$lib/testing/entities.js';
import type {QueryDeps} from '$lib/db/query_deps.js';

const mock_deps: QueryDeps = {db: {} as any};

vi.mock('$lib/auth/account_queries.js', () => ({
	query_account_by_id: vi.fn(),
	query_actor_by_id: vi.fn(),
	query_actors_by_account: vi.fn(),
}));

vi.mock('$lib/auth/permit_queries.js', () => ({
	query_permit_find_active_for_actor: vi.fn(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Build a minimal fake Hono `Context` exposing just `.get()` / `.set()`
 * over an in-memory store. The function under test only touches those
 * two methods.
 */
const create_fake_context = (initial_vars: Record<string, unknown> = {}): Context => {
	const vars: Record<string, unknown> = {...initial_vars};
	return {
		get: (key: string) => vars[key],
		set: (key: string, value: unknown) => {
			vars[key] = value;
		},
	} as unknown as Context;
};

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
const permits = [create_test_permit({id: 'permit-1', actor_id: ACTOR_ID, role: 'admin'})];

describe('apply_authorization_phase — short-circuit paths', () => {
	test('returns void when TEST_CONTEXT_PRESET_KEY is set (test escape hatch)', async () => {
		const c = create_fake_context({
			[TEST_CONTEXT_PRESET_KEY]: true,
			[ACCOUNT_ID_KEY]: ACCOUNT_ID,
		});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.strictEqual(result, undefined);
		// The escape hatch trusts whatever the harness pre-populated.
		assert.strictEqual(vi.mocked(query_actors_by_account).mock.calls.length, 0);
	});

	test('returns void when account_id is null (downstream auth guard handles 401)', async () => {
		const c = create_fake_context({[ACCOUNT_ID_KEY]: null});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.strictEqual(result, undefined);
		assert.strictEqual(vi.mocked(query_actors_by_account).mock.calls.length, 0);
	});
});

describe('apply_authorization_phase — needs_actor: false (account-grain)', () => {
	test('builds account-only context on success (actor: null, empty permits)', async () => {
		vi.mocked(query_account_by_id).mockResolvedValue(account);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, false, undefined);

		assert.strictEqual(result, undefined);
		const ctx = c.get(REQUEST_CONTEXT_KEY);
		assert.deepStrictEqual(ctx, {account, actor: null, permits: []});
	});

	test('returns 500 account_vanished when query_account_by_id returns null', async () => {
		vi.mocked(query_account_by_id).mockResolvedValue(undefined);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, false, undefined);

		assert.deepStrictEqual(result, {
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
		assert.strictEqual(c.get(REQUEST_CONTEXT_KEY), undefined);
	});
});

describe('apply_authorization_phase — needs_actor: true', () => {
	test('builds full context on single-actor success (no acting supplied)', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_account_by_id).mockResolvedValue(account);
		vi.mocked(query_actor_by_id).mockResolvedValue(actor);
		vi.mocked(query_permit_find_active_for_actor).mockResolvedValue(permits);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(c.get(REQUEST_CONTEXT_KEY), {account, actor, permits});
	});

	test('returns 500 no_actors_on_account when query_actors_by_account is empty', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([]);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.deepStrictEqual(result, {
			status: 500,
			body: {error: ERROR_NO_ACTORS_ON_ACCOUNT},
		});
		assert.strictEqual(c.get(REQUEST_CONTEXT_KEY), undefined);
	});

	test('returns 400 actor_required with available list on multi-actor + no acting', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([actor, second_actor]);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.deepStrictEqual(result, {
			status: 400,
			body: {
				error: ERROR_ACTOR_REQUIRED,
				available: [
					{id: ACTOR_ID, name: 'alice'},
					{id: SECOND_ACTOR_ID, name: 'alice-pro'},
				],
			},
		});
		assert.strictEqual(c.get(REQUEST_CONTEXT_KEY), undefined);
	});

	test('returns 400 actor_not_on_account when supplied acting does not match', async () => {
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, true, 'actor-not-here');

		assert.deepStrictEqual(result, {
			status: 400,
			body: {error: ERROR_ACTOR_NOT_ON_ACCOUNT},
		});
		assert.strictEqual(c.get(REQUEST_CONTEXT_KEY), undefined);
	});

	test('returns 500 account_vanished when query_account_by_id is null after resolve (torn read)', async () => {
		// `query_actors_by_account` succeeds — `resolve_acting_actor` returns
		// {ok: true}. `build_request_context`'s account lookup then returns
		// null (account row deleted between the two reads — production is a
		// concurrent-deletion race; here we simulate it directly).
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_account_by_id).mockResolvedValue(undefined);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.deepStrictEqual(result, {
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
		assert.strictEqual(c.get(REQUEST_CONTEXT_KEY), undefined);
	});

	test('returns 500 account_vanished when query_actor_by_id is null after resolve (torn read)', async () => {
		// `query_actors_by_account` returned the actor; `query_account_by_id`
		// found the account; but `query_actor_by_id` returns null — the
		// actor row was deleted between enumeration and lookup.
		vi.mocked(query_actors_by_account).mockResolvedValue([actor]);
		vi.mocked(query_account_by_id).mockResolvedValue(account);
		vi.mocked(query_actor_by_id).mockResolvedValue(undefined);
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.deepStrictEqual(result, {
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
		assert.strictEqual(c.get(REQUEST_CONTEXT_KEY), undefined);
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
		const c = create_fake_context({[ACCOUNT_ID_KEY]: ACCOUNT_ID});

		const result = await apply_authorization_phase(mock_deps, c, true, undefined);

		assert.deepStrictEqual(result, {
			status: 500,
			body: {error: ERROR_ACCOUNT_VANISHED},
		});
		assert.strictEqual(c.get(REQUEST_CONTEXT_KEY), undefined);
	});
});
