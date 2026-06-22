import './assert_dev_env.ts';

/**
 * Schema-driven SSE route validation test suite.
 *
 * Complements `describe_round_trip_validation` (which skips SSE routes).
 * For each configured SSE route:
 * 1. Open the stream with matching auth.
 * 2. Assert the `: connected` comment is emitted.
 * 3. Fire `trigger()` — expect one `data: {...}` frame.
 * 4. Validate the payload as `{method, params}` against declared `EventSpec`s.
 * 5. Fire `session_revoke_all` for the account and assert the stream closes
 *    (when `assert_closes_on_revoke !== false`).
 *
 * @module
 */

import {describe, test, beforeAll, afterAll, assert} from 'vitest';

import type {RouteSpec} from '../http/route_spec.ts';
import type {AppServerContext} from '../server/app_server_context.ts';
import type {SessionOptions} from '../auth/session_cookie.ts';
import type {EventSpec, SseNotification} from '../realtime/sse.ts';
import {SSE_CONNECTED_COMMENT} from '../realtime/sse_constants.ts';
import {ROLE_ADMIN} from '../auth/role_schema.ts';
import type {AuditLogEvent} from '../auth/audit_log_schema.ts';
import {create_audit_emitter} from '../auth/audit_emitter.ts';
import type {AuditFactory} from '../server/app_backend.ts';
import {
	create_test_app,
	type SuiteAppOptions,
	type TestApp,
	type TestAccount,
} from './app_server.ts';
import {create_pglite_factory, type DbFactory} from './db.ts';
import {find_route_spec, pick_auth_headers} from './integration_helpers.ts';
import {
	rpc_call,
	require_rpc_endpoint_path,
	resolve_rpc_endpoints_for_setup,
	type RpcEndpointsSuiteOption,
} from './rpc_helpers.ts';
import {run_migrations} from '../db/migrate.ts';
import {auth_migration_ns} from '../auth/migrations.ts';
import type {Db} from '../db/db.ts';
import {account_session_revoke_all_action_spec} from '../auth/account_action_specs.ts';
import {create_sse_frame_reader} from './transports/sse_frame_reader.ts';

/** Config for a single SSE route under test. */
export interface SseRouteTestSpec {
	/** Full HTTP path of the SSE endpoint (e.g., `'/api/zap/subscribe'`). */
	path: string;
	/**
	 * Fire an event matching one of the declared `event_specs` that should
	 * reach the open stream. Called after the `: connected` comment is observed.
	 * The triggered frame must be a JSON-serializable `{method, params}` payload.
	 */
	trigger: (ctx: {test_app: TestApp; account: TestAccount}) => Promise<void>;
	/**
	 * Event specs to validate the triggered payload against. When omitted,
	 * the payload is only asserted to be well-formed `{method, params}`.
	 */
	event_specs?: Array<EventSpec>;
	/**
	 * Whether to assert the stream closes after `session_revoke_all`.
	 * Default `true`. Set `false` for endpoints that don't wire a close-on-revoke
	 * guard (leaves a TODO to fix, rather than silently passing).
	 */
	assert_closes_on_revoke?: boolean;
}

/** Options for `describe_sse_route_tests`. */
export interface SseRouteTestOptions {
	/** Session config for cookie-based auth. */
	session_options: SessionOptions<string>;
	/** Route spec factory — same shape as production. */
	create_route_specs: (ctx: AppServerContext) => Array<RouteSpec>;
	/** Optional overrides for `AppServerOptions`. */
	app_options?: SuiteAppOptions;
	/** Database factories to run tests against. Default: pglite only. */
	db_factories?: Array<DbFactory>;
	/**
	 * Backend audit event callback — threaded to `create_test_app_server`.
	 * Use to wire a close-on-revoke guard for consumer SSE registries
	 * (e.g., via `create_sse_auth_guard`) so `session_revoke_all` actually
	 * closes the tested streams.
	 */
	on_audit_event?: (event: AuditLogEvent) => void;
	/**
	 * RPC endpoint specs — required so the close-on-revoke assertion can
	 * dispatch `account_session_revoke_all` via RPC (there is no REST
	 * equivalent). Hard-fails via `require_rpc_endpoint_path` on setup.
	 *
	 * Accepts either an array (eager) or a factory
	 * `(ctx: AppServerContext) => Array<RpcEndpointSpec>` — the factory form
	 * is required when action handlers must close over the per-test
	 * `ctx.deps`. The factory must return the same
	 * endpoint `path` regardless of ctx — it is invoked once at setup with
	 * a stub ctx for path lookup and again per-test by `create_app_server`
	 * for live dispatch.
	 */
	rpc_endpoints: RpcEndpointsSuiteOption;
	/** SSE routes to exercise. */
	routes: Array<SseRouteTestSpec>;
}

/**
 * Validate a decoded SSE `data:` frame as a JSON-RPC-style `{method, params}` payload.
 */
const parse_and_validate_sse_payload = (
	frame: string,
	event_specs: Array<EventSpec> | undefined,
	route_path: string,
): SseNotification => {
	const data_line = frame.split('\n').find((line) => line.startsWith('data: '));
	assert.ok(data_line, `${route_path}: no 'data:' line in frame: ${JSON.stringify(frame)}`);
	const json_str = data_line.slice('data: '.length);
	let payload: unknown;
	try {
		payload = JSON.parse(json_str);
	} catch (e) {
		throw new Error(`${route_path}: data frame not JSON: ${(e as Error).message} — ${json_str}`);
	}
	assert.ok(
		payload && typeof payload === 'object',
		`${route_path}: payload must be an object, got ${typeof payload}`,
	);
	const notification = payload as Partial<SseNotification>;
	assert.strictEqual(
		typeof notification.method,
		'string',
		`${route_path}: payload.method must be a string`,
	);
	assert.ok('params' in notification, `${route_path}: payload missing 'params'`);

	if (event_specs) {
		const spec = event_specs.find((s) => s.method === notification.method);
		assert.ok(
			spec,
			`${route_path}: no EventSpec declared for method '${
				notification.method
			}' (declared: ${event_specs.map((s) => s.method).join(', ')})`,
		);
		const result = spec.params.safeParse(notification.params);
		if (!result.success) {
			throw new Error(
				`${route_path}: params mismatch for method '${notification.method}': ${JSON.stringify(
					result.error.issues,
				)}`,
			);
		}
	}
	return notification as SseNotification;
};

/**
 * Run SSE route validation tests.
 *
 * For each route: opens an authenticated SSE connection, asserts the
 * connected comment, fires the trigger, validates the resulting payload,
 * then asserts close-on-revoke (unless opted out).
 *
 * @throws Error at setup time when `options.rpc_endpoints` is empty — the
 *   close-on-revoke assertion dispatches `account_session_revoke_all` via
 *   RPC. Hard-fails via `require_rpc_endpoint_path`.
 */
export const describe_sse_route_tests = (options: SseRouteTestOptions): void => {
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

	for (const factory of factories) {
		const describe_fn = factory.skip ? describe.skip : describe;
		describe_fn(`SSE validation (${factory.name})`, () => {
			for (const route_config of options.routes) {
				describe(`GET ${route_config.path}`, () => {
					let test_app: TestApp;
					let authed_account: TestAccount;
					let admin_account: TestAccount;
					let account: TestAccount;
					let db: Db;

					beforeAll(async () => {
						db = await factory.create();
						// Forward the consumer's listener through an `audit_factory`
						// body — the sugar was removed from `TestAppServerOptions`
						// to match the production `CreateAppBackendOptions` shape.
						const {on_audit_event} = options;
						const audit_factory: AuditFactory | undefined = on_audit_event
							? (params) => create_audit_emitter({...params, on_audit_event})
							: undefined;
						test_app = await create_test_app({
							session_options: options.session_options,
							create_route_specs: options.create_route_specs,
							db,
							rpc_endpoints: options.rpc_endpoints,
							app_options: options.app_options,
							audit_factory,
						});
						authed_account = await test_app.create_account({
							username: 'sse_authed',
							roles: [],
						});
						admin_account = await test_app.create_account({
							username: 'sse_admin',
							roles: [ROLE_ADMIN],
						});
					});

					afterAll(async () => {
						await test_app.cleanup();
						await factory.close(db);
					});

					test('opens, emits payload, closes on revoke', async () => {
						const spec = find_route_spec(test_app.route_specs, 'GET', route_config.path);
						assert.ok(spec, `no route spec for GET ${route_config.path}`);

						account = pick_account_for_auth(spec, test_app, authed_account, admin_account);
						const headers = pick_auth_headers(spec, test_app, authed_account, admin_account);

						const res = await test_app.app.request(route_config.path, {
							method: 'GET',
							headers,
						});
						assert.strictEqual(
							res.status,
							200,
							`expected 200 for ${route_config.path}, got ${res.status}`,
						);
						assert.ok(
							res.headers.get('Content-Type')?.includes('text/event-stream'),
							`${route_config.path}: Content-Type must be text/event-stream`,
						);
						assert.ok(res.body, `${route_config.path}: response has no body`);

						const reader = res.body.getReader();
						const sse = create_sse_frame_reader(reader);

						try {
							// 1. Connected comment — matches SSE_CONNECTED_COMMENT minus the trailing \n\n.
							const first = await sse.read_frame();
							assert.strictEqual(
								first + '\n\n',
								SSE_CONNECTED_COMMENT,
								`${route_config.path}: first frame must be the connected comment`,
							);

							// 2. Trigger → first data frame.
							await route_config.trigger({test_app, account});
							const data_frame = await sse.read_frame();
							parse_and_validate_sse_payload(
								data_frame,
								route_config.event_specs,
								route_config.path,
							);

							// 3. Close-on-revoke.
							if (route_config.assert_closes_on_revoke !== false) {
								const revoke_res = await rpc_call({
									app: test_app.app,
									path: rpc_path,
									method: account_session_revoke_all_action_spec.method,
									headers: account.create_session_headers(),
								});
								assert.ok(
									revoke_res.ok,
									`account_session_revoke_all RPC failed (status=${revoke_res.status}): ${
										revoke_res.ok ? '' : JSON.stringify(revoke_res.error)
									}`,
								);
								const closed = await sse.wait_for_close(2000);
								assert.ok(
									closed,
									`${route_config.path}: stream did not close within 2s after session_revoke_all`,
								);
							}
						} finally {
							await sse.cancel();
						}
					});
				});
			}
		});
	}
};

/**
 * Pick the TestAccount that matches the route's auth type.
 *
 * Needed so the test can revoke the right account's sessions. Mirrors the
 * fallthrough order of `pick_auth_headers` — routes with `role: admin` get
 * the admin account; `authenticated` gets the authed account; stricter auth
 * (keeper, other roles) uses the bootstrapped keeper account.
 */
const pick_account_for_auth = (
	spec: RouteSpec,
	test_app: TestApp,
	authed_account: TestAccount,
	admin_account: TestAccount,
): TestAccount => {
	const {auth} = spec;
	if (auth.roles?.includes(ROLE_ADMIN)) return admin_account;
	if (auth.account === 'required' && !auth.roles?.length && !auth.credential_types?.length) {
		return authed_account;
	}
	// keeper / other-role / public — bootstrapped account
	return bootstrap_as_account(test_app);
};

/**
 * Treat the bootstrapped `TestApp` account as a `TestAccount` for revocation.
 */
const bootstrap_as_account = (test_app: TestApp): TestAccount => ({
	account: test_app.backend.account,
	actor: test_app.backend.actor,
	session_cookie: test_app.backend.session_cookie,
	api_token: test_app.backend.api_token,
	create_session_headers: test_app.create_session_headers,
	create_bearer_headers: test_app.create_bearer_headers,
});
