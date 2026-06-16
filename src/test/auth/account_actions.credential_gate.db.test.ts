/**
 * Live-dispatch coverage for the credential-channel gate on
 * `account_*` actions. A bearer (`api_token`) credential hitting any
 * spec that declares `credential_types: ['session']` must be rejected
 * with 403 `ERROR_CREDENTIAL_TYPE_REQUIRED` + `required_credential_types:
 * ['session']` before the handler runs. Closes the threat shapes
 * documented in `docs/security.md` §Credential-channel gating.
 *
 * Positive controls assert (a) session-credential calls still reach the
 * handler on the same gated specs and (b) un-gated specs accept bearer.
 *
 * Dispatcher ordering note: the pipeline is **401 → 400 → 403 → handler**,
 * so `credential_types` (403) fires *after* input validation (400). The
 * `params` shapes below are deliberately well-formed (`Blake3Hash`-shaped
 * session ids, `tok_`-prefixed token ids, valid `Password` lengths) so
 * the 403 credential-gate fires instead of an `invalid_params` 400 —
 * tightening any input schema must keep these fixtures valid or the
 * tests will collapse to the wrong rejection code.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import {create_session_config} from '$lib/auth/session_cookie.ts';
import {create_account_route_specs} from '$lib/auth/account_routes.ts';
import {create_account_actions} from '$lib/auth/account_actions.ts';
import {
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
	account_token_create_action_spec,
	account_token_list_action_spec,
	account_token_revoke_action_spec,
} from '$lib/auth/account_action_specs.ts';
import {create_rpc_endpoint} from '$lib/actions/action_rpc.ts';
import {auth_migration_ns} from '$lib/auth/migrations.ts';
import {create_test_app} from '$lib/testing/app_server.ts';
import {DEFAULT_TEST_PASSWORD} from '$lib/testing/test_credentials.ts';
import {
	auth_integration_truncate_tables,
	create_describe_db,
	create_pglite_factory,
} from '$lib/testing/db.ts';
import {rpc_call_for_spec} from '$lib/testing/rpc_helpers.ts';
import {find_auth_route} from '$lib/testing/integration_helpers.ts';
import {ERROR_CREDENTIAL_TYPE_REQUIRED} from '$lib/http/error_schemas.ts';
import {run_migrations} from '$lib/db/migrate.ts';
import type {Db} from '$lib/db/db.ts';
import type {AppServerContext} from '$lib/server/app_server_context.ts';
import {prefix_route_specs, type RouteSpec} from '$lib/http/route_spec.ts';

const session_options = create_session_config('test_session');
const RPC_PATH = '/api/rpc';

const init_schema = async (db: Db): Promise<void> => {
	await run_migrations(db, [auth_migration_ns]);
};
const factory = create_pglite_factory(init_schema);
const describe_db = create_describe_db(factory, auth_integration_truncate_tables);

const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	...prefix_route_specs(
		'/api/account',
		create_account_route_specs(ctx.deps, {
			session_options,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
			login_fail_floor_ms: 0,
		}),
	),
	...create_rpc_endpoint({
		path: RPC_PATH,
		actions: create_account_actions(ctx.deps),
		log: ctx.deps.log,
	}),
];

const assert_credential_type_required = (res: {
	ok: boolean;
	status: number;
	error?: {data?: unknown};
}): void => {
	assert.strictEqual(res.ok, false, 'expected gated 403');
	assert.strictEqual(res.status, 403);
	assert.isFalse(res.ok);
	const data = (res.error?.data ?? {}) as {
		reason?: string;
		required_credential_types?: ReadonlyArray<string>;
	};
	assert.strictEqual(data.reason, ERROR_CREDENTIAL_TYPE_REQUIRED);
	assert.deepStrictEqual(data.required_credential_types, ['session']);
};

describe_db('credential_channel_gate', (get_db) => {
	describe('bearer rejected on gated RPC methods', () => {
		test('account_token_create — bearer → 403 credential_type_required', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_create_action_spec,
				params: {name: 'bearer-attempt'},
				headers: test_app.create_bearer_headers(),
				suppress_default_origin: true,
			});
			assert_credential_type_required(res);
		});

		test('account_token_revoke — bearer → 403 credential_type_required', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: {token_id: 'tok_xxxxxxxxxxxx'},
				headers: test_app.create_bearer_headers(),
				suppress_default_origin: true,
			});
			assert_credential_type_required(res);
		});

		test('account_session_revoke — bearer → 403 credential_type_required (closes list+loop gap)', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: '0'.repeat(64)},
				headers: test_app.create_bearer_headers(),
				suppress_default_origin: true,
			});
			assert_credential_type_required(res);
		});

		test('account_session_revoke_all — bearer → 403 credential_type_required', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_all_action_spec,
				params: undefined,
				headers: test_app.create_bearer_headers(),
				suppress_default_origin: true,
			});
			assert_credential_type_required(res);
		});
	});

	describe('bearer rejected on gated REST POST /password', () => {
		test('bearer credential → 403 credential_type_required', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'Expected POST /password route');
			const res = await test_app.app.request(password_route.path, {
				method: 'POST',
				headers: {
					...test_app.create_bearer_headers({'content-type': 'application/json'}),
					host: 'localhost',
				},
				body: JSON.stringify({
					current_password: DEFAULT_TEST_PASSWORD,
					new_password: 'never-applied-456',
				}),
			});
			assert.strictEqual(res.status, 403);
			const body = (await res.json()) as {
				error?: string;
				required_credential_types?: ReadonlyArray<string>;
			};
			assert.strictEqual(body.error, ERROR_CREDENTIAL_TYPE_REQUIRED);
			assert.deepStrictEqual(body.required_credential_types, ['session']);
		});
	});

	describe('anonymous → 401 not 403 (auth gate fires before credential gate)', () => {
		// Pins the dispatcher's 401→400→403 ordering at the rejection paths:
		// an unauthenticated caller must surface `unauthenticated` (401), not
		// `credential_type_required` (403). The latter would leak credential-
		// policy information to callers that haven't even authenticated.

		test('account_token_create', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_create_action_spec,
				params: {name: 'anonymous'},
			});
			assert.strictEqual(
				res.ok,
				false,
				'expected 401 from auth gate, not 403 from credential gate',
			);
			assert.strictEqual(res.status, 401);
		});

		test('account_token_revoke', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_revoke_action_spec,
				params: {token_id: 'tok_xxxxxxxxxxxx'},
			});
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.status, 401);
		});

		test('account_session_revoke', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_action_spec,
				params: {session_id: '0'.repeat(64)},
			});
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.status, 401);
		});

		test('account_session_revoke_all', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_session_revoke_all_action_spec,
				params: undefined,
			});
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.status, 401);
		});

		test('REST POST /password', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'Expected POST /password route');
			const res = await test_app.app.request(password_route.path, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					host: 'localhost',
					origin: 'http://localhost:5173',
				},
				body: JSON.stringify({
					current_password: DEFAULT_TEST_PASSWORD,
					new_password: 'never-applied-456',
				}),
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('prevention layer is silent (no audit on gate rejection)', () => {
		// Matches the `require_auth` precedent: rejections before the handler
		// runs write no audit. Without this property a leaked bearer could
		// flood the audit log with rejected-attempt rows, eroding retention
		// budget and obscuring legitimate activity.

		test('all five gated attempts via bearer leave audit_log free of gated event types', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const password_route = find_auth_route(test_app.route_specs, '/password', 'POST');
			assert.ok(password_route, 'Expected POST /password route');

			await Promise.all([
				rpc_call_for_spec({
					app: test_app.app,
					path: RPC_PATH,
					spec: account_token_create_action_spec,
					params: {name: 'bearer-attempt'},
					headers: test_app.create_bearer_headers(),
					suppress_default_origin: true,
				}),
				rpc_call_for_spec({
					app: test_app.app,
					path: RPC_PATH,
					spec: account_token_revoke_action_spec,
					params: {token_id: 'tok_xxxxxxxxxxxx'},
					headers: test_app.create_bearer_headers(),
					suppress_default_origin: true,
				}),
				rpc_call_for_spec({
					app: test_app.app,
					path: RPC_PATH,
					spec: account_session_revoke_action_spec,
					params: {session_id: '0'.repeat(64)},
					headers: test_app.create_bearer_headers(),
					suppress_default_origin: true,
				}),
				rpc_call_for_spec({
					app: test_app.app,
					path: RPC_PATH,
					spec: account_session_revoke_all_action_spec,
					params: undefined,
					headers: test_app.create_bearer_headers(),
					suppress_default_origin: true,
				}),
				test_app.app.request(password_route.path, {
					method: 'POST',
					headers: {
						...test_app.create_bearer_headers({'content-type': 'application/json'}),
						host: 'localhost',
					},
					body: JSON.stringify({
						current_password: DEFAULT_TEST_PASSWORD,
						new_password: 'never-applied-456',
					}),
				}),
			]);

			const events = await test_app.backend.deps.db.query<{event_type: string}>(
				'SELECT event_type FROM audit_log',
			);
			const gated_types = new Set([
				'token_create',
				'token_revoke',
				'session_revoke',
				'session_revoke_all',
				'password_change',
			]);
			const leaked = events.filter((e) => gated_types.has(e.event_type));
			assert.strictEqual(
				leaked.length,
				0,
				`expected no gated audit rows from bearer-rejected attempts, got ${JSON.stringify(leaked)}`,
			);
		});
	});

	describe('positive controls', () => {
		test('session credential reaches token_create handler (gate accepts session)', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_create_action_spec,
				params: {name: 'session-allowed'},
				headers: test_app.create_session_headers(),
			});
			assert.ok(res.ok, `account_token_create should succeed via session: ${JSON.stringify(res)}`);
			assert.strictEqual(res.status, 200);
			assert.match(res.result.token, /^secret_fuz_token_/);
		});

		test('ungated account_token_list accepts bearer (gate is per-method, not blanket)', async () => {
			const test_app = await create_test_app({session_options, create_route_specs, db: get_db()});
			const res = await rpc_call_for_spec({
				app: test_app.app,
				path: RPC_PATH,
				spec: account_token_list_action_spec,
				params: undefined,
				headers: test_app.create_bearer_headers(),
				suppress_default_origin: true,
			});
			assert.ok(res.ok, `account_token_list should accept bearer: ${JSON.stringify(res)}`);
			assert.strictEqual(res.status, 200);
		});
	});
});
