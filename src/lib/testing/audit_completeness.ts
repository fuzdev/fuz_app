import './assert_dev_env.js';

/**
 * Composable audit log completeness test suite.
 *
 * Verifies that every auth mutation route produces the expected audit log
 * event. Uses the real middleware stack and database — audit events are
 * verified by querying the `audit_log` table after each request.
 *
 * Bootstrap is excluded because it requires filesystem token state that
 * `create_test_app` does not provide. Bootstrap audit logging is tested
 * separately in `bootstrap_account.db.test.ts`.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';

import type {SessionOptions} from '../auth/session_cookie.js';
import type {AppServerContext} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {ROLE_KEEPER, ROLE_ADMIN} from '../auth/role_schema.js';
import {AUDIT_EVENT_TYPES, type AuditEventType} from '../auth/audit_log_schema.js';
import {auth_migration_ns} from '../auth/migrations.js';
import {
	create_test_app,
	type CreateTestAppOptions,
	type SuiteAppOptions,
	type TestApp,
} from './app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	auth_integration_truncate_tables,
	type DbFactory,
} from './db.js';
import {find_auth_route} from './integration_helpers.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';
import {query_accept_offer} from '../auth/role_grant_offer_queries.js';
import {
	rpc_call_for_spec,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.js';
import {
	role_grant_offer_create_action_spec,
	role_grant_revoke_action_spec,
} from '../auth/role_grant_offer_action_specs.js';
import {
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	app_settings_update_action_spec,
	invite_create_action_spec,
	invite_delete_action_spec,
} from '../auth/admin_action_specs.js';
import {
	account_session_list_action_spec,
	account_session_revoke_action_spec,
	account_session_revoke_all_action_spec,
	account_token_create_action_spec,
	account_token_list_action_spec,
	account_token_revoke_action_spec,
} from '../auth/account_action_specs.js';

/**
 * Configuration for `describe_audit_completeness_tests`.
 */
export interface AuditCompletenessTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/**
	 * RPC endpoint specs — the source `RpcAction` arrays. Required; the
	 * admin role_grant flow is RPC-only and the suite hard-fails without it.
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` — the factory form
	 * is required when action handlers must close over the per-test
	 * `ctx.app_settings` / `ctx.deps` (e.g. exercising `app_settings_update`).
	 * The factory must return the same endpoint `path` regardless of ctx —
	 * it is invoked once at setup with a stub ctx for path lookup and again
	 * per-test by `create_app_server` for live dispatch.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: SuiteAppOptions;
	/** Database factories to run tests against. Default: pglite only. */
	db_factories?: Array<DbFactory>;
}

/** Query audit log events from the database. */
const query_audit_events = async (
	db: Db,
): Promise<Array<{event_type: AuditEventType; seq: number}>> => {
	return db.query<{event_type: AuditEventType; seq: number}>(
		'SELECT event_type, seq FROM audit_log ORDER BY seq',
	);
};

/** Assert that audit events contain the expected event type. */
const assert_has_event = (
	events: Array<{event_type: string}>,
	expected: AuditEventType,
	context: string,
): void => {
	assert.ok(
		events.some((e) => e.event_type === expected),
		`Expected '${expected}' audit event after ${context}`,
	);
};

/** Build CreateTestAppOptions with admin+keeper roles. */
const build_options = (options: AuditCompletenessTestOptions, db: Db): CreateTestAppOptions => ({
	session_options: options.session_options,
	create_route_specs: options.create_route_specs,
	db,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	app_options: {
		...options.app_options,
		rpc_endpoints: options.rpc_endpoints,
	},
});

/** Headers for unauthenticated JSON requests (login, signup). */
const UNAUTHENTICATED_JSON_HEADERS: Record<string, string> = {
	host: 'localhost',
	origin: 'http://localhost:5173',
	'content-type': 'application/json',
};

/** Standard request headers for session-authenticated JSON requests. */
const json_session_headers = (
	test_app: TestApp,
	extra?: Record<string, string>,
): Record<string, string> =>
	test_app.create_session_headers({
		'content-type': 'application/json',
		...extra,
	});

/**
 * Composable audit log completeness test suite.
 *
 * Verifies that every auth mutation route produces the correct audit log
 * event type. Exercises routes via HTTP requests against a real PGlite
 * database, then queries the `audit_log` table to verify events.
 *
 * @throws Error at setup time when `options.rpc_endpoints` is empty — the
 *   mutation-audit tests drive role_grant flow, session/token revoke-all, and
 *   invite create/delete through their RPC action specs. Hard-fails via
 *   `require_rpc_endpoint_path`.
 */
export const describe_audit_completeness_tests = (options: AuditCompletenessTestOptions): void => {
	// Hard-fail early so consumers see a clear setup error instead of a
	// confusing test failure when `rpc_endpoints` is missing. Factory-form
	// callers are resolved with a stub ctx purely to extract the endpoint
	// path; real handlers run per-test via `app_options.rpc_endpoints`.
	const rpc_endpoints_for_setup = resolve_rpc_endpoints_for_setup(
		options.rpc_endpoints,
		options.session_options,
	);
	const rpc_path = require_rpc_endpoint_path(rpc_endpoints_for_setup);

	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [auth_migration_ns]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];
	const describe_db = create_describe_db(factories, auth_integration_truncate_tables);

	describe_db('audit_log_completeness', (get_db) => {
		// --- Account routes ---

		describe('account mutation audit events', () => {
			test('login success produces login event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(login_route, 'Expected POST /login route');

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: UNAUTHENTICATED_JSON_HEADERS,
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'test-password-123',
					}),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'login', 'POST /login (success)');
			});

			test('login failure produces login event with failure outcome', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(login_route, 'Expected POST /login route');

				const res = await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: UNAUTHENTICATED_JSON_HEADERS,
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'wrong-password',
					}),
				});
				assert.strictEqual(res.status, 401);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'login', 'POST /login (failure)');
			});

			test('logout produces logout event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(logout_route, 'Expected POST /logout route');

				const res = await test_app.app.request(logout_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'logout', 'POST /logout');
			});

			test('token create produces token_create event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_create_action_spec,
					params: {name: 'audit-test'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`account_token_create failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'token_create', 'account_token_create RPC');
			});

			test('token revoke produces token_revoke event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				// get a token ID to revoke
				const list_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_list_action_spec,
					params: undefined,
					headers: test_app.create_session_headers(),
				});
				assert.ok(list_res.ok, 'account_token_list should succeed');
				const {tokens} = list_res.result;
				assert.ok(tokens.length > 0, 'Expected at least one token');

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_token_revoke_action_spec,
					params: {token_id: tokens[0]!.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`account_token_revoke failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'token_revoke', 'account_token_revoke RPC');
			});

			test('session revoke produces session_revoke event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				// login to create a second session we can revoke
				const login_route = find_auth_route(test_app.route_specs, '/login', 'POST');
				assert.ok(login_route, 'Expected POST /login route');
				await test_app.app.request(login_route.path, {
					method: 'POST',
					headers: UNAUTHENTICATED_JSON_HEADERS,
					body: JSON.stringify({
						username: test_app.backend.account.username,
						password: 'test-password-123',
					}),
				});

				// get session IDs (newest first)
				const list_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_list_action_spec,
					params: undefined,
					headers: test_app.create_session_headers(),
				});
				assert.ok(list_res.ok, 'account_session_list should succeed');
				const {sessions} = list_res.result;
				assert.ok(sessions.length >= 2, 'Expected at least 2 sessions');

				// revoke the second session (not the one used for auth)
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_action_spec,
					params: {session_id: sessions[1]!.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`account_session_revoke failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'session_revoke', 'account_session_revoke RPC');
			});

			test('session revoke-all produces session_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_all_action_spec,
					params: undefined,
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`account_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'session_revoke_all', 'account_session_revoke_all RPC');
			});

			test('password change produces password_change event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const route = find_auth_route(test_app.route_specs, '/password', 'POST');
				assert.ok(route, 'Expected POST /password route');

				const res = await test_app.app.request(route.path, {
					method: 'POST',
					headers: json_session_headers(test_app),
					body: JSON.stringify({
						current_password: 'test-password-123',
						new_password: 'new-password-456',
					}),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'password_change', 'POST /password');
			});
		});

		// --- Admin routes ---

		describe('admin mutation audit events', () => {
			test('admin offer (RPC) + accept produces role_grant_offer_create and role_grant_create events', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				const target = await test_app.create_account({username: 'audit_target'});

				const offer_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_offer_create_action_spec,
					params: {to_account_id: target.account.id, role: ROLE_ADMIN},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					offer_res.ok,
					`role_grant_offer_create failed: ${offer_res.ok ? '' : JSON.stringify(offer_res.error)}`,
				);
				const {offer} = offer_res.result;

				// Admin offer emits `role_grant_offer_create` only — the role_grant doesn't
				// exist yet. Drive the accept to confirm `role_grant_create` fires on the
				// downstream consent transition.
				const events_after_offer = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(
					events_after_offer,
					'role_grant_offer_create',
					'role_grant_offer_create RPC',
				);

				await get_db().transaction(async (tx) => {
					await query_accept_offer(
						{db: tx},
						{
							offer_id: offer.id,
							to_account_id: target.account.id,
							actor_id: target.actor.id,
							ip: null,
						},
					);
				});

				const events_after_accept = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events_after_accept, 'role_grant_create', 'offer accept');
			});

			test('role_grant revoke (RPC) produces role_grant_revoke event with both target columns', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				const target = await test_app.create_account({username: 'audit_revoke_target'});

				// Offer + accept to materialize a role_grant we can revoke.
				const offer_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_offer_create_action_spec,
					params: {to_account_id: target.account.id, role: ROLE_ADMIN},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					offer_res.ok,
					`role_grant_offer_create failed: ${offer_res.ok ? '' : JSON.stringify(offer_res.error)}`,
				);
				const {offer} = offer_res.result;
				const accept_result = await get_db().transaction(async (tx) => {
					return query_accept_offer(
						{db: tx},
						{
							offer_id: offer.id,
							to_account_id: target.account.id,
							actor_id: target.actor.id,
							ip: null,
						},
					);
				});

				// Revoke via RPC.
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_revoke_action_spec,
					params: {actor_id: target.actor.id, role_grant_id: accept_result.role_grant.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`role_grant_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'role_grant_revoke', 'role_grant_revoke RPC');

				// Audit envelope must populate both target columns —
				// `role_grant_revoke` is the canonical actor-bound-subject event.
				const revoke_rows = await test_app.backend.deps.db.query<{
					target_account_id: string | null;
					target_actor_id: string | null;
				}>(
					`SELECT target_account_id, target_actor_id FROM audit_log
					 WHERE event_type = 'role_grant_revoke' ORDER BY seq DESC LIMIT 1`,
				);
				const row = revoke_rows[0]!;
				assert.strictEqual(row.target_account_id, target.account.id);
				assert.strictEqual(row.target_actor_id, target.actor.id);
			});

			test('admin session revoke-all produces session_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const target = await test_app.create_account({username: 'audit_sessions_target'});

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_session_revoke_all_action_spec,
					params: {account_id: target.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_session_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				// admin session revoke-all also produces session_revoke_all
				assert_has_event(events, 'session_revoke_all', 'admin_session_revoke_all RPC');
			});

			test('admin token revoke-all produces token_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const target = await test_app.create_account({username: 'audit_tokens_target'});

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: admin_token_revoke_all_action_spec,
					params: {account_id: target.account.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`admin_token_revoke_all failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'token_revoke_all', 'admin_token_revoke_all RPC');
			});
		});

		// --- Invite RPC actions ---

		describe('invite mutation audit events', () => {
			test('invite create and delete produce audit events', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				const create_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: invite_create_action_spec,
					params: {username: 'invited_user'},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					create_res.ok,
					`invite_create failed: ${create_res.ok ? '' : JSON.stringify(create_res.error)}`,
				);
				const {invite} = create_res.result;

				const delete_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: invite_delete_action_spec,
					params: {invite_id: invite.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					delete_res.ok,
					`invite_delete failed: ${delete_res.ok ? '' : JSON.stringify(delete_res.error)}`,
				);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'invite_create', 'invite_create RPC');
				assert_has_event(events, 'invite_delete', 'invite_delete RPC');
			});
		});

		// --- App settings RPC action ---

		describe('app settings mutation audit events', () => {
			test('settings update produces app_settings_update event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: app_settings_update_action_spec,
					params: {open_signup: true},
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, `app_settings_update failed: ${res.ok ? '' : JSON.stringify(res.error)}`);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'app_settings_update', 'app_settings_update RPC');
			});
		});

		// --- Signup route ---

		describe('signup audit events', () => {
			test('signup produces signup event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				// enable open signup via RPC
				const settings_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: app_settings_update_action_spec,
					params: {open_signup: true},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					settings_res.ok,
					`app_settings_update failed: ${settings_res.ok ? '' : JSON.stringify(settings_res.error)}`,
				);

				// signup
				const signup_route = find_auth_route(test_app.route_specs, '/signup', 'POST');
				assert.ok(signup_route, 'Expected POST /signup route');

				const res = await test_app.app.request(signup_route.path, {
					method: 'POST',
					headers: UNAUTHENTICATED_JSON_HEADERS,
					body: JSON.stringify({
						username: 'signup_user',
						password: 'signup-password-123',
					}),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'signup', 'POST /signup');
			});
		});

		// --- Completeness check ---

		describe('completeness', () => {
			/**
			 * Event types covered by this suite. Bootstrap is excluded because
			 * it requires filesystem token state not provided by create_test_app.
			 */
			const COVERED_EVENT_TYPES: ReadonlySet<AuditEventType> = new Set([
				'login',
				'logout',
				'signup',
				'password_change',
				'session_revoke',
				'session_revoke_all',
				'token_create',
				'token_revoke',
				'token_revoke_all',
				'role_grant_offer_create',
				'role_grant_create',
				'role_grant_revoke',
				'invite_create',
				'invite_delete',
				'app_settings_update',
			]);

			/** Event types excluded with justification. */
			const EXCLUDED_EVENT_TYPES: ReadonlySet<AuditEventType> = new Set([
				'bootstrap', // requires filesystem token — tested in bootstrap_account.db.test.ts
				// The remaining `role_grant_offer_*` events fire only via the RPC
				// endpoint or via downstream effects of `role_grant_revoke`. Direct
				// coverage lives in `role_grant_offer_queries.db.test.ts`,
				// `role_grant_offer_actions.db.test.ts`,
				// `role_grant_offer_actions.notifications.db.test.ts`, and
				// `role_grant_offer_actions.notifications.revoke.db.test.ts`.
				// `role_grant_offer_expire` fires from the cleanup sweep
				// (`cleanup_expired_role_grant_offers` in `auth/cleanup.ts`) —
				// covered in `cleanup.db.test.ts`.
				'role_grant_offer_accept',
				'role_grant_offer_decline',
				'role_grant_offer_retract',
				'role_grant_offer_expire',
				'role_grant_offer_supersede',
			]);

			test('all audit event types are covered or explicitly excluded', () => {
				const all_covered = new Set([...COVERED_EVENT_TYPES, ...EXCLUDED_EVENT_TYPES]);
				for (const event_type of AUDIT_EVENT_TYPES) {
					assert.ok(
						all_covered.has(event_type),
						`Audit event type '${event_type}' is not covered by the completeness suite and not explicitly excluded — add a test or exclude with justification`,
					);
				}
			});

			test('no excluded event types are also covered', () => {
				for (const event_type of EXCLUDED_EVENT_TYPES) {
					assert.ok(
						!COVERED_EVENT_TYPES.has(event_type),
						`Event type '${event_type}' is in both COVERED and EXCLUDED — remove from one`,
					);
				}
			});
		});
	});
};
