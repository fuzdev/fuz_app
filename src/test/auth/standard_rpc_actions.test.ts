/**
 * Smoke tests for `create_standard_rpc_actions` — the combined
 * admin + role-grant-offer + account RPC action registry consumers spread into
 * their single `/api/rpc` endpoint.
 *
 * The inner factories are exhaustively tested elsewhere (`admin_actions.*`,
 * `role_grant_offer_actions.*`, and `account_actions.*` suites). This file
 * verifies the combiner emits every method each side exposes without
 * collisions, threads the shared `roles` option to both admin and
 * role-grant-offer, and always includes the two app-settings methods.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';

import {create_standard_rpc_actions} from '$lib/auth/standard_rpc_actions.js';
import {all_admin_action_specs} from '$lib/auth/admin_action_specs.js';
import {
	all_role_grant_offer_action_specs,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	role_grant_offer_create_action_spec,
} from '$lib/auth/role_grant_offer_action_specs.js';
import {all_account_action_specs} from '$lib/auth/account_action_specs.js';
import {create_stub_db, create_test_audit_emitter} from '$lib/testing/stubs.js';
import {create_test_context} from '$lib/testing/entities.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import type {ActionContext} from '$lib/actions/action_rpc.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

const log = new Logger('test', {level: 'off'});
const deps = {log, audit: create_test_audit_emitter()};

/** Minimal ActionContext for invoking handlers directly. */
const make_action_ctx = (auth_ctx: ReturnType<typeof create_test_context>): ActionContext => {
	const db = create_stub_db();
	return {
		auth: auth_ctx,
		request_id: 'test',
		db,
		pending_effects: [],
		post_commit_effects: [],
		client_ip: 'unknown',
		credential_type: 'session',
		log,
		notify: () => {},
		signal: new AbortController().signal,
	};
};

describe('create_standard_rpc_actions', () => {
	test('emits every admin + role-grant-offer + account method without duplicates', () => {
		const actions = create_standard_rpc_actions(deps);
		const methods = actions.map((a) => a.spec.method);
		// every admin method present
		for (const spec of all_admin_action_specs) {
			assert.include(methods, spec.method, `missing admin method ${spec.method}`);
		}
		// every role-grant-offer method present
		for (const spec of all_role_grant_offer_action_specs) {
			assert.include(methods, spec.method, `missing role-grant-offer method ${spec.method}`);
		}
		// every account method present
		for (const spec of all_account_action_specs) {
			assert.include(methods, spec.method, `missing account method ${spec.method}`);
		}
		// no duplicates — the RPC dispatcher throws on collision, so catching
		// this at construction time is worth the extra check
		assert.strictEqual(methods.length, new Set(methods).size, 'duplicate methods emitted');
	});

	test('app-settings rpc_actions are always present in the handler list', () => {
		// The two app-settings methods are unconditionally wired: the
		// `app_settings` row is part of the built-in auth schema, so the
		// update handler writes it and signup reads the toggle fresh from
		// the DB. No option gates them — RPC dispatch never returns
		// method_not_found for these.
		const methods = new Set(create_standard_rpc_actions(deps).map((a) => a.spec.method));
		assert.isTrue(methods.has('app_settings_get'));
		assert.isTrue(methods.has('app_settings_update'));
	});

	test('methods land in admin → role-grant-offer → account order', () => {
		// Stability pin: the combined factory spreads the three sub-factories
		// in a fixed order. Consumers don't depend on ordering for dispatch,
		// but surface snapshots and codegen output can drift silently if a
		// future refactor reorders the spreads.
		const actions = create_standard_rpc_actions(deps);
		const methods = actions.map((a) => a.spec.method);
		const first_admin = methods.indexOf(all_admin_action_specs[0]!.method);
		const first_offer = methods.indexOf(all_role_grant_offer_action_specs[0]!.method);
		const first_account = methods.indexOf(all_account_action_specs[0]!.method);
		assert.ok(first_admin >= 0, 'admin methods must be present');
		assert.ok(first_offer >= 0, 'role-grant-offer methods must be present');
		assert.ok(first_account >= 0, 'account methods must be present');
		assert.ok(first_admin < first_offer, 'admin must precede role-grant-offer');
		assert.ok(first_offer < first_account, 'role-grant-offer must precede account');
	});

	test('admin + role-grant-offer + account action counts add up', () => {
		// admin factory emits 14 actions (includes account_delete +
		// account_purge + account_undelete + the two always-on app-settings
		// methods). role-grant-offer factory emits 7. account factory emits 7.
		// Combined helper should equal the sum.
		const actions = create_standard_rpc_actions(deps);
		assert.strictEqual(actions.length, 14 + 7 + 7);
	});

	test('authorize option reaches the role_grant_offer_create handler', async () => {
		// Drive the combined surface's `role_grant_offer_create` handler with a
		// custom `authorize` that denies — proves the option threaded through
		// to the role-grant-offer factory. Denying short-circuits before the DB
		// path, so a stub db is sufficient.
		const calls: Array<{actor_id: string; role: string; scope_id: string | null}> = [];
		const actions = create_standard_rpc_actions(deps, {
			authorize: async (auth, input) => {
				calls.push({actor_id: auth.actor!.id, role: input.role, scope_id: input.scope_id});
				return false;
			},
		});
		const create_action = actions.find(
			(a) => a.spec.method === role_grant_offer_create_action_spec.method,
		);
		assert.ok(create_action, 'combined surface must expose role_grant_offer_create');

		const auth_ctx = create_test_context([{role: ROLE_ADMIN}]);
		const ctx = make_action_ctx(auth_ctx);

		const caught = (await assert_rejects(() =>
			create_action.handler({to_account_id: 'acct-target' as Uuid, role: ROLE_ADMIN}, ctx),
		)) as Error & {data?: {reason?: string}};

		assert.strictEqual(calls.length, 1, 'authorize must be invoked exactly once');
		assert.strictEqual(calls[0]!.role, ROLE_ADMIN);
		assert.strictEqual(calls[0]!.scope_id, null);
		// Denial surfaces as the documented reason code.
		assert.strictEqual(caught.data?.reason, ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED);
	});
});
