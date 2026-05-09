/**
 * Finding 6 — scoped permit must not unlock unscoped role gate.
 *
 * `has_role(ctx, role)` walks `ctx.permits` matching only `p.role`, not
 * `p.scope_id`. The framework gates (route-spec `require_role`, the RPC
 * dispatcher's per-action role check, the WS dispatcher's per-action role
 * check) and the application-level admin bypasses inside
 * `permit_offer_actions.ts` all use this scope-agnostic helper, so a permit
 * like `{role: 'admin', scope_id: <some uuid>}` admits the holder to every
 * `auth: {account: 'required', actor: 'required', roles: ['admin']}` route in fuz_app — including the global admin RPC
 * surface (`account_list`, `audit_log_list`, `app_settings_update`, etc.).
 *
 * Threat path: a global admin offers `{role: 'admin', scope_id: scope_X}`
 * intending to delegate scoped admin authority over scope_X. The recipient
 * accepts; the resulting permit unlocks the entire global admin surface.
 *
 * The fix tightens each gate site to `has_scoped_role(ctx, role, null)`
 * (matches global / unscoped permits only). This file is the regression
 * harness: it should FAIL on main pre-fix (proves the bug exists), then
 * PASS after the gate sites are updated.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {admin_account_list_action_spec} from '$lib/auth/admin_action_specs.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {query_grant_permit} from '$lib/auth/permit_queries.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';
import {
	RPC_PATH,
	create_admin_route_specs,
	describe_db,
	session_options,
} from './admin_rpc_test_helpers.js';

// Valid v4 UUID for the synthetic scope. Any non-bootstrap-account scope id
// works — the gate only checks role + scope, not whether the scope row exists.
const test_scope_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as Uuid;

describe_db('permit_scope_role_gate', (get_db) => {
	describe('scoped admin permit must not unlock unscoped admin RPC actions', () => {
		test('account holding admin@scope is rejected by `admin_account_list`', async () => {
			const test_app = await create_test_app({
				session_options,
				create_route_specs: create_admin_route_specs,
				db: get_db(),
			});

			// Create a non-admin account ("alice") with no permits.
			const alice = await test_app.create_account({username: 'alice'});

			// Grant alice a scoped admin permit. This is the privilege-escalation
			// shape: an admin issued admin@scope intending to delegate scoped
			// authority, but the global admin gate today admits the holder.
			await query_grant_permit(test_app.backend.deps, {
				actor_id: alice.actor.id,
				role: ROLE_ADMIN,
				scope_kind: 'classroom',
				scope_id: test_scope_id,
				granted_by: null,
			});

			// Call a global-admin RPC action with alice's session.
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: admin_account_list_action_spec,
				params: {},
				headers: alice.create_session_headers(),
			});

			// Pre-fix: this assertion FAILS (the dispatcher admits alice → 200).
			// Post-fix: the dispatcher uses `has_scoped_role(ctx, role, null)`
			// and rejects scoped-admin permits → 403.
			assert.ok(
				!res.ok,
				`scoped admin@${test_scope_id} should NOT unlock global admin_account_list — ` +
					`but the gate admitted alice. This is the privilege escalation Finding 6 documents.`,
			);
			assert.strictEqual(res.status, 403);
		});
	});
});
