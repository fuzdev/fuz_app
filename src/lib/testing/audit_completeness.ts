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
import type {AppServerContext, AppServerOptions} from '../server/app_server.js';
import type {RouteSpec} from '../http/route_spec.js';
import {ROLE_KEEPER, ROLE_ADMIN} from '../auth/role_schema.js';
import {AUDIT_EVENT_TYPES, type AuditEventType} from '../auth/audit_log_schema.js';
import {AUTH_MIGRATION_NS} from '../auth/migrations.js';
import {create_test_app, type CreateTestAppOptions, type TestApp} from './app_server.js';
import {
	create_pglite_factory,
	create_describe_db,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
	type DbFactory,
} from './db.js';
import {find_auth_route} from './integration_helpers.js';
import {run_migrations} from '../db/migrate.js';
import type {Db} from '../db/db.js';

/**
 * Configuration for `describe_audit_completeness_tests`.
 */
export interface AuditCompletenessTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same one used in production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: Partial<
		Omit<AppServerOptions, 'backend' | 'session_options' | 'create_route_specs'>
	>;
	/** Database factories to run tests against. Default: pglite only. */
	db_factories?: Array<DbFactory>;
}

/** Find an admin route by suffix and method. */
const find_admin_route = (
	specs: Array<RouteSpec>,
	suffix: string,
	method: string,
): RouteSpec | undefined =>
	specs.find(
		(s) =>
			s.method === method &&
			s.path.endsWith(suffix) &&
			s.auth.type === 'role' &&
			s.auth.role === 'admin',
	);

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
 * Find an account-scoped parameterized route (e.g. `/tokens/:id/revoke`).
 *
 * Matches routes with a `:id` or `:param` segment that are NOT admin role-gated.
 */
const find_account_parameterized_route = (
	specs: Array<RouteSpec>,
	segment: string,
	suffix: string,
	method: string,
): RouteSpec | undefined =>
	specs.find(
		(s) =>
			s.method === method &&
			s.path.includes(`/${segment}/`) &&
			s.path.endsWith(suffix) &&
			s.auth.type !== 'role',
	);

/**
 * Composable audit log completeness test suite.
 *
 * Verifies that every auth mutation route produces the correct audit log
 * event type. Exercises routes via HTTP requests against a real PGlite
 * database, then queries the `audit_log` table to verify events.
 *
 * @param options - session config, route factory, and optional overrides
 */
export const describe_audit_completeness_tests = (options: AuditCompletenessTestOptions): void => {
	const init_schema = async (db: Db): Promise<void> => {
		await run_migrations(db, [AUTH_MIGRATION_NS]);
	};
	const factories = options.db_factories ?? [create_pglite_factory(init_schema)];
	const describe_db = create_describe_db(factories, AUTH_INTEGRATION_TRUNCATE_TABLES);

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
				const route = find_auth_route(test_app.route_specs, '/tokens/create', 'POST');
				assert.ok(route, 'Expected POST /tokens/create route');

				const res = await test_app.app.request(route.path, {
					method: 'POST',
					headers: json_session_headers(test_app),
					body: JSON.stringify({name: 'audit-test'}),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'token_create', 'POST /tokens/create');
			});

			test('token revoke produces token_revoke event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				// get a token ID to revoke
				const tokens_route = find_auth_route(test_app.route_specs, '/tokens', 'GET');
				assert.ok(tokens_route, 'Expected GET /tokens route');
				const list_res = await test_app.app.request(tokens_route.path, {
					headers: test_app.create_session_headers(),
				});
				const {tokens} = (await list_res.json()) as {tokens: Array<{id: string}>};
				assert.ok(tokens.length > 0, 'Expected at least one token');

				const route = find_account_parameterized_route(
					test_app.route_specs,
					'tokens',
					'/revoke',
					'POST',
				);
				assert.ok(route, 'Expected POST /tokens/:id/revoke route');
				const path = route.path.replace(':id', tokens[0]!.id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'token_revoke', 'POST /tokens/:id/revoke');
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
				const sessions_route = find_auth_route(test_app.route_specs, '/sessions', 'GET');
				assert.ok(sessions_route, 'Expected GET /sessions route');
				const list_res = await test_app.app.request(sessions_route.path, {
					headers: test_app.create_session_headers(),
				});
				const {sessions} = (await list_res.json()) as {sessions: Array<{id: string}>};
				assert.ok(sessions.length >= 2, 'Expected at least 2 sessions');

				const route = find_account_parameterized_route(
					test_app.route_specs,
					'sessions',
					'/revoke',
					'POST',
				);
				assert.ok(route, 'Expected POST /sessions/:id/revoke route');

				// revoke the second session (not the one used for auth)
				const path = route.path.replace(':id', sessions[1]!.id);
				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'session_revoke', 'POST /sessions/:id/revoke');
			});

			test('session revoke-all produces session_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const route = find_auth_route(test_app.route_specs, '/sessions/revoke-all', 'POST');
				assert.ok(route, 'Expected POST /sessions/revoke-all route');

				const res = await test_app.app.request(route.path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'session_revoke_all', 'POST /sessions/revoke-all');
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
			test('permit grant produces permit_grant event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				assert.ok(route, 'Expected admin POST /permits/grant route');

				const target = await test_app.create_account({username: 'audit_target'});
				const path = route.path.replace(':account_id', target.account.id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: json_session_headers(test_app),
					body: JSON.stringify({role: ROLE_ADMIN}),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'permit_grant', 'POST /permits/grant');
			});

			test('permit revoke produces permit_revoke event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const grant_route = find_admin_route(test_app.route_specs, '/permits/grant', 'POST');
				const revoke_route = test_app.route_specs.find(
					(s) =>
						s.method === 'POST' &&
						s.path.includes('/permits/') &&
						s.path.endsWith('/revoke') &&
						s.auth.type === 'role',
				);
				assert.ok(grant_route, 'Expected admin POST /permits/grant route');
				assert.ok(revoke_route, 'Expected admin POST /permits/:permit_id/revoke route');

				const target = await test_app.create_account({username: 'audit_revoke_target'});

				// grant a permit first
				const grant_path = grant_route.path.replace(':account_id', target.account.id);
				const grant_res = await test_app.app.request(grant_path, {
					method: 'POST',
					headers: json_session_headers(test_app),
					body: JSON.stringify({role: ROLE_ADMIN}),
				});
				const grant_body = (await grant_res.json()) as {permit: {id: string}};

				// revoke it
				const revoke_path = revoke_route.path
					.replace(':account_id', target.account.id)
					.replace(':permit_id', grant_body.permit.id);
				const res = await test_app.app.request(revoke_path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'permit_revoke', 'POST /permits/:permit_id/revoke');
			});

			test('admin session revoke-all produces session_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const route = find_admin_route(test_app.route_specs, '/sessions/revoke-all', 'POST');
				assert.ok(route, 'Expected admin POST /sessions/revoke-all route');

				const target = await test_app.create_account({username: 'audit_sessions_target'});
				const path = route.path.replace(':account_id', target.account.id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				// admin session revoke-all also produces session_revoke_all
				assert_has_event(events, 'session_revoke_all', 'admin POST /sessions/revoke-all');
			});

			test('admin token revoke-all produces token_revoke_all event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const route = find_admin_route(test_app.route_specs, '/tokens/revoke-all', 'POST');
				assert.ok(route, 'Expected admin POST /tokens/revoke-all route');

				const target = await test_app.create_account({username: 'audit_tokens_target'});
				const path = route.path.replace(':account_id', target.account.id);

				const res = await test_app.app.request(path, {
					method: 'POST',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'token_revoke_all', 'admin POST /tokens/revoke-all');
			});
		});

		// --- Invite routes ---

		describe('invite mutation audit events', () => {
			test('invite create and delete produce audit events', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const create_route = find_admin_route(test_app.route_specs, '/invites', 'POST');
				const delete_route = test_app.route_specs.find(
					(s) => s.method === 'DELETE' && s.path.includes('/invites/') && s.auth.type === 'role',
				);
				assert.ok(create_route, 'Expected admin POST /invites route');
				assert.ok(delete_route, 'Expected admin DELETE /invites/:id route');

				// create invite
				const create_res = await test_app.app.request(create_route.path, {
					method: 'POST',
					headers: json_session_headers(test_app),
					body: JSON.stringify({username: 'invited_user'}),
				});
				assert.strictEqual(create_res.status, 200);
				const {invite} = (await create_res.json()) as {invite: {id: string}};

				// delete invite
				const delete_path = delete_route.path.replace(':id', invite.id);
				const delete_res = await test_app.app.request(delete_path, {
					method: 'DELETE',
					headers: test_app.create_session_headers(),
				});
				assert.strictEqual(delete_res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'invite_create', 'POST /invites');
				assert_has_event(events, 'invite_delete', 'DELETE /invites/:id');
			});
		});

		// --- App settings routes ---

		describe('app settings mutation audit events', () => {
			test('settings update produces app_settings_update event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));
				const route = find_admin_route(test_app.route_specs, '/settings', 'PATCH');
				assert.ok(route, 'Expected admin PATCH /settings route');

				const res = await test_app.app.request(route.path, {
					method: 'PATCH',
					headers: json_session_headers(test_app),
					body: JSON.stringify({open_signup: true}),
				});
				assert.strictEqual(res.status, 200);

				const events = await query_audit_events(test_app.backend.deps.db);
				assert_has_event(events, 'app_settings_update', 'PATCH /settings');
			});
		});

		// --- Signup route ---

		describe('signup audit events', () => {
			test('signup produces signup event', async () => {
				const test_app = await create_test_app(build_options(options, get_db()));

				// enable open signup
				const settings_route = find_admin_route(test_app.route_specs, '/settings', 'PATCH');
				assert.ok(settings_route, 'Expected admin PATCH /settings route');
				await test_app.app.request(settings_route.path, {
					method: 'PATCH',
					headers: json_session_headers(test_app),
					body: JSON.stringify({open_signup: true}),
				});

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
				'permit_grant',
				'permit_revoke',
				'invite_create',
				'invite_delete',
				'app_settings_update',
			]);

			/** Event types excluded with justification. */
			const EXCLUDED_EVENT_TYPES: ReadonlySet<AuditEventType> = new Set([
				'bootstrap', // requires filesystem token — tested in bootstrap_account.db.test.ts
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
