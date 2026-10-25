/**
 * Admin-surface conformance cases the per-method auth rows can't derive.
 *
 * `generate_rpc_auth_conformance_cases` reads each method's declared auth, so
 * it pins the dispatcher gates — anonymous, wrong credential, missing role —
 * and nothing a handler decides from its input. These rows pin those:
 *
 * - **offer list / history across accounts** — `role_grant_offer_list` and
 *   `role_grant_offer_history` declare no role, so any authenticated account
 *   reaches the handler, which refuses a non-admin naming another account
 *   (403) and admits an admin. The rows name the nil id, which no account
 *   holds; that the refusal is identical for an account that exists is the
 *   imperative `describe_offer_cross_account_tests`, since the existing id is
 *   the keeper's and only the fixture knows it. The refusal carries no
 *   `data.reason` on either spine, so `status` pins it.
 * - **invite errors** — an absent invite id and an invite for an existing
 *   username. The duplicate-invite refusal needs a first invite in place, so
 *   it is the imperative `describe_invite_duplicate_tests`.
 * - **pagination bounds** — `limit` below 1, past the method's max, or
 *   non-integer, and a negative `offset`, are `invalid_params` (400); `limit`
 *   at the max is admitted. Neither spine clamps an out-of-range page. The TS
 *   refusal carries no `data.reason`, so `status` pins it.
 *
 * Each `note` cites where its property is stated: the input schemas and
 * their TSDoc in `auth/admin_action_specs.ts` and
 * `auth/role_grant_offer_action_specs.ts`, the `ERROR_INVITE_*` TSDoc in
 * `http/error_schemas.ts`, or `docs/security.md`.
 *
 * @module
 */

import {
	ADMIN_ACCOUNT_LIST_LIMIT_MAX,
	AUDIT_LOG_LIST_LIMIT_MAX
} from '#lib/auth/admin_action_specs.ts';
import { ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX } from '#lib/auth/role_grant_offer_action_specs.ts';
import {
	ERROR_INVITE_ACCOUNT_EXISTS_USERNAME,
	ERROR_INVITE_NOT_FOUND
} from '#lib/http/error_schemas.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';
import { default_test_keeper_username } from '#lib/testing/cross_backend/default_secrets.ts';

/** A well-formed UUID that names no account or invite. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The two offer reads whose `account_id` is admin-only. */
const OFFER_READ_METHODS = ['role_grant_offer_list', 'role_grant_offer_history'] as const;

const offer_cross_account_cases: Array<ConformanceCase> = OFFER_READ_METHODS.flatMap(
	(method): Array<ConformanceCase> => {
		const note =
			'auth/role_grant_offer_action_specs.ts — the input’s `account_id` is admin-only; the handler requires an admin for another account';
		return [
			{
				name: `fresh non-admin → ${method} {account_id: NIL} → 403`,
				request: { method, as: 'fresh_non_admin', params: { account_id: NIL_UUID } },
				expect: { status: 403 },
				note
			},
			{
				name: `fresh non-admin → ${method} {} → 200 (own offers, the control)`,
				request: { method, as: 'fresh_non_admin', params: {} },
				expect: { status: 200 },
				note: `${note}; the caller’s own offers stay readable without the role`
			},
			{
				name: `admin → ${method} {account_id: NIL} → 200`,
				request: { method, as: 'keeper', params: { account_id: NIL_UUID } },
				expect: { status: 200, fields: { offers: [] } },
				note
			}
		];
	}
);

const invite_cases: Array<ConformanceCase> = [
	{
		name: 'admin → invite_delete {invite_id: NIL} → 404 invite_not_found',
		request: { method: 'invite_delete', as: 'keeper', params: { invite_id: NIL_UUID } },
		expect: { status: 404, error_reason: ERROR_INVITE_NOT_FOUND },
		note: 'http/error_schemas.ts `ERROR_INVITE_NOT_FOUND` — deleting an invite that does not exist'
	},
	{
		name: 'admin → invite_create {username: <the keeper>} → 409 invite_account_exists_username',
		request: {
			method: 'invite_create',
			as: 'keeper',
			params: { username: default_test_keeper_username }
		},
		expect: { status: 409, error_reason: ERROR_INVITE_ACCOUNT_EXISTS_USERNAME },
		note: 'security.md §Signup — an invite cannot be addressed to a username an account already holds'
	}
];

/** The admin-reachable lists with `limit` / `offset` paging, and each one's max page. */
const PAGED_LISTS: ReadonlyArray<{ readonly method: string; readonly max: number }> = [
	{ method: 'admin_account_list', max: ADMIN_ACCOUNT_LIST_LIMIT_MAX },
	{ method: 'audit_log_list', max: AUDIT_LOG_LIST_LIMIT_MAX },
	{ method: 'audit_log_role_grant_history', max: AUDIT_LOG_LIST_LIMIT_MAX },
	{ method: 'role_grant_offer_history', max: ROLE_GRANT_OFFER_HISTORY_LIMIT_MAX }
];

const pagination_cases: Array<ConformanceCase> = PAGED_LISTS.flatMap(
	({ method, max }): Array<ConformanceCase> => {
		const note =
			'auth/admin_action_specs.ts + auth/role_grant_offer_action_specs.ts — the input schemas bound `limit` to [1, max] and `offset` to >= 0, so an out-of-range page is refused, not clamped';
		const refused = (label: string, params: Record<string, unknown>): ConformanceCase => ({
			name: `admin → ${method} ${label} → 400`,
			request: { method, as: 'keeper', params },
			expect: { status: 400 },
			note
		});
		return [
			refused('{limit: 0}', { limit: 0 }),
			refused('{limit: max + 1}', { limit: max + 1 }),
			refused('{limit: 1.5}', { limit: 1.5 }),
			refused('{offset: -1}', { offset: -1 }),
			{
				name: `admin → ${method} {limit: max} → 200`,
				request: { method, as: 'keeper', params: { limit: max } },
				expect: { status: 200 },
				note: `${note}; the max itself is a valid page`
			}
		];
	}
);

export const conformance_admin_cases: ReadonlyArray<ConformanceCase> = [
	...offer_cross_account_cases,
	...invite_cases,
	...pagination_cases
];
