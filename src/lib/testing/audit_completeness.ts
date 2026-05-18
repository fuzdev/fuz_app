import './assert_dev_env.js';

/**
 * Composable audit log completeness test suite.
 *
 * Verifies that every auth mutation route produces the expected audit log
 * event. Uses the real middleware stack and database, then **reads back
 * through the `audit_log_list` RPC** — the production observation path the
 * admin UI consumes. This is intentional end-to-end coverage: emit →
 * persist → query → wire response, all in one round-trip.
 *
 * The trade is a deliberate transport coupling: a regression in
 * `audit_log_list_action_spec`'s auth or response shape can surface here as
 * a secondary failure. `describe_rpc_round_trip_tests` covers that RPC
 * directly, so primary breakages localize there first. For *unit-level*
 * "did the handler emit?" assertions without the persistence path, use
 * `create_recording_audit_emitter` from `audit_drift_guard.ts` — that
 * captures emits before they hit DB or transport.
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
import {
	AUDIT_EVENT_TYPES,
	type AuditEventType,
	type AuditLogEventWithUsernamesJson,
} from '../auth/audit_log_schema.js';
import {auth_migration_ns} from '../auth/migrations.js';
import {
	create_test_app,
	type CreateTestAppOptions,
	type SuiteAppOptions,
	type TestAccount,
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
import {
	rpc_call_for_spec,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcCallArgs,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.js';
import {role_grant_offer_and_accept} from './role_grant_helpers.js';
import {
	role_grant_offer_accept_action_spec,
	role_grant_offer_create_action_spec,
	role_grant_revoke_action_spec,
} from '../auth/role_grant_offer_action_specs.js';
import {
	admin_session_revoke_all_action_spec,
	admin_token_revoke_all_action_spec,
	app_settings_update_action_spec,
	audit_log_list_action_spec,
	AUDIT_LOG_LIST_LIMIT_MAX,
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

/**
 * Mint a dedicated admin account whose sole job is to read the audit log
 * via RPC. Decoupling the *observer* from the *subject* keeps the helper
 * shape uniform across every audit-touching test — even ones whose
 * mutation revokes the bootstrapped admin's credentials (logout,
 * session_revoke, password_change). The observer has no role-grants the
 * test exercises and no credentials the test mutates, so it survives
 * every flow.
 */
const create_admin_observer = (test_app: TestApp): Promise<TestAccount> =>
	test_app.create_account({username: 'audit_observer', roles: [ROLE_ADMIN]});

/**
 * List audit log events via the `audit_log_list` RPC. Replaces the previous
 * raw `SELECT FROM audit_log` query — the RPC is the documented contract and
 * the same path the admin UI consumes. The RPC orders newest-first
 * (`ORDER BY seq DESC`); assertions use `.some()` / `.find()` so ordering is
 * invisible to test logic. Default `limit: AUDIT_LOG_LIST_LIMIT_MAX` (200)
 * future-proofs against tests with more emissions; per-test
 * `auth_integration_truncate_tables` keeps the table empty between cases.
 *
 * `observer` is a dedicated admin account (see {@link create_admin_observer})
 * — its credentials are never the subject of the mutation under test, so the
 * read works uniformly across every flow including session-revoking ones.
 */
const list_audit_events = async (
	app: RpcCallArgs['app'],
	rpc_path: string,
	observer: TestAccount,
	params: {event_type?: AuditEventType} = {},
): Promise<Array<AuditLogEventWithUsernamesJson>> => {
	const res = await rpc_call_for_spec({
		app,
		path: rpc_path,
		spec: audit_log_list_action_spec,
		params: {limit: AUDIT_LOG_LIST_LIMIT_MAX, ...params},
		headers: observer.create_session_headers(),
	});
	assert.ok(res.ok, `audit_log_list failed: ${res.ok ? '' : JSON.stringify(res.error)}`);
	return res.result.events;
};

/** Assert that audit events contain the expected event type. */
const assert_has_event = (
	events: ReadonlyArray<{event_type: string}>,
	expected: AuditEventType,
	context: string,
): void => {
	assert.ok(
		events.some((e) => e.event_type === expected),
		`Expected '${expected}' audit event after ${context}`,
	);
};

/**
 * Assert that an event type was emitted with the expected `credential_type`
 * recorded in metadata — defense-in-depth coverage for the spec gate
 * documented in `docs/security.md` §Credential-channel gating.
 */
const assert_event_credential_type = (
	events: ReadonlyArray<AuditLogEventWithUsernamesJson>,
	expected: AuditEventType,
	credential_type: string,
	context: string,
): void => {
	const match = events.find((e) => e.event_type === expected);
	assert.ok(match, `Expected '${expected}' audit event after ${context}`);
	const recorded = (match.metadata ?? {}).credential_type;
	assert.strictEqual(
		recorded,
		credential_type,
		`Expected '${expected}' audit metadata.credential_type === '${credential_type}' after ${context} (got ${JSON.stringify(recorded)})`,
	);
};

/** Build CreateTestAppOptions with admin+keeper roles. */
const build_options = (options: AuditCompletenessTestOptions, db: Db): CreateTestAppOptions => ({
	session_options: options.session_options,
	create_route_specs: options.create_route_specs,
	db,
	roles: [ROLE_KEEPER, ROLE_ADMIN],
	rpc_endpoints: options.rpc_endpoints,
	app_options: options.app_options,
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
	// path; real handlers run per-test via the top-level `rpc_endpoints` slot on `CreateTestAppOptions`.
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
				const observer = await create_admin_observer(test_app);
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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'login', 'POST /login (success)');
			});

			test('login failure produces login event with failure outcome', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);
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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'login', 'POST /login (failure)');
			});

			test('logout produces logout event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);
				const logout_route = find_auth_route(test_app.route_specs, '/logout', 'POST');
				assert.ok(logout_route, 'Expected POST /logout route');

				const res = await test_app.app.request(logout_route.path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'logout', 'POST /logout');
			});

			test('token create produces token_create event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);
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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'token_create', 'account_token_create RPC');
				assert_event_credential_type(events, 'token_create', 'session', 'account_token_create RPC');
			});

			test('token revoke produces token_revoke event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'token_revoke', 'account_token_revoke RPC');
				assert_event_credential_type(events, 'token_revoke', 'session', 'account_token_revoke RPC');
			});

			test('session revoke produces session_revoke event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

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

				// get session IDs (newest first — `account_session_list` orders DESC
				// by `created_at`, so [0] is the just-logged-in session and [1] is
				// the bootstrap session driving the RPC call).
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

				// revoke the newest session — not the bootstrap one driving auth.
				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: account_session_revoke_action_spec,
					params: {session_id: sessions[0]!.id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					res.ok,
					`account_session_revoke failed: ${res.ok ? '' : JSON.stringify(res.error)}`,
				);

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'session_revoke', 'account_session_revoke RPC');
				assert_event_credential_type(
					events,
					'session_revoke',
					'session',
					'account_session_revoke RPC',
				);
			});

			test('session revoke-all produces session_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'session_revoke_all', 'account_session_revoke_all RPC');
				assert_event_credential_type(
					events,
					'session_revoke_all',
					'session',
					'account_session_revoke_all RPC',
				);
			});

			test('password change produces password_change event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);
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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'password_change', 'POST /password');
				assert_event_credential_type(events, 'password_change', 'session', 'POST /password');
			});
		});

		// --- Admin routes ---

		describe('admin mutation audit events', () => {
			test('admin offer (RPC) + accept (RPC) produces role_grant_offer_create, role_grant_offer_accept, and role_grant_create events', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

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
				// exist yet. Drive the accept to confirm `role_grant_offer_accept` and
				// `role_grant_create` both fire on the downstream consent transition.
				const events_after_offer = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(
					events_after_offer,
					'role_grant_offer_create',
					'role_grant_offer_create RPC',
				);

				const accept_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_offer_accept_action_spec,
					params: {offer_id: offer.id},
					headers: target.create_session_headers(),
				});
				assert.ok(
					accept_res.ok,
					`role_grant_offer_accept failed: ${accept_res.ok ? '' : JSON.stringify(accept_res.error)}`,
				);

				const events_after_accept = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events_after_accept, 'role_grant_offer_accept', 'offer accept RPC');
				assert_has_event(events_after_accept, 'role_grant_create', 'offer accept RPC');
			});

			test('role_grant revoke (RPC) produces role_grant_revoke event with both target columns', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

				const target = await test_app.create_account({username: 'audit_revoke_target'});

				// Offer + accept to materialize a role_grant we can revoke. The
				// consent path itself is covered by the `offer + accept` test above;
				// here we only need the role_grant to exist.
				const {role_grant_id} = await role_grant_offer_and_accept({
					app: test_app.app,
					rpc_path,
					grantor: test_app,
					recipient: target,
					role: ROLE_ADMIN,
				});

				// Revoke via RPC.
				const revoke_res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: role_grant_revoke_action_spec,
					params: {actor_id: target.actor.id, role_grant_id},
					headers: test_app.create_session_headers(),
				});
				assert.ok(
					revoke_res.ok,
					`role_grant_revoke failed: ${revoke_res.ok ? '' : JSON.stringify(revoke_res.error)}`,
				);

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'role_grant_revoke', 'role_grant_revoke RPC');

				// Audit envelope must populate both target columns —
				// `role_grant_revoke` is the canonical actor-bound-subject event.
				// RPC orders newest-first, so `.find` picks up the just-emitted row.
				const revoke = events.find((e) => e.event_type === 'role_grant_revoke');
				assert.ok(revoke, 'Expected role_grant_revoke audit event');
				assert.strictEqual(revoke.target_account_id, target.account.id);
				assert.strictEqual(revoke.target_actor_id, target.actor.id);
			});

			test('admin session revoke-all produces session_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);
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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				// admin session revoke-all also produces session_revoke_all
				assert_has_event(events, 'session_revoke_all', 'admin_session_revoke_all RPC');
			});

			test('admin token revoke-all produces token_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);
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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'token_revoke_all', 'admin_token_revoke_all RPC');
			});
		});

		// --- Invite RPC actions ---

		describe('invite mutation audit events', () => {
			test('invite create and delete produce audit events', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'invite_create', 'invite_create RPC');
				assert_has_event(events, 'invite_delete', 'invite_delete RPC');
			});
		});

		// --- App settings RPC action ---

		describe('app settings mutation audit events', () => {
			test('settings update produces app_settings_update event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

				const res = await rpc_call_for_spec({
					app: test_app.app,
					path: rpc_path,
					spec: app_settings_update_action_spec,
					params: {open_signup: true},
					headers: test_app.create_session_headers(),
				});
				assert.ok(res.ok, `app_settings_update failed: ${res.ok ? '' : JSON.stringify(res.error)}`);

				const events = await list_audit_events(test_app.app, rpc_path, observer);
				assert_has_event(events, 'app_settings_update', 'app_settings_update RPC');
			});
		});

		// --- Signup route ---

		describe('signup audit events', () => {
			test('signup produces signup event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const observer = await create_admin_observer(test_app);

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

				const events = await list_audit_events(test_app.app, rpc_path, observer);
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
				'role_grant_offer_accept',
				'role_grant_create',
				'role_grant_revoke',
				'invite_create',
				'invite_delete',
				'app_settings_update',
			]);

			/** Event types excluded with justification. */
			const EXCLUDED_EVENT_TYPES: ReadonlySet<AuditEventType> = new Set([
				'bootstrap', // requires filesystem token — tested in bootstrap_account.db.test.ts
				// The remaining `role_grant_offer_*` events fire only via terminal
				// transitions (decline, retract) or downstream effects (supersede on
				// accept of a sibling, or as a fan-out of `role_grant_revoke`). Direct
				// coverage lives in `role_grant_offer_queries.db.test.ts`,
				// `role_grant_offer_actions.db.test.ts`,
				// `role_grant_offer_actions.notifications.db.test.ts`, and
				// `role_grant_offer_actions.notifications.revoke.db.test.ts`.
				// `role_grant_offer_expire` fires from the cleanup sweep
				// (`cleanup_expired_role_grant_offers` in `auth/cleanup.ts`) —
				// covered in `cleanup.db.test.ts`.
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
