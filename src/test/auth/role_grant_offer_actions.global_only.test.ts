/**
 * Handler-level coverage of the **global-only** builtin-role rules on the
 * role-grant surface, without a database: the handlers run against a stub db
 * and each case refuses before the first query.
 *
 * - `role_grant_assign` re-checks the **global** admin grant in-handler, behind
 *   the dispatcher's role gate — a scoped `admin` never reaches the write.
 * - `role_grant_offer_create` refuses a scoped builtin role and a builtin role
 *   offered by a caller without a global `admin` **before** the consumer
 *   `authorize` callback, so even an admit-everything callback can't open
 *   either door.
 *
 * The DB-backed siblings (`role_grant_offer_actions.global_only.db.test.ts`,
 * `role_grant_offer_actions.accept_builtin.db.test.ts`) drive the same rules
 * through the dispatcher and the query layer; the `scope_kind` + `scope_id`
 * pairing is in `role_grant_offer_action_specs.test.ts`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { Logger } from '@fuzdev/fuz_util/log.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import {
	create_role_grant_offer_actions,
	type RoleGrantOfferCreateAuthorize
} from '$lib/auth/role_grant_offer_actions.ts';
import {
	ERROR_ROLE_GRANT_BUILTIN_SCOPED,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	role_grant_assign_action_spec,
	role_grant_offer_create_action_spec
} from '$lib/auth/role_grant_offer_action_specs.ts';
import { ROLE_ADMIN } from '$lib/auth/role_schema.ts';
import { ERROR_INSUFFICIENT_PERMISSIONS } from '$lib/http/error_schemas.ts';
import { JSONRPC_ERROR_CODES, ThrownJsonrpcError } from '$lib/http/jsonrpc_errors.ts';
import { create_test_audit_emitter } from '$lib/testing/stubs.ts';
import { create_test_context } from '$lib/testing/entities.ts';
import type { RpcAction } from '$lib/actions/action_rpc.ts';

import { create_test_action_context } from './rpc_test_helpers.ts';

const deps = { log: new Logger('test', { level: 'off' }), audit: create_test_audit_emitter() };

const SCOPE = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as Uuid;
const TO_ACCOUNT = '11111111-1111-4111-8111-111111111111' as Uuid;

/** A caller whose only `admin` is bound to a scope — the legacy row no grant path mints. */
const scoped_admin = () =>
	create_test_context([{ role: ROLE_ADMIN, scope_kind: 'space', scope_id: SCOPE }]);

const global_admin = () => create_test_context([{ role: ROLE_ADMIN }]);

const find_action = (actions: Array<RpcAction>, method: string): RpcAction => {
	const action = actions.find((a) => a.spec.method === method);
	assert.ok(action, `missing ${method}`);
	return action;
};

/** Build the offer surface with an `authorize` callback that records its calls and admits all. */
const create_recording_actions = (): { calls: Array<string>; actions: Array<RpcAction> } => {
	const calls: Array<string> = [];
	const authorize: RoleGrantOfferCreateAuthorize = (_auth, input) => {
		calls.push(input.role);
		return true;
	};
	return { calls, actions: create_role_grant_offer_actions(deps, { authorize }) };
};

/** Run `fn`, assert it rejects with a `ThrownJsonrpcError`, and return it. */
const rejects_with_jsonrpc_error = async (
	fn: () => Promise<unknown>
): Promise<ThrownJsonrpcError> => {
	const caught = await assert_rejects(fn);
	assert(caught instanceof ThrownJsonrpcError);
	return caught;
};

describe('role_grant_assign re-checks the global admin grant', () => {
	test('a scoped admin caller is refused before any write — even assigning itself a global admin', async () => {
		const { actions } = create_recording_actions();
		const assign = find_action(actions, role_grant_assign_action_spec.method);
		const auth = scoped_admin();
		const caught = await rejects_with_jsonrpc_error(() =>
			assign.handler(
				{ to_account_id: auth.account.id, to_actor_id: auth.actor.id, role: ROLE_ADMIN },
				create_test_action_context(auth)
			)
		);
		assert.strictEqual(caught.code, JSONRPC_ERROR_CODES.forbidden);
		assert.deepEqual(caught.data, { reason: ERROR_INSUFFICIENT_PERMISSIONS });
	});
});

describe('role_grant_offer_create decides builtin roles before the authorize callback', () => {
	test('a scoped builtin is refused (-32602 role_grant_builtin_scoped) under an admit-all callback', async () => {
		const { calls, actions } = create_recording_actions();
		const create = find_action(actions, role_grant_offer_create_action_spec.method);
		const caught = await rejects_with_jsonrpc_error(() =>
			create.handler(
				{ to_account_id: TO_ACCOUNT, role: ROLE_ADMIN, scope_kind: 'space', scope_id: SCOPE },
				create_test_action_context(global_admin())
			)
		);
		assert.strictEqual(caught.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.deepEqual(caught.data, { reason: ERROR_ROLE_GRANT_BUILTIN_SCOPED });
		assert.deepEqual(calls, [], 'the callback never sees a scoped builtin');
	});

	test('a builtin offer from a scoped admin is refused (403 not_authorized) under an admit-all callback', async () => {
		const { calls, actions } = create_recording_actions();
		const create = find_action(actions, role_grant_offer_create_action_spec.method);
		const caught = await rejects_with_jsonrpc_error(() =>
			create.handler(
				{ to_account_id: TO_ACCOUNT, role: ROLE_ADMIN },
				create_test_action_context(scoped_admin())
			)
		);
		assert.strictEqual(caught.code, JSONRPC_ERROR_CODES.forbidden);
		assert.deepEqual(caught.data, { reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED });
		assert.deepEqual(calls, [], 'the callback never sees a builtin offer from a non-global-admin');
	});

	test('the default callback reads the global grant — a scoped admin authorizes no offer', async () => {
		const create = find_action(
			create_role_grant_offer_actions(deps),
			role_grant_offer_create_action_spec.method
		);
		const caught = await rejects_with_jsonrpc_error(() =>
			create.handler(
				{ to_account_id: TO_ACCOUNT, role: ROLE_ADMIN },
				create_test_action_context(scoped_admin())
			)
		);
		assert.deepEqual(caught.data, { reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED });
	});
});
