/**
 * Bearer auth + dispatcher authorization phase: actor missing.
 *
 * The bearer middleware validates the token and sets `ACCOUNT_ID_KEY` /
 * `CREDENTIAL_TYPE_KEY` only — actor + permit resolution lives in the
 * dispatcher's authorization phase. When the actor was deleted between
 * token issuance and the call, the authorization phase surfaces
 * `ERROR_NO_ACTORS_ON_ACCOUNT` (500) cleanly instead of the bearer
 * middleware emitting a misleading 401.
 *
 * Companion to `permit_offer.multi_actor.db.test.ts` which exercises the
 * `actor_not_on_account` / `actor_required` (400) branches via the
 * `acting` parameter.
 *
 * @module
 */

import {test, assert} from 'vitest';

import {admin_session_revoke_all_action_spec} from '$lib/auth/admin_action_specs.js';
import {create_test_app} from '$lib/testing/app_server.js';
import {ERROR_NO_ACTORS_ON_ACCOUNT} from '$lib/http/error_schemas.js';
import {ROLE_ADMIN} from '$lib/auth/role_schema.js';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.js';
import {
	RPC_PATH,
	create_admin_route_specs,
	describe_db,
	session_options,
} from './admin_rpc_test_helpers.js';

describe_db('bearer auth + dispatcher authorization phase — torn actor', (get_db) => {
	test('actor deleted → 500 no_actors_on_account envelope on a role-gated method', async () => {
		const test_app = await create_test_app({
			session_options,
			create_route_specs: create_admin_route_specs,
			db: get_db(),
			roles: [ROLE_ADMIN],
		});

		// Delete every actor on the bootstrap account directly. The bearer
		// token still validates — the `api_token` row is intact and the
		// account row is intact — so this isolates the dispatcher's
		// authorization phase as the only code that walks the actor list.
		await test_app.backend.deps.db.query('DELETE FROM actor WHERE account_id = $1', [
			test_app.backend.account.id,
		]);

		// Hit a role-gated RPC method (`auth: {role: 'admin'}`) over the
		// bearer transport. `suppress_default_origin: true` drops the
		// default Origin header so `bearer_auth` doesn't discard the token
		// under browser-context rules.
		const res = await rpc_call_for_spec({
			app: test_app.app,
			path: RPC_PATH,
			spec: admin_session_revoke_all_action_spec,
			params: {account_id: test_app.backend.account.id},
			headers: test_app.create_bearer_headers(),
			suppress_default_origin: true,
		});

		// The dispatcher folds the auth-phase failure into a JSON-RPC
		// envelope: 500 status, internal_error code, reason on
		// `error.data.reason`. `rpc_call_for_spec` rejects non-envelope
		// bodies, so reaching this assertion is itself the regression
		// guard for the wrap.
		assert.ok(!res.ok);
		assert.strictEqual(res.status, 500);
		assert.strictEqual(res.error.message, ERROR_NO_ACTORS_ON_ACCOUNT);
		assert.strictEqual(
			(res.error.data as {reason?: string} | undefined)?.reason,
			ERROR_NO_ACTORS_ON_ACCOUNT,
		);

		await test_app.cleanup();
	});
});
